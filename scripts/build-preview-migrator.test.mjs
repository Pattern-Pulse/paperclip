import assert from "node:assert/strict";
import test from "node:test";
import { previewIdentity } from "./build-preview-migrator.mjs";

test("preview artifact identity is immutable, namespaced, and ordered by commit time", () => {
  const sha = "2f42a4968d5761fd62172e35ecf8188195b8d431";
  const identity = previewIdentity(sha, new Date("2026-07-19T09:30:00.000Z"), "https://staging.example/migrators");
  assert.equal(identity.version, `2026.719.34201-preview.sha${sha}`);
  assert.equal(identity.tag, `preview/${sha}`);
  assert.equal(identity.baseUrl, `https://staging.example/migrators/${sha}`);
  assert.throws(() => previewIdentity("master", new Date()), /Invalid preview/);
  assert.throws(() => previewIdentity(sha, new Date("invalid")), /Invalid preview/);
});

test("staging artifact URLs cannot carry credentials or use plaintext", () => {
  for (const url of ["http://staging.example", "https://user:secret@staging.example", "https://staging.example?token=secret"]) {
    assert.throws(() => previewIdentity("a".repeat(40), new Date(), url), /Invalid staging/);
  }
});
