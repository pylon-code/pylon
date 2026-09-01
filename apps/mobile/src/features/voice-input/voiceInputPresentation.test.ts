import { describe, expect, it } from "vite-plus/test";
import { voiceInputFreezesEditor } from "@t3tools/client-runtime/voice-input";

import { resolveVoiceComposerPresentation } from "./voiceInputPresentation";

describe("resolveVoiceComposerPresentation", () => {
  it("maps voice states to stable composer actions and editor read-only state", () => {
    expect(
      resolveVoiceComposerPresentation({ phase: "idle", error: null, errorAction: null }, 0),
    ).toEqual({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: null,
      statusLabel: null,
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "preparing", error: null, errorAction: null }, 0),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Preparing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation({ phase: "recording", error: null, errorAction: null }, 64),
    ).toMatchObject({
      leadingAction: "cancel",
      trailingAction: "confirm",
      showsSend: false,
      statusLabel: "Recording 1:04",
      confirmationEnabled: true,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "transcribing", error: null, errorAction: null },
        0,
      ),
    ).toMatchObject({
      statusLabel: "Transcribing",
      confirmationEnabled: false,
    });
    expect(
      resolveVoiceComposerPresentation(
        { phase: "error", error: "Microphone unavailable", errorAction: "retry" },
        0,
      ),
    ).toMatchObject({
      leadingAction: null,
      trailingAction: "mic",
      showsSend: true,
      statusKind: "error",
      statusLabel: "Microphone unavailable",
    });

    expect(voiceInputFreezesEditor({ phase: "preparing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "recording", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "transcribing", error: null, errorAction: null })).toBe(
      true,
    );
    expect(voiceInputFreezesEditor({ phase: "idle", error: null, errorAction: null })).toBe(false);
  });
});

describe("showsSend is not the same predicate as having a status label", () => {
  // The composer must gate its send control on showsSend. Gating on the
  // presence of a status label instead looks equivalent — both are non-null
  // through recording and transcribing — but diverges exactly in the error
  // phase, which shows a label AND keeps send. Getting this wrong strands the
  // user with no send control until they find the dismiss affordance.
  it("keeps send available in the error phase, which also shows a status label", () => {
    const presentation = resolveVoiceComposerPresentation(
      { phase: "error", error: "No speech was detected.", errorAction: null },
      0,
    );
    expect(presentation.showsSend).toBe(true);
    expect(presentation.statusLabel).not.toBeNull();
  });

  it("hides send only while dictation actually owns the row", () => {
    for (const phase of ["preparing", "recording", "transcribing"] as const) {
      const presentation = resolveVoiceComposerPresentation(
        { phase, error: null, errorAction: null },
        0,
      );
      expect(presentation.showsSend).toBe(false);
      expect(presentation.statusLabel).not.toBeNull();
    }
    const idle = resolveVoiceComposerPresentation(
      { phase: "idle", error: null, errorAction: null },
      0,
    );
    expect(idle.showsSend).toBe(true);
    expect(idle.statusLabel).toBeNull();
  });
});
