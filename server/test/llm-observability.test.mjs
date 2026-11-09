import test from 'node:test';
import assert from 'node:assert/strict';
import { generate } from '../gemini.mjs';
import { observeWorkflow } from '../llm-observability.mjs';
import { recognize, explain } from '../recognize.mjs';
import { tutor } from '../tutor.mjs';
import { POST as recognizePost } from '../../api/recognize.mjs';
import { POST as explainPost } from '../../api/explain.mjs';
import { POST as tutorPost } from '../../api/tutor.mjs';

const env = {
  GEMINI_API_KEY: 'gemini-secret',
  GEMINI_MODEL: 'test-model',
  DD_LLMOBS_ENABLED: 'true',
  DD_API_KEY: 'datadog-secret',
  DD_SITE: 'datadoghq.eu',
  DD_LLMOBS_ML_APP: 'test-app',
  DD_SERVICE: 'test-service',
  DD_ENV: 'test',
  DD_VERSION: '1.2.3',
};
const parts = [{ text: 'private student notes' }, { inline_data: { mime_type: 'image/png', data: 'private-image' } }];

function answer(text = '  A helpful answer  ') {
  return Response.json({
    candidates: [{ content: { parts: [{ text }] } }],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, totalTokenCount: 42 },
  });
}

function mockFetch(t, provider = () => answer(), exporter = () => new Response(null, { status: 202 }), site = 'datadoghq.eu') {
  const exports = [];
  const requests = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    if (url.startsWith('https://generativelanguage.googleapis.com/')) {
      requests.push({ url, init });
      return provider(url, init);
    }
    assert.equal(url, 'https://api.' + site + '/api/intake/llm-obs/v1/trace/spans');
    exports.push({ url, init, body: JSON.parse(init.body) });
    return exporter(url, init);
  });
  t.mock.method(console, 'warn', () => {});
  t.mock.method(console, 'log', () => {});
  return { exports, requests };
}

function spanOf(record) {
  return record.body.data.attributes.spans.find(span => span.meta.kind === 'llm');
}

test('disabled observability leaves the Gemini request and answer unchanged', async t => {
  const { exports, requests } = mockFetch(t);
  assert.equal(await generate(parts, { ...env, DD_LLMOBS_ENABLED: 'false' }), 'A helpful answer');
  assert.equal(exports.length, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].init.headers['x-goog-api-key'], env.GEMINI_API_KEY);
  assert.deepEqual(JSON.parse(requests[0].init.body), { contents: [{ parts }] });
});

test('successful calls export agentless spans with metrics and no private content', async t => {
  const { exports } = mockFetch(t);
  await generate(parts, env, { operation: 'recognize' });
  assert.equal(exports.length, 1);
  const record = exports[0];
  assert.equal(record.init.headers['DD-API-KEY'], env.DD_API_KEY);
  assert.ok(record.init.signal instanceof AbortSignal);
  assert.equal(record.body.data.type, 'span');
  assert.equal(record.body.data.attributes.ml_app, 'test-app');
  assert.deepEqual(record.body.data.attributes.tags, ['service:test-service', 'env:test', 'version:1.2.3']);
  const span = spanOf(record);
  assert.match(span.trace_id, /^\d+$/);
  assert.match(span.span_id, /^\d+$/);
  assert.equal(span.parent_id, 'undefined');
  assert.equal(span.name, 'recognize');
  assert.equal(span.meta.kind, 'llm');
  assert.equal(span.meta.model_name, 'test-model');
  assert.equal(span.meta.model_provider, 'google');
  assert.ok(span.start_ns > 0);
  assert.ok(span.duration > 0);
  assert.equal(span.status, 'ok');
  assert.deepEqual(span.metrics, { input_tokens: 30, output_tokens: 12, total_tokens: 42 });
  assert.deepEqual(span.meta.metadata, { content_captured: false, attempts: 1, http_status: 200 });
  assert.equal(span.meta.input, undefined);
  assert.equal(span.meta.output, undefined);
  for (const secret of ['private student notes', 'private-image', 'A helpful answer', env.GEMINI_API_KEY, env.DD_API_KEY]) {
    assert.equal(JSON.stringify(record.body).includes(secret), false);
  }
});

