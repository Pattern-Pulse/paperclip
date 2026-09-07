import assert from "node:assert/strict";
import test from "node:test";
import { previewIdentity } from "./build-preview-migrator.mjs";

test("preview artifact identity is immutable, namespaced, and ordered by commit time", () => {
  const sha = "2f42a4968d5761fd62172e35ecf8188195b8d431";
  const identity = previewIdentity(sha, new Date("2026-07-19T09:30:00.000Z"));
  assert.equal(identity.version, `2026.719.34201-preview.sha${sha}`);
  assert.equal(identity.tag, `preview/${sha}`);
  assert.equal(identity.baseUrl, `https://github.com/paperclipai/paperclip/releases/download/preview%2F${sha}`);
  assert.throws(() => previewIdentity("master", new Date()), /Invalid preview/);
  assert.throws(() => previewIdentity(sha, new Date("invalid")), /Invalid preview/);
});
