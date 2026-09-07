import { describe, expect, it } from "vitest";
import { isStagingOrigin } from "./deployed-stack.js";

describe("deployed stack target", () => {
  it("requires an explicit HTTPS staging tenant and rejects credential-bearing URLs", () => {
    expect(isStagingOrigin("https://work-folders-qa.staging.paperclip.app")).toBe(true);
    for (const value of ["http://localhost:3100", "https://tenant.paperclip.app", "https://staging.paperclip.app.attacker.test",
      "https://token@tenant.staging.paperclip.app", "https://tenant.staging.paperclip.app/path", "https://tenant.staging.paperclip.app?secret=x"]) {
      expect(isStagingOrigin(value), value).toBe(false);
    }
  });
});
