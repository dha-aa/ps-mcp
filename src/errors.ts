// The one error format every tool returns: {error: {code, message, hint}}.

export const ERROR_CODES = [
  "NOT_FOUND",
  "BAD_ARGS",
  "PS_ERROR",
  "BUSY",
  "BRIDGE_DOWN",
  "TIMEOUT",
  "FORBIDDEN",
  "UNSUPPORTED",
  "EXISTS",
  "NETWORK",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export interface ToolErrorBody {
  code: ErrorCode;
  message: string;
  hint?: string;
}

export class PsToolError extends Error {
  readonly code: ErrorCode;
  readonly hint?: string;

  constructor(code: ErrorCode, message: string, hint?: string) {
    super(message);
    this.code = code;
    this.hint = hint;
  }

  toJSON(): ToolErrorBody {
    return this.hint ? { code: this.code, message: this.message, hint: this.hint } : { code: this.code, message: this.message };
  }
}

/** Turns anything thrown into the error body; unknown errors become PS_ERROR. */
export function toErrorBody(e: unknown): ToolErrorBody {
  if (e instanceof PsToolError) return e.toJSON();
  const b = e as Partial<ToolErrorBody> | null;
  if (b && typeof b.code === "string" && (ERROR_CODES as readonly string[]).includes(b.code) && typeof b.message === "string") {
    return b.hint ? { code: b.code as ErrorCode, message: b.message, hint: b.hint } : { code: b.code as ErrorCode, message: b.message };
  }
  return { code: "PS_ERROR", message: e instanceof Error ? e.message : String(e) };
}
