import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { test } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { buildProviderPack } from "./build-provider-pack.mjs";
import { canonicalJson, sha256File, sha256Tree } from "./provider-pack-integrity.mjs";
const revision = "a".repeat(40);
function fixture(runTest) {
  const parent = mkdtempSync(join(tmpdir(), "canonical-provider-test-"));
  const workspaceRoot = join(parent, "source"), outputRoot = join(parent, "output");
  const lock = "the dedicated immutable resolution\n";
  const hash = createHash("sha256").update(lock).digest("hex");
  mkdirSync(join(workspaceRoot, "docker/daytona-runner"), { recursive: true });
  writeFileSync(join(workspaceRoot, "docker/daytona-runner/provider-dependencies.lock.yaml"), lock);
  writeFileSync(join(workspaceRoot, "docker/daytona-runner/Dockerfile"), `ARG PAPERCLIP_RUNNER_LOCK_SHA256=${hash}\n`);
  writeFileSync(join(workspaceRoot, "pnpm-lock.yaml"), "different CI resolution");
  const calls = [];
  function exported(args, tamper) {
    const destination = args[args.indexOf("--output") + 1].slice("type=local,dest=".length);
    const paths = {
      nodeCommand: "node_modules/node/bin/node", productionLock: "pnpm-lock.yaml",
      opencodeCommand: "node_modules/.bin/opencode", opencodeExecutable: "node_modules/opencode-ai/bin/opencode.exe",
      opencodeProxy: "dist/cli/opencode-app-server-proxy.cjs", acpxSidecar: "dist/cli/acpx-runtime-sidecar.cjs",
    };
    const artifacts = {};
    for (const [name, path] of Object.entries(paths)) {
      const file = join(destination, path);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, name === "productionLock" ? lock : name);
      artifacts[name] = { path, sha256: sha256File(file) };
    }
    const distDigest = sha256Tree(join(destination, "dist"));
    const payload = { target: { platform: "linux", architecture: "x64" },
      runnerSourceRevision: args.find((value) => value.startsWith("PAPERCLIP_RUNNER_SOURCE_REVISION=")).split("=")[1],
      artifacts, distDigest, bridgeDigest: `sha256:${createHash("sha256").update(artifacts.opencodeProxy.sha256).update("\n")
        .update(artifacts.acpxSidecar.sha256).update("\n").update(distDigest).digest("hex")}` };
    const manifest = { schema: "paperclip-runner/remote-provider-pack/v1", payload,
      digest: `sha256:${createHash("sha256").update(canonicalJson(payload)).digest("hex")}` };
    writeFileSync(join(destination, "provider-pack.json"), JSON.stringify(manifest));
    tamper?.(destination);
  }
  const run = (command, args, options) => { calls.push({ command, args, options }); exported(args); return { status: 0 }; };
  try { runTest({ parent, workspaceRoot, outputRoot, hash, calls, run, exported }); }
  finally { rmSync(parent, { recursive: true, force: true }); }
}
test("workflow entry isolates the canonical linux stage from root dependency graph and stale outputs", () => fixture((f) => {
  mkdirSync(join(f.workspaceRoot, "node_modules"));
  writeFileSync(join(f.workspaceRoot, "node_modules/stale"), "must not be assembled");
  const first = buildProviderPack({ ...f, revision });
  writeFileSync(join(f.workspaceRoot, "pnpm-lock.yaml"), "another CI lock");
  const second = buildProviderPack({ ...f, revision });
  assert.equal(first.manifest.digest, second.manifest.digest);
  for (const call of f.calls) {
    assert.equal(call.command, "docker");
    assert.equal(call.args[call.args.indexOf("--platform") + 1], "linux/amd64");
    assert.equal(call.args[call.args.indexOf("--target") + 1], "provider-pack-export");
    assert.ok(call.args.includes(`PAPERCLIP_RUNNER_SOURCE_REVISION=${revision}`));
    assert.equal(call.options.timeout, 720_000);
  }
  assert.equal(readFileSync(join(f.outputRoot, "pnpm-lock.yaml"), "utf8"), "the dedicated immutable resolution\n");
  assert.deepEqual(readdirSync(f.parent).sort(), ["output", "source"]);
}));
test("tampered dedicated lock fails before invoking Docker", () => fixture((f) => {
  writeFileSync(join(f.workspaceRoot, "docker/daytona-runner/provider-dependencies.lock.yaml"), "changed");
  assert.throws(() => buildProviderPack({ ...f, revision }), /lock integrity mismatch/);
  assert.equal(f.calls.length, 0);
}));
test("failed canonical build preserves prior pack and cleans only temporary output", () => fixture((f) => {
  mkdirSync(f.outputRoot); writeFileSync(join(f.outputRoot, "old"), "retain");
  assert.throws(() => buildProviderPack({ ...f, revision, run: () => ({ status: 1 }) }), /build failed/);
  assert.equal(readFileSync(join(f.outputRoot, "old"), "utf8"), "retain");
  assert.deepEqual(readdirSync(f.parent).sort(), ["output", "source"]);
}));
test("exported executable tampering is rejected without replacing the prior pack", () => fixture((f) => {
  mkdirSync(f.outputRoot); writeFileSync(join(f.outputRoot, "old"), "retain");
  const run = (_command, args) => { f.exported(args, (root) => writeFileSync(join(root, "node_modules/node/bin/node"), "tampered")); return { status: 0 }; };
  assert.throws(() => buildProviderPack({ ...f, revision, run }), /artifact integrity mismatch/);
  assert.equal(readFileSync(join(f.outputRoot, "old"), "utf8"), "retain");
}));
test("arbitrary source-tree output and invalid revision are rejected before building", () => fixture((f) => {
  for (const outputRoot of [f.workspaceRoot, join(f.workspaceRoot, "packages"), join(f.workspaceRoot, "..hidden"), dirname(f.workspaceRoot)]) {
    assert.throws(() => buildProviderPack({ ...f, outputRoot, revision }), /unsafe/);
  }
  assert.throws(() => buildProviderPack({ ...f, revision: "not-a-sha" }), /full Git SHA/);
  assert.equal(f.calls.length, 0);
}));

test("implicit HEAD rejects dirty canonical inputs while explicit trusted revisions tolerate CI root-lock drift", () => fixture((f) => {
  const previous = process.env.PAPERCLIP_RUNNER_SOURCE_REVISION;
  delete process.env.PAPERCLIP_RUNNER_SOURCE_REVISION;
  try {
    execFileSync("git", ["init", f.workspaceRoot], { stdio: "ignore" });
    execFileSync("git", ["-C", f.workspaceRoot, "add", "."]);
    execFileSync("git", ["-C", f.workspaceRoot, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "fixture"], { stdio: "ignore" });
    writeFileSync(join(f.workspaceRoot, "pnpm-lock.yaml"), "CI-owned changed root lock");
    buildProviderPack({ ...f });
    assert.equal(f.calls.length, 1);
    mkdirSync(join(f.workspaceRoot, "packages/paperclip-runner/scripts"), { recursive: true });
    writeFileSync(join(f.workspaceRoot, "packages/paperclip-runner/scripts/new-source.mjs"), "changed source");
    assert.throws(() => buildProviderPack({ ...f }), /inputs are dirty/);
    assert.equal(f.calls.length, 1);
    buildProviderPack({ ...f, revision });
    assert.equal(f.calls.length, 2);
  } finally {
    if (previous === undefined) delete process.env.PAPERCLIP_RUNNER_SOURCE_REVISION;
    else process.env.PAPERCLIP_RUNNER_SOURCE_REVISION = previous;
  }
}));
