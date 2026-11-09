// Wires the pieces together. Each module does one job.
//
//   relay / bluetooth / serial / wifi / replay  ->  hub.onPenData(sample)  ->  motion.update  ->  ink.moveBy
//   mouse                   ->  ink.moveTo
//   IR remote (USB)         ->  onRemoteButton  ->  colors, sizes, pages, tabs, explorer, present mode
//   explorer / tabs         ->  openDocument  ->  pageView (one page, ink canvas on top)
//   ink changes             ->  captureInk (page units)  ->  saved to .notechalant/ in the folder
//   pen pauses              ->  notes controller  ->  recognize new strokes  ->  that file's notes
//   tutor mode              ->  each new note or drawing, plus a picture of the page  ->  tutor review  ->  card under it
//   Save copy               ->  buildCopy (document + ink)  ->  new file next to the original

// Up front, so math never shows twice (see notes/katex.js).
import './datadog.js';
import 'katex/dist/katex.min.css';
import { createInkCanvas } from './ink/inkCanvas.js';
import { createTextLayer } from './ink/textLayer.js';
import { snapStroke, snapHeld, strokeBox, isClosedLoop, underlineOf } from './ink/shapes.js';
import { smoothStroke } from './ink/writing.js';
import { createCircleToAsk, explainImage } from './ask/circleToAsk.js';
import { makeTextItem, strokesSignature, sameSignature, handwriting, handwritingPages } from './ink/inkItems.js';
import { attachMouse } from './input/mouse.js';
import { createInputHub } from './input/hub.js';
import { parseRecording } from './input/parseSample.js';
import { connectSerial, serialSupported } from './input/serial.js';
import { connectWebSocket } from './input/websocket.js';
import { connectRelay, RELAY_URL } from './input/relay.js';
import { bluetoothSupported, connectBluetooth, requestPen } from './input/bluetooth.js';
import { playRecording } from './input/replay.js';
import { connectRemote } from './input/remote.js';
import { createMotion } from './motion/index.js';
import { createToolbar } from './ui/toolbar.js';
import { createDebugPanel } from './debug/debugPanel.js';
import { recognizeImage } from './recognize.js';
import { createNotesController } from './notes/notesController.js';
import { reviewNote, askTutor } from './tutor/tutorClient.js';
import { snapshotPage } from './tutor/pageSnapshot.js';
import { createWhiteboard, openDocument } from './files/documents.js';
import { createPageView } from './files/pageView.js';
import { createExplorer } from './files/explorer.js';
import { createTabs } from './files/tabs.js';
import { buildCopy } from './files/saveCopy.js';
import {
  foldersSupported,
  pickFolder,
  lastFolder,
  folderFromHandle,
  looseInkKey,
  loadLooseInk,
  saveLooseInk,
  saveCopyAs,
} from './files/folder.js';
import { scaleStrokes, packInk, unpackInk, copyName, OPENABLE_EXTENSIONS } from './files/fileTypes.js';

const DEFAULT_WS_URL = 'ws://192.168.4.1:81';
const WS_URL_KEY = 'notechalant.wsUrl';
const WHITEBOARD_KEY = 'notechalant.whiteboard';
// Ink is saved this long after the last change, so a burst of writing becomes one save.
const SAVE_DELAY_MS = 800;
const TICK_MS = 250;
// How long the pen has to stay still before new writing is typed up. Gemini answers in about
// a second, so this wait was most of the delay. Raise it if words get read half finished.
const TRANSCRIBE_IDLE_MS = 1200;
const AUTO_KEY = 'notechalant.autoTranscribe';
const AUTO_CLEANUP_KEY = 'notechalant.autoCleanUp';
const ASK_KEY = 'notechalant.askMode';
const NOTES_SHOWN_KEY = 'notechalant.notesShown';
const TUTOR_KEY = 'notechalant.tutor';

const canvas = document.getElementById('ink');
// Clean up's typed text, drawn under the ink so new writing goes on top of it.
const textLayer = createTextLayer(document.getElementById('typed-layer'));
// The notes track ink by stroke position, so they hear about erased and restored strokes.
const ink = createInkCanvas(canvas, {
  onTextItems: textLayer.render,
  onErase: function (indices) {
    return notes.inkErased(indices);
  },
  onRestore: function (indices, info) {
    notes.inkRestored(indices, info);
  },
});
const motion = createMotion();
// The debug panel wraps the motion module so it sees every sample from every input.
const debug = createDebugPanel(motion, ink, {
  onRecalibrate: function () {
    hub.recalibrate();
    toolbar.setStatus('Recalibrating. Hold still');
  },
  onStatus: function (text, isError) {
    toolbar.setStatus(text, isError);
  },
  getSource: function () {
    return active === null ? null : active.name;
  },
});
const hub = createInputHub({
  ink: ink,
  motion: debug.motion,
  // Double tap on the pen's pad: recenters. The two taps left dots, which aren't meant as ink.
  onDoubleTap: function () {
    ink.dropTrailingDots(2);
    hub.recenter();
    toolbar.setStatus('Centered: the pen points at the middle of the page now');
  },
  // Triple tap: clears the page. The double tap before it already recentered and removed two
  // dots, so only the third is left. Undo brings the page back.
  onTripleTap: function () {
    ink.dropTrailingDots(1);
    ink.clear();
    toolbar.setStatus('Page cleared. Undo (Ctrl+Z) brings it back');
  },
});

// While the pen is calibrating, a big card on the page says to hold still. It's easy to miss
// in the status bar, and moving restarts the calibration.
const calibratingEl = document.getElementById('calibrating');
const calibratingTitle = document.getElementById('calibrating-title');
const calibratingText = document.getElementById('calibrating-text');
const calibratingFill = document.getElementById('calibrating-fill');
let wasCalibrating = false;
setInterval(function () {
  const state = motion.getState();
  const showing = hub.isReceiving() && state.calibrating;
  calibratingEl.hidden = !showing;
  if (showing) {
    // With screen corners set, where the pen points now becomes the middle, so aim there.
    calibratingTitle.textContent = motion.config.screenMapping ? 'Point at the middle and hold still' : 'Hold the pen still';
    calibratingText.textContent = state.moved ? 'You moved, so it started over. Keep it still' : 'Measuring the gyro. About 2 seconds';
    calibratingFill.style.width = Math.round(state.progress * 100) + '%';
  } else if (wasCalibrating && !state.calibrating) {
    toolbar.setStatus(motion.config.pointerMode ? 'Ready. Where the pen points now is the middle. Double tap the pad to recenter' : 'Ready');
  }
  wasCalibrating = showing;
}, 100);

