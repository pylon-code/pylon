import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => [] }));
vi.mock("@legendapp/list/react", () => ({
  LegendList: (props: {
    data: string[];
    renderItem: (input: { item: string; index: number }) => ReactNode;
    ListHeaderComponent?: ReactNode;
  }) => (
    <div>
      {props.ListHeaderComponent}
      {props.data.map((item, index) => props.renderItem({ item, index }))}
    </div>
  ),
}));
vi.mock("~/hooks/useSettings", () => ({
  useClientSettings: (select: (settings: { favorites: never[] }) => unknown) =>
    select({ favorites: [] }),
  useUpdateClientSettings: () => () => {},
}));
vi.mock("./ModelPickerSidebar", () => ({ ModelPickerSidebar: () => null }));
vi.mock("./ModelListRow", () => ({
  ModelListRow: (props: { model: { name: string } }) => <div>{props.model.name}</div>,
}));
vi.mock("../ui/tooltip", () => ({
  TooltipProvider: (props: { children: ReactNode }) => <>{props.children}</>,
}));
vi.mock("../ui/combobox", () => ({
  Combobox: (props: { children: ReactNode }) => <>{props.children}</>,
  ComboboxEmpty: (props: { children: ReactNode }) => <>{props.children}</>,
  ComboboxInput: () => null,
  ComboboxItem: (props: { children: ReactNode }) => <>{props.children}</>,
  ComboboxListVirtualized: (props: { children: ReactNode }) => <>{props.children}</>,
}));

import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ModelPickerContent } from "./ModelPickerContent";

describe("ModelPickerContent", () => {
  it("renders a provider message when its catalog contains one model", () => {
    const instanceId = ProviderInstanceId.make("generic-provider");
    const model = { slug: "default", name: "Prime Agent Default" };
    const message =
      "Prime Agent CLI is ready, but model discovery timed out; using the fallback model catalog.";
    const provider: ServerProvider = {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "unknown" },
      checkedAt: "2026-09-10T00:00:00.000Z",
      models: [model],
      slashCommands: [],
      skills: [],
      message,
    };

    const markup = renderToStaticMarkup(
      <ModelPickerContent
        activeInstanceId={instanceId}
        model="default"
        lockedProvider={null}
        instanceEntries={deriveProviderInstanceEntries([provider])}
        keybindings={[]}
        modelOptionsByInstance={new Map([[instanceId, [model]]])}
        terminalOpen={false}
        onInstanceModelChange={() => {}}
      />,
    );

    expect(markup).toContain(message);
  });
});
