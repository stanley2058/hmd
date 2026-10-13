import type { NoteReference } from "./note-reference.ts";

export function noteApiPath(reference: NoteReference, team?: string): string {
  const base = team ? `/teams/${encodeURIComponent(team)}/notes` : "/notes";
  return `${base}/${encodeURIComponent(reference.apiReference)}`;
}
