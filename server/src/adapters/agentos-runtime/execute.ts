import type { AdapterExecutionContext, AdapterExecutionResult } from "../types.js";
import { asString, parseObject } from "../utils.js";
import { guardedHttpAdapterFetch } from "../http/remote-fetch.js";
import { buildAgentOsRuntimeContract, readAgentOsRuntimePrivateKey, signAgentOsRuntimeContract } from "./contract.js";

const MAX_AGENTOS_RUNTIME_RESPONSE_BYTES = 16_384;

async function readBoundedResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength && (!/^\d+$/u.test(contentLength) || Number(contentLength) > MAX_AGENTOS_RUNTIME_RESPONSE_BYTES)) {
    throw new Error("agentos_runtime_response_too_large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_AGENTOS_RUNTIME_RESPONSE_BYTES) {
        await reader.cancel("response_limit_exceeded").catch(() => undefined);
        throw new Error("agentos_runtime_response_too_large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
  return new TextDecoder().decode(bytes);
}

export function resolveAgentOsRuntimeEndpoint(config: Record<string, unknown>): string {
  const canonical = asString(process.env.PAPERCLIP_AGENTOS_RUNTIME_URL, "").trim();
  if (!canonical) throw new Error("agentos_runtime_endpoint_missing");
  const configured = asString(config.endpoint, canonical).trim();
  const normalize = (value: string) => {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") throw new Error("agentos_runtime_endpoint_invalid");
    if (parsed.username || parsed.password || parsed.search || parsed.hash) throw new Error("agentos_runtime_endpoint_invalid");
    parsed.pathname = parsed.pathname.replace(/\/$/u, "");
    if (parsed.pathname !== "/api/runtime/paperclip/v1/runs") throw new Error("agentos_runtime_endpoint_path_invalid");
    return parsed.toString();
  };
  const canonicalUrl = normalize(canonical);
  if (normalize(configured) !== canonicalUrl) throw new Error("agentos_runtime_endpoint_not_allowed");
  return canonicalUrl;
}

export function resolveAgentOsRuntimeTimeout(config: Record<string, unknown>): number {
  const timeoutMs = Number(config.timeoutMs ?? 125_000);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 180_000) throw new Error("agentos_runtime_timeout_invalid");
  return timeoutMs;
}

export async function execute(ctx: AdapterExecutionContext): Promise<AdapterExecutionResult> {
  const config = parseObject(ctx.config);
  const contract = buildAgentOsRuntimeContract({
    runId: ctx.runId,
    attempt: Number(ctx.context.attempt ?? 1),
    agentId: ctx.agent.id,
    companyId: ctx.agent.companyId,
    config,
    context: ctx.context,
  });
  const signed = signAgentOsRuntimeContract(contract, readAgentOsRuntimePrivateKey());
  const runtimeEndpoint = resolveAgentOsRuntimeEndpoint(config);
  const controller = new AbortController();
  const timeoutMs = resolveAgentOsRuntimeTimeout(config);
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    ctx.onDispatch?.();
    const response = await guardedHttpAdapterFetch(runtimeEndpoint, {
      method: "POST",
      headers: { "content-type": "application/json", "x-agentos-paperclip-signature": signed.signature },
      body: signed.body.toString("utf8"),
      signal: controller.signal,
    }, { responseTimeoutMs: timeoutMs, privateEndpointAllowlist: new Set([new URL(runtimeEndpoint).origin]) });
    const text = await readBoundedResponse(response);
    let payload: Record<string, unknown>;
    try { payload = parseObject(JSON.parse(text)); } catch { throw new Error(`agentos_runtime_invalid_response:${response.status}`); }
    if (!response.ok) throw new Error(`agentos_runtime_http_${response.status}`);
    const state = asString(payload.state, "");
    if (payload.version !== "paperclip-agentos-runtime-receipt/v1"
        || payload.runId !== contract.run.runId
        || typeof payload.attempt !== "number"
        || !Number.isInteger(payload.attempt)
        || payload.attempt !== contract.run.attempt) {
      throw new Error("agentos_runtime_response_binding_invalid");
    }
    if (response.status !== 200 || !["succeeded", "failed"].includes(state)) throw new Error(`agentos_runtime_not_terminal:${state || "unknown"}`);
    if (payload.callbackState !== "delivered") throw new Error("agentos_runtime_response_binding_invalid");
    if (state === "failed") {
      return { exitCode: 1, signal: null, timedOut: false, errorCode: asString(payload.error, "agentos_runtime_failed"), resultJson: payload, provider: contract.identity.provider, model: contract.identity.model, summary: `AgentOS runtime ${state}` };
    }
    return { exitCode: 0, signal: null, timedOut: false, resultJson: payload, provider: contract.identity.provider, model: contract.identity.model, summary: "AgentOS runtime succeeded" };
  } catch (error) {
    if (timer && error instanceof Error && error.name === "AbortError") return { exitCode: null, signal: null, timedOut: true, errorCode: "agentos_runtime_timeout", errorMessage: `AgentOS runtime timed out after ${timeoutMs}ms` };
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