test('content capture is opt-in, bounded, and always omits image bytes', async t => {
  const { exports } = mockFetch(t, () => answer('x'.repeat(20000)));
  await generate(parts, { ...env, DD_LLMOBS_CAPTURE_CONTENT: 'true' });
  const span = spanOf(exports[0]);
  assert.deepEqual(span.meta.input.messages, [{ role: 'user', content: 'private student notes\n[image omitted]' }]);
  assert.equal(span.meta.output.messages[0].content.length, 16000);
  assert.equal(JSON.stringify(span).includes('private-image'), false);
  await generate([{ text: 'x'.repeat(20000) }], { ...env, DD_LLMOBS_CAPTURE_CONTENT: 'true' });
  assert.equal(spanOf(exports[1]).meta.input.messages[0].content.length, 16000);
});

test('a timeout followed by success records both attempts in one successful span', async t => {
  let calls = 0;
  const { exports } = mockFetch(t, () => {
    if (++calls === 1) throw new DOMException('timed out', 'TimeoutError');
    return answer();
  });
  assert.equal(await generate(parts, env), 'A helpful answer');
  assert.equal(exports.length, 1);
  assert.equal(spanOf(exports[0]).meta.metadata.attempts, 2);
  assert.equal(spanOf(exports[0]).status, 'ok');
});

test('exhausted timeouts export an error while preserving the original rejection', async t => {
  const { exports } = mockFetch(t, () => { throw new DOMException('timed out', 'TimeoutError'); });
  await assert.rejects(generate(parts, env), /Gemini took too long/);
  const span = spanOf(exports[0]);
  assert.equal(span.status, 'error');
  assert.equal(span.meta['error.type'], 'TimeoutError');
  assert.equal(span.meta.metadata.attempts, 2);
});

test('network errors are sanitized and do not retry', async t => {
  const { exports, requests } = mockFetch(t, () => { throw new Error('private network details'); });
  await assert.rejects(generate(parts, env), /Could not reach Gemini/);
  assert.equal(requests.length, 1);
  assert.equal(spanOf(exports[0]).meta['error.type'], 'NetworkError');
  assert.equal(JSON.stringify(exports[0].body).includes('private network details'), false);
});

test('provider failures retain HTTP status but omit sensitive provider messages', async t => {
  const { exports } = mockFetch(t, () => Response.json({ error: { message: 'private provider details' } }, { status: 429 }));
  await assert.rejects(generate(parts, env), /Gemini error, private provider details/);
  const span = spanOf(exports[0]);
  assert.equal(span.status, 'error');
  assert.equal(span.meta['error.type'], 'ProviderError');
  assert.equal(span.meta.metadata.http_status, 429);
  assert.equal(JSON.stringify(exports[0].body).includes('private provider details'), false);
});

test('unreported token usage is omitted rather than fabricated', async t => {
  const { exports } = mockFetch(t, () => Response.json({ candidates: [] }));
  assert.equal(await generate(parts, env), '');
  assert.deepEqual(spanOf(exports[0]).metrics, {});
});

test('output token usage includes Gemini reasoning tokens', async t => {
  const { exports } = mockFetch(t, () => Response.json({
    candidates: [],
    usageMetadata: { promptTokenCount: 30, candidatesTokenCount: 12, thoughtsTokenCount: 8, totalTokenCount: 50 },
  }));
  await generate(parts, env);
  assert.deepEqual(spanOf(exports[0]).metrics, { input_tokens: 30, output_tokens: 20, total_tokens: 50 });
});

test('export rejection and HTTP failure cannot break successful Gemini calls', async t => {
  let calls = 0;
  mockFetch(t, () => answer(), () => {
    if (++calls === 1) throw new Error('private intake details');
    return new Response(null, { status: 403 });
  });
  assert.equal(await generate(parts, env), 'A helpful answer');
  assert.equal(await generate(parts, env), 'A helpful answer');
  assert.equal(console.warn.mock.calls.length, 2);
  assert.equal(JSON.stringify(console.warn.mock.calls).includes('private intake details'), false);
});

