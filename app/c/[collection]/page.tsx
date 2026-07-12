import { VISIBLE_COLLECTIONS } from "@/lib/collections";
import { CollectionFinder } from "./CollectionFinder";

// Static export enumerates the visible collection routes up front (hidden ones
// get no page).
export function generateStaticParams() {
  return VISIBLE_COLLECTIONS.map((c) => ({ collection: c.id }));
}

export default function CollectionPage() {
  return <CollectionFinder />;
}
