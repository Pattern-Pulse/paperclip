import type { AdapterEnvironmentTestContext, AdapterEnvironmentTestResult } from "../types.js";
import { parseObject } from "../utils.js";
import { readAgentOsRuntimeKeyId, readAgentOsRuntimePrivateKey } from "./contract.js";
import { resolveAgentOsRuntimeEndpoint, resolveAgentOsRuntimeTimeout } from "./execute.js";

export async function testEnvironment(ctx: AdapterEnvironmentTestContext): Promise<AdapterEnvironmentTestResult> {
  const config = parseObject(ctx.config);
  const checks: AdapterEnvironmentTestResult["checks"] = [];
  try { resolveAgentOsRuntimeEndpoint(config); checks.push({ code: "agentos_runtime_endpoint_valid", level: "info", message: "AgentOS runtime endpoint is valid and host-approved." }); }
  catch (error) { checks.push({ code: "agentos_runtime_endpoint_invalid", level: "error", message: error instanceof Error ? error.message : "AgentOS runtime endpoint is invalid." }); }
  try { resolveAgentOsRuntimeTimeout(config); checks.push({ code: "agentos_runtime_timeout_valid", level: "info", message: "AgentOS runtime timeout is bounded." }); }
  catch (error) { checks.push({ code: "agentos_runtime_timeout_invalid", level: "error", message: error instanceof Error ? error.message : "AgentOS runtime timeout is invalid." }); }
  try { readAgentOsRuntimeKeyId(); checks.push({ code: "agentos_runtime_signing_key_id_valid", level: "info", message: "Ed25519 key id is configured." }); }
  catch (error) { checks.push({ code: "agentos_runtime_signing_key_id_invalid", level: "error", message: error instanceof Error ? error.message : "Signing key id is invalid." }); }
  try { readAgentOsRuntimePrivateKey(); checks.push({ code: "agentos_runtime_signing_key_valid", level: "info", message: "Ed25519 signing key is configured." }); }
  catch (error) { checks.push({ code: "agentos_runtime_signing_key_invalid", level: "error", message: error instanceof Error ? error.message : "Signing key is invalid." }); }
  return { adapterType: ctx.adapterType, status: checks.some((check) => check.level === "error") ? "fail" : "pass", checks, testedAt: new Date().toISOString() };
}
