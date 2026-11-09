// Image requests, shared by the local server (index.mjs) and the Vercel functions in api/.
// recognize() transcribes handwriting, explain() answers Circle to ask. Each takes the parsed
// request body and returns { status, body } to send back. The Gemini call is in gemini.mjs.

import { generate, hasConfig, MISSING_CONFIG } from './gemini.mjs';

// The app adds whatever comes back to the file's notes, so it has to read as note text.
const PROMPT = [
  'This image is handwriting drawn in the air with a motion-tracking pen, so letters may be shaky or uneven.',
  'Transcribe exactly what is written, as note text.',
  'Write any math as LaTeX inside $...$, or $$...$$ for an equation on its own line. Do not solve or simplify it.',
  'Use Markdown only for headings (#) and lists (- or 1.). No bold, no code fences.',
  'In math, an x-shaped mark is the variable x. Read it as a multiplication sign only when it sits between two numbers or expressions being multiplied, like 3 × 4. Next to an operator or an equals sign (as in 7x + 4) it is always the variable x.',
  'If there is no writing, or only marks such as circles, arrows, underlines, or check marks, return exactly: (nothing recognized)',
  'Return only the transcription, with no commentary.',
].join(' ');

// Circle to ask: the user circled part of a slide or document. The first line names what was
// circled so the notes get a heading. Kept short, since it's read off a screen across a room.
const EXPLAIN_PROMPT = [
  'The user circled this part of a slide or document.',
  'Explain it briefly and clearly for a student. If it is an equation or math problem, solve it step by step.',
  'Start with one line: "About: " followed by what was circled, in under 8 words. Then the explanation, under 120 words.',
  'Write any math as LaTeX inside $...$, or $$...$$ for an equation on its own line.',
  'Use Markdown only for numbered or bulleted steps. No bold, no headings, no code fences.',
].join(' ');

// Reading handwriting needs no reasoning, so transcription asks for the least thinking.
// Explanations keep the model's default, and get longer to answer.
const TRANSCRIBE_CONFIG = { thinkingConfig: { thinkingLevel: 'minimal' } };
// Transcriptions take about a second, so one still going at 4 s has stalled (it happens now and
// then) and asking again is quicker than the default 8 s wait.
const TRANSCRIBE_TIMEOUT_MS = 4000;
const EXPLAIN_TIMEOUT_MS = 20000;

const PNG_PREFIX = 'data:image/png;base64,';
const MAX_CONTEXT_CHARS = 600;

// context: the end of the notes so far, to help with unclear words.
// previous: what part of this same handwriting was read as before, when a line is read again
// because more was written on it. Without it the model sometimes rereads a letter differently
// (the x in "7x + 4" came back as a times sign once the line was sent again with "=").
function buildPrompt(context, previous) {
  let prompt = PROMPT;
  if (previous) {
    prompt +=
      '\n\nPart of this handwriting was read earlier as the text below. More may have been written since. Transcribe everything in the image, and keep the earlier reading for the parts it covers unless the image clearly shows something else.\n"""\n' +
      previous +
      '\n"""';
  }
  if (context) {
    prompt +=
      '\n\nThe notes so far end with the text below. Use it only to resolve unclear words or symbols. Do not repeat it, and never return any of it that is not written in the image.\n"""\n' +
      context +
      '\n"""';
  }
  return prompt;
}

// index.mjs checks this at startup to warn about a missing key.
export { hasConfig };

export async function recognize(body, env) {
  if (!hasConfig(env)) {
    return { status: 500, body: { error: MISSING_CONFIG } };
  }

  const image = body && body.image;
  if (typeof image !== 'string' || !image.startsWith(PNG_PREFIX)) {
    return { status: 400, body: { error: 'Expected JSON with an image field holding a PNG data URL' } };
  }

  try {
    const context = typeof body.context === 'string' ? body.context.slice(-MAX_CONTEXT_CHARS).trim() : '';
    const previous = typeof body.previous === 'string' ? body.previous.slice(0, MAX_CONTEXT_CHARS).trim() : '';
    const text = await generate(
      [{ text: buildPrompt(context, previous) }, { inline_data: { mime_type: 'image/png', data: image.slice(PNG_PREFIX.length) } }],
      env,
      { operation: 'recognize', generationConfig: TRANSCRIBE_CONFIG, timeoutMs: TRANSCRIBE_TIMEOUT_MS },
    );
    return { status: 200, body: { text: text || '(nothing recognized)' } };
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: err.message } };
  }
}

// Returns { about, text }: what was circled, in a few words, and the explanation.
export async function explain(body, env) {
  if (!hasConfig(env)) {
    return { status: 500, body: { error: MISSING_CONFIG } };
  }
  const image = body && body.image;
  if (typeof image !== 'string' || !image.startsWith(PNG_PREFIX)) {
    return { status: 400, body: { error: 'Expected JSON with an image field holding a PNG data URL' } };
  }
  try {
    const answer = await generate(
      [{ text: EXPLAIN_PROMPT }, { inline_data: { mime_type: 'image/png', data: image.slice(PNG_PREFIX.length) } }],
      env,
      { operation: 'explain', timeoutMs: EXPLAIN_TIMEOUT_MS },
    );
    return { status: 200, body: splitAbout(answer) };
  } catch (err) {
    console.error(err);
    return { status: 502, body: { error: err.message } };
  }
}

// Takes the "About: ..." first line off the answer, if the model wrote one.
export function splitAbout(answer) {
  const match = /^\s*About:\s*(.+)\n+([\s\S]*)$/i.exec(answer || '');
  if (match) {
    return { about: match[1].trim(), text: match[2].trim() };
  }
  return { about: '', text: (answer || '').trim() };
}
