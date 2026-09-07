import { randomUUID } from "node:crypto";
import { test, expect } from "@playwright/test";
import type { EnvironmentCapabilities } from "../../packages/shared/src/environment-support.js";
import type { WorkFolderListing, WorkFolderSyncStatus } from "../../packages/shared/src/work-folders.js";
import { QUALIFIED_ACPX_PROFILES } from "../../packages/paperclip-runner/src/drivers/acpx/qualified-profiles.js";
import { pollUntil } from "./api.js";
import { DeployedStackApi, loadDeployedStack } from "./deployed-stack.js";

const stack = loadDeployedStack();
const api = new DeployedStackApi(stack);
const folder = (scope: string, ownerId: string) => `/api/companies/${stack.companyId}/work-folders/${scope}/${encodeURIComponent(ownerId)}`;
test.beforeAll(async () => {
  const health = await api.json<{ commit: string }>("/api/health");
  expect(health.commit, "Only exercise the declared deployed candidate").toBe(stack.commit);
});

test("deployed candidate and complete supported adapter inventory", async ({}, info) => {
  const health = await api.json<{ commit: string }>("/api/health");
  expect(health.commit).toBe(stack.commit);
  const capabilities = await api.json<EnvironmentCapabilities>(`/api/companies/${stack.companyId}/environments/capabilities`);
  expect(capabilities.sandboxProviders.daytona?.supportsRunExecution).toBe(true);
  const adapters = await api.json<Array<{ type: string; disabled: boolean; capabilities: { supportsAcp: boolean } }>>("/api/adapters");
  const required: string[] = [];
  const excluded = new Set(stack.excludedAdapters?.map((entry) => entry.adapterType));
  for (const adapter of adapters.filter((entry) => !entry.disabled && !excluded.has(entry.type))) {
    if (capabilities.adapters.find((entry) => entry.adapterType === adapter.type)?.drivers.sandbox !== "supported") continue;
    if (adapter.type === "paperclip_runner") {
      required.push("paperclip_runner:codex", "paperclip_runner:opencode",
        ...Object.keys(QUALIFIED_ACPX_PROFILES).map((name) => `paperclip_runner:acpx:${name}`));
    } else {
      required.push(`${adapter.type}:cli`);
      if (adapter.capabilities.supportsAcp) required.push(`${adapter.type}:acp`);
    }
  }
  const configured = new Set(stack.profiles.map((profile) => `${profile.adapterType}:${profile.engine}`));
  expect(required.filter((key) => !configured.has(key)), "Every exposed sandbox adapter/engine requires a qualified fixture").toEqual([]);
  for (const profile of stack.profiles) {
    const agent = await api.json<{ adapterType: string; adapterConfig: Record<string, unknown> }>(`/api/agents/${profile.agentId}`);
    expect(agent.adapterType).toBe(profile.adapterType);
    expect(agent.adapterConfig.model).toBe(profile.model);
  }
  await info.attach("deployed-candidate-and-inventory", { contentType: "application/json", body: Buffer.from(JSON.stringify({ stack, required }, null, 2)) });
});

for (const [scope, owner] of [["task", stack.taskId], ["agent", stack.agentId], ["project", stack.projectId], ["user", stack.userId]]) {
  test(`${scope} nested empty executable files, retry, trash and restoration`, async () => {
    const base = folder(scope!, owner!);
    const filename = `acceptance/${randomUUID()}/empty.sh`;
    const key = randomUUID();
    const write = () => api.request(`${base}/content?path=${encodeURIComponent(filename)}`, {
      method: "PUT", headers: { "Content-Type": "application/octet-stream", "X-File-Executable": "true", "Idempotency-Key": key }, body: "",
    });
    expect((await write()).ok).toBe(true);
    expect((await write()).ok).toBe(true);
    const listing = await api.json<WorkFolderListing>(base);
    const file = listing.files.find((entry) => entry.path === filename)!;
    expect(file).toMatchObject({ byteSize: 0, executable: true, deletedAt: null });
    const download = await api.request(`${base}/content?path=${encodeURIComponent(filename)}`);
    expect(download.status).toBe(200); expect((await download.arrayBuffer()).byteLength).toBe(0);
    await api.json(`${base}/operations`, "POST", { action: "delete", path: filename });
    expect((await api.request(`${base}/content?path=${encodeURIComponent(filename)}`)).status).toBe(404);
    const trash = await api.json<WorkFolderListing>(`${base}?trash=true`);
    expect(trash.files.some((entry) => entry.id === file.id)).toBe(true);
    await api.json(`${base}/operations`, "POST", { action: "restore", fileId: file.id });
    expect((await api.request(`${base}/content?path=${encodeURIComponent(filename)}`)).status).toBe(200);
  });
}

