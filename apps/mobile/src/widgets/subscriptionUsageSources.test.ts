import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { ServerConfigProjection } from "@t3tools/client-runtime/state/server";
import { expect, it } from "vite-plus/test";

import { selectWidgetPresentation } from "./subscriptionUsageSources";

const oldConfig = { providers: [{ instanceId: "old-account" }] };
const freshConfig = {
  providers: [{ instanceId: "new-account" }],
  usageLimitSources: [{ id: "private-hub" }],
};
const presentation = {
  connection: { phase: "connected" },
  serverConfig: oldConfig,
} as unknown as EnvironmentPresentation;
const owner = {};
const live = {
  source: "live",
  config: freshConfig,
  sessionOwner: owner,
} as unknown as ServerConfigProjection;

it("requires a live authenticated config and discards carried hub sources", () => {
  expect(selectWidgetPresentation(presentation, true, live, owner)?.serverConfig).toMatchObject({
    providers: freshConfig.providers,
  });
  expect(
    selectWidgetPresentation(presentation, true, live, owner)?.serverConfig?.usageLimitSources,
  ).toBeUndefined();
  expect(selectWidgetPresentation(presentation, false, live, owner)).toBeNull();
  expect(
    selectWidgetPresentation(presentation, true, { ...live, source: "cache" }, owner),
  ).toBeNull();
  expect(selectWidgetPresentation(presentation, true, live, {})).toBeNull();
  expect(selectWidgetPresentation(presentation, true, live, null)).toBeNull();
  expect(
    selectWidgetPresentation(
      { ...presentation, connection: { phase: "offline", error: null, traceId: null } },
      true,
      live,
      owner,
    ),
  ).toBeNull();
  expect(selectWidgetPresentation(presentation, true, null, owner)).toBeNull();
});
