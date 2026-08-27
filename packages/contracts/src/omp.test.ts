import { describe, expect, it } from "vite-plus/test";
import * as Schema from "effect/Schema";

import { OmpSettings } from "./omp.ts";
import { ProviderInstanceId } from "./providerInstance.ts";
import { ServerSettings } from "./settings.ts";

const decodeOmpSettings = Schema.decodeSync(OmpSettings);
const decodeServerSettings = Schema.decodeUnknownSync(ServerSettings);

describe("OmpSettings", () => {
  it("decodes safe defaults without a legacy enabled flag", () => {
    expect(decodeOmpSettings({})).toEqual({
      binaryPath: "omp",
      profile: "",
      customModels: [],
    });
  });

  it("trims paths and keeps profile configurations independent", () => {
    const work = decodeOmpSettings({
      binaryPath: "  /opt/bin/omp  ",
      profile: "  work  ",
      customModels: ["extension/model"],
    });
    const personal = decodeOmpSettings({ profile: "personal" });

    expect(work).toEqual({
      binaryPath: "/opt/bin/omp",
      profile: "work",
      customModels: ["extension/model"],
    });
    expect(personal).toEqual({
      binaryPath: "omp",
      profile: "personal",
      customModels: [],
    });
  });

  it("advertises only binary path and profile in the generic form", () => {
    expect(Schema.resolveAnnotations(OmpSettings)?.providerSettingsFormSchema).toEqual({
      order: ["binaryPath", "profile"],
    });
  });

  it("keeps multiple instances distinct and discards a legacy providers.omp field", () => {
    const decoded = decodeServerSettings({
      providers: {
        omp: { enabled: true, binaryPath: "/legacy/omp", profile: "legacy" },
      },
      providerInstances: {
        omp_work: {
          driver: "omp",
          displayName: "Oh My Pi Work",
          config: { binaryPath: "/work/omp", profile: "work" },
        },
        omp_personal: {
          driver: "omp",
          displayName: "Oh My Pi Personal",
          environment: [{ name: "OMP_HOME", value: "/profiles/personal" }],
          config: { binaryPath: "/personal/omp", profile: "personal" },
        },
      },
    });

    expect("omp" in decoded.providers).toBe(false);
    expect(decoded.providerInstances[ProviderInstanceId.make("omp_work")]?.config).toEqual({
      binaryPath: "/work/omp",
      profile: "work",
    });
    expect(decoded.providerInstances[ProviderInstanceId.make("omp_personal")]?.environment).toEqual(
      [{ name: "OMP_HOME", value: "/profiles/personal", sensitive: false }],
    );
  });
});