for (const profile of stack.profiles) {
  test(`${profile.id} preserves task-specific repo and file state across cold and warm runs`, async ({}, info) => {
    test.setTimeout(1_800_000);
    const nonce = randomUUID();
    const issue = await api.json<{ id: string; identifier: string }>(`/api/companies/${stack.companyId}/issues`, "POST", {
      title: `Work folder acceptance ${profile.id} ${nonce}`, projectId: stack.projectId,
      assigneeAgentId: profile.agentId, status: "todo",
      description: [
        "Perform this sandbox acceptance task using real filesystem tools.",
        "Verify cwd equals the operating-system HOME and task, agent, user, project, repos, .codex, .cache are directories beneath it.",
        "Verify repos contains at least two independent Git checkouts. Fail the task with the actual error if either assertion fails.",
        "In each repo, assert .acceptance-owner does not exist (another task must not share this checkout).",
        `In each repo write '${nonce}' without a newline to .acceptance-owner, git add ONLY that file, and create a local commit using git -c user.name=Acceptance -c user.email=acceptance@example.invalid commit -m acceptance. Do not push.`,
        "Save each repo's HEAD to $HOME/task/head-<repo-directory-name>.txt.",
        "In each repo write 'staged' without newline to .acceptance-state, git add ONLY that file, then replace its working-tree content with 'unstaged' without newline. Write 'untracked' without newline to .acceptance-untracked and leave it untracked.",
        "If .acceptance-setup-count exists, assert it has exactly one line. Never run setup yourself.",
        `Write exactly '${nonce}' without a newline into $HOME/task/acceptance.txt and $HOME/agent/acceptance-${nonce}.txt.`,
        "Then complete this task successfully. Do not print credentials or modify unrelated files.",
      ].join("\n"),
    });
    await info.attach("task", { contentType: "application/json", body: Buffer.from(JSON.stringify({ profile: profile.id, ...issue })) });
    const base = folder("task", issue.id);
    const cold = await pollUntil({ label: `${profile.id} completed run and durable task file`, deadlineAt: Date.now() + 840_000,
      intervalMs: 5_000,
      load: async () => ({ issue: await api.json<{ status: string }>(`/api/issues/${issue.id}`),
        saves: await api.json<WorkFolderSyncStatus[]>(`${base}/sync`) }),
      accept: (state) => state.issue.status === "done" && state.saves.some((save) => !save.active && save.state === "saved" && save.lastSavedAt !== null),
      reject: (state) => state.saves.some((save) => save.state === "failed") ? "Work-folder save failed"
        : state.issue.status === "blocked" || state.issue.status === "cancelled" ? `Task ${issue.identifier} ended ${state.issue.status}` : undefined,
    });
    const content = await api.request(`${base}/content?path=acceptance.txt`);
    expect(content.status).toBe(200); expect(await content.text()).toBe(nonce);
    const coldRunIds = new Set(cold.saves.map((save) => save.runId));
    await api.json(`/api/issues/${issue.id}`, "PATCH", { status: "todo", description: [
      "Continue this sandbox acceptance task. This is a warm run; inspect the existing work without repairing it.",
      "Verify cwd equals HOME and all seven directories still exist.",
      `Assert $HOME/task/acceptance.txt and every repo's committed HEAD:.acceptance-owner equal '${nonce}'.`,
      "For each repo assert HEAD equals the saved task/head-<repo-directory-name>.txt, index :.acceptance-state equals 'staged', working .acceptance-state equals 'unstaged', and .acceptance-untracked equals 'untracked' and remains untracked.",
      "If .acceptance-setup-count exists, assert exactly one line. Fail with the actual discrepancy; do not recreate missing state or rerun setup.",
      `Write exactly '${nonce}' without a newline to $HOME/task/warm.txt, then complete the task.`,
    ].join("\n") });
    const warm = await pollUntil({ label: `${profile.id} warm run preserves saved work`, deadlineAt: Date.now() + 840_000,
      intervalMs: 5_000,
      load: async () => ({ issue: await api.json<{ status: string }>(`/api/issues/${issue.id}`),
        saves: (await api.json<WorkFolderSyncStatus[]>(`${base}/sync`)).filter((save) => !coldRunIds.has(save.runId)) }),
      accept: (state) => state.issue.status === "done" && state.saves.some((save) => !save.active && save.state === "saved" && save.lastSavedAt !== null),
      reject: (state) => state.saves.some((save) => save.state === "failed") ? "Warm save failed"
        : ["blocked", "cancelled"].includes(state.issue.status) ? `Warm task ended ${state.issue.status}` : undefined,
    });
    const warmContent = await api.request(`${base}/content?path=warm.txt`);
    expect(warmContent.status).toBe(200); expect(await warmContent.text()).toBe(nonce);
    await info.attach("cold-and-warm-checkpoints", { contentType: "application/json", body: Buffer.from(JSON.stringify({ cold: cold.saves, warm: warm.saves })) });
  });
}

