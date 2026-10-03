/**
 * Agents right-panel surface: the fleet view over the native subagent fold,
 * and the ONLY place the roster renders (the chat carries one CTA row per
 * spawn batch).
 *
 * Visualization rules (from live-test feedback):
 * - Spawn order is stable within active and inactive sections.
 * - Agent rows reserve three fixed lines for identity, activity, and metrics;
 *   changing data must never change their height.
 * - Finished work moves to a collapsed history section.
 * - Static status dots, DOM-write elapsed timers, plain token counters.
 */
import type { RuntimeSubagent } from "@t3tools/client-runtime/state/subagentRuntime";
import {
  sessionAgentLiveActivitySelectionIsOpen,
  type SessionAgentLiveActivitySelection,
} from "@t3tools/client-runtime/state/session-agent-live-activity";
import {
  formatSubagentTokenCount,
  isActiveSubagentStatus,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS,
  type EnvironmentId,
  type ThreadId,
} from "@t3tools/contracts";
import { Bot, Check, ChevronDown, ChevronRight, Eye, MessageSquare, Square } from "lucide-react";
import { useEffect, useRef, useState, type ReactNode } from "react";

import { cn } from "~/lib/utils";
import { ScrollArea } from "~/components/ui/scroll-area";
import { Button } from "~/components/ui/button";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "~/components/ui/alert-dialog";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPopup,
  DialogTitle,
} from "~/components/ui/dialog";
import { Textarea } from "~/components/ui/textarea";
import { AgentLiveActivity } from "./AgentLiveActivity";

/** Status truth stays in labels; the marker follows upstream's static dot vocabulary. */
const STATUS_VISUALS: Record<RuntimeSubagent["status"], { dotClass: string; label: string }> = {
  pending: { dotClass: "bg-info", label: "Queued" },
  running: { dotClass: "bg-info", label: "Working" },
  waiting: { dotClass: "bg-info", label: "Waiting" },
  idle: { dotClass: "bg-muted-foreground/50", label: "Idle · resumable" },
  completed: { dotClass: "bg-success", label: "Completed" },
  failed: { dotClass: "bg-destructive", label: "Failed" },
  cancelled: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
  interrupted: { dotClass: "bg-muted-foreground/60", label: "Stopped" },
};

function StatusDot({ status }: { status: RuntimeSubagent["status"] }) {
  return (
    <span
      aria-hidden
      className={cn("size-1.5 shrink-0 rounded-full", STATUS_VISUALS[status].dotClass)}
    />
  );
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) {
    return `${seconds}s`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours === 0) {
    return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  }
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string, endIso: string | null): string {
  const start = Date.parse(startedAt);
  const end = endIso ? Date.parse(endIso) : Date.now();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return "";
  }
  return formatElapsedSeconds((end - start) / 1000);
}

/**
 * Elapsed time for the current activation. Live agents self-tick via DOM
 * writes (zero React commits per tick); settled agents freeze at completedAt.
 */
function AgentElapsed({ agent }: { agent: RuntimeSubagent }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const live = agent.status === "running" || agent.status === "waiting";
  const startedAt = agent.startedAt;

  useEffect(() => {
    if (!live || !startedAt) {
      return;
    }
    const update = () => {
      if (textRef.current) {
        textRef.current.textContent = elapsedBetween(startedAt, null);
      }
    };
    update();
    const id = setInterval(update, 1000);
    return () => clearInterval(id);
  }, [live, startedAt]);

  if (!startedAt) {
    return null;
  }
  return (
    <span ref={textRef} className="tabular-nums">
      {elapsedBetween(startedAt, live ? null : agent.completedAt)}
    </span>
  );
}

/**
 * Status-dependent activity line. Live rows lead with what is happening now;
 * settled rows lead with the outcome. Errors are the only inline previews on
 * failed rows because they explain a red row at a glance.
 */
function agentActivityText(agent: RuntimeSubagent): string | null {
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  if (live) {
    return (
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error
    );
  }
  return (
    agent.error ??
    agent.result ??
    agent.progress ??
    (agent.lastToolName ? `▸ ${agent.lastToolName}` : null)
  );
}

interface AgentCancelControls {
  readonly canRequest: (agent: RuntimeSubagent) => boolean;
  readonly pendingIds: ReadonlySet<string>;
  readonly onRequest: (agent: RuntimeSubagent) => void;
}

