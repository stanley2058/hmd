import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ApiExecutor } from "../src/api.ts";
import { SharedCache } from "../src/cache.ts";
import { PublicMarkdownReader } from "../src/public-markdown.ts";
import { testConfig } from "./helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("PublicMarkdownReader", () => {
  test("uses unauthenticated no-meta Markdown and shares the cached result", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-public-test-"));
    roots.push(root);
    const config = testConfig({ cacheDir: root });
    let calls = 0;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      expect(new Headers(init?.headers).has("authorization")).toBe(false);
      expect(String(input)).toContain("/note-id.md?no-meta=");
      return new Response("# public\n", {
        headers: { "content-type": "text/markdown; charset=utf-8", etag: 'W/"note"' },
        status: 200,
      });
    }) as typeof fetch;
    const api = {
      request: () => {
        throw new Error("API should not be called");
      },
    } as unknown as ApiExecutor;

    const first = new PublicMarkdownReader(config, new SharedCache(root), api, fetcher);
    const initial = await first.read("note-id", { api: "never", cacheMs: 300_000 });
    const second = new PublicMarkdownReader(config, new SharedCache(root), api, fetcher);
    const repeated = await second.read("note-id", { api: "never", cacheMs: 300_000 });

    expect(calls).toBe(1);
    expect(initial.source).toBe("public-web");
    expect(repeated.source).toBe("cache");
    expect(Buffer.from(repeated.body).toString()).toBe("# public\n");
  });

  test("rejects HTML success responses from free-URL handling", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-public-test-"));
    roots.push(root);
    const config = testConfig({ cacheDir: root });
    const fetcher = (async () => {
      return new Response("<html>create a note</html>", {
        headers: { "content-type": "text/html" },
        status: 200,
      });
    }) as unknown as typeof fetch;
    const api = {} as ApiExecutor;
    const reader = new PublicMarkdownReader(config, new SharedCache(root), api, fetcher);

    expect(reader.read("missing", { api: "never", cacheMs: 300_000 })).rejects.toThrow(
      "not publicly readable",
    );
  });
});
