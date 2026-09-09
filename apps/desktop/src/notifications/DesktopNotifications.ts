import type { DesktopNotificationCandidate } from "@t3tools/contracts";
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
    ) => Effect.Effect<void>;
    readonly sendTest: Effect.Effect<boolean>;
  }
>()("@t3tools/desktop/notifications/DesktopNotifications") {}

const { logWarning } = makeComponentLogger("desktop-notifications");

export const make = Effect.gen(function* () {
  const notifications = yield* ElectronNotification.ElectronNotification;
  const windows = yield* ElectronWindow.ElectronWindow;
  const desktopWindow = yield* DesktopWindow.DesktopWindow;
  const context = yield* Effect.context<never>();
  const runFork = Effect.runForkWith(context);

  const navigate = Effect.fn("desktop.notifications.navigate")(
    function* (candidate: DesktopNotificationCandidate) {
      const window = yield* desktopWindow.revealOrCreateMain;
      window.webContents.send(NOTIFICATION_NAVIGATE_CHANNEL, {
        environmentId: candidate.environmentId,
        threadId: candidate.threadId,
      });
    },
    Effect.catchCause((cause) => logWarning("failed to open notification thread", { cause })),
  );

  return DesktopNotifications.of({
    deliver: Effect.fn("desktop.notifications.deliver")(function* (candidates) {
      if (!(yield* notifications.isSupported)) return;
      const focused = yield* windows.focusedMainOrFirst;
      // The accessor falls back to the main window even when no window is focused.
      if (Option.isSome(focused) && focused.value.isFocused()) return;
      for (const candidate of candidates) {
        yield* notifications.show({
          title: candidate.title,
          body: candidate.body,
          onClick: () => {
            runFork(navigate(candidate));
          },
        });
      }
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