attachMouse(canvas, ink);

// ---- Files and tabs ----
//
// A tab is { id, name, path, looseKey, doc, page, ink, dirty }. `ink` maps page index to strokes
// in page units. The canvas holds the current page's strokes in screen pixels; captureInk copies
// them back into the tab whenever they change. Ink saves to wherever the tab came from:
//   folder file   path is set, ink goes to .notechalant/ in the folder
//   single file   looseKey is set (Open File or dropped in), ink goes to this browser
//   whiteboard    always open, ink goes to this browser, so the app works with nothing opened

const whiteboard = {
  id: 'whiteboard',
  name: 'Whiteboard',
  path: null,
  looseKey: null,
  doc: createWhiteboard(),
  page: 0,
  ink: loadWhiteboard(),
  dirty: false,
  notes: null,
};
let tabs = [whiteboard];
let activeTab = whiteboard;
let folder = null;
let rememberedFolder = null;
// Starts equal to the canvas, so the empty canvas at startup isn't mistaken for new ink.
let capturedRevision = ink.getRevision();
let lastInkChangeAt = 0;
// Saves run one after another, so a folder switch can't skip a save that's already running.
let saveQueue = Promise.resolve();
let saving = false;
// Paths being opened right now, so a double click doesn't open two tabs.
const opening = new Set();

const saveStateEl = document.getElementById('save-state');

const pageView = createPageView({
  onPrev: function () {
    goToPage(activeTab.page - 1);
  },
  onNext: function () {
    goToPage(activeTab.page + 1);
  },
});

const tabStrip = createTabs({
  onSelect: function (id) {
    activate(tabs.find((tab) => tab.id === id));
  },
  onClose: closeTab,
});

const explorer = createExplorer({
  onOpenFolder: openFolder,
  onReopen: reopenFolder,
  onRefresh: function () {
    if (folder !== null) {
      explorer.showFolder(folder);
    }
  },
  onOpenFile: openFile,
  onPickFiles: function () {
    fileInput.click();
  },
});

const fileInput = document.getElementById('open-file-input');
fileInput.accept = OPENABLE_EXTENSIONS.map((ext) => '.' + ext).join(',');
fileInput.addEventListener('change', function () {
  const files = Array.from(fileInput.files);
  fileInput.value = '';
  openLooseFiles(files);
});

// Each tab's typed notes, in the panel on the right.
const notes = createNotesController({
  getActiveTab: function () {
    return activeTab;
  },
  getFolder: function () {
    return folder;
  },
  isWriting: function () {
    return ink.isWriting();
  },
  lastInkChangeAt: function () {
    return lastInkChangeAt;
  },
  goToPage: goToPage,
  recognize: recognizeImage,
  cleanUp: cleanUp,
  tutor: { review: reviewNote, ask: askTutor },
  // The tutor sees the page only while it's the one on screen, since that's what gets pictured.
  snapshot: function (tab, page) {
    if (tab !== activeTab || tab.page !== page) {
      return Promise.resolve(null);
    }
    captureInk();
    // Cleaned up text goes in as the handwriting it replaced, since the picture draws strokes.
    return snapshotPage(tab.doc, page, pageView.content, handwriting(tab.ink[page] || []));
  },
  idleMs: TRANSCRIBE_IDLE_MS,
  onStatus: function (text, isError) {
    toolbar.setStatus(text, isError);
  },
});

// Corner calibration: point at the page's four corners in turn and tap the pad (or press
// Enter), so the cursor goes exactly where the pen points. K or the sidebar button starts it.
const cornerGuide = document.getElementById('corner-guide');
const cornerTitle = document.getElementById('corner-title');
const cornerText = document.getElementById('corner-text');
const cornerDots = cornerGuide.querySelectorAll('.corner-dot');
const CORNER_NAMES = ['top left', 'top right', 'bottom right', 'bottom left'];
let calibratingCorners = false;

function startCornerCalibration() {
  if (!motion.config.pointerMode) {
    tell('Corner calibration is for pointer mode. Turn it on in the D panel');
    return;
  }
  if (!hub.isReceiving()) {
    tell('Connect the pen first, then calibrate the screen');
    return;
  }
  motion.startScreenCalibration(function (message) {
    calibratingCorners = message.step === 'corner';
    cornerGuide.hidden = !calibratingCorners;
    if (message.step === 'corner') {
      cornerTitle.textContent = 'Point at the ' + CORNER_NAMES[message.index] + ' corner';
      cornerText.textContent = 'Keep your hand in one place and tilt the pen to aim. Then tap the pad, or press Enter. Esc cancels.';
      cornerDots.forEach(function (dot, i) {
        dot.classList.toggle('done', i < message.index);
        dot.classList.toggle('current', i === message.index);
      });
    } else if (message.step === 'done') {
      debug.refreshSettings();
      tell('Screen calibrated. Double tap the pad to recenter if it drifts');
    } else if (message.step === 'failed') {
      toolbar.setStatus(message.reason, true);
    } else {
      tell('Corner calibration cancelled');
    }
  });
}

document.getElementById('calibrate-screen').addEventListener('click', function (event) {
  event.currentTarget.blur();
  startCornerCalibration();
});

document.getElementById('clear-corners').addEventListener('click', function () {
  motion.clearScreenMapping();
  debug.refreshSettings();
  tell('Screen corners cleared. The pointer width and height sliders apply again');
});

