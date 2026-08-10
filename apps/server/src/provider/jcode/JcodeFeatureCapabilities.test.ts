// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";
import {
  PROVIDER_FEATURE_CAPABILITIES_VERSION,
  ProviderFeatureCapabilities,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { makeJcodeFeatureCapabilities } from "./JcodeFeatureCapabilities.ts";

const decodeCapabilities = Schema.decodeUnknownSync(ProviderFeatureCapabilities);

/**
 * Every group Early Access cannot honor. Advertising any of them would let a
 * client render a control whose Jcode operation does not exist, which is the
 * dishonesty this inventory exists to prevent.
 */
const UNAVAILABLE_GROUPS = [
  "authentication",
  "planning",
  "goals",
  "gates",
  "agents",
  "automation",
  "resources",
  "inputQueue",
  "context",
  "history",
  "sessionUi",
] as const;

describe("makeJcodeFeatureCapabilities", () => {
  it("advertises full-access execution only, with no approval enforcement", () => {
    const capabilities = makeJcodeFeatureCapabilities();

    expect(capabilities.version).toBe(PROVIDER_FEATURE_CAPABILITIES_VERSION);
    expect(capabilities.executionPolicy).toMatchObject({
      support: "read-only",
      operations: ["inspect"],
      runtimeModes: ["full-access"],
      enforcement: "none",
    });
    expect(capabilities.executionPolicy?.runtimeModes).toEqual(["full-access"]);
  });

  it("advertises read-write model selection and thinking with read-only reasoning and usage", () => {
    const capabilities = makeJcodeFeatureCapabilities();

    expect(capabilities.model).toMatchObject({ support: "read-write" });
    expect(capabilities.model?.operations).toEqual(["select", "thinking"]);
    expect(capabilities.reasoning?.support).toBe("read-only");
    expect(capabilities.reasoning?.operations).toEqual(["final", "stream"]);
    expect(capabilities.usage?.support).toBe("read-only");
    // Jcode's `token_usage` frame carries no cost estimate or rate-limit state.
    expect(capabilities.usage?.operations).toEqual(["token-usage"]);
    expect(capabilities.usage?.operations).not.toContain("cost");
  });

  it("marks every unsupported Early Access group unavailable with an explicit reason", () => {
    const capabilities = makeJcodeFeatureCapabilities();

    for (const group of UNAVAILABLE_GROUPS) {
      const capability = capabilities[group];
      expect(capability, `${group} must be advertised`).toBeDefined();
      expect(capability?.support, `${group} must be unavailable`).toBe("unavailable");
      expect(capability?.operations, `${group} must advertise no operations`).toEqual([]);
      expect(capability?.reason?.length ?? 0, `${group} must explain itself`).toBeGreaterThan(0);
    }
  });

  it("decodes as a canonical provider capability inventory", () => {
    expect(() => decodeCapabilities(makeJcodeFeatureCapabilities())).not.toThrow();
  });
});
