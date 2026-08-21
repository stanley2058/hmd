export function writeApiResult(result: { body: Uint8Array; status: number }): void {
  process.stdout.write(result.body);
  if (result.body.length > 0 && result.body.at(-1) !== 10) process.stdout.write("\n");
  if (result.status < 200 || result.status >= 300) process.exitCode = 1;
}

export function writeVerbose(
  verbose: boolean | undefined,
  details: { fetchedAt?: string; source: string; url?: string },
): void {
  if (!verbose) return;
  const fields = [`source=${details.source}`];
  if (details.fetchedAt) fields.push(`fetched_at=${details.fetchedAt}`);
  if (details.url) fields.push(`url=${details.url}`);
  process.stderr.write(`${fields.join(" ")}\n`);
}
