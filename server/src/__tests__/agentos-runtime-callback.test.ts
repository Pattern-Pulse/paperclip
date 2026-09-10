import express from "express";
import request from "supertest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issues } from "@paperclipai/db";
import { agentosRuntimeCallbackInternals, agentosRuntimeCallbackRoutes } from "../routes/agentos-runtime.js";

const runId = "11111111-1111-4111-8111-111111111111";
const companyId = "22222222-2222-4222-8222-222222222222";
const agentId = "33333333-3333-4333-8333-333333333333";
const issueId = "44444444-4444-4444-8444-444444444444";
const eventId = "55555555-5555-4555-8555-555555555555";
const token = "callback-token";
const secret = "01234567890123456789012345678901";
const keyId = "agentos-runtime-v1";

function payload(overrides: Record<string, unknown> = {}) {
  const value: Record<string, unknown> = {
    version: "paperclip-runtime-callback/v1",
    companyId,
    runId,
    attempt: 1,
    issueId,
    agentId,
    status: "succeeded",
    outputSha256: "a".repeat(64),
    result: "ok",
    disposition: "done",
    ...overrides,
  };
  if (value.status === "failed") {
    delete value.outputSha256;
    delete value.result;
    delete value.disposition;
  }
  return value;
}

async function signedBody(overrides: Record<string, unknown> = {}) {
  const { createHash, createHmac } = await import("node:crypto");
  const bodyPayload = payload(overrides);
  const payloadSha256 = createHash("sha256").update(agentosRuntimeCallbackInternals.stableJson(bodyPayload)).digest("hex");
  const body = JSON.stringify({ eventId, payloadSha256, payload: bodyPayload });
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = agentosRuntimeCallbackInternals.callbackPath(runId, 1);
  const bodyHash = createHash("sha256").update(body).digest("hex");
  const signature = `v1;kid=${keyId};ts=${timestamp};sig=${createHmac("sha256", secret)
    .update(`v1\nPOST\n${path}\n${timestamp}\n${bodyHash}`).digest("hex")}`;
  return { body, signature };
}

function createApp(options: { initialStatus?: string; failAudit?: boolean; issuePresent?: boolean; issueUpdateRows?: number } = {}) {
  const run: Record<string, unknown> = {
    id: runId, companyId, agentId, contextSnapshot: { issueId }, status: options.initialStatus ?? "queued", resultJson: null,
  };
  const issue: Record<string, unknown> = { id: issueId, companyId, status: "in_progress", assigneeAgentId: agentId, assigneeUserId: null, checkoutRunId: runId, executionRunId: runId };
  const activityEntries: unknown[] = [];
  const queryFor = (table: unknown) => ({
    from: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    for: vi.fn().mockReturnThis(),
    then: (resolve: (rows: unknown[]) => unknown) => Promise.resolve(table === issues ? (options.issuePresent === false ? [] : [issue]) : [run]).then(resolve),
  });
  const db = {
    select: vi.fn(() => queryFor(undefined)),
    transaction: vi.fn(async (callback: (tx: unknown) => unknown) => {
      const snapshot = { ...run };
      const activityCount = activityEntries.length;
      try {
        return await callback({
      select: vi.fn((selection: Record<string, unknown>) => {
        const table = Object.values(selection).some((column) => column === issues.id || column === issues.status) ? issues : undefined;
        return queryFor(table);
      }),
      update: vi.fn((table: unknown) => ({
        set: vi.fn((values: Record<string, unknown>) => {
          const isIssueUpdate = table === issues;
          const whereResult = isIssueUpdate
            ? Array.from({ length: options.issueUpdateRows ?? 1 }, () => ({ id: issueId }))
            : { rowCount: 1 };
          const whereBuilder = {
            returning: vi.fn(async () => {
              if (options.issueUpdateRows !== undefined) return Array.from({ length: options.issueUpdateRows }, () => ({ id: issueId }));
              Object.assign(issue, values);
              return [{ id: issueId }];
            }),
            then: (resolve: (value: unknown) => unknown) => Promise.resolve(whereResult).then(resolve),
          };
          const builder = {
            where: vi.fn(() => {
              if (!isIssueUpdate) Object.assign(run, values);
              return whereBuilder;
            }),
          };
          return builder;
        }),
      })),
          insert: vi.fn(() => ({ values: vi.fn(async (values: unknown) => {
            if (options.failAudit) throw new Error("audit insert failed");
            activityEntries.push(values);
            return { rowCount: 1 };
          }) })),
        });
      } catch (error) {
        for (const key of Object.keys(run)) delete run[key];
        Object.assign(run, snapshot);
        activityEntries.splice(activityCount);
        throw error;
      }
    }),
  };
  const app = express();
  const captureRawBody = (req: express.Request, _res: express.Response, buf: Buffer) => {
    (req as express.Request & { rawBody?: Buffer }).rawBody = buf;
  };
  app.use(
    "/api/agentos-runtime/v1/runs/:runId/attempts/:attempt/callbacks",
    express.raw({ type: "application/json", limit: "64kb", verify: captureRawBody }),
  );
  app.use("/api", agentosRuntimeCallbackRoutes(db as never, {
    PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_TOKEN: token,
    PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_SIGNING_SECRET: secret,
    PAPERCLIP_AGENTOS_RUNTIME_CALLBACK_SIGNING_KEY_ID: keyId,
  }, {
    projectIssueDisposition: async (_tx, input) => {
      if (options.issuePresent === false) return null;
      if (options.issueUpdateRows === 0) return null;
      issue.status = "done";
      return { id: input.issueId, status: "done" };
    },
  }));
  app.use(express.json({ verify: captureRawBody }));
  return { app, run, issue, activityEntries };
}

