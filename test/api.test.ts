import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ApiExecutor } from "../src/api.ts";
import { SharedCache } from "../src/cache.ts";
import { SpecStore } from "../src/spec.ts";
import { testConfig } from "./helpers.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("ApiExecutor", () => {
  test("reuses a successful GET across calls and processes", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-api-test-"));
    roots.push(root);
    const config = testConfig({ cacheDir: root });
    let swaggerCalls = 0;
    let apiCalls = 0;
    const fetcher = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/docs/swagger.json")) {
        swaggerCalls += 1;
        return Response.json({
          openapi: "3.0.0",
          paths: {
            "/notes/{noteId}": {
              get: {
                operationId: "GetNote",
                parameters: [{ in: "path", name: "noteId", required: true }],
              },
            },
          },
        });
      }
      apiCalls += 1;
      return Response.json({ content: "# cached" });
    }) as typeof fetch;

    const firstCache = new SharedCache(root);
    const first = new ApiExecutor(
      config,
      firstCache,
      new SpecStore(config, firstCache, fetcher),
      fetcher,
    );
    const request = {
      cacheMs: 300_000,
      fields: [{ name: "noteId", value: "abc" }],
    };
    const initial = await first.call("GetNote", request);

    const secondCache = new SharedCache(root);
    const second = new ApiExecutor(
      config,
      secondCache,
      new SpecStore(config, secondCache, fetcher),
      fetcher,
    );
    const repeated = await second.call("GetNote", request);

    expect(swaggerCalls).toBe(1);
    expect(apiCalls).toBe(1);
    expect(initial.source).toBe("api");
    expect(repeated.source).toBe("cache");
    expect(Buffer.from(repeated.body).toString()).toContain("cached");
  });

  test("constructs multipart requests described by Swagger", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-api-test-"));
    roots.push(root);
    const config = testConfig({ cacheDir: root });
    let uploaded: FormData | undefined;
    const fetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      if (String(input).endsWith("/docs/swagger.json")) {
        return Response.json({
          openapi: "3.0.0",
          paths: {
            "/notes/{noteId}/images": {
              post: {
                operationId: "UploadNoteImage",
                parameters: [{ in: "path", name: "noteId", required: true }],
                requestBody: {
                  content: {
                    "multipart/form-data": {
                      schema: { properties: { image: { format: "binary", type: "string" } } },
                    },
                  },
                },
              },
            },
          },
        });
      }
      expect(new Headers(init?.headers).get("authorization")).toBe("Bearer secret-token");
      expect(new Headers(init?.headers).has("content-type")).toBe(false);
      uploaded = init?.body as FormData;
      return Response.json({ url: "https://example.test/image.png" }, { status: 201 });
    }) as typeof fetch;
    const shared = new SharedCache(root);
    const api = new ApiExecutor(config, shared, new SpecStore(config, shared, fetcher), fetcher);

    const result = await api.call("UploadNoteImage", {
      cacheMs: 0,
      fields: [
        { name: "noteId", value: "abc" },
        {
          name: "image",
          value: { data: Buffer.from([1, 2, 3]), filename: "image.png", kind: "file" },
        },
      ],
    });

    expect(result.status).toBe(201);
    expect(uploaded).toBeInstanceOf(FormData);
    expect((uploaded!.get("image") as Blob).size).toBe(3);
  });
});
