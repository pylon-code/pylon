import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { DEFAULT_TIMESTAMP_FORMAT } from "@t3tools/contracts/settings";

import { deriveProviderModelsForDisplay, ProviderInstanceCard } from "./ProviderInstanceCard";

/**
 * The inner markup of every `tag` element carrying `inert=""`. These tests
 * render to a string with no DOM available, so nesting is resolved by
 * balancing open and close tags.
 */
function inertRegions(markup: string, tag: string): ReadonlyArray<string> {
  const regions: Array<string> = [];
  const fenceOpen = `<${tag} inert=""`;
  const anyOpen = `<${tag}`;
  const close = `</${tag}>`;
  let cursor = 0;
  for (;;) {
    const start = markup.indexOf(fenceOpen, cursor);
    if (start === -1) return regions;
    const bodyStart = markup.indexOf(">", start) + 1;
    let depth = 1;
    let index = bodyStart;
    while (depth > 0) {
      const nextOpen = markup.indexOf(anyOpen, index);
      const nextClose = markup.indexOf(close, index);
      if (nextClose === -1) break;
      if (nextOpen !== -1 && nextOpen < nextClose) {
        depth += 1;
        index = nextOpen + anyOpen.length;
      } else {
        depth -= 1;
        index = nextClose + close.length;
      }
    }
    regions.push(markup.slice(bodyStart, Math.max(bodyStart, index - close.length)));
    cursor = index;
  }
}

/**
 * The opening tag of the button carrying `ariaLabel`, with its class attribute
 * stripped so an assertion on `disabled=""` cannot be satisfied by the
 * `disabled:` variants baked into the button's class list.
 */