test('export failure preserves the Gemini error', async t => {
  mockFetch(t, () => new Response(null, { status: 503 }), () => { throw new Error('intake offline'); });
  await assert.rejects(generate(parts, env), /Gemini error, HTTP 503/);
});

test('a stalled intake aborts after the export deadline and preserves the answer', async t => {
  let aborted = false;
  mockFetch(t, () => answer(), (url, init) => new Promise((resolve, reject) => {
    // Keep this mock alive until AbortSignal.timeout fires (its timer is unrefed).
    const guard = setTimeout(() => reject(new Error('export deadline did not fire')), 3000);
    init.signal.addEventListener('abort', () => {
      aborted = true;
      clearTimeout(guard);
      reject(init.signal.reason);
    }, { once: true });
  }));
  assert.equal(await generate(parts, env), 'A helpful answer');
  assert.equal(aborted, true);
});

test('missing keys and unsupported sites skip export without sending credentials elsewhere', async t => {
  const { exports } = mockFetch(t);
  assert.equal(await generate(parts, { ...env, DD_API_KEY: '' }), 'A helpful answer');
  assert.equal(await generate(parts, { ...env, DD_SITE: 'example.com' }), 'A helpful answer');
  assert.equal(exports.length, 0);
  assert.equal(console.warn.mock.calls.length, 2);
});

test('all application operations use the shared instrumentation', async t => {
  const { exports } = mockFetch(t, () => answer('{"verdict":"none","message":""}'));
  const image = 'data:image/png;base64,image';
  assert.equal((await recognize({ image }, env)).status, 200);
  assert.equal((await explain({ image }, env)).status, 200);
  assert.equal((await tutor({ text: 'hello' }, env)).status, 200);
  assert.equal((await tutor({ text: 'hello', thread: [{ role: 'student', text: 'why?' }] }, env)).status, 200);
  assert.deepEqual(exports.map(record => spanOf(record).name), ['recognize', 'explain', 'tutor.review', 'tutor.reply']);
  for (const record of exports) {
    const [root, child] = record.body.data.attributes.spans;
    assert.equal(record.body.data.attributes.spans.length, 2);
    assert.equal(root.meta.kind, 'workflow');
    assert.equal(root.name, 'notechalant.' + child.name);
    assert.equal(root.parent_id, 'undefined');
    assert.equal(child.parent_id, root.span_id);
    assert.equal(child.trace_id, root.trace_id);
    assert.notEqual(child.span_id, root.span_id);
    assert.equal(root.status, 'ok');
    assert.equal(root.meta.metadata.http_status, 200);
    assert.ok(root.duration >= child.duration);
  }
});

test('the requested US site and application name are the defaults', async t => {
  const { exports } = mockFetch(t, () => answer(), undefined, 'datadoghq.com');
  await recognize({ image: 'data:image/png;base64,image' }, {
    ...env, DD_SITE: undefined, DD_LLMOBS_ML_APP: undefined,
  });
  assert.equal(exports.length, 1);
  assert.equal(exports[0].body.data.attributes.ml_app, 'notechalant');
  assert.equal(exports[0].body.data.attributes.spans.length, 2);
});

test('handled provider errors mark both the workflow and LLM span without exporting private details', async t => {
  const { exports } = mockFetch(t, () => Response.json({ error: { message: 'private provider error' } }, { status: 429 }));
  t.mock.method(console, 'error', () => {});
  const result = await explain({ image: 'data:image/png;base64,private-image' }, env);
  assert.equal(result.status, 502);
  assert.equal(result.body.error, 'Gemini error, private provider error');
  assert.equal(exports.length, 1);
  const [root, child] = exports[0].body.data.attributes.spans;
  assert.equal(root.status, 'error');
  assert.equal(root.meta.metadata.http_status, 502);
  assert.equal(root.meta['error.type'], 'WorkflowError');
  assert.equal(child.status, 'error');
  assert.equal(child.meta.metadata.http_status, 429);
  assert.equal(JSON.stringify(exports[0].body).includes('private provider error'), false);
  assert.equal(JSON.stringify(exports[0].body).includes('private-image'), false);
});

