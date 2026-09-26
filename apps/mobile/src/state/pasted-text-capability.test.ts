import type { ConnectedInitialConfig } from "@t3tools/client-runtime/state/session";
import { EnvironmentId, type ServerConfig } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  stateAtom: Symbol("state"),
  configAtom: Symbol("config"),
  get: vi.fn(),
}));

vi.mock("@effect/atom-react", () => ({ useAtomValue: mocks.get }));
vi.mock("../connection/catalog", () => ({
  environmentCatalog: { stateAtom: () => mocks.stateAtom },
}));
vi.mock("./atom-registry", () => ({ appAtomRegistry: { get: mocks.get } }));
vi.mock("./session", () => ({
  environmentSession: { connectedInitialConfigAtom: () => mocks.configAtom },
}));

import {
  connectedPastedTextAttachmentLease,
  useConnectedPastedTextAttachmentCapability,
} from "./pasted-text-capability";

const environmentId = EnvironmentId.make("paste-capability-test");
const connectedState = {
  phase: "connected",
} as ConnectedInitialConfig["state"];
const config = {
  environment: {
    capabilities: {
      pastedTextAttachments: true,
      attachmentUploads: true,
      fileAttachments: { maxUploadBytes: 1024 },
    },
  },
} as ServerConfig;

describe("pasted text capability during connection refresh", () => {
  it("uses the current connected lease even when both atoms are waiting", () => {
    const lease = { state: connectedState, config };
    mocks.get.mockImplementation((atom: symbol) =>
      atom === mocks.stateAtom
        ? AsyncResult.waiting(AsyncResult.success(connectedState))
        : AsyncResult.waiting(AsyncResult.success(Option.some(lease))),
    );

    expect(connectedPastedTextAttachmentLease(environmentId)).toBe(lease);
    expect(useConnectedPastedTextAttachmentCapability(environmentId)).toBe(true);
  });

  it("rejects a stale lease from an earlier connection", () => {
    const staleState = { phase: "connected" } as ConnectedInitialConfig["state"];
    mocks.get.mockImplementation((atom: symbol) =>
      atom === mocks.stateAtom
        ? AsyncResult.waiting(AsyncResult.success(connectedState))
        : AsyncResult.waiting(AsyncResult.success(Option.some({ state: staleState, config }))),
    );

    expect(connectedPastedTextAttachmentLease(environmentId)).toBeNull();
    expect(useConnectedPastedTextAttachmentCapability(environmentId)).toBe(false);
  });
});
