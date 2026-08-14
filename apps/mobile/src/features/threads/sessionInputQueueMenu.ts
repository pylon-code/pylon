import type { SessionInputQueueSnapshot } from "@t3tools/client-runtime/state/session-input-queue";

export type SessionInputQueueModeAction = {
  readonly queue: "steering" | "follow-up";
  readonly mode: "all-at-once" | "one-at-a-time";
};

export function parseSessionInputQueueModeAction(
  eventId: string,
): SessionInputQueueModeAction | null {
  const match = /^session-input-mode:(steering|follow-up):(all-at-once|one-at-a-time)$/.exec(
    eventId,
  );
  if (!match) return null;
  return {
    queue: match[1] as SessionInputQueueModeAction["queue"],
    mode: match[2] as SessionInputQueueModeAction["mode"],
  };
}

export function parseSessionInputQueueRemoveAction(
  eventId: string,
): "steering" | "follow-up" | null {
  const match = /^session-input-remove:(steering|follow-up)$/.exec(eventId);
  return (match?.[1] as "steering" | "follow-up" | undefined) ?? null;
}

export function buildSessionInputQueueMenuActions(input: {
  readonly snapshot: SessionInputQueueSnapshot & {
    readonly steeringMode: "all-at-once" | "one-at-a-time";
    readonly followUpMode: "all-at-once" | "one-at-a-time";
  };
  readonly count: number;
  readonly canSetModes: boolean;
  readonly canClear: boolean;
  readonly canRemove: boolean;
  readonly mutating: boolean;
}) {
  const deliveryActions = (
    queue: SessionInputQueueModeAction["queue"],
    currentMode: SessionInputQueueModeAction["mode"],
  ) =>
    (
      [
        { id: `session-input-mode:${queue}:one-at-a-time`, title: "One at a time" },
        { id: `session-input-mode:${queue}:all-at-once`, title: "All at once" },
      ] as const
    ).map((action) => ({
      ...action,
      state: action.id.endsWith(currentMode) ? ("on" as const) : undefined,
      attributes: input.canSetModes ? undefined : ({ disabled: true } as const),
    }));

  return [
    {
      id: "session-input-steering",
      title: "Steering inputs",
      subtitle: input.snapshot.steeringMode === "all-at-once" ? "All at once" : "One at a time",
      subactions: deliveryActions("steering", input.snapshot.steeringMode),
    },
    {
      id: "session-input-follow-up",
      title: "Follow-up inputs",
      subtitle: input.snapshot.followUpMode === "all-at-once" ? "All at once" : "One at a time",
      subactions: deliveryActions("follow-up", input.snapshot.followUpMode),
    },
    ...(input.snapshot.steeringCount === 1
      ? [
          {
            id: "session-input-remove:steering",
            title: "Remove pending steering input",
            attributes:
              input.canRemove && !input.mutating
                ? ({ destructive: true } as const)
                : ({ disabled: true, destructive: true } as const),
          },
        ]
      : []),
    ...(input.snapshot.followUpCount === 1
      ? [
          {
            id: "session-input-remove:follow-up",
            title: "Remove pending follow-up input",
            attributes:
              input.canRemove && !input.mutating
                ? ({ destructive: true } as const)
                : ({ disabled: true, destructive: true } as const),
          },
        ]
      : []),
    ...(input.count > 0
      ? [
          {
            id: "session-input-clear",
            title: `Clear ${input.count} pending input${input.count === 1 ? "" : "s"}`,
            attributes:
              input.canClear && !input.mutating
                ? ({ destructive: true } as const)
                : ({ disabled: true, destructive: true } as const),
          },
        ]
      : []),
  ];
}
