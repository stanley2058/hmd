import {
  errorCodeForStatus,
  HmdError,
  normalizeError,
  type TransportAttempt,
} from "./diagnostics.ts";

export function writeApiResult(
  result: { attempts?: TransportAttempt[]; body: Uint8Array; status: number },
  options: { jsonErrors?: boolean } = {},
): void {
  if (options.jsonErrors && (result.status < 200 || result.status >= 300)) {
    throw new HmdError(
      errorCodeForStatus(result.status),
      `HackMD API request failed with HTTP ${result.status}.`,
      {
        ...(result.attempts ? { attempts: result.attempts } : {}),
        status: result.status,
      },
    );
  }
  process.stdout.write(result.body);
  if (result.body.length > 0 && result.body.at(-1) !== 10) process.stdout.write("\n");
  if (result.status < 200 || result.status >= 300) process.exitCode = 1;
}

export function formatAttempt(attempt: TransportAttempt): string {
  const label = attempt.label || attempt.source;
  const request = [attempt.method, attempt.url].filter(Boolean).join(" ");
  const outcome = attempt.status === undefined ? attempt.result : `${attempt.status}`;
  const detail = attempt.detail ? ` (${attempt.detail})` : "";
  return `${label}: ${request}${request ? " -> " : ""}${outcome}${detail}`;
}

export function writeVerbose(
  verbose: boolean | undefined,
  details: {
    attempts?: TransportAttempt[];
    fetchedAt?: string;
    source: string;
    url?: string;
  },
): void {
  if (!verbose) return;
  if (details.attempts?.length) {
    for (const attempt of details.attempts) process.stderr.write(`${formatAttempt(attempt)}\n`);
    return;
  }
  const fields = [`source=${details.source}`];
  if (details.fetchedAt) fields.push(`fetched_at=${details.fetchedAt}`);
  if (details.url) fields.push(`url=${details.url}`);
  process.stderr.write(`${fields.join(" ")}\n`);
}

export function errorDocument(error: unknown): { error: Record<string, unknown> } {
  const normalized = normalizeError(error);
  return {
    error: {
      code: normalized.code,
      message: normalized.message,
      ...(normalized.note ? { note: normalized.note } : {}),
      ...(normalized.status === undefined ? {} : { status: normalized.status }),
      ...(normalized.attempts ? { attempts: normalized.attempts } : {}),
      ...(normalized.details ? { details: normalized.details } : {}),
    },
  };
}

export function writeError(
  error: unknown,
  options: { json?: boolean; verbose?: boolean } = {},
): void {
  const normalized = normalizeError(error);
  if (options.json) {
    process.stderr.write(`${JSON.stringify(errorDocument(normalized), null, 2)}\n`);
    return;
  }
  process.stderr.write(`hmd: ${normalized.message}\n`);
  if (options.verbose && normalized.attempts) {
    for (const attempt of normalized.attempts) {
      process.stderr.write(`  ${formatAttempt(attempt)}\n`);
    }
  }
}
