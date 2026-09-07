import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { agents, companies, createDb, heartbeatRuns, issues, environments, environmentLeases, projects, projectWorkspaces, startEmbeddedPostgresTestDatabase, type Db } from "@paperclipai/db";
import { createLocalDiskStorageProvider } from "../storage/local-disk-provider.js";
import { prepareSandboxWorkFolders } from "../services/sandbox-work-folders.js";
import { retainUnsavedWorkFolderLease, workFolderSandboxKey } from "../services/work-folder-retention.js";
import { workFolderService } from "../services/work-folders.js";
import { localTestWorkFolderRunner } from "./helpers/work-folder-runner.js";
const exec = promisify(execFile);

describe("shared sandbox work-folder lifecycle", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: Db;
  let root: string;
  let storage: ReturnType<typeof createLocalDiskStorageProvider>;
  const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), taskId = randomUUID(), environmentId = randomUUID();
  const active: Array<Awaited<ReturnType<typeof prepareSandboxWorkFolders>>> = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-sandbox-folders-");
    db = createDb(database.connectionString);
    root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-sandbox-folders-")));
    storage = createLocalDiskStorageProvider(path.join(root, "bucket"));
    await db.insert(companies).values({ id: companyId, name: "Sandbox folder tests" });
    await db.insert(environments).values({ id: environmentId, name: "Test sandbox", driver: "sandbox", config: {} });
    await db.insert(agents).values({ id: agentId, companyId, name: "Agent" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Project" });
    await db.insert(issues).values({ id: taskId, companyId, projectId, title: "Task", assigneeAgentId: agentId });
    for (const name of ["repo-one", "repo-two"]) {
      const source = path.join(root, name);
      await exec("git", ["init", source]);
      await fs.writeFile(path.join(source, "tracked"), "initial\n");
      await fs.symlink("tracked", path.join(source, "link"));
      await exec("git", ["-C", source, "add", "."]);
      await exec("git", ["-C", source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "initial"]);
      await db.insert(projectWorkspaces).values({ companyId, projectId, name, repoUrl: source, sourceType: "git_repo", isPrimary: name === "repo-one" });
    }
  }, 60_000);
  afterAll(async () => {
    for (const run of active) await run.stop().catch(() => {});
    await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true });
  });
  async function prepare(home: string, leaseId: string, physicalId = leaseId) {
    await fs.mkdir(home, { recursive: true });
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running" });
    const lease = { id: leaseId, companyId, environmentId, provider: "test", providerLeaseId: physicalId };
    await db.insert(environmentLeases).values({ ...lease, heartbeatRunId: runId }).onConflictDoUpdate({ target: environmentLeases.id, set: { heartbeatRunId: runId } });
    const run = await prepareSandboxWorkFolders({ db, companyId, agentId, projectId, taskId, runId,
      responsibleUserId: null, storage, sandboxKey: workFolderSandboxKey(lease), target: { kind: "remote", transport: "sandbox", leaseId, remoteCwd: home,
        runner: { execute: (input) => localTestWorkFolderRunner.execute({ ...input, env: { ...input.env, HOME: home } }) } } });
    active.push(run); return run;
  }
  it("reuses clones and restores saved unpushed work, staged changes, and task files after losing the sandbox", async () => {
    const home = path.join(root, "sandbox");
    const leaseId = randomUUID();
    const first = await prepare(home, leaseId);
    expect(first.home).toBe(home);
    expect(first.manifest.repositories).toHaveLength(2);
    expect(first.primaryRepo).toBe(path.join(home, "repos/repo-one"));
    await fs.writeFile(path.join(home, "task/report.md"), "durable task file");
    const repo = first.primaryRepo;
    await fs.writeFile(path.join(repo, "tracked"), "committed\n");
    await exec("git", ["-C", repo, "add", "."]);
    await exec("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "unpushed"]);
    const expectedHead = (await exec("git", ["-C", repo, "rev-parse", "HEAD"])).stdout.trim();
    await fs.writeFile(path.join(repo, "tracked"), "staged\n");
    await exec("git", ["-C", repo, "add", "tracked"]);
    await fs.writeFile(path.join(repo, "tracked"), "unstaged\n");
    await fs.writeFile(path.join(repo, "untracked"), "untracked\n");
    await first.stop(); active.splice(active.indexOf(first), 1);
    const warm = await prepare(home, randomUUID(), leaseId);
    expect(await fs.readFile(path.join(repo, "tracked"), "utf8")).toBe("unstaged\n");
    await warm.stop(); active.splice(active.indexOf(warm), 1);
    await fs.rm(home, { recursive: true });
    const restored = await prepare(path.join(root, "replacement"), randomUUID());
    expect(await fs.readFile(path.join(restored.home, "task/report.md"), "utf8")).toBe("durable task file");
    expect((await exec("git", ["-C", restored.primaryRepo, "rev-parse", "HEAD"])).stdout.trim()).toBe(expectedHead);
    expect((await exec("git", ["-C", restored.primaryRepo, "show", ":tracked"])).stdout).toBe("staged\n");
    expect(await fs.readFile(path.join(restored.primaryRepo, "tracked"), "utf8")).toBe("unstaged\n");
    expect(await fs.readFile(path.join(restored.primaryRepo, "untracked"), "utf8")).toBe("untracked\n");
    expect(await fs.readlink(path.join(restored.primaryRepo, "link"))).toBe("tracked");
    await restored.stop(); active.splice(active.indexOf(restored), 1);
  }, 120_000);
  it("does not let an unchanged stale shared file overwrite a newer durable value", async () => {
    const svc = workFolderService(db, storage);
    const folder = await svc.ensure({ companyId, scope: "project", ownerId: projectId });
    await svc.write(folder, { path: "shared.md", body: Buffer.from("first"), operationId: randomUUID() });
    const run = await prepare(path.join(root, "stale-sandbox"), randomUUID());
    await svc.write(folder, { path: "shared.md", body: Buffer.from("newer"), operationId: randomUUID() });
    await run.stop(); active.splice(active.indexOf(run), 1);
    const result = await svc.content(folder, "shared.md");
    const chunks = []; for await (const chunk of result.stream) chunks.push(Buffer.from(chunk));
    expect(Buffer.concat(chunks).toString()).toBe("newer");
  }, 120_000);
  it("retains the only working copy until a final checkpoint succeeds", async () => {
    const leaseId = randomUUID();
    const run = await prepare(path.join(root, "retained-sandbox"), leaseId);
    await fs.writeFile(path.join(run.home, "task/pending"), "recover me");
    await run.flush();
    expect(await retainUnsavedWorkFolderLease(db, { id: leaseId, companyId })).toBe(true);
    await run.stop(); active.splice(active.indexOf(run), 1);
    expect(await retainUnsavedWorkFolderLease(db, { id: leaseId, companyId })).toBe(false);
  }, 120_000);
  it("reconciles file-directory replacements and preserves deleted children in trash", async () => {
    const svc = workFolderService(db, storage);
    const folder = await svc.ensure({ companyId, scope: "project", ownerId: projectId });
    await svc.write(folder, { path: "replace/child", body: Buffer.from("child"), operationId: randomUUID() });
    const leaseId = randomUUID();
    const home = path.join(root, "replacement-kinds");
    const run = await prepare(home, leaseId);
    await fs.rm(path.join(home, "project/replace"), { recursive: true });
    await fs.writeFile(path.join(home, "project/replace"), "now a file");
    await run.stop(); active.splice(active.indexOf(run), 1);
    expect((await svc.list(folder, { trash: true })).files.map((file) => file.path)).toContain("replace/child");
    await svc.write(folder, { path: "replace", kind: "directory", replaceKind: true, operationId: randomUUID() });
    const resumed = await prepare(home, randomUUID(), leaseId);
    expect((await fs.stat(path.join(home, "project/replace"))).isDirectory()).toBe(true);
    await resumed.stop(); active.splice(active.indexOf(resumed), 1);
  }, 120_000);

});
