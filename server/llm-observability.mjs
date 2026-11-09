// Agentless Datadog LLM Observability intake, shared by local and Vercel requests.
// Await the bounded export so a serverless runtime cannot freeze before it is sent.
import { randomBytes } from 'node:crypto';
import { performance } from 'node:perf_hooks';

const SITES = new Set([
  'datadoghq.com', 'us3.datadoghq.com', 'us5.datadoghq.com',
  'datadoghq.eu', 'ap1.datadoghq.com', 'ap2.datadoghq.com', 'ddog-gov.com',
]);
const EXPORT_TIMEOUT_MS = 1000;
const MAX_CONTENT_CHARS = 16000;

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

export function startLlmObservation(parts, env, options = {}) {
  if (env.DD_LLMOBS_ENABLED !== 'true') return null;
  const site = env.DD_SITE || 'datadoghq.com';
  if (!env.DD_API_KEY || !SITES.has(site)) {
    console.warn('LLM Observability skipped: set DD_API_KEY and a supported DD_SITE');
    return null;
  }

  const captureContent = env.DD_LLMOBS_CAPTURE_CONTENT === 'true';
  const span = {
    trace_id: id(),
    span_id: id(),
    parent_id: 'undefined',
    name: options.operation || 'gemini.generate',
    start_ns: Date.now() * 1e6,
    duration: 0,
    status: 'ok',
    meta: {
      'span.kind': 'llm',
      model_name: env.GEMINI_MODEL,
      model_provider: 'google',
      metadata: { content_captured: captureContent },
    },
    metrics: {},
  };
  if (captureContent) span.meta.input = { messages: inputMessages(parts) };
  const started = performance.now();

  return {
    async finish({ text, usage, attempts, errorType, httpStatus }) {
      // Measure Gemini latency before the telemetry export adds any time.
      span.duration = Math.max(1, Math.round((performance.now() - started) * 1e6));
      span.meta.metadata.attempts = attempts;
      if (httpStatus !== undefined) span.meta.metadata.http_status = httpStatus;
      if (errorType) {
        span.status = 'error';
        span.meta['error.type'] = errorType;
        // Provider error messages may echo private input. Keep telemetry errors generic.
        span.meta['error.message'] = 'Gemini request failed: ' + errorType;
      }
      if (captureContent && text !== undefined) {
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
      const tags = ['service:' + (env.DD_SERVICE || 'notechalanttesting'), 'env:' + (env.DD_ENV || 'development')];
      if (env.DD_VERSION) tags.push('version:' + env.DD_VERSION);
      const payload = {
        data: {
          type: 'span',
          attributes: {
            ml_app: env.DD_LLMOBS_ML_APP || 'notechalant',
            tags,
            spans: [span],
          },
        },
      };
      try {
        const response = await fetch('https://llmobs-intake.' + site + '/api/v2/llmobs/v1/trace/spans', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'DD-API-KEY': env.DD_API_KEY },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(EXPORT_TIMEOUT_MS),
        });
        if (!response.ok) console.warn('LLM Observability export failed: HTTP ' + response.status);
      } catch {
        // Telemetry availability must never change the result of the Gemini request.
        console.warn('LLM Observability export failed: intake unavailable or timed out');
      }
    },
  };
}
