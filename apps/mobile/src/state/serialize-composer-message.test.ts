import { ComposerContextId, EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

const destination = vi.hoisted(() => ({
  configs: new Map<string, { environment: { capabilities: { inlineMessageContext?: boolean } } }>(),
}));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: { get: (environmentId: string) => destination.configs.get(environmentId) },
}));
vi.mock("./server", () => ({
  serverEnvironment: { configValueAtom: (environmentId: string) => environmentId },
}));

import { serializeComposerMessageForEnvironment } from "./serialize-composer-message";

describe("mobile delivery context compatibility", () => {
  it("rechecks destination capability after reconnect without changing the saved queue payload", () => {
    const environmentId = EnvironmentId.make("destination");
    const terminal = {
      version: 1 as const,
      kind: "terminal" as const,
      contextId: ComposerContextId.make("build"),
      label: "Build",
      terminalId: "main",
      terminalLabel: "Terminal",
      lineStart: 3,
      lineEnd: 3,
      text: "build failed",
    };
    const image = {
      version: 1 as const,
      kind: "image" as const,
      contextId: ComposerContextId.make("image"),
      label: "Screenshot",
      attachmentId: "local-image",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 4,
    };
    const queued = {
      environmentId,
      text: "[Build](t3-context://v1/terminal/build) ![Screenshot](t3-context://v1/image/image)",
      context: { version: 1 as const, records: [terminal, image] },
      draftAttachments: [{ id: "local-image" }],
      uploadedAttachments: [{ id: "server-image" }],
    };
    const before = structuredClone(queued);
    destination.configs.set(environmentId, {
      environment: { capabilities: { inlineMessageContext: true } },
    });
    expect(serializeComposerMessageForEnvironment(queued).context?.records).toEqual([
      terminal,
      { ...image, attachmentId: "server-image" },
    ]);
    destination.configs.set(environmentId, { environment: { capabilities: {} } });
    const legacy = serializeComposerMessageForEnvironment(queued);
    expect(legacy.context).toBeUndefined();
    expect(legacy.text).toContain("build failed");
    expect(legacy.text).not.toContain("t3-context:");
    destination.configs.set(environmentId, {
      environment: { capabilities: { inlineMessageContext: true } },
    });
    expect(serializeComposerMessageForEnvironment(queued).text).toBe(queued.text);
    expect(queued).toEqual(before);
  });
});
