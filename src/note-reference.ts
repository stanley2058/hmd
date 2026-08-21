import type { Config } from "./config.ts";

export interface NoteReference {
  apiReference: string;
  input: string;
  markdownUrl: string;
  webUrl: string;
}

function noteUrl(config: Config, reference: string): URL {
  let url: URL;
  if (/^https?:\/\//i.test(reference)) {
    url = new URL(reference);
    const allowed = new URL(config.webUrl);
    if (url.origin !== allowed.origin) {
      throw new Error(`Refusing note URL outside ${allowed.origin}.`);
    }
  } else {
    const relative = reference.replace(/^\/+/, "");
    url = new URL(`/${relative}`, `${config.webUrl}/`);
  }
  url.hash = "";
  return url;
}

export function resolveNoteReference(config: Config, reference: string): NoteReference {
  const url = noteUrl(config, reference);
  const markdown = new URL(url);
  if (!markdown.pathname.endsWith(".md")) markdown.pathname += ".md";
  markdown.searchParams.set("no-meta", "");

  const web = new URL(url);
  web.search = "";
  if (web.pathname.endsWith(".md")) web.pathname = web.pathname.slice(0, -3);

  const lastSegment = web.pathname.split("/").findLast(Boolean);
  if (!lastSegment) throw new Error(`Cannot extract a note reference from ${reference}.`);

  return {
    apiReference: decodeURIComponent(lastSegment),
    input: reference,
    markdownUrl: markdown.toString(),
    webUrl: web.toString(),
  };
}

export function markdownUrlForReference(config: Config, reference: string, meta: boolean): URL {
  const resolved = resolveNoteReference(config, reference);
  const url = new URL(resolved.markdownUrl);
  if (meta) url.searchParams.delete("no-meta");
  return url;
}
