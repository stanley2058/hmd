import { describe, expect, test } from "bun:test";

import type { ApiExecutor } from "../src/api.ts";
import { Notes } from "../src/notes.ts";
import type { PublicMarkdownReader } from "../src/public-markdown.ts";
import { testConfig } from "./helpers.ts";

function apiResult(body: unknown, status = 200) {
  return {
    body: Buffer.from(JSON.stringify(body)),
    headers: new Headers(),
    source: "api" as const,
    status,
  };
}

describe("Notes", () => {
  test("resolves a note locally without touching either transport", () => {
    const api = {
      request: () => {
        throw new Error("API should not be called");
      },
    } as unknown as ApiExecutor;
    const markdown = {
      read: () => {
        throw new Error("public web should not be called");
      },
    } as unknown as PublicMarkdownReader;
    const notes = new Notes(testConfig(), api, markdown);

    const result = notes.resolve("https://example.test/@uid/note-id");
    expect(result.source).toBe("local");
    expect(JSON.parse(Buffer.from(result.body).toString())).toMatchObject({
      apiReference: "note-id",
      webUrl: "https://example.test/@uid/note-id",
    });
  });

  test("lists only the explicitly selected team", async () => {
    let requested = "";
    const api = {
      request: async (method: string, path: string) => {
        requested = `${method} ${path}`;
        return apiResult([]);
      },
    } as unknown as ApiExecutor;
    const notes = new Notes(testConfig(), api, {} as PublicMarkdownReader);

    await notes.list({ cacheMs: 300_000, team: "docs team" });

    expect(requested).toBe("GET /teams/docs%20team/notes");
  });

  test("views public Markdown as normalized JSON", async () => {
    const markdown = {
      read: async () => ({
        body: Buffer.from("---\ntitle: Public\n---\n# Note\n"),
        source: "public-web" as const,
        url: "https://example.test/note-id.md",
      }),
    } as unknown as PublicMarkdownReader;
    const notes = new Notes(testConfig(), {} as ApiExecutor, markdown);

    const result = await notes.view("note-id", { api: "auto", cacheMs: 300_000 });
    const value = JSON.parse(Buffer.from(result.body).toString());

    expect(value.id).toBe("note-id");
    expect(value.content).toContain("# Note");
    expect(value["_hmd"].source).toBe("public-web");
  });

  test("creates a team note with a JSON request body", async () => {
    let requestedPath = "";
    let requestedBody = "";
    const api = {
      request: async (_method: string, path: string, options: { input?: Uint8Array }) => {
        requestedPath = path;
        requestedBody = Buffer.from(options.input || []).toString();
        return apiResult({ id: "new-note" }, 201);
      },
    } as unknown as ApiExecutor;
    const notes = new Notes(testConfig(), api, {} as PublicMarkdownReader);

    const result = await notes.create({ content: "# New", team: "docs", title: "New" });

    expect(result.status).toBe(201);
    expect(requestedPath).toBe("/teams/docs/notes");
    expect(JSON.parse(requestedBody)).toEqual({ content: "# New", title: "New" });
  });

  test("skips a PATCH when public content is unchanged", async () => {
    let apiCalls = 0;
    const api = {
      request: async () => {
        apiCalls += 1;
        return apiResult({});
      },
    } as unknown as ApiExecutor;
    const markdown = {
      read: async () => ({
        body: Buffer.from("# Same\n"),
        source: "public-web" as const,
        url: "https://example.test/note-id.md",
      }),
    } as unknown as PublicMarkdownReader;
    const notes = new Notes(testConfig(), api, markdown);

    const result = await notes.update("note-id", {
      cacheMs: 300_000,
      content: "# Same\n",
    });

    expect(apiCalls).toBe(0);
    expect(result.source).toBe("local");
    expect(Buffer.from(result.body).toString()).toContain('"updated": false');
  });

  test("updates private content without a charged preflight GET", async () => {
    const requests: string[] = [];
    const api = {
      request: async (method: string, path: string) => {
        requests.push(`${method} ${path}`);
        return apiResult({ updated: true }, 202);
      },
    } as unknown as ApiExecutor;
    const markdown = {
      read: async () => {
        throw new Error("not public");
      },
    } as unknown as PublicMarkdownReader;
    const notes = new Notes(testConfig(), api, markdown);

    await notes.update("private-note", { cacheMs: 300_000, content: "# Changed" });

    expect(requests).toEqual(["PATCH /notes/private-note"]);
  });

  test("produces a unified diff and reports whether content changed", async () => {
    const markdown = {
      read: async () => ({
        body: Buffer.from("# Old\n"),
        source: "cache" as const,
        url: "https://example.test/note-id.md",
      }),
    } as unknown as PublicMarkdownReader;
    const notes = new Notes(testConfig(), {} as ApiExecutor, markdown);

    const result = await notes.diff("note-id", {
      api: "auto",
      cacheMs: 300_000,
      filename: "note.md",
      localContent: "# New\n",
    });

    expect(result.different).toBe(true);
    expect(Buffer.from(result.body).toString()).toContain("-# Old");
    expect(Buffer.from(result.body).toString()).toContain("+# New");
  });

  test("deletes through the generic note endpoint", async () => {
    let requested = "";
    const api = {
      request: async (method: string, path: string) => {
        requested = `${method} ${path}`;
        return apiResult({}, 204);
      },
    } as unknown as ApiExecutor;
    const notes = new Notes(testConfig(), api, {} as PublicMarkdownReader);

    await notes.delete("https://example.test/@uid/note-id");

    expect(requested).toBe("DELETE /notes/note-id");
  });
});
