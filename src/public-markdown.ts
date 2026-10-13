import { noteApiPath } from "./note-api-target.ts";
import type { Config } from "./config.ts";
import { SharedCache } from "./cache.ts";
import type { ApiExecutor } from "./api.ts";
import { errorCodeForStatus, HmdError, type TransportAttempt } from "./diagnostics.ts";
import { markdownUrlForReference, resolveNoteReference } from "./note-reference.ts";

interface CachedMarkdown {
  body: string;
  contentType: string;
  url: string;
}

export type ApiPolicy = "always" | "auto" | "never";

export interface MarkdownOptions {
  api: ApiPolicy;
  cacheMs: number;
  fresh?: boolean;
  meta?: boolean;
  team?: string;
  offline?: boolean;
}

export interface MarkdownResult {
  apiData?: Record<string, unknown>;
  attempts: TransportAttempt[];
  body: Uint8Array;
  fetchedAt?: string;
  source: "api" | "cache" | "public-web";
  url: string;
}

interface PublicRead {
  attempts: TransportAttempt[];
  result?: MarkdownResult;
}

function labelApiAttempt(attempt: TransportAttempt, fallback: boolean): TransportAttempt {
  if (!fallback) return attempt;
  return {
    ...attempt,
    label: attempt.source === "cache" ? "api fallback cache" : "api fallback",
  };
}

function cachedResult(
  value: CachedMarkdown,
  fetchedAt: string,
  attempts: TransportAttempt[],
): MarkdownResult {
  return {
    attempts,
    body: Buffer.from(value.body, "base64"),
    fetchedAt,
    source: "cache",
    url: value.url,
  };
}

