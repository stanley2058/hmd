import type { Config } from "./config.ts";
import { SharedCache } from "./cache.ts";
import type { ApiExecutor } from "./api.ts";
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
  offline?: boolean;
}

export interface MarkdownResult {
  apiData?: Record<string, unknown>;
  body: Uint8Array;
  fetchedAt?: string;
  source: "api" | "cache" | "public-web";
  url: string;
}

function cachedResult(value: CachedMarkdown, fetchedAt: string): MarkdownResult {
  return {
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
    if (options.api !== "always") {
      const publicResult = await this.readPublic(reference, options);
      if (publicResult) return publicResult;
    }
    if (options.api === "never") {
      throw new Error("The note is not publicly readable and API use is disabled.");
    }
    if (options.offline) throw new Error("The note is not available in the public Markdown cache.");

    const noteId = resolveNoteReference(this.config, reference).apiReference;
    const result = await this.api.request("GET", `/notes/${encodeURIComponent(noteId)}`, {
      cacheMs: options.cacheMs,
      ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
      ...(options.offline === undefined ? {} : { offline: options.offline }),
    });
    if (result.status < 200 || result.status >= 300) {
      throw new Error(`HackMD API returned HTTP ${result.status}.`);
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(Buffer.from(result.body).toString("utf8")) as Record<string, unknown>;
    } catch {
      throw new Error("HackMD API did not return a JSON note.");
    }
    const content = data.content;
    if (typeof content !== "string") throw new Error("HackMD API response has no note content.");
    return {
      apiData: data,
      body: Buffer.from(content),
      ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
      source: result.source,
      url: `${this.config.apiUrl}/notes/${encodeURIComponent(noteId)}`,
    };
  }

  private async readPublic(
    reference: string,
    options: MarkdownOptions,
  ): Promise<MarkdownResult | undefined> {
    const url = markdownUrlForReference(this.config, reference, Boolean(options.meta));
    const key = url.toString();
    const cached = await this.cache.read<CachedMarkdown>("public", key);
    if (!options.fresh && cached && this.cache.isFresh(cached, options.cacheMs)) {
      return cachedResult(cached.value, cached.fetchedAt);
    }
    if (options.offline) return cached ? cachedResult(cached.value, cached.fetchedAt) : undefined;

    const headers = new Headers({ Accept: "text/markdown" });
    if (cached?.etag) headers.set("If-None-Match", cached.etag);
    const response = await this.fetchSameOrigin(url, headers);
    if (response.status === 304 && cached) {
      const refreshed = await this.cache.write(
        "public",
        key,
        cached.value,
        cached.etag ? { etag: cached.etag } : {},
      );
      return cachedResult(refreshed.value, refreshed.fetchedAt);
    }

    const contentType = response.headers.get("content-type") || "";
    if (response.status !== 200 || !contentType.toLowerCase().startsWith("text/markdown")) {
      return undefined;
    }
    const body = new Uint8Array(await response.arrayBuffer());
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
      body,
      ...(entry ? { fetchedAt: entry.fetchedAt } : {}),
      source: "public-web",
      url: response.url || url.toString(),
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
