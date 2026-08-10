// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import {
  JCODE_DEFAULT_REASONING_EFFORT,
  JCODE_REASONING_EFFORTS,
  JCODE_REASONING_EFFORT_OPTION_ID,
  makeJcodeModelCapabilities,
} from "./JcodeModelOptions.ts";
import { JCODE_DEFAULT_REASONING_EFFORT as SESSION_RUNTIME_DEFAULT_EFFORT } from "./JcodeSessionRuntime.ts";

/** Narrows the published descriptor to the select variant that carries options. */
function reasoningEffortOptions() {
  const descriptor = makeJcodeModelCapabilities().optionDescriptors?.[0];
  if (descriptor?.type !== "select") {
    throw new Error("Expected a select descriptor for Jcode reasoning effort.");
  }
  return descriptor.options;
}

describe("JcodeModelOptions", () => {
  it("names the inherited effort `jcode-default`", () => {
    expect(JCODE_DEFAULT_REASONING_EFFORT).toBe("jcode-default");
  });

  it("shares one default-effort constant with the session runtime", () => {
    // The runtime skips `set_reasoning_effort` for exactly this sentinel. A
    // divergent copy would silently send `jcode-default` to the daemon.
    expect(JCODE_DEFAULT_REASONING_EFFORT).toBe(SESSION_RUNTIME_DEFAULT_EFFORT);
  });

  it("publishes the option id the session runtime reads", () => {
    expect(JCODE_REASONING_EFFORT_OPTION_ID).toBe("reasoningEffort");
  });

  it("publishes only efforts Jcode accepts, in ascending order", () => {
    expect(JCODE_REASONING_EFFORTS).toEqual(["minimal", "low", "medium", "high", "xhigh", "max"]);
    // `none` is accepted by Jcode but deliberately not published: Pylon has no
    // UI affordance that distinguishes it from the inherited default.
    expect(JCODE_REASONING_EFFORTS).not.toContain("none");
  });

  it("builds a single select descriptor defaulting to the inherited effort", () => {
    const capabilities = makeJcodeModelCapabilities();

    expect(capabilities.optionDescriptors?.map((descriptor) => descriptor.id)).toEqual([
      JCODE_REASONING_EFFORT_OPTION_ID,
    ]);

    const descriptor = capabilities.optionDescriptors?.[0];
    expect(descriptor?.type).toBe("select");
    expect(descriptor?.label).toBe("Thinking");
    expect(descriptor?.currentValue).toBe(JCODE_DEFAULT_REASONING_EFFORT);
  });

  it("publishes the documented effort ids and labels", () => {
    expect(
      reasoningEffortOptions().map((option) => ({ id: option.id, label: option.label })),
    ).toEqual([
      { id: "jcode-default", label: "Jcode default" },
      { id: "minimal", label: "Minimal" },
      { id: "low", label: "Low" },
      { id: "medium", label: "Medium" },
      { id: "high", label: "High" },
      { id: "xhigh", label: "Extra high" },
      { id: "max", label: "Maximum" },
    ]);
  });

  it("marks only the inherited effort as the default option", () => {
    const defaults = reasoningEffortOptions().filter((option) => option.isDefault === true);

    expect(defaults.map((option) => option.id)).toEqual([JCODE_DEFAULT_REASONING_EFFORT]);
  });

  it("returns independent descriptor objects per call", () => {
    const first = makeJcodeModelCapabilities();
    const second = makeJcodeModelCapabilities();

    expect(first.optionDescriptors?.[0]).not.toBe(second.optionDescriptors?.[0]);
    expect(first).toEqual(second);
  });
});
