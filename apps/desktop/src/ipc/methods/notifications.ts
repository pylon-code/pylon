import { DesktopNotificationCandidate } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import * as DesktopNotifications from "../../notifications/DesktopNotifications.ts";
import * as IpcChannels from "../channels.ts";
import * as DesktopIpc from "../DesktopIpc.ts";

export const notifyAgentAwareness = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.NOTIFY_AGENT_AWARENESS_CHANNEL,
  payload: Schema.Array(DesktopNotificationCandidate),
  result: Schema.Void,
  handler: Effect.fn("desktop.ipc.notifications.notifyAgentAwareness")(function* (candidates) {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    yield* notifications.deliver(candidates);
  }),
});

export const sendTestNotification = DesktopIpc.makeIpcMethod({
  channel: IpcChannels.SEND_TEST_NOTIFICATION_CHANNEL,
  payload: Schema.Undefined,
  result: Schema.Boolean,
  handler: Effect.fn("desktop.ipc.notifications.sendTestNotification")(function* () {
    const notifications = yield* DesktopNotifications.DesktopNotifications;
    return yield* notifications.sendTest;
  }),
});
