import crypto from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { buildAgentOsRuntimeContract, signAgentOsRuntimeContract } from "./contract.js";

const fixed = {
  runId: "11111111-1111-4111-8111-111111111111",
  agentId: "22222222-2222-4222-8222-222222222222",
  companyId: "33333333-3333-4333-8333-333333333333",
  config: {
    projectId: "44444444-4444-4444-8444-444444444444",
    issueId: "55555555-5555-4555-8555-555555555555",
    agentOsAgentId: "chief-of-staff",
    ownerHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    provider: "codex",
    model: "gpt-5.3-codex",
    providerConnectionEpoch: "66666666-6666-4666-8666-666666666666",
    revision: 3,
    capabilities: ["action:paperclip.create_issue", "adapter:codex"],
  },
  context: {
    projectId: "44444444-4444-4444-8444-444444444444",
    issueId: "55555555-5555-4555-8555-555555555555",
  },
};

afterEach(() => {
  delete process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID;
});

describe("agentos runtime contract", () => {
  it("builds and signs a scope-bound contract", () => {
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    const keys = crypto.generateKeyPairSync("ed25519");
    const contract = buildAgentOsRuntimeContract({ ...fixed, attempt: 1, now: new Date("2026-09-10T10:00:00.000Z") });
    const signed = signAgentOsRuntimeContract(contract, keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString());
    const message = Buffer.from(`v1\nPOST\n/api/runtime/paperclip/v1/runs\n${crypto.createHash("sha256").update(signed.body).digest("hex")}`);
    expect(crypto.verify(null, message, keys.publicKey, Buffer.from(signed.signature.slice(7), "base64url"))).toBe(true);
    expect(JSON.parse(signed.body.toString()).scope.issueId).toBe(fixed.config.issueId);
  });

  it("rejects an unsorted or duplicated capability snapshot", () => {
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    expect(() => buildAgentOsRuntimeContract({
      ...fixed, attempt: 1,
      config: { ...fixed.config, capabilities: ["adapter:codex", "adapter:codex"] },
    })).toThrow("agentos_runtime_capabilities_must_be_sorted_unique");
  });

  it("binds project and issue to the server-owned Paperclip run context", () => {
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    expect(() => buildAgentOsRuntimeContract({
      ...fixed,
      attempt: 1,
      config: { ...fixed.config, projectId: "77777777-7777-4777-8777-777777777777" },
    })).toThrow("agentos_runtime_projectId_config_context_mismatch");
    expect(() => buildAgentOsRuntimeContract({
      ...fixed,
      attempt: 1,
      config: { ...fixed.config, issueId: "88888888-8888-4888-8888-888888888888" },
    })).toThrow("agentos_runtime_issueId_config_context_mismatch");
    expect(() => buildAgentOsRuntimeContract({
      ...fixed,
      attempt: 1,
      context: { ...fixed.context, issueId: undefined },
      config: { ...fixed.config, issueId: undefined, taskId: undefined },
    })).toThrow("agentos_runtime_issueId_run_context_missing");
    expect(() => buildAgentOsRuntimeContract({
      ...fixed,
      attempt: 1,
      context: { ...fixed.context, taskId: "88888888-8888-4888-8888-888888888888" },
    })).toThrow("agentos_runtime_issueId_run_context_mismatch");
    expect(() => buildAgentOsRuntimeContract({
      ...fixed,
      attempt: 1,
      config: { ...fixed.config, taskId: "88888888-8888-4888-8888-888888888888" },
    })).toThrow("agentos_runtime_issueId_config_context_mismatch");
  });

  it("requires routine and trigger to be paired", () => {
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    expect(() => buildAgentOsRuntimeContract({
      ...fixed, attempt: 1,
      config: { ...fixed.config, routineId: "77777777-7777-4777-8777-777777777777" },
    })).toThrow("agentos_runtime_routine_trigger_pair_required");
  });
});
