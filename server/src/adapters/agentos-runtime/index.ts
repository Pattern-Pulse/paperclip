import type { ServerAdapterModule } from "../types.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export const agentOsRuntimeAdapter: ServerAdapterModule = {
  type: "agentos_runtime",
  runtimeToolDelivery: "invocation_context",
  execute,
  testEnvironment,
  models: [],
  agentConfigurationDoc: `# AgentOS runtime\n\nAdapter: agentos_runtime\n\nSends one signed, scope-bound Paperclip run to AgentOS. The adapter accepts only a terminal AgentOS response (HTTP 200 with state succeeded or failed); pending responses fail closed. The Ed25519 private key is host-only in PAPERCLIP_AGENTOS_RUNTIME_SIGNING_PRIVATE_KEY_B64.\n`,
  getConfigSchema: () => ({ fields: [
    { key: "endpoint", label: "AgentOS runtime endpoint", type: "text" as const, required: true },
    { key: "agentOsAgentId", label: "AgentOS agent ID", type: "text" as const, required: true },
    { key: "projectId", label: "Paperclip project ID", type: "text" as const, required: true },
    { key: "ownerHash", label: "Owner hash", type: "text" as const, required: true },
    { key: "provider", label: "Provider", type: "select" as const, required: true, options: [{ value: "codex", label: "Codex" }, { value: "claude", label: "Claude" }] },
    { key: "model", label: "AgentOS model", type: "text" as const, required: true },
    { key: "providerConnectionEpoch", label: "Provider connection epoch", type: "text" as const, required: true },
    { key: "revision", label: "AgentOS configuration revision", type: "number" as const, required: true },
    { key: "capabilities", label: "AgentOS capabilities (sorted JSON array)", type: "textarea" as const, required: true },
  ] }),
};
