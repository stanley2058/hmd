export type AttemptResult = "bypass" | "error" | "hit" | "miss" | "response" | "stale";

export interface TransportAttempt {
  detail?: string;
  fetchedAt?: string;
  label?: string;
  method?: string;
  result: AttemptResult;
  source: "api" | "cache" | "public" | "swagger";
  status?: number;
  url?: string;
}

export interface HmdErrorOptions {
  attempts?: TransportAttempt[];
  cause?: unknown;
  details?: Record<string, unknown>;
  note?: string;
  status?: number;
}

export class HmdError extends Error {
  readonly attempts?: TransportAttempt[];
  readonly code: string;
  readonly details?: Record<string, unknown>;
  readonly note?: string;
  readonly status?: number;

  constructor(code: string, message: string, options: HmdErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "HmdError";
    this.code = code;
    if (options.attempts?.length) this.attempts = options.attempts;
    if (options.details) this.details = options.details;
    if (options.note) this.note = options.note;
    if (options.status !== undefined) this.status = options.status;
  }
}

export function errorCodeForStatus(status: number, note = false): string {
  if (status === 401) return "AUTH_REQUIRED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404 && note) return "NOTE_NOT_FOUND";
  if (status === 429) return "RATE_LIMITED";
  return "HTTP_ERROR";
}

export function normalizeError(error: unknown): HmdError {
  if (error instanceof HmdError) return error;
  if (error instanceof Error) {
    return new HmdError("COMMAND_FAILED", error.message, { cause: error });
  }
  return new HmdError("COMMAND_FAILED", String(error));
}