afterEach(() => vi.restoreAllMocks());

describe("AgentOS runtime callback receiver", () => {
  it("validates the explicit done disposition and structured result", async () => {
    const done = await signedBody({ disposition: "done" });
    expect(agentosRuntimeCallbackInternals.parseEnvelope(JSON.parse(done.body))).not.toBeNull();
    const unsupported = await signedBody({ disposition: "in_review" });
    expect(agentosRuntimeCallbackInternals.parseEnvelope(JSON.parse(unsupported.body))).toBeNull();
    const missingResult = await signedBody({ result: "" });
    expect(agentosRuntimeCallbackInternals.parseEnvelope(JSON.parse(missingResult.body))).toBeNull();
  });

  it("accepts a signed callback, projects terminal status, and returns the same receipt on replay", async () => {
    const { app, run } = createApp();
    const signed = await signedBody({ disposition: "done" });
    const first = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
    .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ accepted: true, eventId, status: "succeeded", replay: false });
    expect(run.status).toBe("succeeded");
    expect(run.error).toBeNull();
    expect(run.errorCode).toBeNull();

    const replay = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ accepted: true, eventId, replay: true });

    const readback = await request(app)
      .get(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks/${eventId}`)
      .set("authorization", `Bearer ${token}`);
    expect(readback.status).toBe(200);
    expect(readback.body).toMatchObject({ accepted: true, eventId, status: "succeeded" });

    const runReadback = await request(app)
      .get(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks/${eventId}/run`)
      .set("authorization", `Bearer ${token}`);
    expect(runReadback.status).toBe(200);
    expect(runReadback.body).toMatchObject({
      id: runId,
      companyId,
      status: "succeeded",
      runtimeCallbackEventId: eventId,
      runtimeCallbackStatus: "succeeded",
      runtimeCallbackResult: "ok",
      runtimeCallbackDisposition: "done",
    });
  });

  it("rolls back the run and audit when the disposition issue is missing", async () => {
    const { app, run, activityEntries } = createApp({ issuePresent: false });
    const signed = await signedBody({ disposition: "done" });
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("callback_issue_not_found");
    expect(run.status).toBe("queued");
    expect(run.resultJson).toBeNull();
    expect(activityEntries).toHaveLength(0);
  });

  it("rolls back the run and audit when the disposition update loses its row", async () => {
    const { app, run, activityEntries } = createApp({ issueUpdateRows: 0 });
    const signed = await signedBody({ disposition: "done" });
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("callback_issue_update_conflict");
    expect(run.status).toBe("queued");
    expect(run.resultJson).toBeNull();
    expect(activityEntries).toHaveLength(0);
  });

  it("rejects a callback after the issue has been taken by another run", async () => {
    const { app, run, issue, activityEntries } = createApp();
    issue.executionRunId = "66666666-6666-4666-8666-666666666666";
    const signed = await signedBody({ disposition: "done" });
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("callback_issue_authority_conflict");
    expect(run.status).toBe("queued");
    expect(run.resultJson).toBeNull();
    expect(activityEntries).toHaveLength(0);
  });

  it("projects a failed callback to both canonical error fields and audits it", async () => {
    const { app, run, activityEntries } = createApp();
    const failed = await signedBody({ status: "failed", errorCode: "provider_quota" });
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", failed.signature)
      .send(failed.body);
    expect(response.status).toBe(202);
    expect(run.status).toBe("failed");
    expect(run.error).toBe("provider_quota");
    expect(run.errorCode).toBe("provider_quota");
    expect(activityEntries).toHaveLength(1);
  });

  it("fails closed when a stored callback is bound to another run", async () => {
    const { app, run } = createApp();
    const signed = await signedBody();
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(202);
    const stored = run.resultJson as { agentosRuntimeCallback: { runId: string } };
    stored.agentosRuntimeCallback.runId = "66666666-6666-4666-8666-666666666666";

    const readback = await request(app)
      .get(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks/${eventId}/run`)
      .set("authorization", `Bearer ${token}`);
    expect(readback.status).toBe(404);
    expect(readback.body.error).toBe("callback_not_found");
  });

  it("rejects a tampered callback body with an invalid signature", async () => {
    const { app } = createApp();
    const signed = await signedBody();
    const tamperedBody = signed.body.replace("a".repeat(64), "b".repeat(64));
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(tamperedBody);
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("callback_unauthorized");
  });

  it("rejects a callback whose idempotency key is not the event id", async () => {
    const { app } = createApp();
    const signed = await signedBody();
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", "66666666-6666-4666-8666-666666666666")
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(400);
    expect(response.body.error).toBe("idempotency_key_mismatch");
  });

  it("checks an invalid signature before interpreting malformed JSON", async () => {
    const { app } = createApp();
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("x-agentos-paperclip-signature", "v1;kid=agentos-runtime-v1;ts=1;sig=" + "0".repeat(64))
      .send("{not-json");
    expect(response.status).toBe(401);
    expect(response.body.error).toBe("callback_unauthorized");
  });

  it("rejects an oversized callback at the route-scoped raw-body limit", async () => {
    const { app } = createApp();
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .send(JSON.stringify({ padding: "x".repeat(70 * 1024) }));
    expect(response.status).toBe(413);
  });

  it("rejects a company mismatch without status or audit mutation", async () => {
    const { app, run, activityEntries } = createApp();
    const signed = await signedBody({ companyId: "66666666-6666-4666-8666-666666666666" });
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("callback_run_binding_mismatch");
    expect(run.status).toBe("queued");
    expect(run.resultJson).toBeNull();
    expect(activityEntries).toHaveLength(0);
  });

  it("rolls back the status projection when the audit insert fails", async () => {
    const { app, run, activityEntries } = createApp({ failAudit: true });
    const signed = await signedBody();
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(500);
    expect(run.status).toBe("queued");
    expect(run.resultJson).toBeNull();
    expect(activityEntries).toHaveLength(0);
  });

  it("rejects a terminal run without changing it", async () => {
    const { app, run, activityEntries } = createApp({ initialStatus: "succeeded" });
    const signed = await signedBody();
    const response = await request(app)
      .post(`/api/agentos-runtime/v1/runs/${runId}/attempts/1/callbacks`)
      .set("content-type", "application/json")
      .set("authorization", `Bearer ${token}`)
      .set("idempotency-key", eventId)
      .set("x-agentos-paperclip-signature", signed.signature)
      .send(signed.body);
    expect(response.status).toBe(409);
    expect(response.body.error).toBe("callback_run_already_terminal");
    expect(run.status).toBe("succeeded");
    expect(run.resultJson).toBeNull();
    expect(activityEntries).toHaveLength(0);
  });
});
