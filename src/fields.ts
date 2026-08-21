import { readFile } from "node:fs/promises";
import { basename } from "node:path";

export interface FileFieldValue {
  data: Uint8Array;
  filename: string;
  kind: "file";
}

export interface Field {
  name: string;
  value: unknown;
}

function splitField(input: string): [string, string] {
  const index = input.indexOf("=");
  if (index <= 0) throw new Error(`Invalid field "${input}". Expected key=value.`);
  return [input.slice(0, index), input.slice(index + 1)];
}

async function typedValue(input: string): Promise<unknown> {
  if (input.startsWith("@")) {
    const path = input.slice(1);
    return {
      data: await readFile(path),
      filename: basename(path),
      kind: "file",
    } satisfies FileFieldValue;
  }
  if (input === "true") return true;
  if (input === "false") return false;
  if (input === "null") return null;
  if (/^-?\d+(?:\.\d+)?$/.test(input)) return Number(input);
  return input;
}

export function isFileFieldValue(value: unknown): value is FileFieldValue {
  return Boolean(value && typeof value === "object" && "kind" in value && value.kind === "file");
}

export function fieldValueAsString(value: unknown): string {
  return isFileFieldValue(value) ? Buffer.from(value.data).toString("utf8") : String(value);
}

export async function parseFields(typed: string[], raw: string[]): Promise<Field[]> {
  const fields: Field[] = [];
  for (const input of typed) {
    const [name, value] = splitField(input);
    fields.push({ name, value: await typedValue(value) });
  }
  for (const input of raw) {
    const [name, value] = splitField(input);
    fields.push({ name, value });
  }
  return fields;
}

export function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}
