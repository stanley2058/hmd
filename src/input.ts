import { readFile } from "node:fs/promises";

export async function readInput(path: string): Promise<Uint8Array> {
  if (path !== "-") return readFile(path);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
