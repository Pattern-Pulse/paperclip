import crypto from "node:crypto";

export const AGENTOS_RUNTIME_CONTRACT_VERSION = "paperclip-agentos-runtime-run/v1";
export const AGENTOS_RUNTIME_AUDIENCE = "agentos-paperclip-runtime/v1";
export const AGENTOS_RUNTIME_ISSUER = "paperclip-agentos-bridge/v1";
export const AGENTOS_RUNTIME_ROUTE = "/api/runtime/paperclip/v1/runs";

type RuntimeContext = Record<string, unknown>;
type RuntimeConfig = Record<string, unknown>;

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function uuid(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(result)) {
    throw new Error(`agentos_runtime_${field}_invalid`);
  }
  return result;
}

function ownerHash(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result || !/^[0-9a-f]{64}$/.test(result)) throw new Error(`agentos_runtime_${field}_invalid`);
  return result;
}

function iso(value: unknown, field: string): string {
  const result = stringValue(value);
  if (!result || Number.isNaN(Date.parse(result))) throw new Error(`agentos_runtime_${field}_invalid`);
  return new Date(result).toISOString();
}

function readFrom(config: RuntimeConfig, context: RuntimeContext, key: string): unknown {
  return config[key] ?? context[key];
}

/**
 * Issue/project identity belongs to the Paperclip heartbeat-run context, not
 * to adapter configuration. Keep the context authoritative and reject a
 * conflicting configured value instead of silently letting config retarget a
 * signed run. A missing context value is also rejected: the runtime adapter
 * must only be used for a canonical issue-bound heartbeat run.
 */
function readRunBoundIdentity(config: RuntimeConfig, context: RuntimeContext, key: "projectId" | "issueId"): string {
  const contextValue = stringValue(context[key]);
  const configValue = stringValue(config[key]);
  if (!contextValue) throw new Error(`agentos_runtime_${key}_run_context_missing`);
  if (configValue && configValue !== contextValue) {
    throw new Error(`agentos_runtime_${key}_config_context_mismatch`);
  }
  return contextValue;
}

function readRunBoundIssueId(config: RuntimeConfig, context: RuntimeContext): string {
  const contextIssueId = stringValue(context.issueId);
  const contextTaskId = stringValue(context.taskId);
  if (contextIssueId && contextTaskId && contextIssueId !== contextTaskId) {
    throw new Error("agentos_runtime_issueId_run_context_mismatch");
  }
  const canonicalIssueId = contextIssueId ?? contextTaskId;
  if (!canonicalIssueId) throw new Error("agentos_runtime_issueId_run_context_missing");
  for (const [key, value] of [["issueId", config.issueId], ["taskId", config.taskId]] as const) {
    const configured = stringValue(value);
    if (configured && configured !== canonicalIssueId) {
      throw new Error("agentos_runtime_issueId_config_context_mismatch");
    }
  }
  return canonicalIssueId;
}

function sortedCapabilities(value: unknown): string[] {
  if (typeof value === "string") {
    try { value = JSON.parse(value); } catch { throw new Error("agentos_runtime_capabilities_invalid"); }
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new Error("agentos_runtime_capabilities_invalid");
  }
  const result = value.map((entry) => entry.trim());
  if (result.some((entry) => !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(entry))) {
    throw new Error("agentos_runtime_capabilities_invalid");
  }
  const sorted = [...new Set(result)].sort();
  if (sorted.length !== result.length || sorted.some((entry, index) => entry !== result[index])) {
    throw new Error("agentos_runtime_capabilities_must_be_sorted_unique");
  }
  return sorted;
}

export interface AgentOsRuntimeContractInput {
  runId: string;
  attempt: number;
  agentId: string;
  companyId: string;
  config: RuntimeConfig;
  context: RuntimeContext;
  now?: Date;
}

