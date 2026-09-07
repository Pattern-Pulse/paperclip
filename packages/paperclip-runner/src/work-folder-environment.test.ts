import { describe, expect, it } from "vitest";
import { externalWorkFolderEnvironment } from "./work-folder-environment.js";
import { createSanitizedCodexEnvironment } from "./drivers/codex/app-server-transport.js";
import { codexCommandEnvironment } from "./drivers/codex/codex-security-config.js";

describe("external sandbox work-folder environment", () => {
  const home = "/home/daytona";
  const environment = { HOME: home, PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: "1", PAPERCLIP_TASK_DIR: `${home}/task`,
    PAPERCLIP_AGENT_DIR: `${home}/agent`, PAPERCLIP_USER_DIR: `${home}/user`, PAPERCLIP_PROJECT_DIR: `${home}/project`,
    PAPERCLIP_REPOS_DIR: `${home}/repos`, PAPERCLIP_PRIMARY_REPO: `${home}/repos/main` };
  it("preserves natural HOME and scoped paths for both Codex and its shell tools", () => {
    expect(createSanitizedCodexEnvironment(environment)).toMatchObject(externalWorkFolderEnvironment(environment));
    expect(codexCommandEnvironment(environment)).toMatchObject(externalWorkFolderEnvironment(environment));
  });
  it("leaves local execution unchanged and rejects inconsistent sandbox bindings", () => {
    expect(externalWorkFolderEnvironment({ ...environment, PAPERCLIP_RUNNER_EXTERNAL_SANDBOX: undefined })).toEqual({});
    expect(() => externalWorkFolderEnvironment({ ...environment, PAPERCLIP_USER_DIR: "/other/user" })).toThrow("does not match");
  });
});
