import { describe, expect, test } from "bun:test";

import { resolveNoteReference } from "../src/note-reference.ts";
import { testConfig } from "./helpers.ts";

describe("resolveNoteReference", () => {
  test("normalizes IDs, named URLs, and raw Markdown URLs", () => {
    const config = testConfig();

    expect(resolveNoteReference(config, "abc")).toMatchObject({
      apiReference: "abc",
      markdownUrl: "https://example.test/abc.md?no-meta=",
      webUrl: "https://example.test/abc",
    });
    expect(resolveNoteReference(config, "https://example.test/@uid/named-note")).toMatchObject({
      apiReference: "named-note",
      markdownUrl: "https://example.test/@uid/named-note.md?no-meta=",
      webUrl: "https://example.test/@uid/named-note",
    });
    expect(
      resolveNoteReference(config, "https://example.test/@uid/named-note.md?no-meta"),
    ).toMatchObject({
      apiReference: "named-note",
      webUrl: "https://example.test/@uid/named-note",
    });
  });

  test("refuses URLs from another origin", () => {
    expect(() => resolveNoteReference(testConfig(), "https://attacker.example/note")).toThrow(
      "outside https://example.test",
    );
  });
});
