const VIDEO_MIME_TYPE_BY_EXTENSION = new Map([
  ["avi", "video/x-msvideo"],
  ["m4v", "video/mp4"],
  ["mkv", "video/x-matroska"],
  ["mov", "video/quicktime"],
  ["mp4", "video/mp4"],
  ["ogv", "video/ogg"],
  ["webm", "video/webm"],
]);

const PLAYABLE_VIDEO_MIME_TYPES = new Set(VIDEO_MIME_TYPE_BY_EXTENSION.values());

export const VIDEO_FILE_EXTENSIONS = Object.freeze([...VIDEO_MIME_TYPE_BY_EXTENSION.keys()]);

/**
 * The container this attachment should be presented as, or null when it is not
 * a video Pylon offers to play. Recognizes videos even when the file picker
 * omitted their MIME type.
 *
 * The extension decides first. Trusting a bare `video/*` prefix misreads files
 * the host maps to a transport stream — a TypeScript `.ts` source is reported as
 * `video/mp2t` — which would turn source files into blank play tiles.
 */
export function videoMimeType(attachment: {
  readonly name: string;
  readonly mimeType: string;
}): string | null {
  const dotIndex = attachment.name.lastIndexOf(".");
  const byExtension =
    dotIndex < 0
      ? null
      : (VIDEO_MIME_TYPE_BY_EXTENSION.get(attachment.name.slice(dotIndex + 1).toLowerCase()) ??
        null);
  if (byExtension !== null) return byExtension;
  const mimeType = attachment.mimeType.split(";", 1)[0]?.trim().toLowerCase() ?? "";
  return PLAYABLE_VIDEO_MIME_TYPES.has(mimeType) ? mimeType : null;
}
