import { createTwoFilesPatch } from "diff";

import type { ApiExecutor, ApiResult } from "./api.ts";
import type { Config } from "./config.ts";
import type { ApiPolicy, MarkdownOptions, PublicMarkdownReader } from "./public-markdown.ts";
import { resolveNoteReference } from "./note-reference.ts";
import type { TransportAttempt } from "./diagnostics.ts";

export interface NoteResult {
  attempts?: TransportAttempt[];
  body: Uint8Array;
  different?: boolean;
  fetchedAt?: string;
  source: "api" | "cache" | "local" | "public-web";
  status: number;
  url?: string;
}

interface CachedRequestOptions {
  cacheMs: number;
  fresh?: boolean;
  offline?: boolean;
}

export interface ListNoteOptions extends CachedRequestOptions {
  team?: string;
}

export interface ViewNoteOptions extends CachedRequestOptions {
  api: ApiPolicy;
}

export interface CreateNoteOptions {
  content?: string;
  readPermission?: string;
  team?: string;
  title?: string;
  writePermission?: string;
}

export interface UpdateNoteOptions {
  cacheMs: number;
  content?: string;
  description?: string;
  force?: boolean;
  parentFolderId?: string | null;
  permalink?: string;
  readPermission?: string;
  tags?: string[];
  title?: string;
  writePermission?: string;
}

export interface DiffNoteOptions extends MarkdownOptions {
  filename: string;
  localContent: string;
}

type RequestApi = Pick<ApiExecutor, "request">;
type MarkdownReader = Pick<PublicMarkdownReader, "read">;

function jsonBody(value: unknown): Uint8Array {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function withUrl(result: ApiResult, url: string): NoteResult {
  return {
    attempts: result.attempts,
    body: result.body,
    ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
    source: result.source,
    status: result.status,
    url,
  };
}

function requestOptions(options: CachedRequestOptions) {
  return {
    cacheMs: options.cacheMs,
    ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
    ...(options.offline === undefined ? {} : { offline: options.offline }),
  };
}

export class Notes {
  constructor(
    private readonly config: Config,
    private readonly api: RequestApi,
    private readonly markdown: MarkdownReader,
  ) {}

  resolve(reference: string): NoteResult {
    return {
      body: jsonBody(resolveNoteReference(this.config, reference)),
      source: "local",
      status: 200,
    };
  }

  async list(options: ListNoteOptions): Promise<NoteResult> {
    const path = options.team ? `/teams/${encodeURIComponent(options.team)}/notes` : "/notes";
    const result = await this.api.request("GET", path, requestOptions(options));
    return withUrl(result, `${this.config.apiUrl}${path}`);
  }

  async view(reference: string, options: ViewNoteOptions): Promise<NoteResult> {
    const resolved = resolveNoteReference(this.config, reference);
    const result = await this.markdown.read(reference, {
      api: options.api,
      cacheMs: options.cacheMs,
      ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
      meta: true,
      ...(options.offline === undefined ? {} : { offline: options.offline }),
    });
    const hmd = {
      ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
      source: result.source,
      url: result.url,
    };
    const value = result.apiData
      ? { ...result.apiData, _hmd: hmd }
      : {
          id: resolved.apiReference,
          url: resolved.webUrl,
          content: Buffer.from(result.body).toString("utf8"),
          _hmd: hmd,
        };
    return {
      attempts: result.attempts,
      body: jsonBody(value),
      ...(result.fetchedAt ? { fetchedAt: result.fetchedAt } : {}),
      source: result.source,
      status: 200,
      url: result.url,
    };
  }

  async create(options: CreateNoteOptions): Promise<NoteResult> {
    const path = options.team ? `/teams/${encodeURIComponent(options.team)}/notes` : "/notes";
    const body = {
      ...(options.content === undefined ? {} : { content: options.content }),
      ...(options.readPermission === undefined ? {} : { readPermission: options.readPermission }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.writePermission === undefined
        ? {}
        : { writePermission: options.writePermission }),
    };
    const result = await this.api.request("POST", path, {
      cacheMs: 0,
      headers: ["Content-Type: application/json"],
      input: jsonBody(body),
    });
    return withUrl(result, `${this.config.apiUrl}${path}`);
  }

  async update(reference: string, options: UpdateNoteOptions): Promise<NoteResult> {
    const resolved = resolveNoteReference(this.config, reference);
    const attempts: TransportAttempt[] = [];
    const body: Record<string, unknown> = {
      ...(options.content === undefined ? {} : { content: options.content }),
      ...(options.description === undefined ? {} : { description: options.description }),
      ...(options.parentFolderId === undefined ? {} : { parentFolderId: options.parentFolderId }),
      ...(options.permalink === undefined ? {} : { permalink: options.permalink }),
      ...(options.readPermission === undefined ? {} : { readPermission: options.readPermission }),
      ...(options.tags === undefined ? {} : { tags: options.tags }),
      ...(options.title === undefined ? {} : { title: options.title }),
      ...(options.writePermission === undefined
        ? {}
        : { writePermission: options.writePermission }),
    };
    if (Object.keys(body).length === 0) throw new Error("No note update was provided.");

    if (typeof body.content === "string" && !options.force) {
      try {
        const current = await this.markdown.read(reference, {
          api: "never",
          cacheMs: options.cacheMs,
        });
        if (current.attempts) attempts.push(...current.attempts);
        if (Buffer.from(current.body).toString("utf8") === body.content) delete body.content;
      } catch (error) {
        if (error && typeof error === "object" && "attempts" in error) {
          const failedAttempts = (error as { attempts?: TransportAttempt[] }).attempts;
          if (failedAttempts) attempts.push(...failedAttempts);
        }
      }
    }

    if (Object.keys(body).length === 0) {
      return {
        attempts,
        body: jsonBody({ updated: false, reason: "content is unchanged" }),
        source: "local",
        status: 200,
        url: resolved.webUrl,
      };
    }

    const path = `/notes/${encodeURIComponent(resolved.apiReference)}`;
    const result = await this.api.request("PATCH", path, {
      cacheMs: 0,
      headers: ["Content-Type: application/json"],
      input: jsonBody(body),
    });
    const response = withUrl(result, `${this.config.apiUrl}${path}`);
    response.attempts = [...attempts, ...(result.attempts || [])];
    return response;
  }

  async delete(reference: string): Promise<NoteResult> {
    const resolved = resolveNoteReference(this.config, reference);
    const path = `/notes/${encodeURIComponent(resolved.apiReference)}`;
    const result = await this.api.request("DELETE", path, { cacheMs: 0 });
    return withUrl(result, `${this.config.apiUrl}${path}`);
  }

  async diff(reference: string, options: DiffNoteOptions): Promise<NoteResult> {
    const resolved = resolveNoteReference(this.config, reference);
    const remote = await this.markdown.read(reference, {
      api: options.api,
      cacheMs: options.cacheMs,
      ...(options.fresh === undefined ? {} : { fresh: options.fresh }),
      ...(options.offline === undefined ? {} : { offline: options.offline }),
    });
    const remoteContent = Buffer.from(remote.body).toString("utf8");
    const different = remoteContent !== options.localContent;
    const patch = different
      ? createTwoFilesPatch(
          `hackmd:${resolved.apiReference}`,
          options.filename,
          remoteContent,
          options.localContent,
        )
      : "";
    return {
      attempts: remote.attempts,
      body: Buffer.from(patch),
      different,
      ...(remote.fetchedAt ? { fetchedAt: remote.fetchedAt } : {}),
      source: remote.source,
      status: 200,
      url: remote.url,
    };
  }
}
