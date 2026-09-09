import { and, eq, isNotNull, isNull, notExists, or, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRuns, workFolderRuns, type Db } from "@paperclipai/db";
import type { EnvironmentLease } from "@paperclipai/shared";

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : null;
}

export function hasLegacySandboxWorkspace(lease: Pick<EnvironmentLease, "metadata">) {
  return lease.metadata?.workFolderLayout === "legacy"
    || record(lease.metadata?.reusableSandboxLease)?.version === 1;
}

/** Keep the old sync/restore contract even after its provider sandbox expires. */
export async function taskUsesLegacySandboxWorkspace(db: Db, companyId: string, issueId: string | null) {
  if (!issueId) return false;
  const [previous] = await db.select({ id: environmentLeases.id }).from(environmentLeases)
    .innerJoin(heartbeatRuns, and(eq(heartbeatRuns.id, environmentLeases.heartbeatRunId), eq(heartbeatRuns.companyId, environmentLeases.companyId)))
    .leftJoin(workFolderRuns, eq(workFolderRuns.runId, heartbeatRuns.id))
    .where(and(eq(environmentLeases.companyId, companyId), eq(environmentLeases.issueId, issueId),
      sql`${environmentLeases.metadata}->>'driver' = 'sandbox'`,
      // A failed or interrupted old run may still have written valuable work.
      // New leases are marked scoped before preparation, so preparation failure
      // must not accidentally opt a new task into the compatibility path.
      sql`${environmentLeases.metadata}->>'workFolderLayout' is distinct from 'scoped'`,
      or(eq(heartbeatRuns.status, "succeeded"), isNotNull(heartbeatRuns.startedAt),
        sql`${environmentLeases.metadata}->'reusableSandboxLease'->>'version' = '1'`,
        sql`${environmentLeases.metadata}->>'workFolderLayout' = 'legacy'`),
      isNull(workFolderRuns.runId),
      notExists(db.select({ id: workFolderRuns.runId }).from(workFolderRuns).where(and(
        eq(workFolderRuns.companyId, companyId), sql`${workFolderRuns.manifest}->>'taskId' = ${issueId}`))))).limit(1);
  return Boolean(previous);
}

/** Recover the missing identity from host records, never from provider claims. */
export async function bindLegacySandboxIdentity(db: Db, lease: EnvironmentLease): Promise<EnvironmentLease> {
  const scope = record(lease.metadata?.reusableSandboxLease);
  if (scope?.version !== 1 || !lease.heartbeatRunId) return lease;
  const [run] = await db.select({ agentId: heartbeatRuns.agentId,
    responsibleUserId: heartbeatRuns.responsibleUserId, context: heartbeatRuns.contextSnapshot })
    .from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, lease.companyId), eq(heartbeatRuns.id, lease.heartbeatRunId)));
  if (!run || run.agentId !== scope.agentId || scope.companyId !== lease.companyId) return lease;
  const context = run.context ?? {};
  const taskIds = [lease.issueId, context.issueId, context.taskId, context.taskKey]
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  if (new Set(taskIds).size > 1) return lease;
  const issueId = taskIds[0] ?? null;
  return { ...lease, metadata: { ...lease.metadata, workFolderLayout: "legacy",
    reusableSandboxLease: { ...scope, version: 2, responsibleUserId: run.responsibleUserId, issueId } } };
}
