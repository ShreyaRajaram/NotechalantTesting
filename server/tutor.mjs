// The tutor, shared by the local server (index.mjs) and the Vercel function (api/tutor.mjs).
// Takes the parsed request body, returns { status, body } to send back.
//
// Two kinds of request:
//   review   { text, context, sketch?, page? }          a new note was just written. Answers
//                                                      { review }: corrections, an explanation, a
//                                                      question about what help is wanted, a
//                                                      confirmation, or nothing to say.
//   reply    { text, context, thread, sketch?, page? } the student answered or asked something
//                                                      about a note or the page. Answers { reply }
//                                                      as note-style Markdown.
//
// sketch is a PNG of the student's handwriting or drawing. page is what they're reading:
// { image (JPEG or PNG of the page with their ink on it), text, name, number, pageCount }.

import { generate, hasConfig, MISSING_CONFIG } from './gemini.mjs';
import { observeWorkflow } from './llm-observability.mjs';

const MAX_TEXT_CHARS = 4000;
const MAX_CONTEXT_CHARS = 1500;
const MAX_THREAD_MESSAGES = 12;
const MAX_MESSAGE_CHARS = 2000;
const MAX_PAGE_TEXT_CHARS = 6000;
// Base64 lengths. Vercel takes request bodies up to 4.5 MB, and the app sends far less.
const MAX_SKETCH_CHARS = 1500000;
const MAX_PAGE_IMAGE_CHARS = 2500000;
// Checking work step by step, with pictures, takes longer than reading handwriting.
const TIMEOUT_MS = 20000;

const PERSONA = [
  'You are a friendly, encouraging tutor looking over a student\'s shoulder while they study.',
  'They write by hand in the air with a motion-tracking pen and the writing is transcribed automatically,',
  'so a single odd letter or a missing space is probably a transcription slip, not their mistake. Ignore those.',
  'You may also get a picture of their handwriting or drawing, and a picture of the document page they are reading with their ink drawn on top.',
  'Circles, underlines, brackets, arrows, and question marks on the page point at the part they mean.',
  'Write math as LaTeX inside $...$.',
].join(' ');

const REVIEW_PROMPT = [
  PERSONA,
  'Look at what the student just wrote or drew and decide how to help.',
  'Check grammar and spelling in sentences. Check math work step by step (arithmetic, algebra, calculus, units) and point out the first step that is wrong, with the corrected step. Check facts that are stated as true.',
  'Check drawings and diagrams the same way: graphs (shape, axes, intercepts), free-body diagrams (missing or wrong forces), circuits, chemical structures, geometry, flowcharts, and labeled sketches.',
  'Do not finish problems the student has not finished, and do not rewrite their style.',
  'Pick one verdict:',
  '"issues" if anything is wrong. List each problem in issues. For text, wrong is copied exactly from their writing and fix is the corrected text. For a drawing, wrong describes the mistake briefly and fix says what it should be. why is one short sentence.',
  '"explain" if they asked a question about the page or marked part of it as confusing (a question mark, "?", "what does this mean", "huh", a circled term). Explain that part of the page simply and clearly in message, in up to 100 words, using the page picture and text.',
  '"question" if nothing is wrong but the writing is an unsolved problem or unfinished work where help would be useful. Ask briefly what they want help with, and give two or three short options (under 6 words each), like "Check my steps" or "Give me a hint".',
  '"correct" if it is math work, a diagram, or a factual claim and it is right. Say so in a few words.',
  '"none" for ordinary notes, headings, or lists with nothing worth saying.',
  'Except for "explain", message is one or two short sentences, spoken to the student.',
].join(' ');

const REPLY_PROMPT = [
  PERSONA,
  'Answer the student\'s latest message about their note or the page they are reading.',
  'For their own work, guide them toward the answer with hints and questions unless they clearly ask for the answer. For questions about the reading, explain clearly.',
  'Keep it under 150 words. Use Markdown only for lists (- or 1.). No headings, no bold, no code fences.',
].join(' ');

const REVIEW_SCHEMA = {
  type: 'OBJECT',
  properties: {
    verdict: { type: 'STRING', enum: ['issues', 'explain', 'question', 'correct', 'none'] },
    message: { type: 'STRING' },
    issues: {
      type: 'ARRAY',
      items: {
        type: 'OBJECT',
        properties: {
          kind: { type: 'STRING', enum: ['grammar', 'spelling', 'math', 'fact', 'other'] },
          wrong: { type: 'STRING' },
          fix: { type: 'STRING' },
          why: { type: 'STRING' },
        },
        required: ['kind', 'wrong', 'fix', 'why'],
      },
    },
    options: { type: 'ARRAY', items: { type: 'STRING' } },
  },
  required: ['verdict', 'message'],
};

