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
    expect(initial.attempts.map(({ result, source }) => ({ result, source }))).toEqual([
      { result: "miss", source: "cache" },
      { result: "response", source: "public" },
    ]);
    expect(repeated.source).toBe("cache");
    expect(Buffer.from(repeated.body).toString()).toBe("# public\n");
  });

  test("keeps public and API fallback failures in a contextual error", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-public-test-"));
    roots.push(root);
    const config = testConfig({ cacheDir: root });
    const fetcher = (async () =>
      new Response("missing", { status: 404 })) as unknown as typeof fetch;
    const api = {
      request: async () => ({
        attempts: [
          {
            method: "GET",
            result: "response",
            source: "api",
            status: 404,
            url: "https://api.example.test/v1/notes/missing",
          },
        ],
        body: Buffer.from("missing"),
        headers: new Headers(),
        source: "api",
        status: 404,
      }),
    } as unknown as ApiExecutor;
    const reader = new PublicMarkdownReader(config, new SharedCache(root), api, fetcher);

    try {
      await reader.read("missing", { api: "auto", cacheMs: 300_000, fresh: true });
      throw new Error("expected note read to fail");
    } catch (error) {
      expect(error).toMatchObject({
        code: "NOTE_NOT_FOUND",
        message: 'Note "missing" could not be read.',
        note: "missing",
        status: 404,
      });
      expect(
        (error as { attempts: { label?: string; source: string; status?: number }[] }).attempts,
      ).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ source: "public", status: 404 }),
          expect.objectContaining({ label: "api fallback", source: "api", status: 404 }),
        ]),
      );
    }
  });

  for (const policy of ["auto", "always", "never"] as const) {
    for (const team of [undefined, "design"]) {
      test(`reads a named URL directly with policy ${policy} and team ${team}`, async () => {
        const root = await mkdtemp(join(tmpdir(), "hmd-direct-test-"));
        roots.push(root);
        const config = testConfig({ cacheDir: root });
        const paths: string[] = [];
        let publicCalls = 0;
        const fetcher = (async () => {
          publicCalls += 1;
          return new Response("private", { status: 403 });
        }) as unknown as typeof fetch;
        const api = {
          request: async (_method: string, path: string) => {
            paths.push(path);
            return {
              attempts: [
                {
                  method: "GET",
                  result: "response",
                  source: "api",
                  status: 200,
                  url: `${config.apiUrl}${path}`,
                },
              ],
              body: Buffer.from(JSON.stringify({ id: "canonical-id", content: "# Private" })),
              headers: new Headers(),
              source: "api",
              status: 200,
            };
          },
        } as unknown as ApiExecutor;
        const reader = new PublicMarkdownReader(config, new SharedCache(root), api, fetcher);
        const url = "https://example.test/@design/discussion";
        const read = reader.read(url, { api: policy, cacheMs: 300_000, ...(team ? { team } : {}) });
        if (policy === "never") {
          await expect(read).rejects.toThrow("not publicly readable");
          expect(paths).toEqual([]);
        } else {
          const result = await read;
          const path = `${team ? "/teams/design/notes" : "/notes"}/${encodeURIComponent(url)}`;
          expect(paths).toEqual([path]);
          expect(Buffer.from(result.body).toString()).toBe("# Private");
          expect(result.url).toBe(`${config.apiUrl}${path}`);
          expect(result.attempts.filter((attempt) => attempt.source === "api")).toHaveLength(1);
        }
        expect(publicCalls).toBe(policy === "always" ? 0 : 1);
      });
    }
  }

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
