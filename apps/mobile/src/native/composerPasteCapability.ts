import { requireOptionalNativeModule } from "expo";

/** Old installed binaries have no interception event or paste-size props. */
export function supportsNativePastedTextAttachments(): boolean {
  try {
    return (
      requireOptionalNativeModule<{ readonly textPasteAttachmentRevision?: number }>(
        "T3ComposerEditor",
      )?.textPasteAttachmentRevision === 1
    );
  } catch {
    return false;
  }
}
