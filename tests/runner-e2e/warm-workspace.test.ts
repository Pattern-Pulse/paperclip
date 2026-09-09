import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import { daytonaWarmContinuityTask } from "./catalog.js";
import { readWarmWorkspaceFile } from "./warm-workspace.js";

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const workspacePath = await mkdtemp(
    path.join(os.tmpdir(), "warm-workspace-test-"),
  );
  temporaryDirectories.push(workspacePath);
  const binding = {
    version: 1,
    runId: "run",
    companyId: "company",
    agentId: "agent",
    taskId: "task",
    folders: { task: "folder" },
  };
  const saved = {
    runId: "run",
    state: "saved",
    active: false,
    lastSavedAt: "2026-09-09T04:00:00Z",
  };
  const response = {
    ok: () => true,
    status: () => 200,
    text: async () => "T1-nonce\n",
  };
  const api = {
    get: vi.fn().mockResolvedValue([saved]),
    request: { get: vi.fn().mockResolvedValue(response) },
  };
  return {
    input: {
      api,
      run: {
        id: "run",
        companyId: "company",
        agentId: "agent",
        contextSnapshot: { paperclipWorkFolders: binding },
      },
      issueId: "task",
      workspacePath,
      filename: "daytona-warm-nonce.txt",
    },
    saved,
  };
}

describe("warm workspace persistence observation", () => {
  it.each([true, false])(
    "keeps writes in the correct folder across separate shells (scoped=%s)",
    async (scoped) => {
      const { input } = await fixture();
      const taskDirectory = path.join(input.workspacePath, "task files");
      await mkdir(taskDirectory);
      const env = { ...process.env };
      if (scoped) env.PAPERCLIP_TASK_DIR = taskDirectory;
      else delete env.PAPERCLIP_TASK_DIR;
      const prompts = [
        daytonaWarmContinuityTask.buildPrompt("nonce"),
        ...daytonaWarmContinuityTask.buildFollowupMessages!("nonce"),
      ];
      for (const [index, prompt] of prompts.entries()) {
        const shellPath = prompt.match(
          /Use ("[^"\n]+") for every read and write\./,
        )?.[1];
        expect(shellPath).toBeTruthy();
        await promisify(execFile)(
          "sh",
          ["-c", `printf 'T${index + 1}-nonce\\n' >> ${shellPath}`],
          { cwd: input.workspacePath, env },
        );
      }
      expect(
        await readFile(
          path.join(
            scoped ? taskDirectory : input.workspacePath,
            input.filename,
          ),
          "utf8",
        ),
      ).toBe("T1-nonce\nT2-nonce\nT3-nonce\n");
      if (scoped)
        await expect(
          readFile(path.join(input.workspacePath, input.filename)),
        ).rejects.toMatchObject({ code: "ENOENT" });
    },
  );

  it("reads the saved scoped file without requiring a mirrored host file", async () => {
    const { input } = await fixture();
    expect(await readWarmWorkspaceFile(input)).toEqual({
      source: "task-cache",
      content: "T1-nonce\n",
    });
    expect(input.api.get).toHaveBeenCalledWith(
      "/api/companies/company/work-folders/task/task/sync",
    );
    expect(input.api.request.get).toHaveBeenCalledWith(
      "/api/companies/company/work-folders/task/task/content?path=daytona-warm-nonce.txt",
    );
  });

  it("does not substitute a stale host copy for a missing cached file", async () => {
    const { input } = await fixture();
    await writeFile(
      path.join(input.workspacePath, input.filename),
      "T1-nonce\n",
    );
    input.api.request.get.mockResolvedValue({
      ok: () => false,
      status: () => 404,
    });
    await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
      "download returned 404",
    );
  });

  it.each([
    { runId: "older-run" },
    { state: "failed" },
    { state: "saving" },
    { active: true },
    { lastSavedAt: null },
  ])(
    "rejects incomplete or unrelated checkpoint evidence: %j",
    async (override) => {
      const { input, saved } = await fixture();
      input.api.get.mockResolvedValue([{ ...saved, ...override }]);
      await expect(readWarmWorkspaceFile(input)).rejects.toThrow(
        "successful final file save",
      );
      expect(input.api.request.get).not.toHaveBeenCalled();
    },
  );

  it.each(["runId", "companyId", "agentId", "taskId"] as const)(
    "rejects a manifest with a different %s",
    async (field) => {
      const { input } = await fixture();
      input.run.contextSnapshot.paperclipWorkFolders[field] = "other";
      await expect(readWarmWorkspaceFile(input)).rejects.toThrow();
      expect(input.api.get).not.toHaveBeenCalled();
    },
  );

  it("keeps the host workspace contract when the run has no scoped manifest", async () => {
    const { input } = await fixture();
    await writeFile(
      path.join(input.workspacePath, input.filename),
      "T1-local\n",
    );
    expect(
      await readWarmWorkspaceFile({
        ...input,
        run: { ...input.run, contextSnapshot: null },
      }),
    ).toEqual({ source: "host-workspace", content: "T1-local\n" });
    expect(input.api.get).not.toHaveBeenCalled();
    expect(input.api.request.get).not.toHaveBeenCalled();
  });
});
