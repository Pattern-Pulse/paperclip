import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { normalizeProviderPackLayout } from "./provider-pack-layout.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "provider-pack-layout-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, "dist", "cli"), { recursive: true });
  writeFileSync(join(root, "dist", "cli", "provider.cjs"), "provider bytes\n");
  return root;
}

test("app and sandbox image build orders produce the same provider layout", (t) => {
  const app = fixture(t), image = fixture(t);
  mkdirSync(join(app, "dist", "bin"));
  writeFileSync(join(app, "dist", "bin", "paperclip-runnerd"), "separately verified native binary");
  normalizeProviderPackLayout(app);
  normalizeProviderPackLayout(image);
  assert.deepEqual(readdirSync(join(app, "dist")), readdirSync(join(image, "dist")));
  assert.deepEqual(readFileSync(join(app, "dist", "cli", "provider.cjs")), readFileSync(join(image, "dist", "cli", "provider.cjs")));
});

test("normalization removes only redundant runnerd and retains other bin entries", (t) => {
  const root = fixture(t);
  mkdirSync(join(root, "dist", "bin"));
  writeFileSync(join(root, "dist", "bin", "paperclip-runnerd"), "runnerd");
  writeFileSync(join(root, "dist", "bin", "future-provider"), "keep me");
  normalizeProviderPackLayout(root);
  normalizeProviderPackLayout(root);
  assert.deepEqual(readdirSync(join(root, "dist", "bin")), ["future-provider"]);
  assert.equal(readFileSync(join(root, "dist", "bin", "future-provider"), "utf8"), "keep me");
});

test("normalization never follows a substituted bin directory", (t) => {
  const root = fixture(t), outside = fixture(t);
  writeFileSync(join(outside, "paperclip-runnerd"), "keep outside bytes");
  symlinkSync(outside, join(root, "dist", "bin"));
  assert.throws(() => normalizeProviderPackLayout(root), /must be a directory/);
  assert.equal(readFileSync(join(outside, "paperclip-runnerd"), "utf8"), "keep outside bytes");
});