export function buildAgentOsRuntimeContract(input: AgentOsRuntimeContractInput) {
  const now = input.now ?? new Date();
  const iat = now.toISOString();
  const defaultDeadline = new Date(now.getTime() + 120_000).toISOString();
  const deadline = iso(readFrom(input.config, input.context, "deadline") ?? defaultDeadline, "deadline");
  const routineIdValue = readFrom(input.config, input.context, "routineId");
  const triggerIdValue = readFrom(input.config, input.context, "triggerId");
  const routineId = routineIdValue === null || routineIdValue === undefined ? null : uuid(routineIdValue, "routine_id");
  const triggerId = triggerIdValue === null || triggerIdValue === undefined ? null : uuid(triggerIdValue, "trigger_id");
  if ((routineId === null) !== (triggerId === null)) throw new Error("agentos_runtime_routine_trigger_pair_required");

  const attempt = Number.isInteger(input.attempt) && input.attempt > 0 ? input.attempt : 1;
  const runId = uuid(input.runId, "run_id");
  const paperclipAgentId = uuid(input.agentId, "agent_id");
  const companyId = uuid(input.companyId, "company_id");
  const projectId = uuid(readRunBoundIdentity(input.config, input.context, "projectId"), "project_id");
  const issueId = uuid(readRunBoundIssueId(input.config, input.context), "issue_id");
  const agentOsAgentId = stringValue(readFrom(input.config, input.context, "agentOsAgentId"));
  if (!agentOsAgentId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(agentOsAgentId)) {
    throw new Error("agentos_runtime_agent_os_agent_id_invalid");
  }
  const owner = ownerHash(readFrom(input.config, input.context, "ownerHash"), "owner_hash");
  const runtimeOwner = ownerHash(readFrom(input.config, input.context, "runtimeOwnerHash") ?? owner, "runtime_owner_hash");
  const provider = stringValue(readFrom(input.config, input.context, "provider"));
  if (provider !== "codex" && provider !== "claude") throw new Error("agentos_runtime_provider_invalid");
  const model = stringValue(readFrom(input.config, input.context, "model"));
  if (!model || model.length > 128 || /^\s|\s$/.test(model)) throw new Error("agentos_runtime_model_invalid");
  const providerConnectionEpoch = uuid(readFrom(input.config, input.context, "providerConnectionEpoch"), "provider_connection_epoch");
  const revision = Number(readFrom(input.config, input.context, "revision"));
  if (!Number.isSafeInteger(revision) || revision < 1) throw new Error("agentos_runtime_revision_invalid");
  const capabilities = sortedCapabilities(readFrom(input.config, input.context, "capabilities"));
  const scheduledForValue = readFrom(input.config, input.context, "scheduledFor");
  const scheduleRevision = stringValue(readFrom(input.config, input.context, "scheduleRevisionSha256"));
  const scheduledFor = scheduledForValue === null || scheduledForValue === undefined ? null : iso(scheduledForValue, "scheduled_for");
  if (routineId !== null && (!scheduledFor || !scheduleRevision || !/^[0-9a-f]{64}$/.test(scheduleRevision))) {
    throw new Error("agentos_runtime_schedule_occurrence_required");
  }
  if (routineId === null && (scheduledFor !== null || scheduleRevision !== null)) {
    throw new Error("agentos_runtime_nonroutine_schedule_forbidden");
  }
  const idempotencyKey = `paperclip-agentos:${runId}:${attempt}`;
  const contract = {
    schemaVersion: AGENTOS_RUNTIME_CONTRACT_VERSION,
    signature: {
      alg: "Ed25519",
      kid: stringValue(process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID),
      iss: AGENTOS_RUNTIME_ISSUER,
      aud: AGENTOS_RUNTIME_AUDIENCE,
      iat,
      nbf: iat,
      exp: new Date(now.getTime() + 300_000).toISOString(),
      jti: crypto.randomUUID(),
    },
    scope: { companyId, projectId, agentId: paperclipAgentId, agentOsAgentId, issueId, routineId, triggerId },
    run: { runId, attempt, deadline, idempotencyKey, scheduledFor, scheduleRevisionSha256: scheduleRevision },
    identity: { ownerHash: owner, runtimeOwnerHash: runtimeOwner, provider, model, providerConnectionEpoch },
    context: { revision, capabilities },
  } as const;
  readAgentOsRuntimeKeyId();
  return contract;
}

export function readAgentOsRuntimeKeyId(): string {
  const kid = stringValue(process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID);
  if (!kid || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(kid)) throw new Error("agentos_runtime_signing_key_id_missing");
  return kid;
}

export function signAgentOsRuntimeContract(contract: object, privateKeyPem: string): { body: Buffer; signature: string } {
  const body = Buffer.from(JSON.stringify(contract), "utf8");
  const bodyHash = crypto.createHash("sha256").update(body).digest("hex");
  const message = Buffer.from(`v1\nPOST\n${AGENTOS_RUNTIME_ROUTE}\n${bodyHash}`, "utf8");
  const signature = crypto.sign(null, message, privateKeyPem).toString("base64url");
  return { body, signature: `v1;sig=${signature}` };
}

export function readAgentOsRuntimePrivateKey(): string {
  const encoded = process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64;
  if (!encoded) throw new Error("agentos_runtime_signing_private_key_missing");
  const pem = Buffer.from(encoded, "base64").toString("utf8");
  if (!pem.includes("BEGIN PRIVATE KEY") || Buffer.from(pem, "utf8").toString("base64") !== encoded) throw new Error("agentos_runtime_signing_private_key_invalid");
  const key = crypto.createPrivateKey(pem);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("agentos_runtime_signing_private_key_invalid");
  return pem;
}
