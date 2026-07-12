import type { Collection } from "./types";

/**
 * Recently-viewed tokens, persisted to localStorage. Stores only refs
 * (collection + id) — never image data. Max 12, most-recent first.
 */

const KEY = "switch:recent";
const MAX = 12;

export interface NFTRef {
  collection: Collection;
  id: number;
}

export function getRecent(): NFTRef[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.slice(0, MAX) : [];
  } catch {
    return [];
  }
}

export function addRecent(ref: NFTRef): NFTRef[] {
  if (typeof window === "undefined") return [];
  const current = getRecent().filter(
    (r) => !(r.collection === ref.collection && r.id === ref.id)
  );
  const next = [ref, ...current].slice(0, MAX);
  try {
    window.localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* storage full / disabled — non-fatal */
  }
  return next;
}