// Circle to ask: with Ask on, a loop around part of the page gets it explained in a card, and
// the answer goes in the notes. A tap (a dot) while the card is up closes it instead of drawing.
const circleToAsk = createCircleToAsk(pageView.stage, document.getElementById('page'), {
  onStatus: function (text, isError) {
    toolbar.setStatus(text, isError);
  },
});
let askOn = false;
// The tutor gives hints instead of the whole answer, so with Tutor on, asking goes to it.
let tutorIsOn = false;
// An underline asks about the text above it: this share of the page's height, within limits.
const UNDERLINE_REACH = 0.12;
const UNDERLINE_REACH_MIN = 50;
const UNDERLINE_REACH_MAX = 160;

// Hold to snap: hold the pen still for a moment at the end of a stroke. A rough line, circle, box,
// triangle, or arrow becomes a clean one, and a letter made of straight strokes (an L, a V, a Z)
// gets them straightened. If it's none of those, like a curvy letter, holding means "done": the
// writing is typed up as soon as the pen lifts, without waiting for the pause.
let typeUpOnLift = false;
ink.setHold(function (stroke) {
  const clean = snapHeld(stroke);
  if (clean === null) {
    typeUpOnLift = !askOn;
  }
  return clean;
});

ink.setStrokeListener(function (stroke) {
  if (typeUpOnLift) {
    typeUpOnLift = false;
    setTimeout(transcribeNow, 0);
  }
  const box = strokeBox(stroke.points);
  if (circleToAsk.isOpen() && box.width < 6 && box.height < 6) {
    ink.dropTrailingDots(1);
    circleToAsk.dismiss();
    return;
  }
  if (!askOn) {
    return;
  }
  if (isClosedLoop(stroke.points)) {
    askAbout(box, 'circled');
    return;
  }
  const underline = underlineOf(stroke.points);
  if (underline !== null) {
    const pageHeight = document.getElementById('page').clientHeight;
    const reach = Math.max(UNDERLINE_REACH_MIN, Math.min(UNDERLINE_REACH_MAX, pageHeight * UNDERLINE_REACH));
    askAbout({ minX: underline.x0 - 8, maxX: underline.x1 + 8, minY: underline.y - reach, maxY: underline.y + 8 }, 'underlined');
  }
});

// Tutor on: hints and a conversation in the notes for follow-ups, with no card over the page.
// Tutor off: the full step-by-step explanation in a card, added to the notes as a study sheet entry.
async function askAbout(box, marked) {
  captureInk();
  const tab = activeTab;
  const page = tab.page;
  notes.skipLastStroke(tab, page);
  if (tutorIsOn) {
    tell('Asking the tutor about what you ' + marked + '…');
    try {
      const pictures = await circleToAsk.capture(box);
      const question = 'I ' + marked + ' this. Walk me through how to answer it, starting with a hint rather than the answer.';
      await notes.askAboutPicture(tab, page, question, pictures.image, pictures.thumb);
      tell('The tutor answered in Notes. Ask follow-ups under it');
    } catch (err) {
      toolbar.setStatus(err.message, true);
    }
    return;
  }
  tell('Asking about what you ' + marked + '…');
  const answer = await circleToAsk.ask(box, function (pictures) {
    return explainImage(pictures.image);
  });
  if (answer === null) {
    return;
  }
  tell('Answered. Tap the pad or press Esc to close');
  await notes.addNote(tab, page, '### ' + (answer.about || 'Asked on page ' + (page + 1)) + '\n\n' + answer.text);
}

// Swaps the handwriting that was just read (items start..end-1 of the page) for the typed text,
// placed in the handwriting's box. Only if that page is still on screen and still holds the
// same strokes. If not (the user moved on, or undid them), the text just goes to the notes.
function cleanUp(tab, page, start, end, signature, text) {
  if (tab !== activeTab || tab.page !== page) {
    return false;
  }
  captureInk();
  const pageItems = tab.ink[page] || [];
  if (pageItems.length < end || !sameSignature(strokesSignature(pageItems.slice(start, end)), signature)) {
    return false;
  }
  const item = makeTextItem(text, ink.getStrokes().slice(start, end));
  item.fresh = true;
  ink.replaceWithText(start, end, item);
  captureInk();
  return true;
}

// Undo, and if it brought cleaned up handwriting back, tells the notes so it isn't read again.
function undoInk() {
  const undone = ink.undo();
  if (undone !== null && undone.type === 'cleanup') {
    captureInk();
    notes.onHandwritingRestored(activeTab, activeTab.page, undone.index, undone.restored);
  }
}

function showNotes(isShown) {
  document.body.classList.toggle('notes-hidden', !isShown);
  toolbar.setNotesShown(isShown);
  saveSetting(NOTES_SHOWN_KEY, isShown ? 'on' : 'off');
}

// Ask on: the pen aims like a laser pointer, for circling something from across the room.
// Ask off: writing mode (motion/index.js), where the pen moves the ink like a mouse, smaller and
// steadier.
function setAsk(isOn) {
  askOn = isOn;
  motion.config.writingMode = !isOn;
}

// Clean up: rough lines, circles, and boxes snap to clean ones when the pen lifts, and after a
// pause handwriting is swapped for typed text. Undo brings back what was drawn either way.
function setCleanUp(isOn) {
  ink.setSnap(isOn ? snapStroke : null);
  notes.setAutoCleanUp(isOn);
}

function transcribeNow() {
  captureInk();
  notes.transcribeNow();
}

// Tutor feedback shows in the notes panel, so turning the tutor on opens the panel too.
function setTutor(isOn) {
  tutorIsOn = isOn;
  notes.setTutor(isOn);
  toolbar.setTutorOn(isOn);
  saveSetting(TUTOR_KEY, isOn ? 'on' : 'off');
  if (isOn) {
    showNotes(true);
  }
}

// Copies the canvas strokes into the active tab if they changed since last time.
function captureInk() {
  const revision = ink.getRevision();
  if (revision === capturedRevision) {
    return;
  }
  capturedRevision = revision;
  activeTab.ink[activeTab.page] = scaleStrokes(ink.getStrokes(), 1 / pageView.getScale());
  activeTab.dirty = true;
  lastInkChangeAt = performance.now();
}

