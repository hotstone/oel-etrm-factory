import { setupTracer, getTracer } from "@strands-agents/sdk/telemetry";

/**
 * Tracing setup. Two modes:
 *
 * - Inside AgentCore Runtime: ADOT JS is preloaded via `node --require
 *   .../register` (see Dockerfile) and registers a global tracer provider with
 *   a SigV4-signed exporter to CloudWatch (AgentCore injects no OTLP endpoint
 *   and runs no local collector, so a vanilla OTLP exporter goes nowhere).
 *   Strands and our withSpan() write through the global OTel API, so nothing
 *   further is needed — setupTracer must NOT run or it would replace ADOT's
 *   provider with one pointing at localhost.
 * - Anywhere else with an explicit OTEL_EXPORTER_OTLP_*ENDPOINT: configure
 *   Strands' own provider/exporter.
 */
export function initTelemetry(): "adot" | "otlp" | "off" {
  if (process.env.AGENT_OBSERVABILITY_ENABLED) return "adot";
  if (process.env.OTEL_EXPORTER_OTLP_ENDPOINT || process.env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT) {
    setupTracer({ exporters: { otlp: true } });
    return "otlp";
  }
  return "off";
}

/** Wrap an async step in a span (used by the pipeline's bridge nodes). */
export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number>,
  fn: () => Promise<T>,
): Promise<T> {
  const span = getTracer().startSpan(name);
  for (const [k, v] of Object.entries(attributes)) span.setAttribute(k, v);
  try {
    const result = await fn();
    span.setStatus({ code: 1 }); // OK
    return result;
  } catch (err) {
    span.setStatus({ code: 2, message: err instanceof Error ? err.message : String(err) });
    span.recordException(err instanceof Error ? err : new Error(String(err)));
    throw err;
  } finally {
    span.end();
  }
}
