import crypto from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

const guardedFetchMock = vi.hoisted(() => vi.fn());
vi.mock("../http/remote-fetch.js", () => ({ guardedHttpAdapterFetch: guardedFetchMock }));

const config = {
  endpoint: "https://agentos.test/api/runtime/paperclip/v1/runs",
  projectId: "44444444-4444-4444-8444-444444444444",
  issueId: "55555555-5555-4555-8555-555555555555",
  agentOsAgentId: "chief-of-staff",
  ownerHash: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
  provider: "codex",
  model: "gpt-5.3-codex",
  providerConnectionEpoch: "66666666-6666-4666-8666-666666666666",
  revision: 3,
  capabilities: ["action:paperclip.create_issue", "adapter:codex"],
};

const base = {
  runId: "11111111-1111-4111-8111-111111111111",
  agent: { id: "22222222-2222-4222-8222-222222222222", companyId: "33333333-3333-4333-8333-333333333333", name: "Chief", adapterType: "agentos_runtime", adapterConfig: {} },
  runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
  config,
  context: {
    projectId: config.projectId,
    issueId: config.issueId,
  },
  onLog: async () => {},
};

afterEach(() => {
  guardedFetchMock.mockReset();
  delete process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID;
  delete process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64;
  delete process.env.PAPERCLIP_AGENTOS_RUNTIME_URL;
});

describe("agentos runtime adapter", () => {
  it("sends a signed request and only accepts a terminal success", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    const privatePem = keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(privatePem).toString("base64");
    const onDispatch = vi.fn();
    guardedFetchMock.mockResolvedValue(new Response(JSON.stringify({ version: "paperclip-agentos-runtime-receipt/v1", state: "succeeded", runId: base.runId, attempt: 1, callbackState: "delivered" }), { status: 200 }));
    const result = await execute({ ...base, onDispatch });
    expect(result.exitCode).toBe(0);
    expect(onDispatch).toHaveBeenCalledOnce();
    expect(guardedFetchMock).toHaveBeenCalledOnce();
    expect(guardedFetchMock.mock.calls[0]?.[2]).toMatchObject({ responseTimeoutMs: 125000 });
    expect(guardedFetchMock.mock.calls[0]?.[2].privateEndpointAllowlist).toEqual(new Set(["https://agentos.test"]));
    const request = guardedFetchMock.mock.calls[0]?.[1] as RequestInit;
    expect(request.headers).toMatchObject({ "x-agentos-paperclip-signature": expect.stringMatching(/^v1;sig=/) });
    expect(JSON.parse(Buffer.from(request.body as Buffer).toString()).schemaVersion).toBe("paperclip-agentos-runtime-run/v1");
  });

  it("fails closed on an accepted but non-terminal response", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    guardedFetchMock.mockResolvedValue(new Response(JSON.stringify({ version: "paperclip-agentos-runtime-receipt/v1", state: "running", runId: base.runId, attempt: 1, callbackState: "pending" }), { status: 202 }));
    await expect(execute(base)).rejects.toThrow("agentos_runtime_not_terminal:running");
  });

  it("rejects a configured endpoint that differs from the host-approved URL", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    await expect(execute({ ...base, config: { ...config, endpoint: "https://evil.test/api/runtime/paperclip/v1/runs" } })).rejects.toThrow("agentos_runtime_endpoint_not_allowed");
  });

  it("rejects a terminal response bound to another run", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    guardedFetchMock.mockResolvedValue(new Response(JSON.stringify({ version: "paperclip-agentos-runtime-receipt/v1", state: "succeeded", runId: "99999999-9999-4999-8999-999999999999", attempt: 1, callbackState: "delivered" }), { status: 200 }));
    await expect(execute(base)).rejects.toThrow("agentos_runtime_response_binding_invalid");
  });

  it("rejects a terminal response whose attempt has the wrong JSON type", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    guardedFetchMock.mockResolvedValue(new Response(JSON.stringify({ version: "paperclip-agentos-runtime-receipt/v1", state: "succeeded", runId: base.runId, attempt: "1", callbackState: "delivered" }), { status: 200 }));
    await expect(execute(base)).rejects.toThrow("agentos_runtime_response_binding_invalid");
  });

  it("rejects an oversized response before parsing it", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    guardedFetchMock.mockResolvedValue(new Response("x".repeat(16_385), { status: 200 }));
    await expect(execute(base)).rejects.toThrow("agentos_runtime_response_too_large");
  });

  it("rejects an invalid timeout instead of waiting without a bound", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    await expect(execute({ ...base, config: { ...config, timeoutMs: "not-a-number" } })).rejects.toThrow("agentos_runtime_timeout_invalid");
  });

  it("keeps environment readiness aligned with dispatch prerequisites", async () => {
    const keys = crypto.generateKeyPairSync("ed25519");
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID = "test-key";
    process.env.PAPERCLIP_AGENTOS_RUNTIME_URL = config.endpoint;
    process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64 = Buffer.from(keys.privateKey.export({ type: "pkcs8", format: "pem" }).toString()).toString("base64");
    const ready = await testEnvironment({ companyId: base.agent.companyId, adapterType: "agentos_runtime", config });
    expect(ready.status).toBe("pass");
    delete process.env.PAPERCLIP_AGENTOS_RUNTIME_SIGNING_KEY_ID;
    const missingKeyId = await testEnvironment({ companyId: base.agent.companyId, adapterType: "agentos_runtime", config });
    expect(missingKeyId.status).toBe("fail");
    expect(missingKeyId.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "agentos_runtime_signing_key_id_invalid", level: "error" })]));
  });
});
