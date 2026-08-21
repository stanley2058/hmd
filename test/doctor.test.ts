import { describe, expect, test } from "bun:test";

import type { ApiExecutor } from "../src/api.ts";
import type { SharedCache } from "../src/cache.ts";
import { Doctor, formatDoctor } from "../src/doctor.ts";
import { testConfig } from "./helpers.ts";

describe("Doctor", () => {
  test("reports endpoints, cache health, Swagger, and a safe identity", async () => {
    const config = testConfig();
    const cache = {
      checkWritable: async () => ({ ok: true, root: "/cache/hmd" }),
    } as Pick<SharedCache, "checkWritable">;
    const api = {
      request: async () => ({
        attempts: [],
        body: Buffer.from(
          JSON.stringify({ email: "agent@example.test", id: "user-id", token: "never show" }),
        ),
        headers: new Headers(),
        source: "api",
        status: 200,
      }),
    } as Pick<ApiExecutor, "request">;
    const fetcher = (async () => Response.json({ openapi: "3.0.0" })) as unknown as typeof fetch;

    const result = await new Doctor("1.2.3", config, cache, api, fetcher).run();

    expect(result).toMatchObject({
      checks: {
        auth: {
          configured: true,
          identity: { email: "agent@example.test", id: "user-id" },
          ok: true,
          status: 200,
        },
        cache: { ok: true, path: "/cache/hmd" },
        swagger: { ok: true, status: 200 },
      },
      ok: true,
      token: { present: true },
      version: "1.2.3",
    });
    expect(JSON.stringify(result)).not.toContain("never show");
    expect(formatDoctor(result)).toContain("Identity:");
  });

  test("does not call auth when no token is configured", async () => {
    const config = testConfig();
    delete config.token;
    const cache = {
      checkWritable: async () => ({ ok: true, root: "/cache/hmd" }),
    } as Pick<SharedCache, "checkWritable">;
    const api = {
      request: () => {
        throw new Error("auth should not be called");
      },
    } as unknown as Pick<ApiExecutor, "request">;
    const result = await new Doctor("1.2.3", config, cache, api, (async () =>
      Response.json({})) as unknown as typeof fetch).run();

    expect(result.ok).toBe(true);
    expect(result.checks.auth).toEqual({ configured: false, ok: null });
  });
});
