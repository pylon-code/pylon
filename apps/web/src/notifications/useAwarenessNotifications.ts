import { useEffect, useRef } from "react";

import { useProjects, useThreadShells } from "~/state/entities";
import { useClientSettings } from "~/hooks/useSettings";
import {
  projectAwarenessStates,
  reconcileAwarenessNotifications,
  selectAwarenessNotificationPreferences,
  type ThreadPhaseMap,
} from "./awarenessNotifications.logic";

/**
 * Forwards agent-awareness transitions to the desktop main process for
 * native notification delivery. Reads the same thread-shell atom the
 * sidebar renders from, so it observes every thread in every connected
 * environment, not only the open one. No-ops outside Electron and on
 * older desktop shells whose bridge lacks the method.
 */
export function useAwarenessNotifications(): void {
  const threads = useThreadShells();
  const projects = useProjects();
  const preferences = useClientSettings(selectAwarenessNotificationPreferences);
  const previousPhasesRef = useRef<ThreadPhaseMap>(new Map());

  useEffect(() => {
    const notify = window.desktopBridge?.notifyAgentAwareness;
    if (typeof notify !== "function") {
      return;
    }
    const projectTitleByKey = new Map(
      projects.map((project) => [`${project.environmentId}:${project.id}`, project.title]),
    );
    const { notifications, nextPhases } = reconcileAwarenessNotifications({
      previousPhases: previousPhasesRef.current,
      states: projectAwarenessStates({ threads, projectTitleByKey }),
      preferences,
    });
    previousPhasesRef.current = nextPhases;
    if (notifications.length > 0) {
      void notify(notifications).catch((error: unknown) => {
        console.warn("Could not deliver desktop notifications", error);
      });
    }
  }, [threads, projects, preferences]);
}
