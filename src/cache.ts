import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";

export type CacheNamespace = "public" | "responses" | "spec";

export interface CacheEntry<T> {
  etag?: string;
  fetchedAt: string;
  value: T;
  version: 1;
}

export interface CacheStats {
  bytes: number;
  entries: number;
  newestFetchedAt: string | null;
  oldestFetchedAt: string | null;
  root: string;
}

export interface CacheWriteCheck {
  error?: string;
  ok: boolean;
  root: string;
}

export function hashCacheKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

export class SharedCache {
  constructor(
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {}

  isFresh(entry: CacheEntry<unknown>, maxAgeMs: number): boolean {
    return this.now().getTime() - Date.parse(entry.fetchedAt) <= maxAgeMs;
  }

  async read<T>(namespace: CacheNamespace, key: string): Promise<CacheEntry<T> | undefined> {
    try {
      const text = await readFile(this.path(namespace, key), "utf8");
      const entry = JSON.parse(text) as CacheEntry<T>;
      if (entry.version !== 1 || !entry.fetchedAt) return undefined;
      return entry;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      return undefined;
    }
  }

  async write<T>(
    namespace: CacheNamespace,
    key: string,
    value: T,
    options: { etag?: string } = {},
  ): Promise<CacheEntry<T>> {
    const directory = join(this.root, namespace);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const destination = this.path(namespace, key);
    const temporary = join(directory, `.${randomUUID()}.tmp`);
    const entry: CacheEntry<T> = {
      ...(options.etag ? { etag: options.etag } : {}),
      fetchedAt: this.now().toISOString(),
      value,
      version: 1,
    };
    const handle = await open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(entry)}\n`, "utf8");
    } finally {
      await handle.close();
    }
    await rename(temporary, destination);
    return entry;
  }

  async clear(): Promise<number> {
    let removed = 0;
    for (const namespace of ["public", "responses", "spec"] as const) {
      const directory = join(this.root, namespace);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        await unlink(join(directory, name));
        removed += 1;
      }
    }
    return removed;
  }

  async checkWritable(): Promise<CacheWriteCheck> {
    let probe: string | undefined;
    try {
      await mkdir(this.root, { recursive: true, mode: 0o700 });
      probe = join(this.root, `.write-check-${randomUUID()}`);
      const handle = await open(probe, "wx", 0o600);
      await handle.close();
      await unlink(probe);
      return { ok: true, root: this.root };
    } catch (error) {
      if (probe) {
        try {
          await unlink(probe);
        } catch {}
      }
      return {
        error: error instanceof Error ? error.message : String(error),
        ok: false,
        root: this.root,
      };
    }
  }

  async stats(): Promise<CacheStats> {
    let bytes = 0;
    let entries = 0;
    const fetchedTimes: string[] = [];
    for (const namespace of ["public", "responses", "spec"] as const) {
      const directory = join(this.root, namespace);
      let names: string[];
      try {
        names = await readdir(directory);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
        throw error;
      }
      for (const name of names) {
        if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
        const file = join(directory, name);
        const [metadata, content] = await Promise.all([stat(file), readFile(file, "utf8")]);
        bytes += metadata.size;
        entries += 1;
        try {
          const parsed = JSON.parse(content) as CacheEntry<unknown>;
          if (parsed.fetchedAt) fetchedTimes.push(parsed.fetchedAt);
        } catch {}
      }
    }
    fetchedTimes.sort();
    return {
      bytes,
      entries,
      newestFetchedAt: fetchedTimes.at(-1) || null,
      oldestFetchedAt: fetchedTimes[0] || null,
      root: this.root,
    };
  }

  private path(namespace: CacheNamespace, key: string): string {
    return join(this.root, namespace, `${hashCacheKey(key)}.json`);
  }
}