// Draws the active tab's current page and puts its ink on the canvas.
function showPage() {
  // An answer belongs to the page it was asked on.
  circleToAsk.dismiss();
  // Notebook lines on the whiteboard only. Real documents stay plain white. Set here rather than
  // in activate() so closing a tab that falls back to the whiteboard gets its lines too.
  document.getElementById('page').classList.toggle('whiteboard', activeTab === whiteboard);
  const scale = pageView.show(activeTab.doc, activeTab.page);
  placeInk(scale);
}

function placeInk(scale) {
  ink.resize();
  ink.setStrokes(scaleStrokes(activeTab.ink[activeTab.page] || [], scale));
  capturedRevision = ink.getRevision();
}

function activate(tab) {
  captureInk();
  activeTab = tab;
  renderTabs();
  explorer.setActive(tab.path);
  showPage();
  notes.show(tab);
}

function goToPage(index) {
  if (index < 0 || index >= activeTab.doc.pageCount || index === activeTab.page) {
    return;
  }
  captureInk();
  activeTab.page = index;
  showPage();
  notes.show(activeTab);
}

function renderTabs() {
  tabStrip.render(
    tabs.map(function (tab) {
      return { id: tab.id, name: tab.name, title: tabTitle(tab), closable: tab !== whiteboard };
    }),
    activeTab.id,
  );
}

function tabTitle(tab) {
  if (tab.path) return tab.path;
  if (tab.looseKey) return tab.name + ' (not in a folder, ink saved in this browser)';
  return 'Whiteboard, saved in this browser';
}

function addTab(tab) {
  tab.notes = null;
  notes.attach(tab);
  tabs.splice(tabs.indexOf(activeTab) + 1, 0, tab);
  activate(tab);
  const doc = tab.doc;
  toolbar.setStatus(doc.pageCount > 1 ? 'Opened ' + doc.name + '. Page Up and Page Down change pages' : 'Opened ' + doc.name);
}

// Files opened on their own: from Open File, or dropped onto the page.
async function openLooseFiles(files) {
  for (const file of files) {
    await openLooseFile(file);
  }
}

async function openLooseFile(file) {
  const key = looseInkKey(file);
  const id = 'loose:' + key;
  const existing = tabs.find((tab) => tab.id === id);
  if (existing) {
    activate(existing);
    return;
  }
  if (opening.has(id)) {
    return;
  }
  opening.add(id);
  toolbar.setStatus('Opening ' + file.name + '…');
  try {
    const doc = await openDocument(file, null);
    const savedInk = await loadLooseInk(key);
    addTab({ id: id, name: doc.name, path: null, looseKey: key, doc: doc, page: 0, ink: savedInk, dirty: false });
  } catch (err) {
    toolbar.setStatus("Couldn't open " + file.name + ': ' + err.message, true);
  } finally {
    opening.delete(id);
  }
}

async function openFile(handle, path) {
  const existing = tabs.find((tab) => tab.path === path);
  if (existing) {
    activate(existing);
    return;
  }
  if (opening.has(path)) {
    return;
  }
  opening.add(path);
  const openedFrom = folder;
  toolbar.setStatus('Opening ' + path + '…');
  try {
    const doc = await openDocument(await handle.getFile(), path);
    const savedInk = await openedFrom.loadInk(path);
    if (folder !== openedFrom) {
      doc.dispose();
      return;
    }
    addTab({ id: 'file:' + path, name: doc.name, path: path, looseKey: null, doc: doc, page: 0, ink: savedInk, dirty: false });
  } catch (err) {
    toolbar.setStatus("Couldn't open " + path + ': ' + err.message, true);
  } finally {
    opening.delete(path);
  }
}

async function closeTab(id) {
  const tab = tabs.find((t) => t.id === id);
  if (!tab || tab === whiteboard) {
    return;
  }
  if (tab === activeTab) {
    captureInk();
  }
  if (tab.dirty) {
    await saveTab(tab);
  }
  const index = tabs.indexOf(tab);
  tabs.splice(index, 1);
  tab.doc.dispose();
  if (tab === activeTab) {
    activeTab = tabs[Math.min(index, tabs.length - 1)];
    explorer.setActive(activeTab.path);
    showPage();
    notes.show(activeTab);
  }
  renderTabs();
}

async function openFolder() {
  try {
    await useFolder(await pickFolder());
  } catch (err) {
    if (err.name !== 'AbortError') {
      toolbar.setStatus("Couldn't open the folder: " + err.message, true);
    }
  }
}

async function reopenFolder() {
  if (rememberedFolder === null) {
    return;
  }
  try {
    await useFolder(await rememberedFolder.open());
  } catch (err) {
    toolbar.setStatus(err.message, true);
  }
}

// Switching folders saves and closes the old folder's tabs. The whiteboard and single files stay.
async function useFolder(newFolder) {
  captureInk();
  await saveDirty();
  const stayOpen = tabs.filter((tab) => tab.path === null);
  for (const tab of tabs) {
    if (!stayOpen.includes(tab)) {
      tab.doc.dispose();
    }
  }
  tabs = stayOpen;
  folder = newFolder;
  await explorer.showFolder(folder);
  activate(stayOpen.includes(activeTab) ? activeTab : whiteboard);
  toolbar.setStatus('Opened ' + folder.name + '. Pick a file to write on');
}

async function saveTab(tab) {
  tab.dirty = false;
  try {
    if (tab === whiteboard) {
      localStorage.setItem(WHITEBOARD_KEY, JSON.stringify(packInk(null, tab.ink)));
      showSaveState('Saved in browser', false);
    } else if (tab.looseKey) {
      await saveLooseInk(tab.looseKey, tab.name, tab.ink);
      showSaveState('Saved in browser', false);
    } else {
      showSaveState('Saving…', false);
      await folder.saveInk(tab.path, tab.ink);
      showSaveState('Saved', false);
    }
  } catch (err) {
    // Not retried until the ink changes again, so a read-only folder doesn't spam errors.
    showSaveState('Not saved', true);
    toolbar.setStatus("Couldn't save ink for " + (tab.path || tab.name) + ': ' + err.message, true);
  }
}

