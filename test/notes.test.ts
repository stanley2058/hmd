import { describe, expect, test } from "bun:test";

import type { ApiExecutor } from "../src/api.ts";
import { Notes } from "../src/notes.ts";
import type { PublicMarkdownReader } from "../src/public-markdown.ts";
import { testConfig } from "./helpers.ts";

function apiResult(body: unknown, status = 200) {
  return {
    attempts: [],
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
      apiReference: "https://example.test/@uid/note-id",
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

    const result = await notes.update("https://example.test/@design/note-id", {
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

  for (const operation of ["update", "delete"] as const) {
    for (const team of [undefined, "design team"]) {
      test(`${operation} sends a named URL directly with team ${team}`, async () => {
        const requests: string[] = [];
        const url = "https://example.test/@design%20team/discussion";
        const path = `${team ? "/teams/design%20team/notes" : "/notes"}/${encodeURIComponent(url)}`;
        const method = operation === "update" ? "PATCH" : "DELETE";
        const api = {
          request: async (
            actualMethod: string,
            actualPath: string,
            options: { input?: Uint8Array },
          ) => {
            requests.push(`${actualMethod} ${actualPath}`);
            if (operation === "update")
              expect(JSON.parse(Buffer.from(options.input!).toString())).toEqual({
                title: "Updated",
              });
            return apiResult({}, operation === "update" ? 202 : 204);
          },
        } as unknown as ApiExecutor;
        const notes = new Notes(testConfig(), api, {} as PublicMarkdownReader);
        const options = team === undefined ? {} : { team };
        const result =
          operation === "update"
            ? await notes.update(`${url}.md?no-meta#heading`, {
                ...options,
                cacheMs: 300_000,
                title: "Updated",
              })
            : await notes.delete(`${url}.md?no-meta#heading`, options);
        expect(requests).toEqual([`${method} ${path}`]);
        expect(result.url).toBe(`https://api.example.test/v1${path}`);
      });
    }
    test(`${operation} preserves an API rejection without retrying another workspace`, async () => {
      const requests: string[] = [];
      const api = {
        request: async (method: string, path: string) => {
          requests.push(`${method} ${path}`);
          return apiResult({ error: "Forbidden" }, 403);
        },
      } as unknown as ApiExecutor;
      const notes = new Notes(testConfig(), api, {} as PublicMarkdownReader);
      const result =
        operation === "update"
          ? await notes.update("@design/discussion", {
              cacheMs: 300_000,
              title: "Updated",
              team: "design",
            })
          : await notes.delete("@design/discussion", { team: "design" });
      expect(result.status).toBe(403);
      expect(requests).toHaveLength(1);
      expect(requests[0]).toContain(
        "/teams/design/notes/https%3A%2F%2Fexample.test%2F%40design%2Fdiscussion",
      );
    });
  }

  for (const operation of ["view", "diff"] as const) {
    test(`${operation} forwards the URL and explicit team to the shared reader`, async () => {
      const markdown = {
        read: async (reference: string, options: { team?: string }) => {
          expect(reference).toBe("@design/discussion");
          expect(options.team).toBe("design");
          return {
            body: Buffer.from("content"),
            source: "api",
            url: "https://api.example.test/v1/teams/design/notes/reference",
          };
        },
      } as unknown as PublicMarkdownReader;
      const notes = new Notes(testConfig(), {} as ApiExecutor, markdown);
      const options = { api: "always" as const, cacheMs: 300_000, team: "design" };
      if (operation === "view") await notes.view("@design/discussion", options);
      else
        await notes.diff("@design/discussion", {
          ...options,
          filename: "note.md",
          localContent: "content",
        });
    });
  }

  test("deletes through the generic note endpoint", async () => {
    let requested = "";
    const api = {
      request: async (method: string, path: string) => {
        requested = `${method} ${path}`;
        return apiResult({}, 204);
      },
    } as unknown as ApiExecutor;
    const notes = new Notes(testConfig(), api, {} as PublicMarkdownReader);

    await notes.delete("https://example.test/note-id");

    expect(requested).toBe("DELETE /notes/note-id");
  });
});
