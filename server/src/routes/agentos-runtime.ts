import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { Request, Response } from "express";
import { Router } from "express";
import { and, eq } from "drizzle-orm";
import { activityLog, heartbeatRuns } from "@paperclipai/db";
import type { Db } from "@paperclipai/db";

const MAX_BODY_BYTES = 64 * 1024;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA256_RE = /^[0-9a-f]{64}$/;
const ERROR_CODE_RE = /^[a-z][a-z0-9_]{0,63}$/;
const KEY_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
// The router is mounted below `/api`, while AgentOS signs the path relative
// to the configured Paperclip API base (`.../api`). Keep the signed path
// independent of that deployment prefix.
const CALLBACK_PREFIX = "/agentos-runtime/v1/runs/";
const CALLBACK_SUFFIX = "/callbacks";
const RECEIPT_VERSION = "paperclip-agentos-runtime-callback-receipt/v1";

type CallbackStatus = "succeeded" | "failed";
type CallbackPayload = {
  version: "paperclip-runtime-callback/v1";
  companyId: string;
  runId: string;
  attempt: number;
  issueId: string;
  agentId: string;
  status: CallbackStatus;
  outputSha256?: string;
  errorCode?: string;
};

type CallbackEnvelope = {
  eventId: string;
  payloadSha256: string;
  payload: CallbackPayload;
};

type StoredCallback = {
  eventId: string;
  companyId: string;
  runId: string;
  attempt: number;
  payloadSha256: string;
  status: CallbackStatus;
  acceptedAt: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableJson(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const token = env.PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_TOKEN;
  const secret = env.PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_SIGNING_SECRET;
  const keyId = env.PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_SIGNING_KEY_ID;
  if (!token || !secret || !keyId || Buffer.byteLength(token) > 4096 || Buffer.byteLength(secret) < 32
    || Buffer.byteLength(secret) > 4096 || !KEY_ID_RE.test(keyId)) return null;
  if (token.trim() !== token || /[\s\u0000-\u001f\u007f]/u.test(token)) return null;
  return { token, secret, keyId };
}

function reject(res: Response, status: number, error: string) {
  res.status(status).json({ error });
}

function callbackPath(runId: string, attempt: number, eventId?: string): string {
  const base = `${CALLBACK_PREFIX}${encodeURIComponent(runId)}/attempts/${attempt}${CALLBACK_SUFFIX}`;
  return eventId ? `${base}/${encodeURIComponent(eventId)}` : base;
}

function verifyBearer(req: Request, token: string): boolean {
  const value = req.header("authorization") ?? "";
  if (!value.toLowerCase().startsWith("bearer ")) return false;
  return constantTimeEqual(value.slice("bearer ".length).trim(), token);
}

function verifySignature(req: Request, rawBody: Buffer, secret: string, keyId: string, path: string): boolean {
  const header = req.header("x-agentos-paperclip-signature") ?? "";
  const match = /^v1;kid=([A-Za-z0-9][A-Za-z0-9._:-]{0,127});ts=(\d{1,12});sig=([0-9a-f]{64})$/.exec(header);
  if (!match || match[1] !== keyId) return false;
  const timestamp = Number(match[2]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(Math.floor(Date.now() / 1000) - timestamp) > 60) return false;
  const bodyHash = createHash("sha256").update(rawBody).digest("hex");
  const expected = createHmac("sha256", secret)
    .update(`v1\nPOST\n${path}\n${match[2]}\n${bodyHash}`)
    .digest("hex");
  return constantTimeEqual(expected, match[3]);
}

function parseEnvelope(value: unknown): CallbackEnvelope | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const candidate = value as Record<string, unknown>;
  if (Object.keys(candidate).some((key) => !["eventId", "payloadSha256", "payload"].includes(key))) return null;
  const payload = candidate.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const body = payload as Record<string, unknown>;
  const allowedPayloadKeys = body.status === "succeeded"
    ? ["version", "companyId", "runId", "attempt", "issueId", "agentId", "status", "outputSha256"]
    : ["version", "companyId", "runId", "attempt", "issueId", "agentId", "status", "errorCode"];
  if (Object.keys(body).some((key) => !allowedPayloadKeys.includes(key))) return null;
  if (typeof candidate.eventId !== "string" || !UUID_RE.test(candidate.eventId)
    || typeof candidate.payloadSha256 !== "string" || !SHA256_RE.test(candidate.payloadSha256)
    || body.version !== "paperclip-runtime-callback/v1"
    || typeof body.companyId !== "string" || !UUID_RE.test(body.companyId)
    || typeof body.runId !== "string" || !UUID_RE.test(body.runId)
    || typeof body.attempt !== "number" || !Number.isInteger(body.attempt) || body.attempt < 1 || body.attempt > 100
    || typeof body.issueId !== "string" || !UUID_RE.test(body.issueId)
    || typeof body.agentId !== "string" || !UUID_RE.test(body.agentId)
    || (body.status !== "succeeded" && body.status !== "failed")) return null;
  if (body.status === "succeeded") {
    if (typeof body.outputSha256 !== "string" || !SHA256_RE.test(body.outputSha256) || body.errorCode !== undefined) return null;
  } else if (typeof body.errorCode !== "string" || !ERROR_CODE_RE.test(body.errorCode) || body.outputSha256 !== undefined) return null;
  return {
    eventId: candidate.eventId,
    payloadSha256: candidate.payloadSha256,
    payload: body as CallbackPayload,
  };
}