// Writes a new file with the active tab's ink drawn on it. A folder file's copy goes next to it
// in the folder. A single file or the whiteboard asks where to save, since there's no folder.
// The original is never written to.
let savingCopy = false;

async function saveCopy() {
  if (savingCopy) {
    return;
  }
  captureInk();
  const tab = activeTab;
  const tabFolder = folder;
  if (tab.doc.pageCount === 0) {
    toolbar.setStatus("This file can't be shown, so there's nothing to save", true);
    return;
  }
  if (!Object.values(tab.ink).some((strokes) => strokes.length > 0)) {
    toolbar.setStatus('Write something first');
    return;
  }
  savingCopy = true;
  toolbar.setSavingCopy(true);
  toolbar.setStatus('Saving a copy of ' + tab.name + '…');
  try {
    // Copies draw ink as vector strokes, so cleaned up text goes in as its original handwriting.
    const copy = await buildCopy(tab.doc, handwritingPages(tab.ink), function (done, total) {
      if (total > 1) {
        toolbar.setStatus('Saving a copy of ' + tab.name + ': page ' + done + ' of ' + total + '…');
      }
    });
    if (tab.path !== null) {
      // The folder the file came from, even if another one was opened while the copy was made.
      const savedPath = await tabFolder.saveCopy(tab.path, copy.blob, copy.extension);
      toolbar.setStatus('Saved ' + savedPath + ' in ' + tabFolder.name + '. The original is unchanged');
      if (folder === tabFolder) {
        await explorer.showFolder(folder);
        explorer.setActive(activeTab.path);
      }
    } else {
      const originalName = tab.doc.file ? tab.doc.file.name : null;
      const savedName = await saveCopyAs(copyName(tab.name, copy.extension, () => false), copy.blob, copy.extension, originalName);
      toolbar.setStatus(savedName === null ? 'Copy not saved' : 'Saved ' + savedName + '. The original is unchanged');
    }
  } catch (err) {
    toolbar.setStatus("Couldn't save a copy of " + tab.name + ': ' + err.message, true);
  } finally {
    savingCopy = false;
    toolbar.setSavingCopy(false);
    // A presentation shows one slide at a time, and saving drew every slide, so put the shown one back.
    if (tab === activeTab && tab.doc.kind === 'pptx') {
      captureInk();
      showPage();
    }
  }
}

function saveDirty() {
  saving = true;
  saveQueue = saveQueue.then(async function () {
    for (const tab of tabs.slice()) {
      if (tab.dirty) {
        await saveTab(tab);
      }
    }
    saving = false;
  });
  return saveQueue;
}

function showSaveState(text, isError) {
  saveStateEl.textContent = text;
  saveStateEl.classList.toggle('error', isError);
}

function loadWhiteboard() {
  try {
    return unpackInk(JSON.parse(localStorage.getItem(WHITEBOARD_KEY)));
  } catch (err) {
    return {};
  }
}

// Drag and drop: a file opens on its own, a folder opens in the explorer.
const dropOverlay = document.getElementById('drop-overlay');
let dragDepth = 0;

function draggingFiles(event) {
  return event.dataTransfer && Array.from(event.dataTransfer.types).includes('Files');
}

window.addEventListener('dragenter', function (event) {
  if (draggingFiles(event)) {
    dragDepth++;
    dropOverlay.hidden = false;
  }
});

window.addEventListener('dragleave', function (event) {
  if (draggingFiles(event) && --dragDepth <= 0) {
    dragDepth = 0;
    dropOverlay.hidden = true;
  }
});

window.addEventListener('dragover', function (event) {
  if (draggingFiles(event)) {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
  }
});

window.addEventListener('drop', function (event) {
  if (!draggingFiles(event)) {
    return;
  }
  event.preventDefault();
  dragDepth = 0;
  dropOverlay.hidden = true;
  // The dropped items stop being readable once this handler returns, so grab them all now.
  const entries = Array.from(event.dataTransfer.items)
    .filter((item) => item.kind === 'file')
    .map(function (item) {
      return {
        file: item.getAsFile(),
        handle: typeof item.getAsFileSystemHandle === 'function' ? item.getAsFileSystemHandle() : null,
      };
    });
  openDropped(entries);
});

async function openDropped(entries) {
  const files = [];
  for (const entry of entries) {
    const handle = entry.handle ? await entry.handle.catch(() => null) : null;
    if (handle && handle.kind === 'directory') {
      try {
        await useFolder(await folderFromHandle(handle));
      } catch (err) {
        toolbar.setStatus(err.message, true);
      }
    } else if (entry.file) {
      files.push(entry.file);
    }
  }
  await openLooseFiles(files);
}

// Keep the page fitted when the window or sidebar changes size.
new ResizeObserver(function () {
  captureInk();
  placeInk(pageView.layout());
}).observe(pageView.stage);

setInterval(function () {
  captureInk();
  notes.tick();
  if (!saving && !ink.isWriting() && performance.now() - lastInkChangeAt > SAVE_DELAY_MS && tabs.some((tab) => tab.dirty)) {
    saveDirty();
  }
}, TICK_MS);

// Closing the page with unsaved ink asks first. Saves are under a second behind, so this is rare.
window.addEventListener('beforeunload', function (event) {
  captureInk();
  if (tabs.some((tab) => tab.dirty)) {
    saveDirty();
    event.preventDefault();
  }
});

// Only one hardware source runs at a time. `active` holds its name and how to stop it.
let active = null;

async function stopActive() {
  if (active === null) {
    return;
  }
  const previous = active;
  active = null;
  toolbar.setActiveSource(null);
  liftPen();
  await previous.stop();
}

// Ends any stroke a source left open when it stopped mid-write.
function liftPen() {
  ink.moveBy(0, 0, false);
}

function startSource(name, stop) {
  active = { name: name, stop: stop };
  toolbar.setActiveSource(name);
  hub.recalibrate();
}

// Called when a source stops on its own (cable pulled, replay done). If the user already
// switched to another source, the old one's message is dropped so it can't overwrite the new status.
function sourceEnded(name, message) {
  if (active === null || active.name !== name) {
    return;
  }
  active = null;
  toolbar.setActiveSource(null);
  liftPen();
  toolbar.setStatus(message);
}

