import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SharedCache } from "../src/cache.ts";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("SharedCache", () => {
  test("persists values and fetched time across instances", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-cache-test-"));
    roots.push(root);
    const now = new Date("2026-08-21T05:00:00.000Z");
    const first = new SharedCache(root, () => now);
    await first.write("responses", "same request", { body: "hello" });

    const second = new SharedCache(root, () => new Date("2026-08-21T05:01:00.000Z"));
    const entry = await second.read<{ body: string }>("responses", "same request");

    expect(entry?.value.body).toBe("hello");
    expect(entry?.fetchedAt).toBe("2026-08-21T05:00:00.000Z");
    expect(second.isFresh(entry!, 61_000)).toBe(true);
    expect((await second.stats()).entries).toBe(1);
  });

  test("clear only removes hmd cache entries", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-cache-test-"));
    roots.push(root);
    const cache = new SharedCache(root);
    await cache.write("public", "note", "markdown");
    await cache.write("spec", "swagger", { paths: {} });

    expect(await cache.clear()).toBe(2);
    expect((await cache.stats()).entries).toBe(0);
  });

  test("checks whether the shared directory is writable", async () => {
    const root = await mkdtemp(join(tmpdir(), "hmd-cache-test-"));
    roots.push(root);

    expect(await new SharedCache(join(root, "new-cache")).checkWritable()).toEqual({
      ok: true,
      root: join(root, "new-cache"),
    });
  });
});
