// Agentless Datadog LLM Observability intake, shared by local and Vercel requests.
// Await the bounded export so a serverless runtime cannot freeze before it is sent.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { AsyncLocalStorage } from 'node:async_hooks';

const SITES = new Set([
  'datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com',
  'datadoghq.eu', 'ap1.datadoghq.com', 'ap2.datadoghq.com', 'ddog-gov.com',
]);
const EXPORT_TIMEOUT_MS = 1000;
const MAX_CONTENT_CHARS = 16000;
const workflowContext = new AsyncLocalStorage();

function id() {
  return BigInt('0x' + randomBytes(8).toString('hex')).toString();
}

function inputMessages(parts) {
  return [{
    role: 'user',
    // Images can contain whole documents; never send their base64 data to Datadog.
    content: parts.map(part => typeof part.text === 'string' ? part.text : '[image omitted]')
      .join('\n').slice(0, MAX_CONTENT_CHARS),
  }];
}

function configuration(env) {
  if (env.DD_LLMOBS_ENABLED !== 'true') return null;
  const site = env.DD_SITE || 'datadoghq.com';
  if (!env.DD_API_KEY || !SITES.has(site)) {
    console.warn('LLM Observability skipped: set DD_API_KEY and a supported DD_SITE');
    return null;
  }

  return { env, site, captureContent: env.DD_LLMOBS_CAPTURE_CONTENT === 'true' };
}

function startSpan(name, kind, config, parent) {
  const span = {
    trace_id: parent ? parent.span.trace_id : id(),
    span_id: id(),
    parent_id: parent ? parent.span.span_id : 'undefined',
    name,
    start_ns: Date.now() * 1e6,
    duration: 0,
    status: 'ok',
    meta: {
      'span.kind': kind,
      metadata: { content_captured: config.captureContent },
    },
    metrics: {},
  };
  return { span, started: performance.now() };
}

function finishSpan(observation) {
  observation.span.duration = Math.max(1, Math.round((performance.now() - observation.started) * 1e6));
}

function markError(span, type) {
  span.status = 'error';
  span.meta['error.type'] = type;
  // Provider errors can echo private input, so export only our fixed categories.
  span.meta['error.message'] = 'Application request failed: ' + type;
}

async function exportSpans({ env, site }, spans) {
  try {
    const tags = ['service:' + (env.DD_SERVICE || 'notechalanttesting'), 'env:' + (env.DD_ENV || 'development')];
    if (env.DD_VERSION) tags.push('version:' + env.DD_VERSION);
    const payload = {
      data: {
        type: 'span',
        attributes: { ml_app: env.DD_LLMOBS_ML_APP || 'notechalant', tags, spans },
      },
    };
    const response = await fetch('https://llmobs-intake.' + site + '/api/v2/llmobs/v1/trace/spans', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'DD-API-KEY': env.DD_API_KEY },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
    });
    if (!response.ok) console.warn('LLM Observability export failed: HTTP ' + response.status);
  } catch {
    // Telemetry availability must never change the application response.
    console.warn('LLM Observability export failed: intake unavailable or timed out');
  }
}

// The application has fixed Gemini workflows. Each request gets one root workflow
// and its nested LLM calls, isolated from concurrent requests by async context.
export async function observeWorkflow(name, env, callback) {
  const config = configuration(env);
  if (!config) return callback();
  const observation = startSpan('notechalant.' + name, 'workflow', config);
  const context = { config, observation, spans: [] };
  return workflowContext.run(context, async () => {
    try {
      const result = await callback();
      observation.span.meta.metadata.http_status = result.status;
      if (result.status >= 400) markError(observation.span, 'WorkflowError');
      return result;
    } catch (err) {
      markError(observation.span, 'WorkflowError');
      throw err;
    } finally {
      finishSpan(observation);
      // One bounded export for the whole request, including postprocessing.
      await exportSpans(config, [observation.span, ...context.spans]);
    }
  });
}

export function startLlmObservation(parts, env, options = {}) {
  const active = workflowContext.getStore();
  const parent = active?.config.env === env ? active : null;
  const config = parent ? parent.config : configuration(env);
  if (!config) return null;
  const observation = startSpan(options.operation || 'gemini.generate', 'llm', config, parent?.observation);
  const { span } = observation;
  span.meta.model_name = env.GEMINI_MODEL;
  span.meta.model_provider = 'google';
  if (config.captureContent) span.meta.input = { messages: inputMessages(parts) };

  return {
    async finish({ text, usage, attempts, errorType, httpStatus }) {
      // Measure Gemini latency before the telemetry export adds any time.
      finishSpan(observation);
      span.meta.metadata.attempts = attempts;
      if (httpStatus !== undefined) span.meta.metadata.http_status = httpStatus;
      if (errorType) markError(span, errorType);
      if (config.captureContent && text !== undefined) {
        span.meta.output = { messages: [{ role: 'assistant', content: text.slice(0, MAX_CONTENT_CHARS) }] };
      }
      const tokenFields = {
        promptTokenCount: 'input_tokens',
        totalTokenCount: 'total_tokens',
      };
      for (const [source, target] of Object.entries(tokenFields)) {
        if (Number.isFinite(usage?.[source]) && usage[source] >= 0) span.metrics[target] = usage[source];
      }
      // Gemini reports reasoning separately from the visible candidate tokens.
      const outputCounts = [usage?.candidatesTokenCount, usage?.thoughtsTokenCount]
        .filter(count => Number.isFinite(count) && count >= 0);
      if (outputCounts.length) span.metrics.output_tokens = outputCounts.reduce((sum, count) => sum + count, 0);
      if (parent) parent.spans.push(span);
      else await exportSpans(config, [span]);
    },
  };
}
