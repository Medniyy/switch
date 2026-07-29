import type { NFT } from "@/lib/types";
import { blobToImage, loadSavedMask, nftMaskKey } from "@/lib/userMasks";

/**
 * The single source of truth for "which mask image should this NFT wear".
 *
 * Every output mode — live camera, camera capture, uploaded-photo editor, and the
 * final export — must resolve the mask through here so they all honour the user's
 * saved choice (a customized edit OR a kept full character) and reuse the exact
 * same saved blob. It NEVER re-runs background removal on the saved bitmap.
 *
 * Returns the saved mask image when one exists for this token, otherwise `null`
 * so the caller can fall back to the automatic seed (precomputed head mask or the
 * on-device cutout). Resolution failures degrade to `null` rather than throwing.
 */
export async function resolveSavedMaskImage(
  nft: Pick<NFT, "collection" | "id" | "image"> | null | undefined
): Promise<HTMLImageElement | null> {
  if (!nft) return null;
  try {
    const saved = await loadSavedMask(nftMaskKey(nft as NFT));
    if (!saved || !saved.editedMaskBlob) return null;
    // Guard against a token whose art URL changed out from under the saved edit.
    if (nft.image && saved.sourceImageUrl && saved.sourceImageUrl !== nft.image) {
      return null;
    }
    return await blobToImage(saved.editedMaskBlob);
  } catch {
    return null;
  }
}