test("saves during two real 180-second intervals and flushes the final edit", async ({}, info) => {
  const profile = stack.profiles.find((entry) => entry.id === "legacy-codex")!;
  const nonce = randomUUID();
  const issue = await api.json<{ id: string; identifier: string }>(`/api/companies/${stack.companyId}/issues`, "POST", {
    title: `Real checkpoint intervals ${nonce}`, projectId: stack.projectId, assigneeAgentId: profile.agentId, status: "todo",
    description: [
      "Run a real timed persistence acceptance test. Execute the following shell sequence and wait for it to finish, keeping this task in progress throughout both sleeps. Use a tool timeout of at least 420 seconds, or poll its session until it exits. Do not shorten either sleep or mark the task complete early.",
      `printf '${nonce}:one' > "$HOME/task/interval.txt"; sleep 190; printf '${nonce}:two' > "$HOME/task/interval.txt"; sleep 190; printf '${nonce}:final' > "$HOME/task/interval.txt"`,
      "After the command exits successfully, complete the task. Do not print credentials.",
    ].join("\n"),
  });
  await info.attach("task", { contentType: "application/json", body: Buffer.from(JSON.stringify(issue)) });
  const base = folder("task", issue.id);
  const observations: Array<{ observedAt: string; phase: string; saves: WorkFolderSyncStatus[] }> = [];
  for (const phase of ["one", "two", "final"]) {
    const snapshot = await pollUntil({ label: `durable interval ${phase}`, deadlineAt: Date.now() + (phase === "one" ? 840_000 : 300_000), intervalMs: 3_000,
      load: async () => {
        const response = await api.request(`${base}/content?path=interval.txt`);
        return { content: response.ok ? await response.text() : null, saves: await api.json<WorkFolderSyncStatus[]>(`${base}/sync`),
          issue: await api.json<{ status: string }>(`/api/issues/${issue.id}`) };
      },
      accept: (state) => state.content === `${nonce}:${phase}` && state.saves.some((save) => save.state === "saved" && save.lastSavedAt !== null && save.active === (phase !== "final")),
      reject: (state) => state.saves.some((save) => save.state === "failed") ? "Timed checkpoint failed"
        : ["blocked", "cancelled"].includes(state.issue.status) ? `Timed task ended ${state.issue.status}` : undefined,
    });
    observations.push({ observedAt: new Date().toISOString(), phase, saves: snapshot.saves });
  }
  const first = observations[0]!.saves.find((save) => save.active)!;
  const second = observations[1]!.saves.find((save) => save.runId === first.runId)!;
  expect(Date.parse(second.lastSavedAt!) - Date.parse(first.lastSavedAt!)).toBeGreaterThanOrEqual(170_000);
  await info.attach("real-checkpoint-intervals", { contentType: "application/json", body: Buffer.from(JSON.stringify(observations, null, 2)) });
});
