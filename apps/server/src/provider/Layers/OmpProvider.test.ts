import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { OmpSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { describe, expect } from "vite-plus/test";

import {
  buildOmpCliArgs,
  buildOmpDiscoveredModels,
  checkOmpProviderStatus,
  parseOmpModelsJson,
  type OmpProviderSettings,
} from "./OmpProvider.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const effectiveSettings = (
  input: Parameters<typeof decodeOmpSettings>[0] & { readonly enabled?: boolean },
): OmpProviderSettings => ({
  ...decodeOmpSettings(input),
  enabled: input.enabled ?? true,
});

describe("OmpProvider", () => {
  it("parses OMP's machine-readable model inventory", () => {
    const parsed = parseOmpModelsJson(
      JSON.stringify({
        models: [
          {
            provider: "anthropic",
            id: "claude-sonnet-4-6",
            selector: "anthropic/claude-sonnet-4-6",
            name: "Claude Sonnet 4.6",
            reasoning: true,
            thinking: ["low", "medium", "high"],
            input: ["text", "image"],
          },
          {
            provider: "local",
            id: "qwen",
            selector: "local/qwen",
            name: "Qwen",
            reasoning: false,
            thinking: null,
            input: ["text"],
          },
        ],
      }),
    );

    expect(parsed).toHaveLength(2);
    expect(buildOmpDiscoveredModels(parsed ?? [])).toEqual([
      {
        slug: "anthropic/claude-sonnet-4-6",
        name: "Claude Sonnet 4.6",
        subProvider: "Anthropic",
        isCustom: false,
        capabilities: {
          optionDescriptors: [
            {
              id: "thinking",
              label: "Thinking",
              description: "Reasoning effort used by Oh My Pi for this model.",
              type: "select",
              options: [
                { id: "off", label: "Off" },
                { id: "auto", label: "Auto" },
                { id: "low", label: "Low" },
                { id: "medium", label: "Medium" },
                { id: "high", label: "High" },
              ],
            },
          ],
        },
      },
      {
        slug: "local/qwen",
        name: "Qwen",
        subProvider: "Local",
        isCustom: false,
        capabilities: { optionDescriptors: [] },
      },
    ]);
  });

  it("rejects malformed JSON and prepends the selected profile", () => {
    expect(parseOmpModelsJson("not json")).toBeUndefined();
    expect(buildOmpCliArgs({ profile: "work" }, ["models", "--json"])).toEqual([
      "--profile",
      "work",
      "models",
      "--json",
    ]);
    expect(buildOmpCliArgs({ profile: "" }, ["acp"])).toEqual(["acp"]);
  });
});

it.layer(NodeServices.layer)("checkOmpProviderStatus", (it) => {
  const makeOmpScript = (lines: ReadonlyArray<string>) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-omp-status-" });
      const binaryPath = path.join(dir, "omp");
      yield* fs.writeFileString(binaryPath, ["#!/bin/sh", ...lines, ""].join("\n"));
      yield* fs.chmod(binaryPath, 0o755);
      return binaryPath;
    });

  it.effect("does not spawn when the instance is disabled", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        effectiveSettings({ enabled: false, binaryPath: "/definitely/not/installed/omp" }),
      );
      expect(snapshot).toMatchObject({ enabled: false, installed: false, status: "disabled" });
    }),
  );

  it.effect("reports a missing configured binary", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkOmpProviderStatus(
        effectiveSettings({ binaryPath: "/definitely/not/installed/omp" }),
      );
      expect(snapshot).toMatchObject({ installed: false, status: "error" });
      expect(snapshot.message).toContain("not installed");
      expect(snapshot.models).toMatchObject([{ slug: "default", isDefault: true }]);
    }),
  );

  it.effect("rejects invalid and unsupported versions before discovery", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalidBinaryPath = yield* makeOmpScript(['printf "not a version\n"']);
        const invalid = yield* checkOmpProviderStatus(
          effectiveSettings({ binaryPath: invalidBinaryPath }),
        );
        expect(invalid.message).toContain("determine");

        const oldBinaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/15.13.0\n"; fi',
        ]);
        const old = yield* checkOmpProviderStatus(effectiveSettings({ binaryPath: oldBinaryPath }));
        expect(old.message).toContain("too old");
      }),
    ),
  );

  it.effect("uses a safe profile-scoped catalog probe and merges custom models", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const callsDir = yield* fs.makeTempDirectoryScoped({ prefix: "pylon-omp-calls-" });
        const callsPath = path.join(callsDir, "calls.log");
        const binaryPath = yield* makeOmpScript([
          'printf "%s\n" "$*" >> "$OMP_CALLS"',
          'if [ "$1" = "--version" ]; then printf "omp/18.0.4\n"; exit 0; fi',
          `printf '%s\n' '{"models":[{"provider":"openai","id":"gpt-5.4","selector":"openai/gpt-5.4","name":"GPT-5.4","reasoning":true,"thinking":["low","high"]}]}'`,
        ]);
        const snapshot = yield* checkOmpProviderStatus(
          effectiveSettings({
            binaryPath,
            profile: "work profile",
            customModels: ["extension/acme-model"],
          }),
          { ...process.env, OMP_CALLS: callsPath },
        );

        expect((yield* fs.readFileString(callsPath)).trim().split("\n")).toEqual([
          "--version",
          "--profile work profile models --json --no-extensions",
        ]);
        expect(snapshot).toMatchObject({ installed: true, status: "ready" });
        expect(snapshot.auth).toEqual({ status: "unknown" });
        expect(snapshot.models).toMatchObject([
          { slug: "default", name: "Profile default", isDefault: true },
          { slug: "openai/gpt-5.4", subProvider: "OpenAI" },
          { slug: "extension/acme-model", isCustom: true },
        ]);
      }),
    ),
  );

  it.effect("distinguishes invalid JSON from an empty model catalog", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const invalidBinaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/18.0.4\n"; exit 0; fi',
          'printf "{not-json\n"',
        ]);
        const invalid = yield* checkOmpProviderStatus(
          effectiveSettings({ binaryPath: invalidBinaryPath }),
        );
        expect(invalid).toMatchObject({ installed: true, status: "warning" });
        expect(invalid.message).toContain("invalid JSON");

        const emptyBinaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/18.0.4\n"; exit 0; fi',
          `printf '%s\n' '{"models":[]}'`,
        ]);
        const empty = yield* checkOmpProviderStatus(
          effectiveSettings({ binaryPath: emptyBinaryPath }),
        );
        expect(empty).toMatchObject({ installed: true, status: "warning" });
        expect(empty.message).toContain("empty model catalog");
        expect(empty.models).toMatchObject([{ slug: "default", isDefault: true }]);
      }),
    ),
  );

  it.effect("keeps the profile default on a failed catalog without leaking stderr", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const binaryPath = yield* makeOmpScript([
          'if [ "$1" = "--version" ]; then printf "omp/18.0.4\n"; exit 0; fi',
          'printf "secret-provider-error\n" >&2',
          "exit 2",
        ]);
        const snapshot = yield* checkOmpProviderStatus(effectiveSettings({ binaryPath }));
        expect(snapshot).toMatchObject({ installed: true, status: "warning" });
        expect(snapshot.message).toContain("exited with code 2");
        expect(snapshot.message).not.toContain("secret-provider-error");
        expect(snapshot.models).toMatchObject([{ slug: "default", isDefault: true }]);
      }),
    ),
  );
});
