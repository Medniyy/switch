import { MY_AVATARS } from "@/lib/userMasks";

export const COLLECTIONS_HREF = "/?view=collections";

const COLLECTIONS_SESSION_KEY = "switch:collections-open";

/** Keep browser Back on the collection gallery instead of resetting to ENTER. */
export function rememberCollectionsOpen(open = true): void {
  if (typeof window === "undefined") return;
  try {
    if (open) window.sessionStorage.setItem(COLLECTIONS_SESSION_KEY, "1");
    else window.sessionStorage.removeItem(COLLECTIONS_SESSION_KEY);
  } catch {
    /* Session storage can be blocked; the explicit URL still carries the state. */
  }
}

export function shouldOpenCollections(): boolean {
  if (typeof window === "undefined") return false;
  if (new URLSearchParams(window.location.search).get("view") === "collections") {
    return true;
  }
  try {
    return window.sessionStorage.getItem(COLLECTIONS_SESSION_KEY) === "1";
  } catch {
    return false;
  }
}

/** The useful parent of the camera is the picker the current avatar came from. */
export function avatarPickerHref(collectionId: string): string {
  return collectionId === MY_AVATARS
    ? "/create"
    : `/c/${encodeURIComponent(collectionId)}`;
}
