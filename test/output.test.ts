import { describe, expect, test } from "bun:test";

import { HmdError } from "../src/diagnostics.ts";
import { errorDocument, formatAttempt } from "../src/output.ts";

describe("diagnostic output", () => {
  test("serializes stable error codes and transport attempts", () => {
    const error = new HmdError("NOTE_NOT_FOUND", 'Note "abc" could not be read.', {
      attempts: [
        { method: "GET", result: "response", source: "public", status: 404, url: "https://x" },
      ],
      note: "abc",
      status: 404,
    });

    expect(errorDocument(error)).toEqual({
      error: {
        attempts: [
          {
            method: "GET",
            result: "response",
            source: "public",
            status: 404,
            url: "https://x",
          },
        ],
        code: "NOTE_NOT_FOUND",
        message: 'Note "abc" could not be read.',
        note: "abc",
        status: 404,
      },
    });
    expect(formatAttempt(error.attempts![0]!)).toBe("public: GET https://x -> 404");
  });
});
