import type { ToolPolicy } from "./contracts.js";

export function allowAllToolCalls(): ToolPolicy {
  return () => ({ decision: "allow" });
}

export function denyAllToolCalls(reason?: string): ToolPolicy {
  return () =>
    reason === undefined
      ? { decision: "deny" }
      : { decision: "deny", reason };
}
