import type { ExecutionLimits } from "./contracts.js";

export const defaultExecutionLimits: ExecutionLimits = Object.freeze({
  sourceBytes: 128 * 1024,
  computeTimeMs: 5_000,
  wallTimeMs: 60_000,
  toolCallTimeMs: 30_000,
  memoryBytes: 64 * 1024 * 1024,
  maxToolCalls: 32,
  maxConcurrentToolCalls: 8,
  toolResultBytes: 2 * 1024 * 1024,
  totalBridgeBytes: 8 * 1024 * 1024,
  finalResultBytes: 256 * 1024,
  logBytes: 64 * 1024,
  logEntries: 100,
});

export function resolveExecutionLimits(
  overrides: Partial<ExecutionLimits> | undefined,
): ExecutionLimits {
  const resolved = { ...defaultExecutionLimits, ...overrides };

  for (const [name, value] of Object.entries(resolved)) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError(`Execution limit ${name} must be a positive safe integer`);
    }
  }

  return Object.freeze(resolved);
}