export async function tutor(body, env) {
  if (!hasConfig(env)) {
    return { status: 500, body: { error: MISSING_CONFIG } };
  }
  if (!body || typeof body !== 'object') {
    return { status: 400, body: { error: 'Expected JSON with a text field holding the note' } };
  }
  const text = typeof body.text === 'string' ? body.text.slice(0, MAX_TEXT_CHARS).trim() : '';
  const sketch = dataUrl(body.sketch, ['image/png'], MAX_SKETCH_CHARS);
  // A drawing with no words in it is still something to look at.
  if (text === '' && sketch === null) {
    return { status: 400, body: { error: 'Expected JSON with a text field holding the note' } };
  }
  const context = typeof body.context === 'string' ? body.context.slice(-MAX_CONTEXT_CHARS).trim() : '';
  const thread = cleanThread(body.thread);
  const page = cleanPage(body.page);

  return observeWorkflow(thread.length === 0 ? 'tutor.review' : 'tutor.reply', env, async () => {
    try {
      if (thread.length === 0) {
        return { status: 200, body: { review: await review(text, context, sketch, page, env) } };
      }
      return { status: 200, body: { reply: await reply(text, context, thread, sketch, page, env) } };
    } catch (err) {
      console.error(err);
      return { status: 502, body: { error: err.message } };
    }
  });
}

async function review(text, context, sketch, page, env) {
  const writing = text ? 'NEW writing, as transcribed:\n"""\n' + text + '\n"""' : 'They drew something with no words in it. Look at the picture of it.';
  const parts = [{ text: REVIEW_PROMPT + contextSection(context) + '\n\n' + writing }, ...pictureParts(sketch, page)];
  const answer = await generate(parts, env, {
    operation: 'tutor.review',
    timeoutMs: TIMEOUT_MS,
    generationConfig: { responseMimeType: 'application/json', responseSchema: REVIEW_SCHEMA },
  });
  try {
    return JSON.parse(answer);
  } catch (err) {
    // The app checks every field anyway, so an unreadable answer just means nothing to show.
    return { verdict: 'none', message: '' };
  }
}

async function reply(text, context, thread, sketch, page, env) {
  const conversation = thread
    .map(function (message) {
      return (message.role === 'tutor' ? 'Tutor: ' : 'Student: ') + message.text;
    })
    .join('\n');
  const note = text ? '\n\nThe note:\n"""\n' + text + '\n"""' : '\n\nThe note is a drawing (pictured below).';
  const prompt = REPLY_PROMPT + contextSection(context) + note + '\n\nConversation so far:\n' + conversation;
  // The pictures go before the cue for the answer, so the tutor reads them first.
  return generate([{ text: prompt }, ...pictureParts(sketch, page), { text: 'Tutor:' }], env, { operation: 'tutor.reply', timeoutMs: TIMEOUT_MS });
}

// The student's drawing and the page they're reading, as Gemini parts with a caption each.
function pictureParts(sketch, page) {
  const parts = [];
  if (sketch) {
    parts.push({ text: "The student's handwriting or drawing:" }, inline(sketch));
  }
  if (page) {
    const where = 'page ' + page.number + (page.pageCount ? ' of ' + page.pageCount : '') + (page.name ? ' of "' + page.name + '"' : '');
    if (page.image) {
      parts.push({ text: 'The document they are reading, ' + where + ', with their ink drawn on it:' }, inline(page.image));
    }
    if (page.text) {
      parts.push({ text: 'The text printed on ' + where + ':\n"""\n' + page.text + '\n"""' });
    }
  }
  return parts;
}

function inline(url) {
  const comma = url.indexOf(',');
  return { inline_data: { mime_type: url.slice(5, url.indexOf(';')), data: url.slice(comma + 1) } };
}

// A base64 data URL of one of the allowed image types, under the size limit, or null.
function dataUrl(value, types, maxChars) {
  if (typeof value !== 'string' || value.length > maxChars) {
    return null;
  }
  for (const type of types) {
    if (value.startsWith('data:' + type + ';base64,')) {
      return value;
    }
  }
  return null;
}

function cleanPage(page) {
  if (!page || typeof page !== 'object') {
    return null;
  }
  const image = dataUrl(page.image, ['image/jpeg', 'image/png'], MAX_PAGE_IMAGE_CHARS);
  const text = typeof page.text === 'string' ? page.text.slice(0, MAX_PAGE_TEXT_CHARS).trim() : '';
  if (image === null && text === '') {
    return null;
  }
  return {
    image: image,
    text: text,
    name: typeof page.name === 'string' ? page.name.slice(0, 200) : '',
    number: Number(page.number) || 1,
    pageCount: Number(page.pageCount) || 0,
  };
}

function contextSection(context) {
  if (!context) {
    return '';
  }
  return '\n\nEarlier notes, for context only:\n"""\n' + context + '\n"""';
}

// [{ role: 'student' | 'tutor', text }], newest last, trimmed to a sensible size.
function cleanThread(thread) {
  if (!Array.isArray(thread)) {
    return [];
  }
  return thread
    .filter(function (m) {
      return m && typeof m.text === 'string' && m.text.trim() !== '';
    })
    .slice(-MAX_THREAD_MESSAGES)
    .map(function (m) {
      return { role: m.role === 'tutor' ? 'tutor' : 'student', text: m.text.slice(0, MAX_MESSAGE_CHARS) };
    });
}
