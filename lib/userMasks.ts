import type { NFT } from "@/lib/types";
import { sanitizePlacement, type MaskPlacement } from "@/lib/imageUtils";
import type { FaceAnchors } from "@/lib/faceAnchors";

/**
 * v2 (2026-07-13): placement metadata is now validated. Records written before
 * this are migrated in place on load — their edited bitmap, mask mode, flip and
 * fit offsets are preserved; only implausible/obsolete placement is dropped (so a
 * bad Mad Lads placement self-heals to the safe centered transform without the
 * user having to press "Start this PFP over"). See `migrateRecord`.
 */
export const USER_MASK_VERSION = 2;

const DB_NAME = "switch-user-masks";
const DB_VERSION = 1;
const STORE_NAME = "masks";
const LAST_SELECTED_KEY = "switch:lastSelectedMaskKey";
const ONBOARDING_PREFIX = "switch:onboardingCompleted:";

/**
 * Whether the user kept the whole automatically-prepared character (body,
 * shoulders and all) or opened the editor to carve out a cleaner shape. This is
 * a creative preference, not an error state — some people want the full PFP.
 */
export type MaskMode = "full" | "adjusted";

export interface SavedUserMask {
  key: string;
  collectionId: string;
  tokenId: string;
  tokenName?: string;
  sourceImageUrl: string;
  editedMaskBlob: Blob;
  editedMaskType: "image/webp" | "image/png";
  /** "full" = kept the whole character, "adjusted" = edited in the mask editor.
   *  Optional so masks saved before this field existed still load (treated as
   *  "adjusted"). */
  maskMode?: MaskMode;
  maskFlip: boolean;
  anchorOffsetX: number;
  anchorOffsetY: number;
  scaleOffset: number;
  placement: MaskPlacement | null;
  /** Where the ART's own eyes/mouth sit in the mask bitmap — drives the T2
   *  mouth/blink imitation (lib/headAnimation.ts). Absent or null = feature
   *  animation off for this mask; T1 breathing is unaffected. Optional so
   *  records saved before this field existed keep loading unchanged. */
  faceAnchors?: FaceAnchors | null;
  createdAt: number;
  updatedAt: number;
  version: number;
}

export interface MaskFit {
  anchorOffsetX: number;
  anchorOffsetY: number;
  scaleOffset: number;
}

let dbPromise: Promise<IDBDatabase> | null = null;

export function maskKey(collectionId: string, tokenId: string | number) {
  return `${collectionId}:${String(tokenId)}`;
}

export function nftMaskKey(nft: NFT) {
  return maskKey(nft.collection, nft.id);
}

export function parseMaskKey(key: string) {
  const splitAt = key.lastIndexOf(":");
  if (splitAt <= 0 || splitAt === key.length - 1) return null;
  return {
    collectionId: key.slice(0, splitAt),
    tokenId: key.slice(splitAt + 1),
  };
}

function ensureBrowser() {
  if (typeof window === "undefined" || !("indexedDB" in window)) {
    throw new Error("IndexedDB is unavailable.");
  }
}

function openDb(): Promise<IDBDatabase> {
  ensureBrowser();
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = window.indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: "key" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("Could not open mask storage."));
    req.onblocked = () => reject(new Error("Mask storage is blocked by another tab."));
  });
  return dbPromise;
}

async function withStore<T>(
  mode: IDBTransactionMode,
  run: (store: IDBObjectStore) => IDBRequest<T> | void
): Promise<T | undefined> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, mode);
    const store = tx.objectStore(STORE_NAME);
    let request: IDBRequest<T> | void;
    tx.oncomplete = () => resolve(request ? request.result : undefined);
    tx.onerror = () => reject(tx.error ?? new Error("Mask storage failed."));
    tx.onabort = () => reject(tx.error ?? new Error("Mask storage was aborted."));
    try {
      request = run(store);
    } catch (error) {
      reject(error);
    }
  });
}

/**
 * Bring an older record up to the current schema, or return null if it is
 * unusable (no bitmap) or from a NEWER app version we can't understand. The
 * user's edited bitmap and creative choices are always preserved; only invalid
 * placement metadata is sanitized away.
 */
export function migrateRecord(record: SavedUserMask | undefined | null): SavedUserMask | null {
  if (!record || !record.editedMaskBlob) return null;
  const v = record.version ?? 0;
  if (v > USER_MASK_VERSION) return null; // written by a newer build — don't guess
  if (v === USER_MASK_VERSION) return record;
  // v < current: migrate in place, keeping everything the user made.
  return {
    ...record,
    placement: sanitizePlacement(record.placement),
    version: USER_MASK_VERSION,
  };
}

export async function loadSavedMask(key: string): Promise<SavedUserMask | null> {
  const record = await withStore<SavedUserMask>("readonly", (store) => store.get(key));
  const migrated = migrateRecord(record);
  if (!migrated) return null;
  // Persist the upgrade (best-effort, no side effects) so it only runs once. A
  // direct put — not saveUserMask — so migrating on load can't change the
  // "last selected" pointer or onboarding flags.
  if (record && (record.version ?? 0) < USER_MASK_VERSION) {
    void withStore("readwrite", (store) => store.put(migrated)).catch(() => {
      /* render already uses the migrated value; storage upgrade can retry later */
    });
  }
  return migrated;
}

export async function saveUserMask(record: SavedUserMask): Promise<void> {
  await withStore("readwrite", (store) => {
    store.put(record);
  });
  rememberLastMask(record.key);
  markOnboardingCompleted(record.key);
}

export async function deleteSavedMask(key: string): Promise<void> {
  await withStore("readwrite", (store) => {
    store.delete(key);
  });
}

export function rememberLastMask(key: string) {
  try {
    window.localStorage.setItem(LAST_SELECTED_KEY, key);
  } catch {
    /* local preferences are best-effort */
  }
}

export function getLastMaskKey(): string | null {
  try {
    return window.localStorage.getItem(LAST_SELECTED_KEY);
  } catch {
    return null;
  }
}

export function markOnboardingCompleted(key: string) {
  try {
    window.localStorage.setItem(`${ONBOARDING_PREFIX}${key}`, "1");
  } catch {
    /* local preferences are best-effort */
  }
}

export function hasCompletedMaskOnboarding(key: string) {
  try {
    return window.localStorage.getItem(`${ONBOARDING_PREFIX}${key}`) === "1";
  } catch {
    return false;
  }
}

export async function loadLastSavedMask(): Promise<SavedUserMask | null> {
  const key = getLastMaskKey();
  if (!key) return null;
  try {
    return await loadSavedMask(key);
  } catch {
    return null;
  }
}

export async function blobToImage(blob: Blob): Promise<HTMLImageElement> {
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    return img;
  } catch (error) {
    URL.revokeObjectURL(url);
    throw error;
  }
}

export function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error("Could not load image."));
    img.src = src;
  });
}

export async function exportTransparentCanvas(
  canvas: HTMLCanvasElement
): Promise<{ blob: Blob; type: "image/webp" | "image/png" }> {
  const webp = await canvasToBlob(canvas, "image/webp", 0.92);
  if (webp?.type === "image/webp") return { blob: webp, type: "image/webp" };
  const png = await canvasToBlob(canvas, "image/png");
  if (png) return { blob: png, type: "image/png" };
  throw new Error("Could not export the mask image.");
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality));
}
