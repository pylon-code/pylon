import type { SessionCompactionControlSnapshot } from "@t3tools/client-runtime/state/context-compaction";

export type SessionCompactionMenuAction = "compact" | "abort" | "auto-enable" | "auto-disable";

export function sessionCompactionMenuActionId(
  scopeKey: string,
  action: SessionCompactionMenuAction,
): string {
  return `session-compaction:${encodeURIComponent(scopeKey)}:${action}`;
}

export function parseSessionCompactionMenuAction(
  eventId: string,
  scopeKey: string,
): SessionCompactionMenuAction | null {
  const actions: ReadonlyArray<SessionCompactionMenuAction> = [
    "compact",
    "abort",
    "auto-enable",
    "auto-disable",
  ];
  return (
    actions.find((action) => eventId === sessionCompactionMenuActionId(scopeKey, action)) ?? null
  );
}

export function buildSessionCompactionMenuActions(input: {
  readonly scopeKey: string;
  readonly snapshot: SessionCompactionControlSnapshot;
  readonly canCompact: boolean;
  readonly canAbort: boolean;
  readonly canSetAuto: boolean;
  readonly pendingAction: SessionCompactionMenuAction | null;
}) {
  const busy = input.pendingAction !== null;
  const statusTitle =
    input.snapshot.status === "starting"
      ? "Starting compaction…"
      : input.snapshot.status === "compacting"
        ? "Compacting context…"
        : input.snapshot.status === "abort-requested"
          ? "Stopping compaction…"
          : "Context ready";
  const manualAction =
    input.snapshot.status === "idle"
      ? {
          id: sessionCompactionMenuActionId(input.scopeKey, "compact"),
          title: input.pendingAction === "compact" ? "Starting compaction…" : "Compact context now",
          subtitle: "Reduce the current provider session's context",
          image: "arrow.down.right.and.arrow.up.left",
          attributes: input.canCompact && !busy ? undefined : ({ disabled: true } as const),
        }
      : {
          id: sessionCompactionMenuActionId(input.scopeKey, "abort"),
          title: input.pendingAction === "abort" ? "Requesting stop…" : "Stop compaction",
          subtitle: statusTitle,
          image: "stop.fill",
          attributes:
            input.canAbort && !busy
              ? ({ destructive: true } as const)
              : ({ destructive: true, disabled: true } as const),
        };
  const autoEnabled = input.snapshot.autoCompactionEnabled;

  return [
    manualAction,
    ...(autoEnabled === undefined
      ? []
      : [
          {
            id: `session-compaction:${encodeURIComponent(input.scopeKey)}:automatic`,
            title: "Automatic compaction",
            subtitle: `${autoEnabled ? "On" : "Off"} · Applies to this session and the provider default`,
            subactions: [
              { action: "auto-enable" as const, title: "On", enabled: true },
              { action: "auto-disable" as const, title: "Off", enabled: false },
            ].map((option) => ({
              id: sessionCompactionMenuActionId(input.scopeKey, option.action),
              title: option.title,
              subtitle: "This session and provider default",
              state: autoEnabled === option.enabled ? ("on" as const) : undefined,
              attributes: input.canSetAuto && !busy ? undefined : ({ disabled: true } as const),
            })),
          },
        ]),
  ];
}