interface AgentMessageControls {
  readonly enabled: boolean;
  readonly onRequest: (agent: RuntimeSubagent) => void;
}

interface AgentLiveActivityControls {
  readonly enabled: boolean;
  readonly onRequest: (agent: RuntimeSubagent) => void;
}

/** Flat agent status line with provider-neutral message and stop actions. */
function AgentRow({
  agent,
  cancelControls,
  messageControls,
  liveActivityControls,
}: {
  agent: RuntimeSubagent;
  cancelControls: AgentCancelControls;
  messageControls: AgentMessageControls;
  liveActivityControls: AgentLiveActivityControls;
}) {
  const visuals = STATUS_VISUALS[agent.status];
  const statusLabel =
    agent.kind === "subagent_batch" && agent.status === "idle" ? "Idle" : visuals.label;
  const activity = agentActivityText(agent);
  const modelLabel =
    agent.model === null ? null : agent.effort ? `${agent.model} · ${agent.effort}` : agent.model;
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  const metadata = [
    modelLabel,
    agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
  ].filter((value): value is string => value !== null);
  const active = isActiveSubagentStatus(agent.status);
  const messageable =
    messageControls.enabled && agent.kind !== "workflow" && agent.messageable && active;
  const cancellable = cancelControls.canRequest(agent) && agent.kind !== "workflow" && active;
  const stopping = cancellable && cancelControls.pendingIds.has(agent.id);
  const liveActivityEligible =
    liveActivityControls.enabled && agent.watchable !== false && agent.kind !== "workflow";
  const liveActivityAvailable = liveActivityEligible && active;

  return (
    <div className="grid h-[3.875rem] grid-cols-[0.375rem_minmax(0,1fr)_auto_auto_1.75rem_1.75rem] grid-rows-[1.25rem_1.125rem_1rem] items-center gap-x-2 rounded-md px-1.5 py-1">
      <span className="col-start-1 row-start-1 flex items-center">
        <StatusDot status={agent.status} />
      </span>
      <span className="col-start-2 row-start-1 flex min-w-0 items-baseline gap-2">
        <span className="min-w-0 truncate text-sm font-medium">{agent.title}</span>
        {role ? (
          <span className="max-w-28 shrink-0 truncate rounded-sm border border-border/60 px-1 font-mono text-3xs text-muted-foreground">
            {role}
          </span>
        ) : null}
      </span>
      <span className="col-start-3 row-start-1 min-w-14 text-right font-mono text-2xs text-muted-foreground/80">
        <span className="inline-flex items-center gap-1">
          <AgentElapsed agent={agent} />
          {agent.status === "completed" ? (
            <Check aria-hidden className="size-3 text-success" />
          ) : null}
        </span>
      </span>
      <span className="col-start-4 row-start-1 flex items-center justify-end">
        {liveActivityAvailable ? (
          <button
            type="button"
            aria-label={`Open live activity for ${agent.title}`}
            onClick={() => liveActivityControls.onRequest(agent)}
            className="flex h-6 items-center gap-1 rounded-sm px-1.5 text-[.65rem] text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Eye aria-hidden className="size-3" />
            Live activity
          </button>
        ) : liveActivityEligible ? (
          <span
            aria-label={`Live activity unavailable for ${agent.title}`}
            className="text-3xs text-muted-foreground/60"
          >
            Live activity unavailable
          </span>
        ) : null}
      </span>
      <span className="col-start-5 row-start-1 flex size-7 items-center justify-center">
        {messageable ? (
          <button
            type="button"
            aria-label={`Message ${agent.title}`}
            onClick={() => messageControls.onRequest(agent)}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <MessageSquare aria-hidden className="size-3.5" />
          </button>
        ) : null}
      </span>
      <span className="col-start-6 row-start-1 flex size-7 items-center justify-center">
        {cancellable ? (
          <button
            type="button"
            aria-label={stopping ? `Stopping ${agent.title}` : `Stop ${agent.title}`}
            aria-busy={stopping || undefined}
            disabled={stopping}
            onClick={() => cancelControls.onRequest(agent)}
            className="flex size-6 items-center justify-center rounded-sm text-muted-foreground hover:bg-destructive/10 hover:text-destructive-foreground disabled:cursor-wait disabled:opacity-50"
          >
            <Square aria-hidden className="size-3" fill="currentColor" />
          </button>
        ) : null}
      </span>
      <span
        className={cn(
          "col-start-2 col-end-7 row-start-2 block truncate text-xs",
          agent.status === "failed" ? "text-destructive-foreground" : "text-muted-foreground",
        )}
      >
        {activity ? `${statusLabel} · ${activity}` : statusLabel}
      </span>
      <span className="col-start-2 col-end-7 row-start-3 truncate font-mono text-2xs tabular-nums text-muted-foreground/70">
        {metadata.join(" · ")}
      </span>
    </div>
  );
}

