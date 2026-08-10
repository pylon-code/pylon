import type { ProviderInstanceEnvironment } from "@t3tools/contracts";
import { ProviderInstanceId } from "@t3tools/contracts";
// @ts-expect-error -- Vite Plus provides the Vitest runner transitively to server tests.
import { describe, expect, it } from "vitest";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { jcodeSdkBridge } from "../jcode/JcodeSdkBridge.ts";
import {
  JcodeDriver,
  buildJcodeInstanceManagerInput,
  jcodeCredentialValuesFromEnvironment,
} from "./JcodeDriver.ts";

const INSTANCE_ID = ProviderInstanceId.make("jcode_local");

describe("JcodeDriver", () => {
  it("registers one Jcode driver with contract defaults", () => {
    expect(JcodeDriver.driverKind).toBe("jcode");
    expect(JcodeDriver.metadata).toEqual({
      displayName: "Jcode",
      supportsMultipleInstances: true,
    });
    expect(JcodeDriver.defaultConfig()).toEqual({
      enabled: true,
      binaryPath: "jcode",
      inheritLogins: true,
    });
    expect(BUILT_IN_DRIVERS.filter((driver) => driver.driverKind === "jcode")).toEqual([
      JcodeDriver,
    ]);
  });
});

describe("jcodeCredentialValuesFromEnvironment", () => {
  it("derives every sensitive value so redaction cannot miss one", () => {
    const environment: ProviderInstanceEnvironment = [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-secret", sensitive: true },
      { name: "OPENAI_API_KEY", value: "sk-openai-secret", sensitive: true },
      { name: "PATH", value: "/usr/bin", sensitive: false },
    ];

    expect(jcodeCredentialValuesFromEnvironment(environment)).toEqual([
      "sk-ant-secret",
      "sk-openai-secret",
    ]);
  });

  it("ignores non-sensitive entries even when they look like secrets", () => {
    expect(
      jcodeCredentialValuesFromEnvironment([
        { name: "LOOKS_LIKE_A_KEY", value: "sk-not-marked-sensitive", sensitive: false },
      ]),
    ).toEqual([]);
  });

  it("drops empty and whitespace-only sensitive values", () => {
    // Literal redaction of "" or " " would shred unrelated text out of every
    // later bridge error message.
    expect(
      jcodeCredentialValuesFromEnvironment([
        { name: "EMPTY", value: "", sensitive: true },
        { name: "BLANK", value: "   ", sensitive: true },
        { name: "REAL", value: "sk-real", sensitive: true },
      ]),
    ).toEqual(["sk-real"]);
  });

  it("de-duplicates a value shared by two sensitive names", () => {
    expect(
      jcodeCredentialValuesFromEnvironment([
        { name: "PRIMARY", value: "sk-same", sensitive: true },
        { name: "MIRROR", value: "sk-same", sensitive: true },
      ]),
    ).toEqual(["sk-same"]);
  });

  it("returns nothing for an absent environment", () => {
    expect(jcodeCredentialValuesFromEnvironment(undefined)).toEqual([]);
    expect(jcodeCredentialValuesFromEnvironment([])).toEqual([]);
  });
});

describe("buildJcodeInstanceManagerInput", () => {
  const base = {
    instanceId: INSTANCE_ID,
    stateDir: "/tmp/pylon-state",
    settings: { binaryPath: "jcode", inheritLogins: true },
    environment: [
      { name: "ANTHROPIC_API_KEY", value: "sk-ant-secret", sensitive: true },
      { name: "PATH", value: "/usr/bin", sensitive: false },
    ] satisfies ProviderInstanceEnvironment,
    processEnv: { PATH: "/usr/bin", ANTHROPIC_API_KEY: "sk-ant-secret" },
  } as const;

  it("builds one bridge per provider instance, never the module singleton", () => {
    const first = buildJcodeInstanceManagerInput(base);
    const second = buildJcodeInstanceManagerInput(base);

    // The bridge retains launch credential literals for its whole life, so a
    // shared one would cross-contaminate secrets between provider instances.
    expect(first.bridge).not.toBe(second.bridge);
    expect(first.bridge).not.toBe(jcodeSdkBridge);
    expect(second.bridge).not.toBe(jcodeSdkBridge);
  });

  it("carries the derived credential values and instance identity through", () => {
    const input = buildJcodeInstanceManagerInput(base);

    expect(input.instanceId).toBe(INSTANCE_ID);
    expect(input.stateDir).toBe("/tmp/pylon-state");
    expect(input.settings).toEqual({ binaryPath: "jcode", inheritLogins: true });
    expect(input.credentialValues).toEqual(["sk-ant-secret"]);
    expect(input.environment).toEqual(base.processEnv);
  });
});
