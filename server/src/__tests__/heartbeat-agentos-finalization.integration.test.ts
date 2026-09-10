import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  agentWakeupRequests,
  companies,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  projects,
} from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import {
  heartbeatService,
} from "../services/heartbeat.ts";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { buildAgentOsRuntimeContract } from "../adapters/agentos-runtime/contract.js";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping AgentOS finalization integration tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("AgentOS callback terminalization finalizer", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let callbackIssueId: string | null = null;

  const callbackError = "AgentOS provider rejected the controlled run";
  const callbackErrorCode = "agentos_provider_rejected";
  const agentOsExecute = vi.fn<ServerAdapterModule["execute"]>(async ({ runId }) => {
    if (!callbackIssueId) {
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "generic test adapter success",
        resultJson: {},
      };
    }

    // Model the signed AgentOS callback receiver terminalizing Paperclip before
    // the adapter HTTP request returns. The production finalizer must preserve
    // these fields and still run its normal wakeup/issue/agent cleanup.
    await db
      .update(issues)
      .set({ executionRunId: runId, updatedAt: new Date() })
      .where(eq(issues.id, callbackIssueId));
    await db
      .update(heartbeatRuns)
      .set({
        status: "failed",
        error: callbackError,
        errorCode: callbackErrorCode,
        finishedAt: new Date(),
        resultJson: {
          agentosRuntimeCallback: {
            version: "agentos-runtime-callback.v1",
            state: "failed",
            source: "agentos",
          },
        },
        updatedAt: new Date(),
      })
      .where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "running")));

    return {
      exitCode: 1,
      signal: null,
      timedOut: false,
      errorMessage: "Adapter failed",
      errorCode: "adapter_failed",
      summary: "Generic adapter failure that must not replace callback evidence.",
      resultJson: { adapterResult: "generic" },
    };
  });

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-agentos-finalization-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({
      type: "agentos_runtime",
      runtimeToolDelivery: "invocation_context",
      supportsLocalAgentJwt: false,
      execute: agentOsExecute,
    });
  }, 30_000);

  afterEach(async () => {
    await heartbeat.drainActiveRunExecutions();
    await db.execute(sql.raw(`
      TRUNCATE TABLE
        "heartbeat_run_events",
        "heartbeat_runs",
        "agent_wakeup_requests",
        "issues",
        "agents",
        "companies"
      RESTART IDENTITY CASCADE
    `));
    callbackIssueId = null;
    agentOsExecute.mockClear();
    delete process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID;
  });

  afterAll(async () => {
    unregisterServerAdapter("agentos_runtime");
    await tempDb?.cleanup();
  }, 30_000);

  async function waitForRunToFinish(runId: string) {
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline) {
      const current = await heartbeat.getRun(runId, { unsafeFullResultJson: true });
      if (current && !["queued", "running"].includes(current.status)) return current;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return heartbeat.getRun(runId, { unsafeFullResultJson: true });
  }

  it("preserves callback failure evidence while completing the normal finalizer once", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    callbackIssueId = issueId;

    await db.insert(companies).values({
      id: companyId,
      name: "AgentOS callback test",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AgentOS test agent",
      role: "engineer",
      status: "idle",
      adapterType: "agentos_runtime",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "AgentOS callback finalization",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    const queued = await heartbeat.invoke(
      agentId,
      "on_demand",
      { issueId },
      "manual",
    );
    expect(queued).not.toBeNull();
    await waitForRunToFinish(queued!.id);
    await heartbeat.drainActiveRunExecutions();
    const finished = await heartbeat.getRun(queued!.id, { unsafeFullResultJson: true });

    expect(agentOsExecute).toHaveBeenCalledOnce();
    expect(finished).toMatchObject({
      status: "failed",
      error: callbackError,
      errorCode: callbackErrorCode,
    });
    const resultJson = finished?.resultJson as Record<string, unknown> | null;
    expect(resultJson?.agentosRuntimeCallback)
      .toMatchObject({ state: "failed", source: "agentos" });
    expect(resultJson?.adapterResult).toBe("generic");

    const [wakeup] = await db
      .select({ status: agentWakeupRequests.status, error: agentWakeupRequests.error })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.runId, queued!.id));
    expect(wakeup).toMatchObject({ status: "failed", error: callbackError });

    const [agent] = await db
      .select({ status: agents.status, errorReason: agents.errorReason })
      .from(agents)
      .where(eq(agents.id, agentId));
    expect(agent).toMatchObject({ status: "error", errorReason: callbackError });

    const [issue] = await db
      .select({ executionRunId: issues.executionRunId, checkoutRunId: issues.checkoutRunId })
      .from(issues)
      .where(eq(issues.id, issueId));
    expect(issue).toMatchObject({ executionRunId: null, checkoutRunId: null });

    const lifecycleEvents = await db
      .select({ message: heartbeatRunEvents.message })
      .from(heartbeatRunEvents)
      .where(
        and(
          eq(heartbeatRunEvents.runId, queued!.id),
          eq(heartbeatRunEvents.eventType, "lifecycle"),
        ),
      );
    expect(lifecycleEvents.filter((event) => event.message === "run failed")).toHaveLength(1);
  });

  it("binds a normal issueId wake to the database-owned project before the runtime contract is built", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const projectId = randomUUID();
    const issueId = randomUUID();
    let adapterContext: Record<string, unknown> | null = null;

    await db.insert(companies).values({
      id: companyId,
      name: "AgentOS runtime context test",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Runtime context binding",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "AgentOS runtime context agent",
      role: "engineer",
      status: "idle",
      adapterType: "agentos_runtime",
      adapterConfig: {},
      runtimeConfig: {},
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      projectId,
      title: "Normal issue wake",
      status: "in_progress",
      priority: "high",
      assigneeAgentId: agentId,
    });

    agentOsExecute.mockImplementationOnce(async (ctx) => {
      adapterContext = { ...ctx.context };
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        summary: "runtime context captured",
        resultJson: {},
      };
    });

    const queued = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
    expect(queued).not.toBeNull();
    await waitForRunToFinish(queued!.id);
    await heartbeat.drainActiveRunExecutions();

    expect(adapterContext).not.toBeNull();
    expect(adapterContext).toMatchObject({
      issueId,
      taskId: issueId,
      projectId,
    });
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    const contract = buildAgentOsRuntimeContract({
      runId: queued!.id,
      attempt: 1,
      agentId,
      companyId,
      config: {
        projectId,
        issueId,
        agentOsAgentId: "chief-of-staff",
        ownerHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        provider: "codex",
        model: "gpt-5.3-codex",
        providerConnectionEpoch: randomUUID(),
        revision: 1,
        capabilities: ["adapter:codex"],
      },
      context: adapterContext ?? {},
    });
    expect(contract.scope).toMatchObject({ projectId, issueId });
  });
});