function receipt(callback: StoredCallback, replay = false) {
  return {
    version: RECEIPT_VERSION,
    eventId: callback.eventId,
    companyId: callback.companyId,
    runId: callback.runId,
    attempt: callback.attempt,
    payloadSha256: callback.payloadSha256,
    status: callback.status,
    accepted: true,
    replay,
    acceptedAt: callback.acceptedAt,
  };
}

function readStoredCallback(resultJson: unknown): StoredCallback | null {
  if (!resultJson || typeof resultJson !== "object" || Array.isArray(resultJson)) return null;
  const value = (resultJson as Record<string, unknown>).agentosRuntimeCallback;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const callback = value as Record<string, unknown>;
  if (typeof callback.eventId !== "string" || typeof callback.companyId !== "string"
    || typeof callback.runId !== "string" || typeof callback.attempt !== "number"
    || typeof callback.payloadSha256 !== "string" || (callback.status !== "succeeded" && callback.status !== "failed")
    || typeof callback.acceptedAt !== "string") return null;
  return callback as unknown as StoredCallback;
}

async function loadCallback(db: Db, runId: string, eventId: string): Promise<StoredCallback | null> {
  const row = await db.select({ resultJson: heartbeatRuns.resultJson })
    .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
  const callback = readStoredCallback(row?.resultJson);
  return callback?.eventId === eventId ? callback : null;
}

