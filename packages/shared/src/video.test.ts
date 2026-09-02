import { describe, expect, it } from "vite-plus/test";

import { videoMimeType } from "./video.ts";

describe("videoMimeType", () => {
  it("recognizes a saved video with a generic picker MIME type", () => {
    expect(videoMimeType({ name: "Recording.MOV", mimeType: "application/octet-stream" })).toBe(
      "video/quicktime",
    );
  });

  it("lets a known extension outrank the reported MIME type", () => {
    expect(videoMimeType({ name: "recording.mp4", mimeType: " VIDEO/WebM; codecs=vp9 " })).toBe(
      "video/mp4",
    );
  });

  it("trusts a playable MIME type and removes parameters when the extension is unknown", () => {
    expect(videoMimeType({ name: "recording", mimeType: " VIDEO/WebM; codecs=vp9 " })).toBe(
      "video/webm",
    );
  });

  // Hosts map a TypeScript source to video/mp2t. Trusting a bare `video/*`
  // prefix turns source files into blank play tiles, so it is not playable.
  it.each(["session-logic.ts", "clip.ts", "recording"])(
    "does not treat %s reported as video/mp2t as a video",
    (name) => {
      expect(videoMimeType({ name, mimeType: "video/mp2t" })).toBeNull();
    },
  );

  it.each(["README", "report.pdf", "file.constructor", "file.__proto__"])(
    "does not mistake %s for a video",
    (name) => {
      expect(videoMimeType({ name, mimeType: "application/octet-stream" })).toBeNull();
    },
  );
});
