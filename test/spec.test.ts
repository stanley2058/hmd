import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SharedCache } from "../src/cache.ts";
import { findOperation, formatSpecSummary, SpecStore } from "../src/spec.ts";
import { testConfig } from "./helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

const document = {
  openapi: "3.0.0",
  paths: {
    "/notes/{noteId}": {
      get: {
        description: "Get one note",
        operationId: "GetNote",
        parameters: [{ in: "path" as const, name: "noteId", required: true }],
      },
    },
  },
};

describe("SpecStore", () => {
  test("caches Swagger and exposes operation lookup and trimmed help", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-spec-test-"));
    roots.push(root);
    let calls = 0;
    const fetcher = (async () => {
      calls += 1;
      return Response.json(document, { headers: { etag: 'W/"spec"' } });
    }) as unknown as typeof fetch;
    const config = testConfig({ cacheDir: root });

    const first = new SpecStore(config, new SharedCache(root), fetcher);
    const loaded = await first.load();
    const second = new SpecStore(config, new SharedCache(root), fetcher);
    await second.load();

    expect(calls).toBe(1);
    expect(findOperation(loaded, "getnote")?.path).toBe("/notes/{noteId}");
    expect(formatSpecSummary(loaded, first.url)).toContain("GetNote       GET     /notes/{noteId}");
    expect(formatSpecSummary(loaded, first.url)).toContain("OPERATION ID  METHOD  PATH");
    expect(formatSpecSummary(loaded, first.url)).toContain(first.url);
  });
});