test('postprocessing errors mark the workflow and preserve the exception', async t => {
  const { exports } = mockFetch(t);
  const failure = new Error('private processing details');
  await assert.rejects(observeWorkflow('processing', env, async () => {
    await generate(parts, env);
    // The LLM is complete, but the response is not ready for export yet.
    assert.equal(exports.length, 0);
    throw failure;
  }), error => error === failure);
  const [root, child] = exports[0].body.data.attributes.spans;
  assert.equal(root.status, 'error');
  assert.equal(child.status, 'ok');
  assert.equal(JSON.stringify(exports[0].body).includes(failure.message), false);
});

test('an unavailable intake preserves the application response and exports the trace once', async t => {
  const { exports } = mockFetch(t, () => answer('About: Algebra\nSolve for x.'), () => { throw new Error('intake offline'); });
  const result = await explain({ image: 'data:image/png;base64,image' }, env);
  assert.deepEqual(result, { status: 200, body: { about: 'Algebra', text: 'Solve for x.' } });
  assert.equal(exports.length, 1);
  assert.equal(exports[0].body.data.attributes.spans.length, 2);
});

test('disabled workflow instrumentation preserves the application response without exports', async t => {
  const { exports, requests } = mockFetch(t, () => answer('recognized text'));
  assert.deepEqual(await recognize({ image: 'data:image/png;base64,image' }, { ...env, DD_LLMOBS_ENABLED: 'false' }), {
    status: 200, body: { text: 'recognized text' },
  });
  assert.equal(exports.length, 0);
  assert.equal(requests.length, 1);
});

test('concurrent workflows keep parents and captured content in their own traces', async t => {
  const { exports } = mockFetch(t);
  const captureEnv = { ...env, DD_LLMOBS_CAPTURE_CONTENT: 'true' };
  await Promise.all(['first request', 'second request'].map(text => observeWorkflow(text, captureEnv, async () => {
    await generate([{ text }], captureEnv);
    return { status: 200, body: { text } };
  })));
  assert.equal(exports.length, 2);
  const roots = exports.map(record => record.body.data.attributes.spans[0]);
  assert.notEqual(roots[0].trace_id, roots[1].trace_id);
  for (const record of exports) {
    const [root, child] = record.body.data.attributes.spans;
    assert.equal(child.parent_id, root.span_id);
    assert.equal(child.trace_id, root.trace_id);
    assert.equal(root.name, 'notechalant.' + child.meta.input.messages[0].content);
  }
});

test('invalid requests make no Gemini or telemetry calls', async t => {
  const { exports, requests } = mockFetch(t);
  assert.equal((await recognize({}, env)).status, 400);
  assert.equal((await explain({}, env)).status, 400);
  assert.equal((await tutor({}, env)).status, 400);
  assert.equal(exports.length, 0);
  assert.equal(requests.length, 0);
});

test('concurrent requests keep their span identities and content separate', async t => {
  const { exports } = mockFetch(t);
  const captureEnv = { ...env, DD_LLMOBS_CAPTURE_CONTENT: 'true' };
  await Promise.all([
    generate([{ text: 'first request' }], captureEnv),
    generate([{ text: 'second request' }], captureEnv),
  ]);
  const spans = exports.map(spanOf);
  assert.notEqual(spans[0].trace_id, spans[1].trace_id);
  assert.notEqual(spans[0].span_id, spans[1].span_id);
  assert.deepEqual(new Set(spans.map(span => span.meta.input.messages[0].content)), new Set(['first request', 'second request']));
});

test('Vercel handlers await export before returning their responses', async t => {
  const previous = Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]]));
  Object.assign(process.env, env);
  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  let exported = 0;
  const { exports } = mockFetch(t, () => answer('{"verdict":"none","message":""}'), async () => {
    await new Promise(resolve => setImmediate(resolve));
    exported++;
    return new Response(null, { status: 202 });
  });
  const cases = [
    [recognizePost, { image: 'data:image/png;base64,image' }],
    [explainPost, { image: 'data:image/png;base64,image' }],
    [tutorPost, { text: 'hello' }],
  ];
  for (const [handler, body] of cases) {
    const response = await handler(new Request('https://example.com/api/test', {
      method: 'POST', body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' },
    }));
    assert.equal(response.status, 200);
    assert.equal(exported, exports.length);
  }
  assert.equal(exported, 3);
});