function buttonTag(markup: string, ariaLabel: string): string {
  const at = markup.indexOf(`aria-label="${ariaLabel}"`);
  if (at === -1) return "";
  const start = markup.lastIndexOf("<button", at);
  return markup.slice(start, markup.indexOf(">", at) + 1).replace(/ class="[^"]*"/g, "");
}

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: ["kept-custom"],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });

  it("shows a redacted provider email in the editor header", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "ready",
      auth: { status: "authenticated", email: "developer@example.com" },
      checkedAt: "2026-08-27T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };

    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        instanceId,
        instance: { driver },
        driverOption: undefined,
        liveProvider,
        mode: "editor",
        // Required in Pylon, which renders provider usage windows in the editor;
        // upstream's card has no timestamps to format.
        timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
        onUpdate: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );

    // Pylon shows the account email once, in the editor header, alongside the
    // status line that tells two accounts of one driver apart. Upstream #8472
    // instead added a labelled "Account email" field to the Configuration tab;
    // adopting both would render the same redacted address twice in one panel.
    expect(markup).toContain("Authenticated as");
    expect(markup).toContain('aria-label="Toggle account email visibility"');
    expect(markup).toContain("blur-[2px]");
    expect(markup).not.toContain("Account email");
    expect(markup).not.toContain("developer@example.com");
  });

  it("surfaces a failed probe message in both the list row and the editor", () => {
    const instanceId = ProviderInstanceId.make("codex_work");
    const driver = ProviderDriverKind.make("codex");
    const message =
      "Codex app-server provider probe failed: Cannot create Codex shadow home entry 'auth.json' because '/home/me/.codex-t3/work/auth.json' already exists and is not a symlink.";
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: null,
      status: "error",
      auth: { status: "unknown" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
      message,
    };
    const props = {
      instanceId,
      instance: { driver },
      driverOption: undefined,
      liveProvider,
      timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
      onUpdate: () => undefined,
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
      onHiddenModelsChange: () => undefined,
      onFavoriteModelsChange: () => undefined,
      onModelOrderChange: () => undefined,
    } as const;

    for (const mode of ["list", "editor"] as const) {
      const markup = renderToStaticMarkup(createElement(ProviderInstanceCard, { ...props, mode }));
      expect(markup).toContain("Unavailable");
      expect(markup).toContain("is not a symlink");
    }
  });

  // Fork-only affordances that upstream's card has no equivalent of. The
  // upstream cleanup rebuilt the editor header around an inert fence for the
  // write actions, so this guards three things at once: the controls still
  // render, each chevron's disabled state tracks its handler rather than being
  // stuck off, and the fence lands on the write actions instead of on the
  // status line's email reveal.
  it("fences the drain-order chevrons and the in-app sign-in without freezing the email reveal", () => {
    const instanceId = ProviderInstanceId.make("claude_work");
    const driver = ProviderDriverKind.make("claudeAgent");
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      enabled: true,
      installed: true,
      version: "1.0.0",
      status: "warning",
      // Signed out but with a known address, so the sign-in button and the
      // redacted email both render and can be checked on opposite sides of
      // the fence.
      auth: { status: "unauthenticated", email: "work@example.com" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };

    const render = (
      drainOrder: {
        readonly position: number;
        readonly total: number;
        readonly onMoveUp?: (() => void) | undefined;
        readonly onMoveDown?: (() => void) | undefined;
      },
      readOnly: boolean,
    ) =>
      renderToStaticMarkup(
        createElement(ProviderInstanceCard, {
          instanceId,
          environmentId: EnvironmentId.make("env-1"),
          instance: { driver, displayName: "Work account" },
          driverOption: undefined,
          liveProvider,
          mode: "editor",
          readOnly,
          timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
          drainOrder,
          onUpdate: () => undefined,
          hiddenModels: [],
          favoriteModels: [],
          modelOrder: [],
          onHiddenModelsChange: () => undefined,
          onFavoriteModelsChange: () => undefined,
          onModelOrderChange: () => undefined,
        }),
      );

    // Middle of three accounts, so both chevrons carry a handler. A chevron
    // that had gone permanently disabled fails here instead of passing on the
    // strength of its label alone.
    const middle = render(
      { position: 1, total: 3, onMoveUp: () => undefined, onMoveDown: () => undefined },
      false,
    );
    expect(buttonTag(middle, "Use Work account earlier (currently 2 of 3)")).not.toContain(
      'disabled=""',
    );
    expect(buttonTag(middle, "Use Work account later (currently 2 of 3)")).not.toContain(
      'disabled=""',
    );
    expect(middle).toContain("Sign in");
    expect(inertRegions(middle, "span")).toHaveLength(0);

    // First of three: only "later" has a handler, so "earlier" is disabled by
    // its position at the end of the list.
    const first = render({ position: 0, total: 3, onMoveDown: () => undefined }, false);
    expect(buttonTag(first, "Use Work account earlier (currently 1 of 3)")).toContain(
      'disabled=""',
    );
    expect(buttonTag(first, "Use Work account later (currently 1 of 3)")).not.toContain(
      'disabled=""',
    );

    // Read-only sessions freeze the write actions inside inert fences. The
    // status line stays outside them so the email reveal keeps working, which
    // is the whole reason the blanket header wrapper was split up.
    const readOnly = render(
      { position: 1, total: 3, onMoveUp: () => undefined, onMoveDown: () => undefined },
      true,
    );
    const fences = inertRegions(readOnly, "span");
    expect(
      fences.some((region) => region.includes("Use Work account earlier (currently 2 of 3)")),
    ).toBe(true);
    expect(
      fences.some((region) => region.includes("Use Work account later (currently 2 of 3)")),
    ).toBe(true);
    expect(fences.some((region) => region.includes("Sign in"))).toBe(true);
    expect(readOnly).toContain('aria-label="Toggle account email visibility"');
    expect(fences.some((region) => region.includes("Toggle account email visibility"))).toBe(false);
  });

  it("shows an unavailable WSL2 reason ahead of disabled state in the list and detail", () => {
    const instanceId = ProviderInstanceId.make("primeAgent");
    const driver = ProviderDriverKind.make("primeAgent");
    const reason =
      "Prime Agent is unavailable because this Pylon server is running on native Windows. Run the Pylon server and Prime Agent in WSL2, or connect this client to a Pylon server running in WSL2 or another remote environment.";
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      displayName: "Prime Agent",
      enabled: false,
      installed: false,
      version: null,
      status: "disabled",
      availability: "unavailable",
      unavailableReason: reason,
      auth: { status: "unknown" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      message: reason,
      models: [],
      slashCommands: [],
      skills: [],
    };
    const props = {
      instanceId,
      instance: { driver, displayName: "Prime Agent", enabled: true },
      driverOption: undefined,
      liveProvider,
      timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
      onUpdate: () => undefined,
      hiddenModels: [],
      favoriteModels: [],
      modelOrder: [],
      onHiddenModelsChange: () => undefined,
      onFavoriteModelsChange: () => undefined,
      onModelOrderChange: () => undefined,
    } as const;

    for (const mode of ["list", "editor"] as const) {
      const markup = renderToStaticMarkup(createElement(ProviderInstanceCard, { ...props, mode }));
      expect(markup).toContain("Unavailable");
      expect(markup).toContain(reason);
      expect(markup).not.toContain(">Disabled<");
      if (mode === "list") {
        expect(buttonTag(markup, "Enable Prime Agent")).toContain('disabled=""');
      }
    }
  });

  it("keeps an ordinary disabled provider re-enableable", () => {
    const instanceId = ProviderInstanceId.make("codex");
    const driver = ProviderDriverKind.make("codex");
    const liveProvider: ServerProvider = {
      instanceId,
      driver,
      displayName: "Codex",
      enabled: false,
      installed: true,
      version: null,
      status: "disabled",
      auth: { status: "unknown" },
      checkedAt: "2026-08-28T12:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    };
    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        instanceId,
        instance: { driver, displayName: "Codex", enabled: false },
        driverOption: undefined,
        liveProvider,
        mode: "list",
        timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
        onUpdate: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );

    expect(markup).toContain("Disabled");
    expect(markup).not.toContain("Unavailable");
    expect(buttonTag(markup, "Enable Codex")).not.toContain('disabled=""');
  });

  it("shows Prime isolation, ACP, maintenance, and unsupported-host guidance accessibly", () => {
    const instanceId = ProviderInstanceId.make("primeAgent");
    const driver = ProviderDriverKind.make("primeAgent");
    const reason = "Multiple Prime Agent instances require WSL2 on this host.";
    const markup = renderToStaticMarkup(
      createElement(ProviderInstanceCard, {
        instanceId,
        instance: { driver, enabled: true, config: { agentHomePath: "~/prime/work" } },
        driverOption: undefined,
        liveProvider: {
          instanceId,
          driver,
          enabled: true,
          installed: true,
          version: "0.8.1",
          status: "warning",
          auth: { status: "authenticated" },
          checkedAt: "2026-09-01T00:00:00.000Z",
          message: "Using ACP compatibility mode.",
          models: [],
          slashCommands: [],
          skills: [],
          supportsMultipleInstances: false,
          multipleInstancesUnavailableReason: reason,
        },
        mode: "editor",
        timestampFormat: DEFAULT_TIMESTAMP_FORMAT,
        onUpdate: () => undefined,
        hiddenModels: [],
        favoriteModels: [],
        modelOrder: [],
        onHiddenModelsChange: () => undefined,
        onFavoriteModelsChange: () => undefined,
        onModelOrderChange: () => undefined,
      }),
    );

    expect(markup).toContain("sign in separately");
    expect(markup).toContain("It does not enable multiple Prime instances");
    expect(markup).toContain("stop-all maintenance remains external");
    expect(markup).toContain(`role="status">${reason}`);
  });
});
