import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { useCallback, useEffect, useRef } from "react";

import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useEnvironments } from "../state/environments";
import { environmentShell } from "../state/shell";
import {
  projectAwarenessStates,
  reconcileAwarenessNotifications,
  selectAwarenessNotificationPreferences,
  type ThreadPhaseMap,
} from "../notifications/awarenessNotifications.logic";
import {
  hasDesktopNotifications,
  hasNotificationSound,
  notificationModeForClient,
  playNotificationSound,
  setNotificationBadge,
  unlockNotificationAudio,
} from "../threadNotifications";
import { toastManager } from "./ui/toast";

// Keep the browser and native transports behind the same event reconciliation.
// Native delivery and event preferences build on ALGORITHM-0's Pylon PR #424;
// browser/sound/toast/badge behavior comes from upstream #11481/#11570/#11569.
export function ThreadNotificationCoordinator() {
  const { environments } = useEnvironments();
  const mode = useClientSettings(notificationModeForClient);
  const pending = useRef(new Map<string, { environmentId: EnvironmentId; close: () => void }>());
  const onNotification = useCallback(
    (environmentId: EnvironmentId, tag: string, close: () => void, native = false) => {
      if (!native) pending.current.get(tag)?.close();
      pending.current.delete(tag);
      pending.current.set(tag, { environmentId, close });
      if (pending.current.size > 128) {
        const oldest = pending.current.keys().next().value;
        if (oldest !== undefined) {
          pending.current.get(oldest)?.close();
          pending.current.delete(oldest);
        }
      }
      setNotificationBadge(pending.current.size);
    },
    [],
  );

  useEffect(() => {
    const activeIds = new Set(environments.map(({ environmentId }) => environmentId));
    for (const [tag, item] of pending.current) {
      if (activeIds.has(item.environmentId)) continue;
      item.close();
      pending.current.delete(tag);
    }
    setNotificationBadge(pending.current.size);
  }, [environments]);

  useEffect(() => {
    const clear = () => {
      for (const item of pending.current.values()) item.close();
      pending.current.clear();
      setNotificationBadge(0);
    };
    clear();
    const unsubscribe = window.desktopBridge?.onNotificationBadgeClear?.(clear);
    window.addEventListener("focus", clear);
    return () => {
      unsubscribe?.();
      window.removeEventListener("focus", clear);
      clear();
    };
  }, [mode]);

  useEffect(() => {
    if (!hasNotificationSound(mode)) return;
    document.addEventListener("pointerdown", unlockNotificationAudio);
    document.addEventListener("keydown", unlockNotificationAudio);
    return () => {
      document.removeEventListener("pointerdown", unlockNotificationAudio);
      document.removeEventListener("keydown", unlockNotificationAudio);
    };
  }, [mode]);

  // Stay mounted while disabled to consume transitions without replay.
  return environments.map(({ environmentId }) => (
    <EnvironmentNotifications
      key={environmentId}
      environmentId={environmentId}
      onNotification={onNotification}
    />
  ));
}

function EnvironmentNotifications({
  environmentId,
  onNotification,
}: {
  environmentId: EnvironmentId;
  onNotification: (
    environmentId: EnvironmentId,
    tag: string,
    close: () => void,
    native?: boolean,
  ) => void;
}) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const settings = useClientSettings((value) => value);
  const mode = notificationModeForClient(settings);
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  const previous = useRef<ThreadPhaseMap>(new Map());
  const generation = useRef(0);

  useEffect(() => {
    const epoch = ++generation.current;
    const current = () => generation.current === epoch;
    const cleanup = () => {
      generation.current++;
    };
    if (shell.status !== "live" || Option.isNone(shell.snapshot)) {
      previous.current = new Map();
      return cleanup;
    }
    const snapshot = shell.snapshot.value;
    const states = projectAwarenessStates({
      threads: snapshot.threads.map((thread) => ({ ...thread, environmentId })),
      projectTitleByKey: new Map(
        snapshot.projects.map((project) => [`${environmentId}:${project.id}`, project.title]),
      ),
    });
    const { notifications, nextPhases } = reconcileAwarenessNotifications({
      previousPhases: previous.current,
      states,
      preferences: { ...selectAwarenessNotificationPreferences(settings), enabled: true },
    });
    previous.current = nextPhases;
    const statesById = new Map(states.map((state) => [state.threadId, state]));
    for (const candidate of notifications) {
      const state = statesById.get(candidate.threadId);
      if (!state) continue;
      const kind = state.phase === "completed" ? "completion" : "input";
      const focused = () => document.visibilityState === "visible" && document.hasFocus();
      const title =
        state.phase === "completed"
          ? "Thread completed"
          : state.phase === "failed"
            ? "Thread failed"
            : state.phase === "waiting_for_approval"
              ? "Approval needed"
              : "Input needed";
      if (hasNotificationSound(mode)) {
        void playNotificationSound(
          kind,
          () => current() && hasNotificationSound(notificationModeForClient(getClientSettings())),
        );
      }
      if (
        settings.inAppNotificationsEnabled &&
        focused() &&
        (activeEnvironmentId !== environmentId || activeThreadId !== state.threadId)
      ) {
        const id = toastManager.add({
          type: kind === "completion" ? "success" : state.phase === "failed" ? "error" : "warning",
          title,
          description: state.threadTitle,
          data: { hideCopyButton: true },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(id);
              void navigate({
                to: "/$environmentId/$threadId",
                params: { environmentId, threadId: state.threadId },
              });
            },
          },
        });
        continue;
      }
      if (!hasDesktopNotifications(mode) || focused()) continue;
      const tag = `${environmentId}:${state.threadId}`;
      const bridge = window.desktopBridge;
      if (bridge) {
        // Older shells safely omit this capability. Do not double-deliver through
        // Chromium when the native transport owns desktop notifications.
        void bridge
          .notifyAgentAwareness?.([candidate])
          .then((delivered) => {
            if (
              !delivered ||
              !current() ||
              focused() ||
              !hasDesktopNotifications(notificationModeForClient(getClientSettings()))
            )
              return;
            onNotification(
              environmentId,
              tag,
              () => {
                void bridge.dismissAgentNotification?.(tag).catch(() => undefined);
              },
              true,
            );
          })
          .catch(() => undefined);
        continue;
      }
      if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
      try {
        const notification = new Notification(title, {
          body: state.threadTitle,
          tag,
          silent: true,
        });
        onNotification(environmentId, tag, () => notification.close());
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: state.threadId },
          });
        });
      } catch {
        /* Unsupported browser presentation should not break the event stream. */
      }
    }
    return cleanup;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    settings,
    mode,
    navigate,
    onNotification,
    shell,
  ]);
  return null;
}
