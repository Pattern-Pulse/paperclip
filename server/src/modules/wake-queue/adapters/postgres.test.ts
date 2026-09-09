import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  agentWakeupRequests,
  agents,
  companies,
  createDb,
  heartbeatRuns,
  issueComments,
  issues,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "../../../__tests__/helpers/embedded-postgres.js";
import { createPostgresWakeQueueAdapter } from "./postgres.js";
import type { WakeQueuePostgresAdapterDeps } from "./postgres.js";

// Proves the atomicity and company-scope properties the security review
// requires: every mutation names `companyId` in its own SQL `WHERE` clause,
// a foreign-company row is invisible to a read, and a deferred-status
// compare-and-set that affects no row leaves no other trace. The decision
// branching itself is proven against plain facts in `domain/policy.test.ts`.
const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres wake-queue adapter tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("wake-queue postgres adapter", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  const stubDeps: WakeQueuePostgresAdapterDeps = {
    resolveResponsibleUserId: async () => "responsible-user",
    getRoutineEnv: async () => ({ routineId: null, env: null, responsibleUserId: null }),
    resolveSessionBeforeForWakeup: async () => null,
  };

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-wake-queue-postgres-adapter-");
    db = createDb(tempDb.connectionString);
  }, 20_000);

  afterEach(async () => {
    await db.delete(issueComments);
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(heartbeatRuns);
    await db.delete(agents);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedCompany(): Promise<string> {
    const companyId = randomUUID();
    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });
    return companyId;
  }

  async function seedAgent(input: { companyId: string; name?: string }): Promise<string> {
    const agentId = randomUUID();
    await db.insert(agents).values({
      id: agentId,
      companyId: input.companyId,
      name: input.name ?? "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    return agentId;
  }

  async function seedIssue(input: {
    companyId: string;
    issueId?: string;
    status?: string;
    assigneeAgentId?: string | null;
    executionRunId?: string | null;
    checkoutRunId?: string | null;
  }): Promise<string> {
    const issueId = input.issueId ?? randomUUID();
    await db.insert(issues).values({
      id: issueId,
      companyId: input.companyId,
      title: "Wake-queue adapter fixture issue",
      status: input.status ?? "in_progress",
      priority: "medium",
      assigneeAgentId: input.assigneeAgentId ?? null,
      executionRunId: input.executionRunId ?? null,
      checkoutRunId: input.checkoutRunId ?? null,
    });
    return issueId;
  }

  async function seedRun(input: {
    companyId: string;
    agentId: string;
    status?: string;
    contextSnapshot?: Record<string, unknown>;
    errorCode?: string | null;
    runtimeMode?: string;
  }): Promise<string> {
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "on_demand",
      status: input.status ?? "failed",
      contextSnapshot: input.contextSnapshot ?? {},
      errorCode: input.errorCode ?? null,
    });
    return runId;
  }

  async function seedDeferredWake(input: {
    companyId: string;
    agentId: string;
    issueId: string;
    requestedByActorType?: string;
    requestedByActorId?: string | null;
    payload?: Record<string, unknown>;
  }): Promise<string> {
    const id = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id,
      companyId: input.companyId,
      agentId: input.agentId,
      source: "automation",
      reason: "issue_commented",
      status: "deferred_issue_execution",
      requestedByActorType: input.requestedByActorType ?? "user",
      requestedByActorId: input.requestedByActorId ?? null,
      payload: { issueId: input.issueId, ...(input.payload ?? {}) },
    });
    return id;
  }

  // Review test (a): a foreign-company agent id produces the current failed
  // wake status and the current error text, and creates no run.
  it("fails a deferred wake whose agent belongs to a different company, without creating a run", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const foreignAgentId = await seedAgent({ companyId: otherCompanyId });
    const finishingAgentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: finishingAgentId, status: "in_progress" });
    const runId = await seedRun({ companyId, agentId: finishingAgentId, contextSnapshot: { issueId } });
    await db.update(issues).set({ executionRunId: runId }).where(eq(issues.id, issueId));
    const wakeId = await seedDeferredWake({ companyId, agentId: foreignAgentId, issueId });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (locked, ports) => {
      const candidate = await ports.writer.claimNextDeferredWake({ companyId, issueId: locked.primaryIssue.id });
      expect(candidate?.id).toBe(wakeId);
      const agent = await ports.reader.findInvokableAgent({ companyId, agentId: foreignAgentId });
      expect(agent).toBeNull();
      const failed = await ports.writer.failDeferredWake({ companyId, wakeId: candidate!.id, now: new Date() });
      expect(failed).toBe(true);
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result.outcome.kind).toBe("released");

    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("failed");
    expect(wakeRow?.error).toBe("Deferred wake could not be promoted: agent is not invokable");
    expect(wakeRow?.runId).toBeNull();
    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
  });

  // Review test (b): each release adapter mutation with a foreign company
  // affects no row.
  it("scopes every release mutation to its own company and affects no row across a company boundary", async () => {
    const companyId = await seedCompany();
    const otherCompanyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    await adapter.withIssueExecutionLock(
      { companyId, runId: (await seedRun({ companyId, agentId, contextSnapshot: { issueId } })), now: new Date() },
      async (_locked, ports) => {
        const cancelledUnderWrongCompany = await ports.writer.cancelDeferredWake({
          companyId: otherCompanyId,
          wakeId,
          reason: "cross-company cancel attempt",
          now: new Date(),
        });
        expect(cancelledUnderWrongCompany).toBe(false);

        const failedUnderWrongCompany = await ports.writer.failDeferredWake({
          companyId: otherCompanyId,
          wakeId,
          now: new Date(),
        });
        expect(failedUnderWrongCompany).toBe(false);

        const normalizedUnderWrongCompany = await ports.writer.normalizeDeferredWakeCommentIds({
          companyId: otherCompanyId,
          wakeId,
          payload: { issueId },
          liveCommentIds: ["c1"],
          now: new Date(),
        });
        expect(normalizedUnderWrongCompany).toBeNull();

        return { outcome: { kind: "released" as const }, postCommitEffects: [] };
      },
    );

    const wakeRow = (await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, wakeId)))[0];
    expect(wakeRow?.status).toBe("deferred_issue_execution");
    expect(wakeRow?.error).toBeNull();
  });

  // Review test (c): a deferred-status compare-and-set that affects no row
  // rolls the transaction back, and creates no run and no issue lock.
  it("rolls back the promotion when the deferred-status compare-and-set loses the race", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId });
    const wakeId = await seedDeferredWake({ companyId, agentId, issueId });
    // A concurrent finalization already claimed this wake before the promote write runs.
    await db.update(agentWakeupRequests).set({ status: "cancelled" }).where(eq(agentWakeupRequests.id, wakeId));

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const runId = await seedRun({ companyId, agentId, contextSnapshot: { issueId } });
    const result = await adapter.withIssueExecutionLock({ companyId, runId, now: new Date() }, async (locked, ports) => {
      const promoted = await ports.writer.promoteDeferredWake({
        companyId,
        wakeId,
        deferredAgent: { id: agentId, companyId, name: "CodexCoder", invokable: true },
        issue: locked.primaryIssue,
        finishingRun: locked.run,
        contextSnapshot: { issueId },
        reason: "issue_execution_promoted",
        source: "automation",
        triggerDetail: null,
        payload: {},
        responsibleUserId: "responsible-user",
        sessionBefore: null,
        now: new Date(),
      });
      expect(promoted).toBeNull();
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    expect(result.outcome.kind).toBe("released");

    const runs = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
    expect(runs).toHaveLength(1);
    expect(runs[0]!.id).toBe(runId);
    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    expect(issueRow?.executionRunId).toBeNull();
  });

  it("locks the context issue and every sibling issue in id order, and two concurrent releases do not deadlock", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const issueA = await seedIssue({ companyId, assigneeAgentId: agentId });
    const issueB = await seedIssue({ companyId, assigneeAgentId: agentId });
    const runA = await seedRun({ companyId, agentId, contextSnapshot: { issueId: issueA } });
    const runB = await seedRun({ companyId, agentId, contextSnapshot: { issueId: issueB } });
    await db.update(issues).set({ executionRunId: runA, checkoutRunId: runB }).where(eq(issues.id, issueA));
    await db.update(issues).set({ executionRunId: runB, checkoutRunId: runA }).where(eq(issues.id, issueB));

    const adapterA = createPostgresWakeQueueAdapter(db, stubDeps);
    const adapterB = createPostgresWakeQueueAdapter(db, stubDeps);
    const releaseA = adapterA.withIssueExecutionLock({ companyId, runId: runA, now: new Date() }, async (_locked, _ports) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });
    const releaseB = adapterB.withIssueExecutionLock({ companyId, runId: runB, now: new Date() }, async (_locked, _ports) => {
      await new Promise((resolve) => setTimeout(resolve, 25));
      return { outcome: { kind: "released" as const }, postCommitEffects: [] };
    });

    await expect(Promise.all([releaseA, releaseB])).resolves.toBeDefined();

    const rows = await db.select().from(issues).where(eq(issues.companyId, companyId));
    for (const row of rows) {
      expect(row.executionRunId).toBeNull();
      expect(row.checkoutRunId).toBeNull();
    }
  });

  it("clears both lock columns on every sibling and keeps a transferred executionRunId", async () => {
    const companyId = await seedCompany();
    const agentId = await seedAgent({ companyId });
    const finishingRunId = await seedRun({ companyId, agentId, contextSnapshot: {} });
    const retryRunId = await seedRun({ companyId, agentId, contextSnapshot: {}, status: "queued" });
    const issueId = await seedIssue({ companyId, assigneeAgentId: agentId, executionRunId: retryRunId, checkoutRunId: finishingRunId });

    const adapter = createPostgresWakeQueueAdapter(db, stubDeps);
    const result = await adapter.withIssueExecutionLock({ companyId, runId: finishingRunId, now: new Date() }, async () => ({
      outcome: { kind: "released" as const },
      postCommitEffects: [],
    }));
    expect(result.outcome.kind).toBe("released");

    const issueRow = (await db.select().from(issues).where(eq(issues.id, issueId)))[0];
    // executionRunId already pointed at the retry, not the finishing run, so it must survive.
    expect(issueRow?.executionRunId).toBe(retryRunId);
    expect(issueRow?.checkoutRunId).toBeNull();
  });
});