const toolbar = createToolbar({
  onColor: function (color) {
    ink.setColor(color);
    // Picking a color means writing again.
    setEraser(false);
  },

  onEraser: function () {
    setEraser(!ink.isErasing());
  },

  onSize: function (width) {
    ink.setWidth(width);
  },

  // The remote runs alongside whichever pen source is on, so it isn't part of `active`.
  onRemote: async function () {
    if (remote !== null) {
      const previous = remote;
      remote = null;
      toolbar.setRemoteOn(false);
      await previous.disconnect();
      toolbar.setStatus('Remote disconnected');
      return;
    }
    try {
      const connection = await connectRemote(onRemoteButton, function () {
        if (remote === connection) {
          remote = null;
          toolbar.setRemoteOn(false);
          toolbar.setStatus('Remote disconnected');
        }
      }, onRemoteOther);
      remote = connection;
      toolbar.setRemoteOn(true);
      toolbar.setStatus('Remote connected. Press a button on it');
    } catch (err) {
      // Closing the port picker without choosing also lands here.
      const busy = err.name === 'NetworkError' || err.name === 'InvalidStateError';
      toolbar.setStatus(busy ? "Couldn't open the remote's port. Close the Arduino Serial Monitor and try again" : err.message, true);
    }
  },

  onUndo: undoInk,

  onClear: function () {
    ink.clear();
  },

  onSaveCopy: saveCopy,

  onAskChange: function (isOn) {
    setAsk(isOn);
    saveSetting(ASK_KEY, isOn ? 'on' : 'off');
    if (!isOn) {
      circleToAsk.dismiss();
    }
    toolbar.setStatus(isOn ? 'Ask on: point at something and circle or underline it' : 'Ask off: circles are just ink');
  },

  onAutoCleanUpChange: function (isOn) {
    setCleanUp(isOn);
    saveSetting(AUTO_CLEANUP_KEY, isOn ? 'on' : 'off');
    toolbar.setStatus(isOn ? 'Clean up on: shapes snap clean, and handwriting turns into typed text after a pause' : 'Clean up off: everything stays as drawn');
  },

  onAutoChange: function (isOn) {
    notes.setAuto(isOn);
    saveSetting(AUTO_KEY, isOn ? 'on' : 'off');
    toolbar.setStatus(isOn ? 'Auto on: writing is typed up when you pause' : 'Auto off: press Enter to type up your writing');
  },

  onToggleNotes: function () {
    showNotes(document.body.classList.contains('notes-hidden'));
  },

  onToggleTutor: function () {
    const isOn = toolbar.buttons.tutor.getAttribute('aria-pressed') !== 'true';
    setTutor(isOn);
    toolbar.setStatus(isOn ? 'Tutor on. New writing gets checked, and you can ask about any note' : 'Tutor off');
  },

  // The relay keeps reconnecting on its own, so it only ends when the button is clicked again.
  onRelay: async function () {
    if (active !== null && active.name === 'relay') {
      await stopActive();
      toolbar.setStatus('Relay off');
      return;
    }
    await stopActive();
    toolbar.setStatus('Waiting for relay at ' + RELAY_URL);
    let penOnline = false;
    const connection = connectRelay(RELAY_URL, hub.onPenData, function (status) {
      toolbar.setRelayStatus(status);
      const nowOnline = status.relay && status.pens > 0;
      if (nowOnline && !penOnline) {
        hub.recalibrate();
        toolbar.setStatus('Pen connected. Hold still to calibrate');
      } else if (!nowOnline && penOnline) {
        liftPen();
        toolbar.setStatus(status.relay ? 'Pen disconnected' : 'Relay lost. Retrying');
      }
      penOnline = nowOnline;
    });
    startSource('relay', connection.disconnect);
  },

  // Like the relay, Bluetooth keeps reconnecting to the same pen until the button is clicked again.
  onBluetooth: async function () {
    if (active !== null && active.name === 'bluetooth') {
      await stopActive();
      toolbar.setStatus('Bluetooth off');
      return;
    }
    if (!bluetoothSupported()) {
      toolbar.setStatus('Bluetooth needs Chrome or Edge', true);
      return;
    }
    // The chooser has to open straight from the click, so pick the pen before stopping anything.
    let device;
    try {
      device = await requestPen();
    } catch (err) {
      // Closing the chooser without picking also lands here.
      toolbar.setStatus(err.message, true);
      return;
    }
    await stopActive();
    toolbar.setStatus('Connecting to ' + (device.name || 'pen'));
    let penOnline = false;
    const connection = connectBluetooth(device, hub.onPenData, function (status) {
      if (status.connected && !penOnline) {
        hub.recalibrate();
        toolbar.setStatus('Pen connected. Hold still to calibrate');
      } else if (!status.connected && penOnline) {
        liftPen();
        toolbar.setStatus('Pen disconnected. Reconnecting');
      }
      penOnline = status.connected;
    });
    startSource('bluetooth', connection.disconnect);
  },

  onSerial: async function () {
    if (active !== null && active.name === 'serial') {
      await stopActive();
      toolbar.setStatus('USB disconnected');
      return;
    }
    if (!serialSupported()) {
      toolbar.setStatus('USB needs Chrome or Edge', true);
      return;
    }
    await stopActive();
    try {
      const connection = await connectSerial(hub.onPenData, function () {
        sourceEnded('serial', 'USB disconnected');
      });
      startSource('serial', connection.disconnect);
      toolbar.setStatus('USB connected. Hold still to calibrate');
    } catch (err) {
      // Closing the port picker without choosing also lands here.
      toolbar.setStatus(err.message, true);
    }
  },

  onWifi: async function () {
    if (active !== null && active.name === 'wifi') {
      await stopActive();
      toolbar.setStatus('WiFi disconnected');
      return;
    }
    const url = window.prompt('Pen WebSocket address', loadWsUrl());
    if (!url) {
      return;
    }
    saveWsUrl(url);
    await stopActive();
    toolbar.setStatus('Connecting to ' + url);
    let opened = false;
    const connection = connectWebSocket(
      url,
      hub.onPenData,
      function () {
        opened = true;
        toolbar.setStatus('WiFi connected. Hold still to calibrate');
      },
      function () {
        sourceEnded('wifi', opened ? 'WiFi disconnected' : 'Could not reach ' + url);
      },
    );
    startSource('wifi', connection.disconnect);
  },

  isReplaying: function () {
    return active !== null && active.name === 'recording';
  },

  onStopReplay: async function () {
    await stopActive();
    toolbar.setStatus('Replay stopped');
  },

  onRecordingFile: async function (file) {
    const samples = parseRecording(await file.text());
    if (samples.length === 0) {
      toolbar.setStatus('No valid samples in ' + file.name, true);
      return;
    }
    await stopActive();
    const seconds = ((samples[samples.length - 1].t - samples[0].t) / 1000).toFixed(1);
    toolbar.setStatus('Replaying ' + file.name + ' (' + samples.length + ' samples, ' + seconds + 's)');
    const playback = playRecording(samples, hub.onPenData, function () {
      sourceEnded('recording', 'Replay finished');
    });
    startSource('recording', playback.stop);
  },
});

