import type {
  DesktopNotificationCandidate,
  DesktopNotificationNavigation,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { makeComponentLogger } from "../app/DesktopObservability.ts";
import * as ElectronNotification from "../electron/ElectronNotification.ts";
import * as ElectronWindow from "../electron/ElectronWindow.ts";
import { NOTIFICATION_NAVIGATE_CHANNEL } from "../ipc/channels.ts";
import * as DesktopWindow from "../window/DesktopWindow.ts";

export class DesktopNotifications extends Context.Service<
  DesktopNotifications,
  {
    readonly deliver: (
      candidates: ReadonlyArray<DesktopNotificationCandidate>,
    ) => Effect.Effect<boolean>;
    readonly dismiss: (key: string) => Effect.Effect<void>;
    readonly getNavigation: Effect.Effect<typeof DesktopNotificationNavigation.Type | null>;
    readonly completeNavigation: (id: number) => Effect.Effect<void>;
    readonly sendTest: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/notifications/DesktopNotifications") {}

const { logWarning } = makeComponentLogger("desktop-notifications");

const make = Effect.gen(function* () {
  const notifications = yield* ElectronNotification.ElectronNotification;
  const windows = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  let pendingNavigation: typeof DesktopNotificationNavigation.Type | null = null;
  let navigationId = 0;

  const navigate = Effect.fn("desktop.notifications.navigate")(
    function* (candidate: DesktopNotificationCandidate) {
      pendingNavigation = {
        id: ++navigationId,
        environmentId: candidate.environmentId,
        threadId: candidate.threadId,
      };
      const window = yield* desktopWindow.revealOrCreateMain;
      window.webContents.send(NOTIFICATION_NAVIGATE_CHANNEL);
    },
    Effect.catchCause((cause) => logWarning("failed to open notification thread", { cause })),
  );

  return DesktopNotifications.of({
    dismiss: notifications.dismiss,
    getNavigation: Effect.sync(() => pendingNavigation),
    completeNavigation: (id) =>
      Effect.sync(() => {
        if (pendingNavigation?.id === id) pendingNavigation = null;
      }),
    deliver: Effect.fn("desktop.notifications.deliver")(function* (candidates) {
      if (!(yield* notifications.isSupported)) return false;
      const focused = yield* windows.focusedMainOrFirst;
      // The accessor falls back to the main window even when no window is focused.
      if (Option.isSome(focused) && focused.value.isFocused()) return false;
      for (const candidate of candidates) {
        yield* notifications.show({
          key: `${candidate.environmentId}:${candidate.threadId}`,
          title: candidate.title,
          body: candidate.body,
          onClick: () => {
            runFork(navigate(candidate));
          },
        });
      }
      return true;
    }),
    sendTest: Effect.gen(function* () {
      if (!(yield* notifications.isSupported)) return false;
      yield* notifications.show({
        title: "Pylon",
        body: "Notifications are working. Pylon will tell you when an agent needs you.",
        onClick: () => {},
      });
      return true;
    }),
  });
});

export const layer = Layer.effect(DesktopNotifications, make);
