import { describe, expect, it } from "vitest";
import { shouldReconcilePreterminalizedAgentOsRun } from "../services/heartbeat.ts";

describe("AgentOS callback terminalization reconciliation", () => {
  it.each(["succeeded", "failed"])('reconciles a callback-terminalized %s run', (status) => {
    expect(shouldReconcilePreterminalizedAgentOsRun({
      adapterType: "agentos_runtime",
      currentStatus: status,
      expectedStatus: status,
    })).toBe(true);
  });

  it("does not overwrite a conflicting terminal status", () => {
    expect(shouldReconcilePreterminalizedAgentOsRun({
      adapterType: "agentos_runtime",
      currentStatus: "failed",
      expectedStatus: "succeeded",
    })).toBe(false);
  });

  it("does not widen the reconciliation path to other adapters", () => {
    expect(shouldReconcilePreterminalizedAgentOsRun({
      adapterType: "codex_local",
      currentStatus: "succeeded",
      expectedStatus: "succeeded",
    })).toBe(false);
  });
});
