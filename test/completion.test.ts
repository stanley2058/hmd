import { describe, expect, test } from "bun:test";

import { complete, completionScript } from "../src/completion.ts";

describe("completion", () => {
  test("completes built-ins and dynamic operation IDs", () => {
    expect(complete(["a"])).toEqual(["api"]);
    expect(complete(["api", "c"])).toEqual(["call"]);
    expect(complete(["note", "v"])).toEqual(["view"]);
    expect(
      complete(["api", "call", "Get"], {
        paths: {
          "/notes/{noteId}": { get: { operationId: "GetNote" } },
        },
      }),
    ).toEqual(["GetNote"]);
  });

  test("prints scripts for supported shells", () => {
    expect(completionScript("bash")).toContain("complete -F");
    expect(completionScript("zsh")).toContain("compdef");
    expect(completionScript("fish")).toContain("complete -c hmd");
  });
});