function loadWsUrl() {
  return loadSetting(WS_URL_KEY) || DEFAULT_WS_URL;
}

function saveWsUrl(url) {
  saveSetting(WS_URL_KEY, url);
}

function loadSetting(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    return null;
  }
}

function saveSetting(key, value) {
  try {
    localStorage.setItem(key, value);
  } catch (err) {
    // Storage can be blocked. Not worth failing over.
  }
}

// ---- IR remote and present mode ----
//
// Present mode hides everything but the page, so the screen is just the writing. The remote's
// buttons are listed in firmware/remote/README.md. VOL+ and VOL- move through the explorer,
// which is hidden while presenting, so they only work outside present mode.

let remote = null;
let presenting = false;
const toastEl = document.getElementById('toast');
let toastTimer = null;

function setPresenting(isOn) {
  presenting = isOn;
  document.body.classList.toggle('presenting', isOn);
  if (!isOn) {
    clearTimeout(toastTimer);
    toastEl.classList.remove('shown');
  }
  // A file picked in the explorer may still be opening, so the message doesn't name it.
  tell(isOn ? 'Presenting. Press >|| or Esc to leave' : 'Left present mode');
}

// Status line, plus a toast while presenting, since the toolbar is hidden then.
function tell(text) {
  toolbar.setStatus(text);
  if (!presenting) {
    return;
  }
  toastEl.textContent = text;
  toastEl.classList.add('shown');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toastEl.classList.remove('shown');
  }, 1600);
}

// Moves to the tab before (-1) or after (+1) the active one, wrapping around the ends.
function switchTab(delta) {
  const index = tabs.indexOf(activeTab);
  const next = tabs[(index + delta + tabs.length) % tabs.length];
  if (next !== activeTab) {
    activate(next);
  }
  return next;
}

// Anything the UNO prints that isn't a known press: its boot line, or a button the sketch
// doesn't map yet ("OTHER" with its code). Shown so you can see the remote is getting through.
function onRemoteOther(line) {
  console.log('[remote]', line);
  tell('Remote sent: ' + line.slice(0, 80));
}

function onRemoteButton(button) {
  console.log('[remote]', button);
  switch (button) {
    case 'COLOR':
      tell('Color: ' + toolbar.nextColor());
      break;
    case 'SIZE':
      tell('Size: ' + toolbar.nextSize());
      break;
    case 'PREV_PAGE':
    case 'NEXT_PAGE':
      goToPage(activeTab.page + (button === 'NEXT_PAGE' ? 1 : -1));
      if (activeTab.doc.pageCount > 0) {
        tell('Page ' + (activeTab.page + 1) + ' of ' + activeTab.doc.pageCount);
      }
      break;
    case 'PREV_TAB':
    case 'NEXT_TAB':
      tell(tabs.length > 1 ? switchTab(button === 'NEXT_TAB' ? 1 : -1).name : 'Only one tab open');
      break;
    case 'RECENTER':
      hub.recenter();
      tell('Cursor recentered');
      break;
    case 'CLEAR':
      ink.clear();
      tell('Page cleared. Ctrl+Z brings it back');
      break;
    case 'PRESENT':
      onPresentButton();
      break;
    case 'EXPLORER_UP':
    case 'EXPLORER_DOWN':
      onExplorerButton(button === 'EXPLORER_DOWN' ? 1 : -1);
      break;
    case 'CLEANUP':
      toolbar.toggleAutoCleanUp();
      break;
    case 'ASK':
      toolbar.toggleAsk();
      break;
    case 'AUTO':
      toolbar.toggleAuto();
      break;
    case 'TUTOR':
      setTutor(!tutorIsOn);
      tell(tutorIsOn ? 'Tutor on. New writing gets checked' : 'Tutor off');
      break;
    case 'TUTOR_OPTION_1':
    case 'TUTOR_OPTION_2':
      pickTutorOption(button === 'TUTOR_OPTION_1' ? 0 : 1);
      break;
    case 'CALIBRATE':
      // While calibrating, 6 marks the corner the pen points at, like tapping the pad.
      if (calibratingCorners) {
        motion.captureCorner();
      } else {
        startCornerCalibration();
      }
      break;
  }
}

// 4 and 5 answer the newest tutor question with its first or second quick answer.
function pickTutorOption(index) {
  const groups = document.querySelectorAll('.tutor-options');
  const chips = groups.length > 0 ? groups[groups.length - 1].querySelectorAll('.tutor-option') : [];
  if (index >= chips.length) {
    tell(chips.length === 0 ? 'No tutor question to answer' : 'The tutor only gave one option');
    return;
  }
  tell('Answered: ' + chips[index].textContent);
  chips[index].click();
}

