import type { JsonValue } from "../core/types.ts";

export class HostError extends Error {
  readonly code: string;
  readonly details?: Record<string, JsonValue>;

  constructor(code: string, message: string, details?: Record<string, JsonValue>) {
    super(message);
    this.name = "HostError";
    this.code = code;
    this.details = details;
  }
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
