import { expect, it } from "vite-plus/test";

import { primeGraduationEnvironment } from "./PrimeAgentArtifactGraduation.test-fixture.ts";

it("isolates fake-provider proofs from host credentials, configuration, and process flags", () => {
  expect(
    primeGraduationEnvironment("/isolated/home", {
      PATH: "/runtime/bin",
      TMPDIR: "/runtime/tmp",
      HOME: "/live/home",
      PRIME_API_KEY: "private-host-key",
      OPENAI_API_KEY: "private-openai-key",
      CUSTOM_MODEL_CREDENTIAL: "private-custom-key",
      PRIME_AGENT_HOME: "/live/prime",
      RLM_MAX_DEPTH: "9",
      NODE_OPTIONS: "--require /live/bootstrap.js",
      VITEST_WORKER_ID: "5",
      GIT_CONFIG_GLOBAL: "/live/gitconfig",
    }),
  ).toEqual({
    PATH: "/runtime/bin",
    TMPDIR: "/runtime/tmp",
    HOME: "/isolated/home",
    SHELL: "/bin/sh",
    NO_COLOR: "1",
  });
});
