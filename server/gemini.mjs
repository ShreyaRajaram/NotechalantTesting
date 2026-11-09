// One Gemini generateContent call, shared by recognition (recognize.mjs) and the tutor (tutor.mjs).
// Returns the answer's text.
import { startLlmObservation } from './llm-observability.mjs';

// Most answers take about a second, but now and then one stalls for 30s or more.
// Giving up and asking again is much faster than waiting it out.
const DEFAULT_TIMEOUT_MS = 8000;
const ATTEMPTS = 2;

export function hasConfig(env) {
  return Boolean(env.GEMINI_API_KEY && env.GEMINI_MODEL);
}

export const MISSING_CONFIG = 'Missing GEMINI_API_KEY or GEMINI_MODEL. Set them in server/.env, or in Vercel when deployed';

// parts is Gemini's parts list ([{ text }, { inline_data }]). generationConfig is passed through,
// for example to ask for JSON that follows a schema.
export async function generate(parts, env, options) {
  const opts = options || {};
  const observation = startLlmObservation(parts, env, opts);
  const result = { attempts: 0 };
  try {
    return await generateContent(parts, env, opts, result);
  } catch (err) {
    result.errorType ||= 'ResponseError';
    throw err;
  } finally {
    if (observation) await observation.finish(result);
  }
}

async function generateContent(parts, env, opts, result) {
  const url = 'https://generativelanguage.googleapis.com/v1beta/models/' + env.GEMINI_MODEL + ':generateContent';
  const payload = { contents: [{ parts: parts }] };
  if (opts.generationConfig) {
    payload.generationConfig = opts.generationConfig;
  }
  const request = {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-goog-api-key': env.GEMINI_API_KEY,
    },
    body: JSON.stringify(payload),
  };
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;

  let response;
  for (let attempt = 1; response === undefined; attempt++) {
    result.attempts = attempt;
    try {
      response = await fetch(url, Object.assign({ signal: AbortSignal.timeout(timeoutMs) }, request));
    } catch (err) {
      if (err.name !== 'TimeoutError') {
        result.errorType = 'NetworkError';
        throw new Error('Could not reach Gemini. Check the internet connection');
      }
      if (attempt === ATTEMPTS) {
        result.errorType = 'TimeoutError';
        throw new Error('Gemini took too long to answer. Try again');
      }
      console.log('Gemini timed out, retrying');
    }
  }

  const data = await response.json().catch(function () {
    return null;
  });
  result.httpStatus = response.status;
  if (!response.ok) {
    result.errorType = 'ProviderError';
    let detail = 'HTTP ' + response.status;
    if (data !== null && data.error && data.error.message) {
      detail = data.error.message;
    }
    throw new Error('Gemini error, ' + detail);
  }

  // The answer can come back split across several parts. Join them.
  let text = '';
  const candidate = data && data.candidates && data.candidates[0];
  const answerParts = (candidate && candidate.content && candidate.content.parts) || [];
  for (let i = 0; i < answerParts.length; i++) {
    if (typeof answerParts[i].text === 'string') {
      text += answerParts[i].text;
    }
  }
  result.text = text.trim();
  result.usage = data?.usageMetadata;
  return result.text;
}