// >|| leaves present mode, or enters it. Outside present mode, a highlighted file in the explorer
// opens first and is what gets presented. A highlighted folder opens or closes instead.
function onPresentButton() {
  if (presenting) {
    setPresenting(false);
    return;
  }
  const opened = explorer.openCursor();
  if (opened === 'opened' || opened === 'closed') {
    tell('Folder ' + opened + '. VOL+ and VOL- to pick a file');
    return;
  }
  setPresenting(true);
}

function onExplorerButton(delta) {
  if (presenting) {
    tell('Press >|| to leave present mode first');
    return;
  }
  const name = explorer.moveCursor(delta);
  tell(name === null ? 'Open a folder to move through its files' : name + '. Press >|| to open');
}

// Keyboard shortcuts.
// Space  hold for pen down (stands in for the button)
function setEraser(isOn) {
  if (ink.isErasing() === isOn) {
    return;
  }
  ink.setErasing(isOn);
  toolbar.setEraser(isOn);
  toolbar.setStatus(isOn ? 'Eraser on. Drag over strokes to remove them' : 'Pen on');
}

// Page Up / Page Down  previous or next page
// Ctrl/Cmd+Z  undo
// Ctrl/Cmd+S  save a copy with the ink on it
// C  recenter cursor
// E  eraser on or off
// R  recalibrate motion
// D or T  show or hide the motion debug panel (live graphs, axis wizard, recording, tuning)
// P  enter or leave present mode, Esc leaves it
// K  calibrate the screen: point at each corner and tap the pad or press Enter
// Enter  transcribe new writing on this page now
// None of them fire while typing in a text field, like the note editor.
window.addEventListener('keydown', function (event) {
  if (event.target instanceof Element && event.target.closest('input, textarea, [contenteditable]')) {
    return;
  }
  if (event.key === 'PageDown' || event.key === 'PageUp') {
    event.preventDefault();
    goToPage(activeTab.page + (event.key === 'PageDown' ? 1 : -1));
  } else if (event.code === 'Space') {
    event.preventDefault();
    hub.setSpacebar(true);
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undoInk();
  } else if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    saveCopy();
  } else if ((event.key === 'e' || event.key === 'E') && !event.ctrlKey && !event.metaKey) {
    setEraser(!ink.isErasing());
  } else if (event.key === 'c' || event.key === 'C') {
    hub.recenter();
  } else if (event.key === 'r' || event.key === 'R') {
    hub.recalibrate();
    toolbar.setStatus('Recalibrating. Hold still');
  } else if (/^[dDtT]$/.test(event.key) && !event.ctrlKey && !event.metaKey) {
    debug.toggle();
  } else if (event.key === 'p' || event.key === 'P') {
    setPresenting(!presenting);
  } else if (event.key === 'Escape' && calibratingCorners) {
    motion.cancelScreenCalibration();
  } else if (event.key === 'Escape' && circleToAsk.isOpen()) {
    circleToAsk.dismiss();
  } else if (event.key === 'Escape' && presenting) {
    setPresenting(false);
  } else if (event.key === 'Enter' && calibratingCorners) {
    event.preventDefault();
    motion.captureCorner();
  } else if ((event.key === 'k' || event.key === 'K') && !event.ctrlKey && !event.metaKey) {
    startCornerCalibration();
  } else if (event.key === 'Enter' && !(event.target instanceof HTMLButtonElement)) {
    event.preventDefault();
    transcribeNow();
  }
});

window.addEventListener('keyup', function (event) {
  if (event.code === 'Space') {
    // Stops Space from also clicking whichever toolbar button has focus.
    event.preventDefault();
    hub.setSpacebar(false);
  }
});

// Losing focus while holding Space would otherwise leave the pen stuck down.
window.addEventListener('blur', function () {
  hub.setSpacebar(false);
});

// Setup links: opening the app with ?setup=<name> switches the toolbar and motion settings to a
// preset, then drops the parameter so a reload doesn't do it again. Corner calibration and the
// pen direction are kept. For handing someone exact settings to test or record with.
const SETUPS = {
  // Writing test: Write and Snap on, nothing else changing the page, a little smaller ink.
  'writing-test': {
    toggles: { [AUTO_CLEANUP_KEY]: 'off', [ASK_KEY]: 'off', [TUTOR_KEY]: 'off' },
    motion: { pointerMode: true, writingGain: 0.45, writingString: 4, writingCurve: 0 },
  },
};
const setupName = new URLSearchParams(location.search).get('setup');
if (setupName !== null) {
  const setup = SETUPS[setupName];
  if (setup !== undefined) {
    for (const [key, value] of Object.entries(setup.toggles)) {
      saveSetting(key, value);
    }
    Object.assign(motion.config, setup.motion);
    debug.refreshSettings();
  }
  history.replaceState(null, '', location.pathname);
  setTimeout(function () {
    toolbar.setStatus(setup !== undefined ? 'Set up for ' + setupName : 'No setup called ' + setupName, setup === undefined);
  }, 0);
}

notes.attach(whiteboard);
activate(whiteboard);
// Each stroke is smoothed when the pen lifts. The input hub keeps the lazy brush's string length
// in step with the D panel's slider.
ink.setSmoother(smoothStroke);
const autoOn = loadSetting(AUTO_KEY) !== 'off';
toolbar.setAuto(autoOn);
notes.setAuto(autoOn);
setAsk(loadSetting(ASK_KEY) === 'on');
toolbar.setAsk(askOn);
const autoCleanUpOn = loadSetting(AUTO_CLEANUP_KEY) === 'on';
toolbar.setAutoCleanUp(autoCleanUpOn);
setCleanUp(autoCleanUpOn);
showNotes(loadSetting(NOTES_SHOWN_KEY) !== 'off');
if (loadSetting(TUTOR_KEY) === 'on') {
  setTutor(true);
}
ink.centerCursor();
ink.hideCursor();

// Offer the folder from last time. If the browser still allows access, open it straight away.
explorer.showEmpty(null, foldersSupported());
if (foldersSupported()) {
  lastFolder().then(function (remembered) {
    rememberedFolder = remembered;
    if (remembered !== null && remembered.granted) {
      reopenFolder();
    } else if (folder === null) {
      explorer.showEmpty(remembered, true);
    }
  });
}
