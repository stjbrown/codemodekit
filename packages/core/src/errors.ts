import type { ModelDiagnostic, SandboxLogEntry } from "./contracts.js";

export class CodeModeError extends Error {
  readonly diagnostic: ModelDiagnostic;
  readonly logs: readonly SandboxLogEntry[];

  constructor(
    diagnostic: ModelDiagnostic,
    options?: { readonly cause?: unknown; readonly logs?: readonly SandboxLogEntry[] },
  ) {
    super(diagnostic.message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CodeModeError";
    this.diagnostic = diagnostic;
    this.logs = options?.logs ?? [];
  }
}

/** A provider-declared tool failure whose message is safe to return to authored code. */
export class ProviderToolError extends Error {
  readonly upstreamCode: string | undefined;

  constructor(
    message: string,
    options?: { readonly upstreamCode?: string; readonly cause?: unknown },
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderToolError";
    this.upstreamCode = options?.upstreamCode;
  }
}

export function describeUnknownError(error: unknown): string {
  if (error instanceof Error && error.message.trim() !== "") {
    return error.message;
  }
  return "Unknown failure";
}