export class PublicMarkdownReader {
  constructor(
    private readonly config: Config,
    private readonly cache: SharedCache,
    private readonly api: ApiExecutor,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async read(reference: string, options: MarkdownOptions): Promise<MarkdownResult> {
    const resolved = resolveNoteReference(this.config, reference);
    const noteId = resolved.apiReference;
    let attempts: TransportAttempt[] = [];
    if (options.api !== "always") {
      const publicRead = await this.readPublic(reference, options);
      attempts = publicRead.attempts;
      if (publicRead.result) return publicRead.result;
    }
    if (options.api === "never") {
      throw new HmdError(
        "NOTE_NOT_READABLE",
        `Note "${noteId}" is not publicly readable and API use is disabled.`,
        { attempts, note: noteId },
      );
    }
    if (options.offline) {
      throw new HmdError(
        "CACHE_MISS",
        `Note "${noteId}" is not available in the public Markdown cache.`,
        { attempts, note: noteId },
      );
    }

    let result;
    const path = noteApiPath(resolved, options.team);
    try {
      result = await this.api.request("GET", path, {
        cacheMs: options.cacheMs,
        ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
        ...(options.offline === undefined ? {} : { offline: options.offline }),
      });
    } catch (error) {
      if (error instanceof HmdError) {
        throw new HmdError(error.code, `Note "${noteId}" could not be read.`, {
          attempts: [
            ...attempts,
            ...(error.attempts || []).map((attempt) =>
              labelApiAttempt(attempt, options.api === "auto"),
            ),
          ],
          cause: error,
          note: noteId,
          ...(error.status === undefined ? {} : { status: error.status }),
        });
      }
      throw error;
    }
    const apiAttempts = result.attempts.map((attempt) =>
      labelApiAttempt(attempt, options.api === "auto"),
    );
    attempts.push(...apiAttempts);
    if (result.status < 200 || result.status >= 300) {
      throw new HmdError(
        errorCodeForStatus(result.status, true),
        `Note "${noteId}" could not be read.`,
        { attempts, note: noteId, status: result.status },
      );
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(Buffer.from(result.body).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new HmdError("INVALID_RESPONSE", "HackMD API did not return a JSON note.", {
        attempts,
        note: noteId,
      });
    }
    const content = data.content;
    if (typeof content !== "string") {
      throw new HmdError("INVALID_RESPONSE", "HackMD API response has no note content.", {
        attempts,
        note: noteId,
      });
    }
    return {
      apiData: data,
      attempts,
      body: Buffer.from(content),
      ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
      source: result.source,
      url: `${this.config.apiUrl}${path}`,
    };
  }

  private async readPublic(reference: string, options: MarkdownOptions): Promise<PublicRead> {
    const url = markdownUrlForReference(this.config, reference, Boolean(options.meta));
    const key = url.toString();
    const cached = await this.cache.read<CachedMarkdown>("public", key);
    const attempts: TransportAttempt[] = [
      {
        ...(cached?.fetchedAt ? { fetchedAt: cached.fetchedAt } : {}),
        label: "public cache",
        method: "GET",
        result:
          cached && options.fresh
            ? "bypass"
            : cached
              ? this.cache.isFresh(cached, options.cacheMs)
                ? "hit"
                : "stale"
              : "miss",
        source: "cache",
        url: url.toString(),
        ...(cached && options.fresh ? { detail: "ignored by --fresh" } : {}),
      },
    ];
    if (!options.fresh && cached && this.cache.isFresh(cached, options.cacheMs)) {
      return { attempts, result: cachedResult(cached.value, cached.fetchedAt, attempts) };
    }
    if (options.offline) {
      return {
        attempts,
        ...(cached ? { result: cachedResult(cached.value, cached.fetchedAt, attempts) } : {}),
      };
    }

    const headers = new Headers({ Accept: "text/markdown" });
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    let response: Response;
    try {
      response = await this.fetchSameOrigin(url, headers);
    } catch (error) {
      attempts.push({
        detail: error instanceof Error ? error.message : String(error),
        method: "GET",
        result: "error",
        source: "public",
        url: url.toString(),
      });
      return { attempts };
    }
    attempts.push({
      method: "GET",
      result: "response",
      source: "public",
      status: response.status,
      url: response.url || url.toString(),
    });
    if (response.status === 304 && cached) {
      const refreshed = await this.cache.write(
        "public",
        key,
        cached.value,
        cached.etag ? { etag: cached.etag } : {},
      );
      return {
        attempts,
        result: cachedResult(refreshed.value, refreshed.fetchedAt, attempts),
      };
    }

    const contentType = response.headers.get("content-type") || "";
    if (response.status !== 200 || !contentType.toLowerCase().startsWith("text/markdown")) {
      if (response.status === 200) {
        attempts[attempts.length - 1]!.detail =
          `unexpected content-type: ${contentType || "missing"}`;
      }
      return { attempts };
    }
    let body: Uint8Array;
    try {
      body = new Uint8Array(await response.arrayBuffer());
    } catch (error) {
      attempts.push({
        detail: error instanceof Error ? error.message : String(error),
        method: "GET",
        result: "error",
        source: "public",
        url: response.url || url.toString(),
      });
      return { attempts };
    }
    const etag = response.headers.get("etag");
    const value: CachedMarkdown = {
      body: Buffer.from(body).toString("base64"),
      contentType,
      url: response.url || url.toString(),
    };
    const entry =
      options.cacheMs > 0
        ? await this.cache.write<CachedMarkdown>("public", key, value, etag ? { etag } : {})
        : undefined;
    return {
      attempts,
      result: {
        attempts,
        body,
        ...(entry ? { fetchedAt: entry.fetchedAt } : {}),
        source: "public-web",
        url: response.url || url.toString(),
      },
    };
  }

  private async fetchSameOrigin(initialUrl: URL, headers: Headers): Promise<Response> {
    const allowedOrigin = new URL(this.config.webUrl).origin;
    let url = initialUrl;
    for (let redirects = 0; redirects <= 5; redirects += 1) {
      const response = await this.fetcher(url, { headers, redirect: "manual" });
      if (response.status < 300 || response.status >= 400) return response;
      const location = response.headers.get("location");
      if (!location) return response;
      const next = new URL(location, url);
      if (next.origin !== allowedOrigin) {
        throw new Error(`Refusing redirect outside ${allowedOrigin}.`);
      }
      url = next;
    }
    throw new Error("Too many redirects while fetching public Markdown.");
  }
}