function InactiveAgents({ children, count }: { children: ReactNode; count: number }) {
  return (
    <details className="border-t border-border/60 pt-2 [&[open]>summary>svg:first-child]:hidden [&[open]>summary>svg:last-of-type]:block">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 rounded-sm px-1.5 py-1 text-xs font-medium text-muted-foreground hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
        <ChevronRight aria-hidden className="size-3" />
        <ChevronDown aria-hidden className="hidden size-3" />
        Inactive <span className="font-mono tabular-nums">{count}</span>
      </summary>
      <div className="flex flex-col gap-2 pt-1">{children}</div>
    </details>
  );
}

/** Flat roster supported by authoritative orchestration v2 subagent entities. */
export interface AgentPanelModel {
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
  readonly liveCount: number;
}

const EMPTY_CANCELLING_AGENT_IDS: ReadonlySet<string> = new Set();

export function AgentsPanel({
  model,
  environmentId = null,
  threadId = null,
  canCancelAgents = false,
  canCancelAgent,
  canMessageAgents = false,
  canWatchAgentActivity = false,
  agentMessageScopeKey,
  agentLiveActivityScopeKey,
  cancellingAgentIds = EMPTY_CANCELLING_AGENT_IDS,
  onCancelAgent,
  onMessageAgent,
}: {
  model: AgentPanelModel;
  environmentId?: EnvironmentId | null;
  threadId?: ThreadId | null;
  canCancelAgents?: boolean;
  /** Per-agent control resolution; detached workers may outlive a parent session. */
  canCancelAgent?: (agent: RuntimeSubagent) => boolean;
  canMessageAgents?: boolean;
  canWatchAgentActivity?: boolean;
  agentMessageScopeKey?: string;
  agentLiveActivityScopeKey?: string;
  cancellingAgentIds?: ReadonlySet<string>;
  onCancelAgent?: (agentId: string) => Promise<void>;
  onMessageAgent?: (agentId: string, message: string) => Promise<"delivered" | "queued" | null>;
}) {
  const messageScopeKey = agentMessageScopeKey ?? JSON.stringify([environmentId, threadId]);
  const liveActivityScopeKey = agentLiveActivityScopeKey ?? messageScopeKey;
  const [liveActivitySelection, setLiveActivitySelection] =
    useState<SessionAgentLiveActivitySelection | null>(null);
  const [confirmAgent, setConfirmAgent] = useState<RuntimeSubagent | null>(null);
  const [cancelError, setCancelError] = useState<string | null>(null);
  const [messageAgent, setMessageAgent] = useState<RuntimeSubagent | null>(null);
  const [messageDraft, setMessageDraft] = useState("");
  const [messagePending, setMessagePending] = useState(false);
  const [messageError, setMessageError] = useState<string | null>(null);
  const [messageFeedback, setMessageFeedback] = useState<{
    readonly agentTitle: string;
    readonly disposition: "delivered" | "queued";
  } | null>(null);
  const [messageStateScopeKey, setMessageStateScopeKey] = useState(messageScopeKey);
  const messageScopeRef = useRef(messageScopeKey);
  messageScopeRef.current = messageScopeKey;
  useEffect(() => {
    setMessageStateScopeKey(messageScopeKey);
    setMessageAgent(null);
    setMessageDraft("");
    setMessagePending(false);
    setMessageError(null);
    setMessageFeedback(null);
  }, [messageScopeKey]);
  const selectedLiveActivityAgent =
    liveActivitySelection === null
      ? null
      : (model.directAgents.find((agent) => agent.id === liveActivitySelection.agentId) ?? null);
  const liveActivityOpen = sessionAgentLiveActivitySelectionIsOpen({
    selection: liveActivitySelection,
    currentScopeKey: liveActivityScopeKey,
    capabilityEnabled: canWatchAgentActivity && environmentId !== null && threadId !== null,
    agent: selectedLiveActivityAgent,
  });
  useEffect(() => {
    if (liveActivitySelection !== null && !liveActivityOpen) {
      setLiveActivitySelection(null);
    }
  }, [liveActivityOpen, liveActivitySelection]);
  const liveActivityControls: AgentLiveActivityControls = {
    enabled: canWatchAgentActivity && environmentId !== null && threadId !== null,
    onRequest: (agent) => {
      if (
        !isActiveSubagentStatus(agent.status) ||
        agent.kind === "workflow" ||
        agent.watchable === false
      )
        return;
      setLiveActivitySelection({ agentId: agent.id, scopeKey: liveActivityScopeKey });
    },
  };

  const cancelControls: AgentCancelControls = {
    canRequest: (agent) =>
      onCancelAgent !== undefined && (canCancelAgent?.(agent) ?? canCancelAgents),
    pendingIds: cancellingAgentIds,
    onRequest: (agent) => {
      setCancelError(null);
      setConfirmAgent(agent);
    },
  };
  const closeMessageDialog = () => {
    if (messagePending) return;
    setMessageAgent(null);
    setMessageDraft("");
    setMessageError(null);
  };
  const messageControls: AgentMessageControls = {
    enabled: canMessageAgents && onMessageAgent !== undefined,
    onRequest: (agent) => {
      setMessageStateScopeKey(messageScopeKey);
      setMessageFeedback(null);
      setMessageError(null);
      setMessageDraft("");
      setMessageAgent(agent);
    },
  };
  const confirmCancel = async () => {
    const agent = confirmAgent;
    if (agent === null || onCancelAgent === undefined) return;
    setConfirmAgent(null);
    try {
      await onCancelAgent(agent.id);
    } catch {
      setCancelError(`Could not stop ${agent.title}. Its status has been refreshed.`);
    }
  };
  const sendAgentMessage = async () => {
    const agent = messageAgent;
    const message = messageDraft.trim();
    if (
      agent === null ||
      onMessageAgent === undefined ||
      messagePending ||
      messageStateScopeKey !== messageScopeKey
    )
      return;
    if (message.length === 0) {
      setMessageError("Enter a message for the agent.");
      return;
    }
    const expectedScopeKey = messageScopeKey;
    setMessagePending(true);
    setMessageError(null);
    try {
      const disposition = await onMessageAgent(agent.id, message);
      if (messageScopeRef.current !== expectedScopeKey || disposition === null) return;
      setMessageFeedback({ agentTitle: agent.title, disposition });
      setMessageAgent(null);
      setMessageDraft("");
    } catch (error) {
      if (messageScopeRef.current !== expectedScopeKey) return;
      setMessageError(
        error instanceof Error && error.message.length > 0
          ? error.message
          : `Could not message ${agent.title}. Check its live status and try again.`,
      );
    } finally {
      if (messageScopeRef.current === expectedScopeKey) setMessagePending(false);
    }
  };
  const activeDirect = model.directAgents.filter((agent) => isActiveSubagentStatus(agent.status));
  const inactiveDirect = model.directAgents.filter(
    (agent) => !isActiveSubagentStatus(agent.status),
  );
  const inactiveCount = inactiveDirect.length;
  const renderAgent = (agent: RuntimeSubagent) => (
    <AgentRow
      key={agent.id}
      agent={agent}
      cancelControls={cancelControls}
      messageControls={messageControls}
      liveActivityControls={liveActivityControls}
    />
  );
  if (!model.hasAgents) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
        <Bot aria-hidden className="size-6 text-muted-foreground/60" />
        <p className="text-sm font-medium">No agents yet</p>
        <p className="max-w-56 text-xs text-muted-foreground">
          When this thread spawns subagents, they show up here with their live status and activity.
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      {cancelError ? (
        <div
          role="alert"
          className="border-b border-destructive/30 px-3 py-2 text-xs text-destructive-foreground"
        >
          {cancelError}
        </div>
      ) : null}
      {messageFeedback && messageStateScopeKey === messageScopeKey ? (
        <div role="status" className="border-b border-border/60 px-3 py-2 text-xs text-foreground">
          {messageFeedback.disposition === "delivered"
            ? `Message delivered to ${messageFeedback.agentTitle}.`
            : `Message queued for ${messageFeedback.agentTitle}.`}
        </div>
      ) : null}
      <ScrollArea className="min-h-0 flex-1">
        <div className="flex flex-col gap-2 p-2">
          <section aria-label="Active agents" className="flex flex-col gap-2">
            <h3 className="px-1.5 pt-1 text-xs font-medium text-muted-foreground">Active</h3>
            {activeDirect.map(renderAgent)}
            {activeDirect.length === 0 ? (
              <p className="px-1.5 text-xs text-muted-foreground">No active agents</p>
            ) : null}
          </section>
          {inactiveCount > 0 ? (
            <InactiveAgents key={JSON.stringify([environmentId, threadId])} count={inactiveCount}>
              {inactiveDirect.map(renderAgent)}
            </InactiveAgents>
          ) : null}
        </div>
      </ScrollArea>
      <footer className="flex items-center justify-between border-t border-border/60 px-3 py-1.5 font-mono text-2xs text-muted-foreground">
        <span className="flex items-center gap-2">
          {model.runningCount + model.waitingCount > 0 ? (
            <span className="text-info-foreground">
              ● {model.runningCount + model.waitingCount} working
            </span>
          ) : null}
          {model.idleCount > 0 ? <span>{model.idleCount} idle</span> : null}
          {model.settledCount > 0 ? <span>{model.settledCount} settled</span> : null}
        </span>
        <span className="tabular-nums">Σ {formatSubagentTokenCount(model.totalTokens)} tok</span>
      </footer>
      <Dialog
        open={liveActivityOpen}
        onOpenChange={(open) => {
          if (!open) setLiveActivitySelection(null);
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Live activity</DialogTitle>
            <DialogDescription>
              Live only. Assistant updates are a bounded replacement snapshot and are unavailable
              after the agent exits.
            </DialogDescription>
          </DialogHeader>
          {liveActivityOpen &&
          selectedLiveActivityAgent !== null &&
          environmentId !== null &&
          threadId !== null ? (
            <AgentLiveActivity
              key={liveActivityScopeKey}
              environmentId={environmentId}
              threadId={threadId}
              agentId={selectedLiveActivityAgent.id}
              agent={selectedLiveActivityAgent}
            />
          ) : null}
          <DialogFooter>
            <Button variant="outline" onClick={() => setLiveActivitySelection(null)}>
              Close live activity
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <Dialog
        open={messageAgent !== null && messageStateScopeKey === messageScopeKey}
        onOpenChange={(open) => {
          if (!open) closeMessageDialog();
        }}
      >
        <DialogPopup>
          <DialogHeader>
            <DialogTitle>Message {messageAgent?.title ?? "agent"}</DialogTitle>
            <DialogDescription>Send a direct instruction to this active agent.</DialogDescription>
          </DialogHeader>
          <div className="space-y-2 px-6 pb-4">
            <Textarea
              autoFocus
              aria-label={`Message for ${messageAgent?.title ?? "agent"}`}
              maxLength={PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS}
              value={messageDraft}
              disabled={messagePending}
              onChange={(event) => {
                setMessageDraft(event.currentTarget.value);
                if (messageError) setMessageError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  void sendAgentMessage();
                }
              }}
              placeholder="What should this agent know or do?"
              className="min-h-32 resize-y"
            />
            <div className="flex items-center justify-between gap-3 text-xs">
              <span
                className="text-destructive-foreground"
                role={messageError ? "alert" : undefined}
              >
                {messageError}
              </span>
              <span className="ml-auto tabular-nums text-muted-foreground">
                {messageDraft.length.toLocaleString()} /{" "}
                {PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS.toLocaleString()}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">Press Ctrl+Enter or ⌘+Enter to send.</p>
          </div>
          <DialogFooter>
            <Button variant="outline" disabled={messagePending} onClick={closeMessageDialog}>
              Cancel
            </Button>
            <Button
              disabled={messagePending || messageDraft.trim().length === 0}
              aria-busy={messagePending || undefined}
              onClick={() => void sendAgentMessage()}
            >
              {messagePending ? "Sending…" : "Send message"}
            </Button>
          </DialogFooter>
        </DialogPopup>
      </Dialog>
      <AlertDialog
        open={confirmAgent !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmAgent(null);
        }}
      >
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Stop {confirmAgent?.title ?? "agent"}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its current work will end. Completed output and activity stay in the thread.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Keep running</AlertDialogClose>
            <Button variant="destructive" onClick={() => void confirmCancel()}>
              Stop agent
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </div>
  );
}