export function agentosRuntimeCallbackRoutes(db: Db, env: NodeJS.ProcessEnv = process.env): Router {
  const router = Router();

  router.post("/agentos-runtime/v1/runs/:runId/attempts/:attempt/callbacks", async (req, res) => {
    const config = readConfig(env);
    if (!config) return reject(res, 404, "callback_disabled");
    const runId = String(req.params.runId);
    const attempt = Number(req.params.attempt);
    const path = callbackPath(runId, attempt);
    const rawBody = (req as Request & { rawBody?: Buffer }).rawBody;
    if (!UUID_RE.test(runId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 100) return reject(res, 400, "invalid_callback_path");
    if (req.header("content-type")?.toLowerCase() !== "application/json") return reject(res, 415, "unsupported_content_type");
    if (!rawBody || rawBody.length === 0 || rawBody.length > MAX_BODY_BYTES) return reject(res, 413, "invalid_body_size");
    if (!verifyBearer(req, config.token) || !verifySignature(req, rawBody, config.secret, config.keyId, path)) return reject(res, 401, "callback_unauthorized");
    let parsed: unknown;
    try { parsed = JSON.parse(rawBody.toString("utf8")); } catch { return reject(res, 400, "invalid_json"); }
    const envelope = parseEnvelope(parsed);
    if (!envelope) return reject(res, 400, "invalid_callback_envelope");
    if (req.header("idempotency-key") !== envelope.eventId) return reject(res, 400, "idempotency_key_mismatch");
    if (sha256(stableJson(envelope.payload)) !== envelope.payloadSha256) return reject(res, 400, "callback_payload_hash_mismatch");
    const payload = envelope.payload;
    if (payload.runId !== runId || payload.attempt !== attempt) return reject(res, 409, "callback_binding_mismatch");

    const result = await db.transaction(async (tx) => {
      const run = await tx.select({
        id: heartbeatRuns.id,
        companyId: heartbeatRuns.companyId,
        agentId: heartbeatRuns.agentId,
        status: heartbeatRuns.status,
        resultJson: heartbeatRuns.resultJson,
      }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update").then((rows) => rows[0] ?? null);
      if (!run) return { kind: "missing" as const };
      const existing = readStoredCallback(run.resultJson);
      if (existing) {
        if (existing.eventId === envelope.eventId && existing.payloadSha256 === envelope.payloadSha256) return { kind: "replay" as const, callback: existing };
        return { kind: "conflict" as const };
      }
      if (run.companyId !== payload.companyId || run.agentId !== payload.agentId) return { kind: "binding" as const };
      if (!["queued", "running"].includes(run.status)) return { kind: "terminal" as const };
      const acceptedAt = new Date().toISOString();
      const callback: StoredCallback = { eventId: envelope.eventId, companyId: payload.companyId, runId, attempt,
        payloadSha256: envelope.payloadSha256, status: payload.status, acceptedAt };
      const current = run.resultJson && typeof run.resultJson === "object" && !Array.isArray(run.resultJson) ? run.resultJson : {};
      await tx.update(heartbeatRuns).set({
        status: payload.status,
        finishedAt: new Date(acceptedAt),
        error: payload.status === "failed" ? payload.errorCode ?? "agentos_runtime_failed" : null,
        errorCode: payload.status === "failed" ? payload.errorCode ?? "agentos_runtime_failed" : null,
        resultJson: { ...current, agentosRuntimeCallback: callback },
        updatedAt: new Date(acceptedAt),
      }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.companyId, payload.companyId)));
      await tx.insert(activityLog).values({
        companyId: payload.companyId,
        actorType: "agent",
        actorId: payload.agentId,
        action: "heartbeat.runtime_callback.accepted",
        entityType: "heartbeat_run",
        entityId: runId,
        agentId: payload.agentId,
        runId,
        details: {
          eventId: envelope.eventId,
          attempt,
          status: payload.status,
          payloadSha256: envelope.payloadSha256,
        },
      });
      return { kind: "accepted" as const, callback };
    });
    if (result.kind === "missing") return reject(res, 404, "run_not_found");
    if (result.kind === "conflict") return reject(res, 409, "callback_event_conflict");
    if (result.kind === "binding") return reject(res, 409, "callback_run_binding_mismatch");
    if (result.kind === "terminal") return reject(res, 409, "callback_run_already_terminal");
    return res.status(result.kind === "replay" ? 200 : 202).json(receipt(result.callback, result.kind === "replay"));
  });

  router.get("/agentos-runtime/v1/runs/:runId/attempts/:attempt/callbacks/:eventId", async (req, res) => {
    const config = readConfig(env);
    if (!config) return reject(res, 404, "callback_disabled");
    const runId = String(req.params.runId);
    const attempt = Number(req.params.attempt);
    const eventId = String(req.params.eventId);
    if (!UUID_RE.test(runId) || !UUID_RE.test(eventId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 100
      || !verifyBearer(req, config.token)) return reject(res, 401, "callback_unauthorized");
    const callback = await loadCallback(db, runId, eventId);
    if (!callback || callback.attempt !== attempt) return reject(res, 404, "callback_not_found");
    return res.json(receipt(callback));
  });

  // The normal heartbeat-run endpoint is board/session authenticated and may
  // redact the callback ledger from its projection.  The bridge therefore has
  // a narrow, bearer-authenticated readback that exposes only the terminal
  // status and immutable callback binding needed by AgentOS reconciliation.
  router.get("/agentos-runtime/v1/runs/:runId/attempts/:attempt/callbacks/:eventId/run", async (req, res) => {
    const config = readConfig(env);
    if (!config) return reject(res, 404, "callback_disabled");
    const runId = String(req.params.runId);
    const attempt = Number(req.params.attempt);
    const eventId = String(req.params.eventId);
    if (!UUID_RE.test(runId) || !UUID_RE.test(eventId) || !Number.isInteger(attempt) || attempt < 1 || attempt > 100
      || !verifyBearer(req, config.token)) return reject(res, 401, "callback_unauthorized");
    const run = await db.select({
      id: heartbeatRuns.id,
      companyId: heartbeatRuns.companyId,
      status: heartbeatRuns.status,
      resultJson: heartbeatRuns.resultJson,
    }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).then((rows) => rows[0] ?? null);
    if (!run) return reject(res, 404, "run_not_found");
    const callback = readStoredCallback(run.resultJson);
    if (!callback || callback.runId !== runId || callback.eventId !== eventId || callback.attempt !== attempt) {
      return reject(res, 404, "callback_not_found");
    }
    if (callback.companyId !== run.companyId) return reject(res, 409, "callback_run_binding_mismatch");
    return res.json({
      id: run.id,
      companyId: run.companyId,
      status: run.status,
      runtimeCallbackEventId: callback.eventId,
      runtimeCallbackStatus: callback.status,
      runtimeCallbackPayloadSha256: callback.payloadSha256,
    });
  });
  return router;
}

export const agentosRuntimeCallbackInternals = {
  stableJson,
  parseEnvelope,
  readConfig,
  verifySignature,
  callbackPath,
};
