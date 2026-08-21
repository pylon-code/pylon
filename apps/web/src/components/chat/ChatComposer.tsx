import type {
  ApprovalRequestId,
  EnvironmentId,
  ModelSelection,
  ProviderAskSessionSideQuestionResult,
  ProviderCancelSessionSideQuestionResult,
  ProviderSessionSideQuestionRequestId,
  PreviewAnnotationPayload,
  ProviderApprovalDecision,
  ProviderInteractionMode,
  ResolvedKeybindingsConfig,
  RuntimeMode,
  ScopedThreadRef,
  ServerProvider,
  SessionCompactionUpdatedPayload,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  getServerProviderSupportedRuntimeModes,
  resolveServerProviderRuntimeMode,
  isProviderSendTurnSupportedImageMimeType,
  ProviderDriverKind,
  ProviderInstanceId,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
} from "@t3tools/contracts";
import type { EnvironmentConnectionPresentation } from "@t3tools/client-runtime/connection";
import {
  canAbortSessionCompaction,
  canConfigureSessionAutoCompaction,
  canStartSessionCompaction,
  deriveLatestSessionCompaction,
  isCurrentSessionCompactionRequest,
  sessionCompactionScopeKey as makeSessionCompactionScopeKey,
  supportsSessionCompaction,
} from "@t3tools/client-runtime/state/context-compaction";
import { deriveActiveSessionGoal } from "@t3tools/client-runtime/state/session-goal";
import {
  canSetSessionAgentDepth,
  deriveLatestSessionAgentDepth,
  supportsSessionAgentDepth,
} from "@t3tools/client-runtime/state/session-agent-depth";
import {
  deriveLatestSessionInputQueue,
  hasSessionInputQueueModes,
  sessionInputQueueCount,
  supportsSessionInputQueue,
  supportsSessionInputQueueClear,
  supportsSessionInputQueueFollowUp,
  supportsSessionInputQueueRemove,
  supportsSessionInputQueueSetModes,
} from "@t3tools/client-runtime/state/session-input-queue";
import {
  deriveCurrentSessionResources,
  formatProviderSlashCommandDescription,
  presentSessionResourceInventory,
  resolveSessionSlashCommands,
  sessionResourceViewIdentity,
  supportsSessionResourceReload,
} from "@t3tools/client-runtime/state/session-resources";
import { serializeComposerFileLink } from "@t3tools/shared/composerTrigger";
import { createModelSelection, normalizeModelSlug } from "@t3tools/shared/model";
import {
  memo,
  type ReactNode,
  useCallback,
  useEffect,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import {
  clampCollapsedComposerCursor,
  type ComposerSubmissionIntent,
  type ComposerTrigger,
  collapseExpandedComposerCursor,
  composerSubmissionIntentForEnter,
  detectComposerTrigger,
  expandCollapsedComposerCursor,
  replaceTextRange,
} from "../../composer-logic";
import { DISCONNECTED_COMPOSER_PLACEHOLDER } from "../../composerPlaceholder";
import { deriveComposerSendState, readFileAsDataUrl } from "../ChatView.logic";
import {
  dataTransferHasComposerMention,
  makeComposerMentionDragHandlers,
} from "./composerMentionDrag";
import {
  type ComposerImageAttachment,
  type DraftId,
  type PersistedComposerImageAttachment,
  hydrateImagesFromPersisted,
  useComposerDraftStore,
  useComposerThreadDraft,
  useEffectiveComposerModelState,
} from "../../composerDraftStore";
import {
  MAX_STASH_ENTRIES,
  partitionStashAttachments,
  usePromptStashStore,
  type PromptStashEntry,
} from "../../promptStashStore";
import { ComposerStashBadge } from "./ComposerStashBadge";
import { ComposerStashMenu } from "./ComposerStashMenu";
import {
  ComposerTasksBadge,
  ComposerTasksDrawer,
  type ComposerTaskStep,
  type ComposerTasksProgress,
} from "./ComposerTasksBadge";
import { compressImageForStash, compressImageToByteLimit } from "../../lib/imageCompression";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { getTerminalFocusOwner } from "../../lib/terminalFocus";
import { resolveShortcutCommand } from "../../keybindings";
import {
  type TerminalContextDraft,
  type TerminalContextSelection,
  INLINE_TERMINAL_CONTEXT_PLACEHOLDER,
  insertInlineTerminalContextPlaceholder,
  removeInlineTerminalContextPlaceholder,
} from "../../lib/terminalContext";
import { useComposerPathSearch } from "../../lib/composerPathSearchState";
import { type ElementContextDraft } from "../../lib/elementContext";
import { ComposerPendingElementContexts } from "./ComposerPendingElementContexts";
import { ComposerPendingReviewComments } from "./ComposerPendingReviewComments";
import { ComposerPreviewAnnotationCards } from "./ComposerPreviewAnnotationCards";
import {
  shouldUseCompactComposerPrimaryActions,
  shouldUseCompactComposerFooter,
} from "../composerFooterLayout";
import { type ComposerPromptEditorHandle, ComposerPromptEditor } from "../ComposerPromptEditor";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { type ComposerCommandItem, ComposerCommandMenu } from "./ComposerCommandMenu";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerPrimaryActions } from "./ComposerPrimaryActions";
import { ComposerPendingApprovalPanel } from "./ComposerPendingApprovalPanel";
import { ComposerPendingUserInputPanel } from "./ComposerPendingUserInputPanel";
import { ComposerPlanFollowUpBanner } from "./ComposerPlanFollowUpBanner";
import { ComposerControl, ComposerControlIcon, ComposerSelectControl } from "./ComposerControl";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";
import { searchSlashCommandItems } from "./composerSlashCommandSearch";
import {
  getComposerPromptInjectionState,
  getComposerProviderState,
  renderProviderTraitsMenuContent,
  renderProviderTraitsPicker,
} from "./composerProviderState";
import { ContextWindowMeter } from "./ContextWindowMeter";
import { SessionGoalControl } from "./SessionGoalControl";
import { SessionHarnessControl } from "./SessionHarnessControl";
import { SessionInputQueueControl } from "./SessionInputQueueControl";
import { resolveContextWindowModelDisplayName } from "./ContextWindowMeter.logic";
import { buildExpandedImagePreview, type ExpandedImagePreview } from "./ExpandedImagePreview";
import { basenameOfPath } from "../../pierre-icons";
import { cn, randomUUID } from "~/lib/utils";
import { Separator } from "../ui/separator";
import {
  getComposerPromptLengthValidationMessage,
  getComposerSubmissionValidationMessage,
  submitComposerDraft,
} from "./composerSubmission";
import { ComposerPromptLengthValidation } from "./ComposerPromptLengthValidation";

type ComposerCommandMenuPosition = {
  bottom: number;
  left: number;
  maxHeight: number;
  width: number;
};

/** Frames without movement before the position is treated as settled. */
const COMPOSER_MENU_SETTLED_FRAMES = 3;

function composerCommandMenuPositionsEqual(
  a: ComposerCommandMenuPosition,
  b: ComposerCommandMenuPosition,
): boolean {
  return (
    a.bottom === b.bottom && a.left === b.left && a.maxHeight === b.maxHeight && a.width === b.width
  );
}

function ComposerCommandMenuLayer(props: { anchor: HTMLElement | null; children: ReactNode }) {
  const [position, setPosition] = useState<ComposerCommandMenuPosition | null>(null);

  useLayoutEffect(() => {
    const anchor = props.anchor;
    if (!anchor) {
      setPosition(null);
      return;
    }

    let frame = 0;
    let stillFrames = 0;
    let previous: ComposerCommandMenuPosition | null = null;

    // Upstream #7150 measures the drawer-aware surface but schedules it from a
    // plain ResizeObserver, which ce5371d41 established does not fire while the
    // composer glides into place. Its measurement is kept; the settle loop below
    // still owns *when*.
    const measure = () => {
      const form = anchor.closest<HTMLElement>('[data-chat-composer-form="true"]');
      const mainSurface = form?.querySelector<HTMLElement>(
        '[data-chat-composer-main-surface="true"]',
      );
      const rect = (mainSurface ?? form ?? anchor).getBoundingClientRect();
      const rootFontSizePx =
        Number.parseFloat(window.getComputedStyle(document.documentElement).fontSize) || 16;
      const drawerInsetRem =
        Number.parseFloat(
          window.getComputedStyle(form ?? anchor).getPropertyValue("--chat-composer-drawer-inset"),
        ) || 1.375;
      const drawerInset = drawerInsetRem * rootFontSizePx;
      // One extra pixel prevents fractional layout coordinates from exposing
      // the canvas between the drawer mask and the composer's foreground edge.
      // Mirrors --chat-composer-attachment-overlap: calc(1rem + 1px).
      const composerOverlap = rootFontSizePx + 1;
      const next = {
        bottom: window.innerHeight - rect.top - composerOverlap,
        left: rect.left + drawerInset,
        maxHeight: Math.max(96, rect.top - 24 + composerOverlap),
        width: Math.max(0, rect.width - drawerInset * 2),
      };
      const moved = previous === null || !composerCommandMenuPositionsEqual(previous, next);
      previous = next;
      setPosition((current) =>
        current && composerCommandMenuPositionsEqual(current, next) ? current : next,
      );
      return moved;
    };

    // What moves the composer is position, not size. Opening a side panel or the
    // terminal drawer reaches its new ancestor width immediately while the
    // composer is still gliding into place, so a size notification alone lands
    // on a rect that is one layout behind and nothing fires again. Re-measure
    // across frames until the position holds still, then stop: no permanent
    // animation loop, and nothing is left behind mid-transition.
    const track = () => {
      stillFrames = 0;
      if (frame !== 0) return;
      const step = () => {
        const moved = measure();
        stillFrames = moved ? 0 : stillFrames + 1;
        if (stillFrames >= COMPOSER_MENU_SETTLED_FRAMES) {
          frame = 0;
          return;
        }
        frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    };

    measure();
    window.addEventListener("resize", track);
    window.addEventListener("scroll", track, true);
    // Transition events bubble, so one capturing listener covers every ancestor
    // that animates the composer into its new position.
    document.addEventListener("transitionrun", track, true);
    document.addEventListener("transitionend", track, true);
    document.addEventListener("transitioncancel", track, true);

    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(track);
    if (observer) {
      // The composer is centered and capped at a max width, so opening a side
      // panel slides it sideways without ever resizing it. Watching the anchor
      // alone would leave the menu behind; the ancestors are what shrink.
      observer.observe(anchor);
      for (let element = anchor.parentElement; element; element = element.parentElement) {
        observer.observe(element);
      }
    }

    return () => {
      if (frame !== 0) cancelAnimationFrame(frame);
      observer?.disconnect();
      window.removeEventListener("resize", track);
      window.removeEventListener("scroll", track, true);
      document.removeEventListener("transitionrun", track, true);
      document.removeEventListener("transitionend", track, true);
      document.removeEventListener("transitioncancel", track, true);
    };
  }, [props.anchor]);

  if (!position) return null;

  return createPortal(
    <div
      className="pointer-events-auto fixed z-[70]"
      data-composer-drawer-layer="true"
      style={{
        bottom: position.bottom,
        left: position.left,
        maxHeight: position.maxHeight,
        width: position.width,
      }}
    >
      {props.children}
    </div>,
    document.body,
  );
}
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectValue } from "../ui/select";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { toastManager } from "../ui/toast";
import {
  BotIcon,
  CircleAlertIcon,
  PencilRulerIcon,
  MessageCircleQuestionIcon,
  type LucideIcon,
  LockIcon,
  LockOpenIcon,
  PenLineIcon,
  SparklesIcon,
  XIcon,
} from "lucide-react";
import { proposedPlanTitle } from "../../proposedPlan";
import {
  canRefineSessionHarness,
  harnessRefinementToast,
  isCurrentSessionHarnessRefinementRequest,
  sessionHarnessRefinementControlState,
  sessionHarnessRefinementScopeKey as buildSessionHarnessRefinementScopeKey,
  SESSION_HARNESS_REFINEMENT_CONFIRMATION,
} from "../../sessionHarnessRefinement";
import { getProviderInteractionModeToggle } from "../../providerModels";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  isProviderInstanceDrained,
  NO_PROVIDER_MODEL_SELECTION,
  resolveProviderDriverKindForInstanceSelection,
  resolveSelectableProviderInstanceEntry,
  sortProviderInstanceEntries,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { type AppModelOption, getAppModelOptionsForInstance } from "../../modelSelection";
import type { UnifiedSettings } from "@t3tools/contracts/settings";
import type { SessionPhase, Thread } from "../../types";
import type { PendingUserInputDraftAnswer } from "../../pendingUserInput";
import type { PendingApproval, PendingUserInput } from "../../session-logic";
import {
  deriveLatestContextWindowSnapshot,
  formatProviderDisplayName,
} from "../../lib/contextWindow";
import type { ProviderUsageAccount } from "../providerUsage/ProviderUsageAccounts";
// #7150 moved this helper into client-runtime; Pylon's local module is gone.
import { formatProviderSkillDisplayName } from "@t3tools/client-runtime/providerSkills";
import { searchProviderSkills } from "../../providerSkillSearch";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import type { ReviewCommentContext } from "../../reviewCommentContext";
import type { ThreadHandoffOffer } from "./ThreadHandoff.logic";
import { ThreadHandoffTab } from "./ThreadHandoffTab";
import { QuickQuestionDialog } from "./QuickQuestionDialog";
import { SessionResourcesDialog } from "./SessionResourcesDialog";

const runtimeModeConfig: Record<
  RuntimeMode,
  { label: string; description: string; icon: LucideIcon }
> = {
  "approval-required": {
    label: "Supervised",
    description: "Ask before commands and file changes.",
    icon: LockIcon,
  },
  "auto-accept-edits": {
    label: "Auto-accept edits",
    description: "Auto-approve edits, ask before other actions.",
    icon: PenLineIcon,
  },
  auto: {
    label: "Auto",
    description: "Supported providers approve routine actions; others still ask.",
    icon: SparklesIcon,
  },
  "full-access": {
    label: "Full access",
    description: "Allow commands and edits without prompts.",
    icon: LockOpenIcon,
  },
};

const runtimeModeOptions = Object.keys(runtimeModeConfig) as RuntimeMode[];
const COMPOSER_FLOATING_LAYER_SELECTOR = [
  '[data-composer-drawer-layer="true"]',
  '[data-slot="popover-popup"]',
  '[data-slot="menu-popup"]',
  '[data-slot="select-popup"]',
  '[data-slot="combobox-popup"]',
  '[data-slot="autocomplete-popup"]',
].join(",");

const extendReplacementRangeForTrailingSpace = (
  text: string,
  rangeEnd: number,
  replacement: string,
): number => {
  if (!replacement.endsWith(" ")) {
    return rangeEnd;
  }
  return text[rangeEnd] === " " ? rangeEnd + 1 : rangeEnd;
};

const syncTerminalContextsByIds = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): TerminalContextDraft[] => {
  const contextsById = new Map(contexts.map((context) => [context.id, context]));
  return ids.flatMap((id) => {
    const context = contextsById.get(id);
    return context ? [context] : [];
  });
};

const terminalContextIdListsEqual = (
  contexts: ReadonlyArray<TerminalContextDraft>,
  ids: ReadonlyArray<string>,
): boolean =>
  contexts.length === ids.length && contexts.every((context, index) => context.id === ids[index]);

function isInsideComposerFloatingLayer(element: Element): boolean {
  return element.closest(COMPOSER_FLOATING_LAYER_SELECTOR) !== null;
}

const ComposerFooterModeControls = memo(function ComposerFooterModeControls(props: {
  showInteractionModeToggle: boolean;
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  supportedRuntimeModes: ReadonlyArray<RuntimeMode>;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const runtimeModeOption = runtimeModeConfig[props.runtimeMode];
  const RuntimeModeIcon = runtimeModeOption.icon;
  const interactionModeTooltip =
    props.interactionMode === "plan"
      ? "Plan mode — click to return to normal build mode"
      : "Default mode — click to enter plan mode";

  const interactionModeToggle = props.showInteractionModeToggle ? (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />
      <Tooltip>
        <TooltipTrigger
          render={
            <ComposerControl
              className={cn(
                "shrink-0 whitespace-nowrap",
                props.interactionMode === "plan"
                  ? "bg-accent text-accent-foreground hover:bg-accent/80"
                  : "text-secondary-label hover:text-foreground",
              )}
              type="button"
              onClick={props.onToggleInteractionMode}
              aria-label={interactionModeTooltip}
            />
          }
        >
          {props.interactionMode === "plan" ? (
            <ComposerControlIcon icon={PencilRulerIcon} className="text-current opacity-100" />
          ) : (
            <ComposerControlIcon icon={BotIcon} opticalSize="large" />
          )}
          <span className="sr-only sm:not-sr-only">
            {props.interactionMode === "plan" ? "Plan" : "Build"}
          </span>
        </TooltipTrigger>
        <TooltipPopup side="top">{interactionModeTooltip}</TooltipPopup>
      </Tooltip>
    </>
  ) : null;

  return (
    <>
      <Separator orientation="vertical" className="mx-0.5 hidden h-4 sm:block" />

      <Tooltip>
        <Select
          value={props.runtimeMode}
          onValueChange={(value) => props.onRuntimeModeChange(value!)}
        >
          <TooltipTrigger
            render={<ComposerSelectControl className="font-medium" aria-label="Runtime mode" />}
          >
            <ComposerControlIcon icon={RuntimeModeIcon} />
            <SelectValue>{runtimeModeOption.label}</SelectValue>
          </TooltipTrigger>
          <SelectPopup alignItemWithTrigger={false}>
            {runtimeModeOptions
              .filter((mode) => props.supportedRuntimeModes.includes(mode))
              .map((mode) => {
                const option = runtimeModeConfig[mode];
                const OptionIcon = option.icon;
                return (
                  <SelectItem key={mode} value={mode} hideIndicator className="min-w-64 py-2">
                    <div className="flex min-w-0 items-center gap-3">
                      <div className="grid min-w-0 flex-1 gap-0.5">
                        <span className="inline-flex items-center gap-1.5 font-medium text-foreground">
                          <OptionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                          {option.label}
                        </span>
                        <span className="text-muted-foreground text-xs leading-4">
                          {option.description}
                        </span>
                      </div>
                    </div>
                  </SelectItem>
                );
              })}
          </SelectPopup>
        </Select>
        <TooltipPopup side="top">{runtimeModeOption.description}</TooltipPopup>
      </Tooltip>

      {interactionModeToggle}
    </>
  );
});

const ComposerFooterPrimaryActions = memo(function ComposerFooterPrimaryActions(props: {
  compact: boolean;
  activeContextWindow: ReturnType<typeof deriveLatestContextWindowSnapshot>;
  activeThreadModelDisplayName: string | null;
  activeProviderUsageAccounts: readonly ProviderUsageAccount[];
  timestampFormat: UnifiedSettings["timestampFormat"];
  contextCompaction: import("./ContextWindowMeter").ContextCompactionControlProps | null;
  harnessRefinement: import("./ContextWindowMeter").HarnessRefinementControlProps | null;
  sessionGoal: import("@t3tools/client-runtime/state/session-goal").SessionGoalSnapshot | null;
  isPreparingWorktree: boolean;
  pendingAction: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    isResponding: boolean;
    isComplete: boolean;
  } | null;
  isRunning: boolean;
  canQueueFollowUp: boolean;
  onQueueFollowUp: () => void;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
  isEnvironmentUnavailable: boolean;
  hasSendableContent: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  showSendWhileRunning?: boolean;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  onImplementPlanInNewThread: () => void;
}) {
  return (
    <>
      {props.sessionGoal ? <SessionGoalControl snapshot={props.sessionGoal} /> : null}
      {props.activeContextWindow || props.contextCompaction || props.harnessRefinement ? (
        <ContextWindowMeter
          usage={props.activeContextWindow}
          modelDisplayName={props.activeThreadModelDisplayName}
          timestampFormat={props.timestampFormat}
          compaction={props.contextCompaction}
          harnessRefinement={props.harnessRefinement}
        />
      ) : null}
      {props.isPreparingWorktree ? (
        <span className="text-secondary-label text-xs">Preparing worktree...</span>
      ) : null}
      <ComposerPrimaryActions
        compact={props.compact}
        pendingAction={props.pendingAction}
        isRunning={props.isRunning}
        canQueueFollowUp={props.canQueueFollowUp}
        onQueueFollowUp={props.onQueueFollowUp}
        showPlanFollowUpPrompt={props.showPlanFollowUpPrompt}
        promptHasText={props.promptHasText}
        isSendBusy={props.isSendBusy}
        sendDisabledReason={props.sendDisabledReason}
        isConnecting={props.isConnecting}
        isEnvironmentUnavailable={props.isEnvironmentUnavailable}
        isPreparingWorktree={props.isPreparingWorktree}
        hasSendableContent={props.hasSendableContent}
        preserveComposerFocusOnPointerDown={props.preserveComposerFocusOnPointerDown ?? false}
        showSendWhileRunning={props.showSendWhileRunning ?? false}
        onPreviousPendingQuestion={props.onPreviousPendingQuestion}
        onInterrupt={props.onInterrupt}
        onImplementPlanInNewThread={props.onImplementPlanInNewThread}
      />
    </>
  );
});

// --------------------------------------------------------------------------
// Handle exposed to ChatView
// --------------------------------------------------------------------------

export interface ChatComposerHandle {
  focusAtEnd: () => void;
  focusAt: (cursor: number) => void;
  addDroppedFiles: (files: File[]) => void;
  insertTextAtEnd: (text: string, options?: { ensureLeadingBoundary?: boolean }) => boolean;
  openModelPicker: () => void;
  toggleModelPicker: () => void;
  isModelPickerOpen: () => boolean;
  canOpenQuickQuestion: () => boolean;
  openQuickQuestion: () => boolean;
  canOpenSessionResources: () => boolean;
  openSessionResources: () => boolean;
  readSnapshot: () => {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  };
  /** Reset composer cursor/trigger/highlight after external prompt mutations (e.g. onSend). */
  resetCursorState: (options?: {
    cursor?: number;
    prompt?: string;
    detectTrigger?: boolean;
  }) => void;
  /** Insert a terminal context from the terminal drawer. */
  addTerminalContext: (selection: TerminalContextSelection) => void;
  /** Get the current prompt/effort/model state for use in send. */
  getSendContext: () => {
    prompt: string;
    images: ComposerImageAttachment[];
    terminalContexts: TerminalContextDraft[];
    elementContexts: ElementContextDraft[];
    previewAnnotations: PreviewAnnotationPayload[];
    reviewComments: ReviewCommentContext[];
    selectedPromptEffort: string | null;
    selectedModelOptionsForDispatch: unknown;
    selectedModelSelection: ModelSelection;
    providerAvailable: boolean;
    selectedProvider: ProviderDriverKind;
    selectedModel: string;
    selectedProviderModels: ReadonlyArray<ServerProvider["models"][number]>;
  };
  /** Validate the fully composed text immediately before a provider turn starts. */
  validateProviderInput: (providerInput: string) => boolean;
}

// --------------------------------------------------------------------------
// Props
// --------------------------------------------------------------------------

export interface ChatComposerProps {
  composerDraftTarget: ScopedThreadRef | DraftId;
  environmentId: EnvironmentId;
  routeKind: "server" | "draft";
  routeThreadRef: ScopedThreadRef;
  draftId: DraftId | null;

  // Thread context
  activeThreadId: ThreadId | null;
  activeThreadEnvironmentId: EnvironmentId | undefined;
  activeThread: Thread | undefined;
  isServerThread: boolean;
  isLocalDraftThread: boolean;
  forceExpandedOnMobile: boolean;
  projectSelectionRequired: boolean;

  // Session phase
  phase: SessionPhase;
  isConnecting: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isPreparingWorktree: boolean;
  externalDrawerAttached: boolean;
  environmentUnavailable: {
    readonly label: string;
    readonly connection: EnvironmentConnectionPresentation;
  } | null;

  // Pending approvals / inputs
  activePendingApproval: PendingApproval | null;
  pendingApprovals: PendingApproval[];
  pendingUserInputs: PendingUserInput[];
  activePendingProgress: {
    questionIndex: number;
    isLastQuestion: boolean;
    canAdvance: boolean;
    customAnswer: string;
    activeQuestion: { id: string; multiSelect?: boolean | undefined } | null;
  } | null;
  activePendingResolvedAnswers: Record<string, unknown> | null;
  activePendingIsResponding: boolean;
  activePendingDraftAnswers: Record<string, PendingUserInputDraftAnswer>;
  activePendingQuestionIndex: number;
  respondingRequestIds: ApprovalRequestId[];

  // Plan
  showPlanFollowUpPrompt: boolean;
  activeProposedPlan: Thread["proposedPlans"][number] | null;
  activeTasksProgress: ComposerTasksProgress | null;
  activeTaskSteps: readonly ComposerTaskStep[] | null;

  // Mode
  runtimeMode: RuntimeMode;
  interactionMode: ProviderInteractionMode;

  // Provider / model
  lockedProvider: ProviderDriverKind | null;
  providerStatuses: ServerProvider[];
  activeProjectDefaultModelSelection: ModelSelection | null | undefined;
  activeThreadModelSelection: ModelSelection | null | undefined;

  // Context window
  activeThreadActivities: Thread["activities"] | undefined;

  // Ephemeral session side question
  quickQuestionAvailable: boolean;
  quickQuestionIdentity: string | null;

  // Misc
  resolvedTheme: "light" | "dark";
  settings: UnifiedSettings;
  keybindings: ResolvedKeybindingsConfig;
  terminalOpen: boolean;
  gitCwd: string | null;

  // Refs the parent needs kept in sync
  promptRef: React.RefObject<string>;
  composerImagesRef: React.RefObject<ComposerImageAttachment[]>;
  composerTerminalContextsRef: React.RefObject<TerminalContextDraft[]>;
  composerElementContextsRef: React.RefObject<ElementContextDraft[]>;
  composerRef: React.RefObject<ChatComposerHandle | null>;

  // Cross-account handoff. Resolved by the parent, which owns the thread
  // creation the offer leads to; the composer only shows it.
  threadHandoffOffer: ThreadHandoffOffer | null;
  isContinuingThreadOnAccount: boolean;

  // Callbacks
  onSend: (e?: { preventDefault: () => void }, intent?: ComposerSubmissionIntent) => void;
  onQueueFollowUp: () => void;
  onClearSessionInputQueue: () => Promise<void>;
  onRemoveOnlySessionInputQueueItem: (queue: "steering" | "follow-up") => Promise<void>;
  onSetSessionInputQueueMode: (
    queue: "steering" | "follow-up",
    mode: "all-at-once" | "one-at-a-time",
  ) => Promise<void>;
  onInterrupt: () => void;
  onReloadSessionResources: () => Promise<void>;
  onSetSessionAgentDepth: (maxDepth: number) => Promise<void>;
  onGetSessionCompaction: () => Promise<SessionCompactionUpdatedPayload | null>;
  onCompactSession: () => Promise<SessionCompactionUpdatedPayload | null>;
  onAbortSessionCompaction: () => Promise<SessionCompactionUpdatedPayload | null>;
  onSetSessionAutoCompaction: (enabled: boolean) => Promise<SessionCompactionUpdatedPayload | null>;
  onRefineSessionHarness: () => Promise<
    import("../../sessionHarnessRefinement").SessionHarnessRefinementOutcome | null
  >;
  onAskQuickQuestion: (
    requestId: ProviderSessionSideQuestionRequestId,
    question: string,
  ) => Promise<ProviderAskSessionSideQuestionResult>;
  onCancelQuickQuestion: (
    requestId: ProviderSessionSideQuestionRequestId,
  ) => Promise<ProviderCancelSessionSideQuestionResult>;
  onImplementPlanInNewThread: () => void;
  onContinueThreadOnAccount: () => void;
  onRespondToApproval: (
    requestId: ApprovalRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
  onSelectActivePendingUserInputOption: (questionId: string, optionLabel: string) => void;
  onAdvanceActivePendingUserInput: () => void;
  onPreviousActivePendingUserInputQuestion: () => void;
  onChangeActivePendingUserInputCustomAnswer: (
    questionId: string,
    value: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
  ) => void;

  onProviderModelSelect: (instanceId: ProviderInstanceId, model: string) => void;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  toggleInteractionMode: () => void;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  handleInteractionModeChange: (mode: ProviderInteractionMode) => void;

  focusComposer: () => void;
  scheduleComposerFocus: () => void;
  setThreadError: (threadId: ThreadId | null, error: string | null) => void;
  onExpandImage: (preview: ExpandedImagePreview) => void;
}

// --------------------------------------------------------------------------
// Component
// --------------------------------------------------------------------------

export const ChatComposer = memo(function ChatComposer(props: ChatComposerProps) {
  const {
    composerDraftTarget,
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    activeThreadId,
    activeThreadEnvironmentId: _activeThreadEnvironmentId,
    activeThread,
    isServerThread: _isServerThread,
    isLocalDraftThread: _isLocalDraftThread,
    forceExpandedOnMobile,
    projectSelectionRequired,
    phase,
    isConnecting,
    isSendBusy,
    sendDisabledReason,
    isPreparingWorktree,
    environmentUnavailable,
    activePendingApproval,
    pendingApprovals,
    pendingUserInputs,
    activePendingProgress,
    activePendingResolvedAnswers,
    activePendingIsResponding,
    activePendingDraftAnswers,
    activePendingQuestionIndex,
    respondingRequestIds,
    showPlanFollowUpPrompt,
    activeProposedPlan,
    activeTasksProgress,
    activeTaskSteps,
    runtimeMode,
    interactionMode,
    lockedProvider,
    providerStatuses,
    activeProjectDefaultModelSelection,
    activeThreadModelSelection,
    activeThreadActivities,
    quickQuestionAvailable,
    quickQuestionIdentity,
    resolvedTheme,
    settings,
    keybindings,
    terminalOpen,
    gitCwd,
    promptRef,
    composerRef,
    composerImagesRef,
    composerTerminalContextsRef,
    composerElementContextsRef,
    threadHandoffOffer,
    isContinuingThreadOnAccount,
    onSend,
    onQueueFollowUp,
    onClearSessionInputQueue,
    onRemoveOnlySessionInputQueueItem,
    onSetSessionInputQueueMode,
    onInterrupt,
    onReloadSessionResources,
    onSetSessionAgentDepth,
    onGetSessionCompaction,
    onCompactSession,
    onAbortSessionCompaction,
    onSetSessionAutoCompaction,
    onRefineSessionHarness,
    onAskQuickQuestion,
    onCancelQuickQuestion,
    onImplementPlanInNewThread,
    onContinueThreadOnAccount,
    onRespondToApproval,
    onSelectActivePendingUserInputOption,
    onAdvanceActivePendingUserInput,
    onPreviousActivePendingUserInputQuestion,
    onChangeActivePendingUserInputCustomAnswer,
    onProviderModelSelect,
    getModelDisabledReason,
    toggleInteractionMode,
    handleRuntimeModeChange,
    handleInteractionModeChange,
    focusComposer,
    scheduleComposerFocus,
    setThreadError,
    onExpandImage,
  } = props;
  const isSendDisabled = sendDisabledReason !== null;
  const [isQuickQuestionOpen, setIsQuickQuestionOpen] = useState(false);

  // ------------------------------------------------------------------
  // Store subscriptions (prompt / images / terminal contexts)
  // ------------------------------------------------------------------
  const composerDraft = useComposerThreadDraft(composerDraftTarget);
  const prompt = composerDraft.prompt;
  const composerImages = composerDraft.images;
  const composerTerminalContexts = composerDraft.terminalContexts;
  const composerElementContexts = composerDraft.elementContexts;
  const composerPreviewAnnotations = composerDraft.previewAnnotations;
  const composerReviewComments = composerDraft.reviewComments;
  const nonPersistedComposerImageIds = composerDraft.nonPersistedImageIds;

  const setComposerDraftPrompt = useComposerDraftStore((store) => store.setPrompt);
  const addComposerDraftImage = useComposerDraftStore((store) => store.addImage);
  const addComposerDraftImages = useComposerDraftStore((store) => store.addImages);
  const removeComposerDraftImage = useComposerDraftStore((store) => store.removeImage);
  const insertComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.insertTerminalContext,
  );
  const removeComposerDraftTerminalContext = useComposerDraftStore(
    (store) => store.removeTerminalContext,
  );
  const setComposerDraftTerminalContexts = useComposerDraftStore(
    (store) => store.setTerminalContexts,
  );
  const removeComposerDraftElementContext = useComposerDraftStore(
    (store) => store.removeElementContext,
  );
  const removeComposerDraftPreviewAnnotation = useComposerDraftStore(
    (store) => store.removePreviewAnnotation,
  );
  const removeComposerDraftReviewComment = useComposerDraftStore(
    (store) => store.removeReviewComment,
  );
  const clearComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.clearPersistedAttachments,
  );
  const clearComposerDraftPromptAndImages = useComposerDraftStore(
    (store) => store.clearComposerPromptAndImages,
  );
  const syncComposerDraftPersistedAttachments = useComposerDraftStore(
    (store) => store.syncPersistedAttachments,
  );
  const getComposerDraft = useComposerDraftStore((store) => store.getComposerDraft);

  // ------------------------------------------------------------------
  // Model state
  // ------------------------------------------------------------------
  // Instance-aware projection of the wire provider list. One entry per
  // configured instance (default built-in + any custom `providerInstances.*`),
  // sorted default-first per driver kind for a stable picker order.
  const providerInstanceEntries = useMemo<ReadonlyArray<ProviderInstanceEntry>>(
    () =>
      sortProviderInstanceEntries(
        applyProviderInstanceSettings(deriveProviderInstanceEntries(providerStatuses), settings),
      ),
    [providerStatuses, settings],
  );
  const selectedProviderByThreadId = composerDraft.activeProvider ?? null;
  const threadProvider =
    activeThread?.session?.providerInstanceId ??
    activeThreadModelSelection?.instanceId ??
    activeProjectDefaultModelSelection?.instanceId ??
    null;
  const explicitSelectedInstanceId = selectedProviderByThreadId ?? threadProvider;

  const unlockedSelectedProvider =
    resolveProviderDriverKindForInstanceSelection(
      providerInstanceEntries,
      providerStatuses,
      explicitSelectedInstanceId,
    ) ??
    providerInstanceEntries[0]?.driverKind ??
    ProviderDriverKind.make("unconfigured");
  const requestedDriverKind: ProviderDriverKind = lockedProvider ?? unlockedSelectedProvider;
  const lockedContinuationGroupKey = useMemo((): string | null => {
    if (!lockedProvider || !activeThread) return null;
    const lockedInstanceId =
      activeThread.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId;
    if (!lockedInstanceId) return null;
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === lockedInstanceId)
        ?.continuationGroupKey ?? null
    );
  }, [
    activeThread,
    activeThreadModelSelection?.instanceId,
    lockedProvider,
    providerInstanceEntries,
  ]);

  // Resolve which configured instance the composer is currently targeting.
  // Priority:
  //   1. The composer draft's `activeProvider` — the user's unsaved pick
  //      from the model picker (must win, otherwise the UI appears to
  //      ignore picker selections).
  //   2. Thread's persisted instance id (server-side saved selection).
  //   3. Project default's instance id.
  //   4. First enabled entry matching the current driver kind.
  //   5. First enabled entry overall / default instance for the kind.
  //
  // Candidates 1 and 2 are pinned: an explicit picker choice and a thread's
  // live session binding are honored even when that account is spent, so an
  // existing thread never migrates off the account it started on. Everything
  // below them has not bound to a session yet and is free to route around a
  // drained account, in configured priority order.
  //
  // `Date.now()` is read without a ticking dependency on purpose. Drain
  // windows run for hours, the memo already recomputes on every provider
  // snapshot and thread change, and a per-minute recompute of a hot component
  // buys nothing at that timescale.
  const selectedInstanceId = useMemo<ProviderInstanceId>(() => {
    const nowMs = Date.now();
    const candidates: Array<{
      readonly instanceId: string | null | undefined;
      readonly pinned: boolean;
    }> = [
      { instanceId: composerDraft.activeProvider, pinned: true },
      { instanceId: activeThread?.session?.providerInstanceId, pinned: true },
      { instanceId: activeThreadModelSelection?.instanceId, pinned: false },
      { instanceId: activeProjectDefaultModelSelection?.instanceId, pinned: false },
    ];
    for (const candidate of candidates) {
      if (!candidate.instanceId) continue;
      const match = providerInstanceEntries.find(
        (entry) => entry.instanceId === candidate.instanceId && entry.enabled && entry.isAvailable,
      );
      if (match) {
        // When locked to a specific driver kind, ignore persisted instance
        // ids from a different kind or continuation group.
        if (lockedProvider && match.driverKind !== lockedProvider) continue;
        if (
          lockedContinuationGroupKey &&
          match.continuationGroupKey !== lockedContinuationGroupKey
        ) {
          continue;
        }
        // Drained and unpinned: defer to the ordered fallback below, which
        // prefers a healthy instance and lands back here only when every
        // instance is drained.
        if (!candidate.pinned && isProviderInstanceDrained(match, nowMs)) continue;
        return match.instanceId;
      }
    }
    const compatibleEntries = providerInstanceEntries.filter(
      (entry) =>
        (!lockedProvider || entry.driverKind === lockedProvider) &&
        (!lockedContinuationGroupKey || entry.continuationGroupKey === lockedContinuationGroupKey),
    );
    const requestedDriverEntries = compatibleEntries.filter(
      (entry) => entry.driverKind === requestedDriverKind,
    );
    return (
      resolveSelectableProviderInstanceEntry(requestedDriverEntries, undefined, nowMs)
        ?.instanceId ??
      resolveSelectableProviderInstanceEntry(compatibleEntries, undefined, nowMs)?.instanceId ??
      NO_PROVIDER_MODEL_SELECTION.instanceId
    );
  }, [
    activeProjectDefaultModelSelection?.instanceId,
    activeThread?.session?.providerInstanceId,
    activeThreadModelSelection?.instanceId,
    composerDraft.activeProvider,
    lockedContinuationGroupKey,
    lockedProvider,
    providerInstanceEntries,
    requestedDriverKind,
  ]);

  // Resolve the active instance's snapshot by `instanceId` so a custom
  // instance gets its own slash commands, skills, and model list — not
  // the first snapshot for the same driver kind.
  const selectedProviderEntry = useMemo(
    () => providerInstanceEntries.find((entry) => entry.instanceId === selectedInstanceId),
    [providerInstanceEntries, selectedInstanceId],
  );
  const noProviderAvailable = selectedProviderEntry === undefined;
  // The driver kind follows the instance that will actually run the turn,
  // which can differ from the persisted selection when that selection is
  // disabled.
  const selectedProvider: ProviderDriverKind =
    selectedProviderEntry?.driverKind ?? requestedDriverKind;

  const { modelOptions: composerModelOptions, selectedModel } = useEffectiveComposerModelState({
    threadRef: composerDraftTarget,
    providers: providerStatuses,
    selectedProvider,
    selectedInstanceId,
    threadModelSelection: activeThreadModelSelection,
    projectModelSelection: activeProjectDefaultModelSelection,
    settings,
  });
  const selectedProviderStatus = useMemo(
    () => selectedProviderEntry?.snapshot ?? null,
    [selectedProviderEntry],
  );
  const activeSessionProviderStatus = useMemo(() => {
    const instanceId = activeThread?.session?.providerInstanceId;
    if (instanceId === undefined) return null;
    return (
      providerInstanceEntries.find((entry) => entry.instanceId === instanceId)?.snapshot ?? null
    );
  }, [activeThread?.session?.providerInstanceId, providerInstanceEntries]);
  const sessionGoal = useMemo(
    () =>
      deriveActiveSessionGoal({
        activities: activeThreadActivities ?? [],
        provider: activeSessionProviderStatus,
        providerInstanceId: activeThread?.session?.providerInstanceId,
        runtimeMode: activeThread?.session?.runtimeMode,
        sessionStatus: activeThread?.session?.status,
      }),
    [activeSessionProviderStatus, activeThread?.session, activeThreadActivities],
  );
  const showSessionResourceReload =
    activeThreadId !== null &&
    activeThread?.session?.runtimeMode === "full-access" &&
    supportsSessionResourceReload(activeSessionProviderStatus);
  const sessionResourceReloadDisabled =
    activeThread?.session?.status !== "ready" ||
    phase === "running" ||
    isConnecting ||
    environmentUnavailable !== null;
  const [isReloadingSessionResources, setIsReloadingSessionResources] = useState(false);
  const reloadSessionResources = useCallback(async () => {
    if (sessionResourceReloadDisabled || isReloadingSessionResources) return;
    setIsReloadingSessionResources(true);
    try {
      await onReloadSessionResources();
    } finally {
      setIsReloadingSessionResources(false);
    }
  }, [isReloadingSessionResources, onReloadSessionResources, sessionResourceReloadDisabled]);
  const activeSessionInstanceId = activeThread?.session?.providerInstanceId;
  const sessionInputQueue = useMemo(
    () =>
      activeSessionInstanceId === undefined
        ? null
        : deriveLatestSessionInputQueue(activeThreadActivities ?? [], activeSessionInstanceId),
    [activeSessionInstanceId, activeThreadActivities],
  );
  const sessionInputCount = sessionInputQueueCount(sessionInputQueue);
  const sessionInputQueueScopeKey = `${environmentId}:${activeThreadId ?? "draft"}:${activeSessionInstanceId ?? "none"}`;
  const showSessionInputQueue =
    sessionInputQueue !== null &&
    sessionInputCount > 0 &&
    supportsSessionInputQueue(activeSessionProviderStatus);
  const showSessionInputQueueModes =
    hasSessionInputQueueModes(sessionInputQueue) &&
    supportsSessionInputQueueSetModes(activeSessionProviderStatus);
  const canQueueSessionFollowUp =
    activeThread?.session?.status === "running" &&
    phase === "running" &&
    supportsSessionInputQueueFollowUp(activeSessionProviderStatus);
  const canClearSessionInputQueue =
    sessionInputCount > 0 &&
    supportsSessionInputQueueClear(activeSessionProviderStatus) &&
    activeThread?.session?.status === "running" &&
    activeThread.session.activeTurnId != null &&
    !isConnecting &&
    environmentUnavailable === null;
  const [clearingSessionInputQueueScope, setClearingSessionInputQueueScope] = useState<
    string | null
  >(null);
  const isClearingSessionInputQueue = clearingSessionInputQueueScope === sessionInputQueueScopeKey;
  const clearSessionInputQueue = useCallback(async () => {
    if (!canClearSessionInputQueue || isClearingSessionInputQueue) return;
    if (!globalThis.confirm("Clear all pending inputs for this provider session?")) return;
    const scopeKey = sessionInputQueueScopeKey;
    setClearingSessionInputQueueScope(scopeKey);
    try {
      await onClearSessionInputQueue();
    } finally {
      setClearingSessionInputQueueScope((current) => (current === scopeKey ? null : current));
    }
  }, [
    canClearSessionInputQueue,
    isClearingSessionInputQueue,
    onClearSessionInputQueue,
    sessionInputQueueScopeKey,
  ]);
  const canRemoveOnlySessionInputQueueItem =
    supportsSessionInputQueueRemove(activeSessionProviderStatus) &&
    activeThread?.session?.status === "running" &&
    activeThread.session.activeTurnId != null &&
    !isConnecting &&
    environmentUnavailable === null;
  const [removingSessionInputQueueItem, setRemovingSessionInputQueueItem] = useState<{
    readonly scopeKey: string;
    readonly queue: "steering" | "follow-up";
  } | null>(null);
  const isRemovingSessionInputQueueItem =
    removingSessionInputQueueItem?.scopeKey === sessionInputQueueScopeKey;
  const removeOnlySessionInputQueueItem = useCallback(
    async (queue: "steering" | "follow-up") => {
      const count =
        queue === "steering"
          ? (sessionInputQueue?.steeringCount ?? 0)
          : (sessionInputQueue?.followUpCount ?? 0);
      if (!canRemoveOnlySessionInputQueueItem || isRemovingSessionInputQueueItem || count !== 1) {
        return;
      }
      const label = queue === "steering" ? "steering" : "follow-up";
      if (!globalThis.confirm(`Remove the pending ${label} input?`)) return;
      const mutation = { scopeKey: sessionInputQueueScopeKey, queue } as const;
      setRemovingSessionInputQueueItem(mutation);
      try {
        await onRemoveOnlySessionInputQueueItem(queue);
      } finally {
        setRemovingSessionInputQueueItem((current) => (current === mutation ? null : current));
      }
    },
    [
      canRemoveOnlySessionInputQueueItem,
      isRemovingSessionInputQueueItem,
      onRemoveOnlySessionInputQueueItem,
      sessionInputQueue?.followUpCount,
      sessionInputQueue?.steeringCount,
      sessionInputQueueScopeKey,
    ],
  );
  const [settingSessionInputQueueMode, setSettingSessionInputQueueMode] = useState<{
    readonly scopeKey: string;
    readonly queue: "steering" | "follow-up";
  } | null>(null);
  const isSettingSessionInputQueueMode =
    settingSessionInputQueueMode?.scopeKey === sessionInputQueueScopeKey;
  const canSetSessionInputQueueModes =
    showSessionInputQueueModes &&
    (activeThread?.session?.status === "ready" || activeThread?.session?.status === "running") &&
    !isConnecting &&
    environmentUnavailable === null &&
    !isSettingSessionInputQueueMode;
  const setSessionInputQueueMode = useCallback(
    async (queue: "steering" | "follow-up", value: string | null) => {
      if (!canSetSessionInputQueueModes || (value !== "all-at-once" && value !== "one-at-a-time")) {
        return;
      }
      const currentMode =
        queue === "steering" ? sessionInputQueue?.steeringMode : sessionInputQueue?.followUpMode;
      if (value === currentMode) return;
      const mutation = { scopeKey: sessionInputQueueScopeKey, queue } as const;
      setSettingSessionInputQueueMode(mutation);
      try {
        await onSetSessionInputQueueMode(queue, value);
      } finally {
        setSettingSessionInputQueueMode((current) => (current === mutation ? null : current));
      }
    },
    [
      canSetSessionInputQueueModes,
      onSetSessionInputQueueMode,
      sessionInputQueue?.followUpMode,
      sessionInputQueue?.steeringMode,
      sessionInputQueueScopeKey,
    ],
  );
  const sessionAgentDepth = useMemo(
    () =>
      activeSessionInstanceId === undefined
        ? null
        : deriveLatestSessionAgentDepth(activeThreadActivities ?? [], activeSessionInstanceId),
    [activeSessionInstanceId, activeThreadActivities],
  );
  const showSessionAgentDepth =
    activeThreadId !== null &&
    sessionAgentDepth !== null &&
    supportsSessionAgentDepth(activeSessionProviderStatus);
  const [isSettingSessionAgentDepth, setIsSettingSessionAgentDepth] = useState(false);
  const sessionAgentDepthAccessibleLabel =
    sessionAgentDepth === null
      ? "Agent spawn depth"
      : sessionAgentDepth.writable && sessionAgentDepth.settable
        ? `Agent spawn depth ${sessionAgentDepth.maxDepth}`
        : !sessionAgentDepth.writable
          ? `Agent spawn depth ${sessionAgentDepth.maxDepth}, fixed by session policy`
          : `Agent spawn depth ${sessionAgentDepth.maxDepth}, unavailable until the session is idle`;
  const sessionAgentDepthDisabled =
    !canSetSessionAgentDepth(activeSessionProviderStatus, sessionAgentDepth) ||
    activeThread?.session?.status !== "ready" ||
    phase === "running" ||
    isSendBusy ||
    isConnecting ||
    environmentUnavailable !== null ||
    isReloadingSessionResources ||
    isSettingSessionAgentDepth;
  const setSessionAgentDepth = useCallback(
    async (value: string | null) => {
      if (value === null || sessionAgentDepthDisabled) return;
      const maxDepth = Number(value);
      if (!Number.isInteger(maxDepth)) return;
      setIsSettingSessionAgentDepth(true);
      try {
        await onSetSessionAgentDepth(maxDepth);
      } finally {
        setIsSettingSessionAgentDepth(false);
      }
    },
    [onSetSessionAgentDepth, sessionAgentDepthDisabled],
  );

  const sessionCompactionScopeKey =
    activeThreadId && activeSessionInstanceId
      ? makeSessionCompactionScopeKey({
          environmentId,
          threadId: activeThreadId,
          providerInstanceId: activeSessionInstanceId,
        })
      : null;
  const activitySessionCompaction = useMemo(
    () =>
      activeSessionInstanceId === undefined
        ? null
        : deriveLatestSessionCompaction(activeThreadActivities ?? [], activeSessionInstanceId),
    [activeSessionInstanceId, activeThreadActivities],
  );
  const [authoritativeSessionCompaction, setAuthoritativeSessionCompaction] = useState<{
    readonly scopeKey: string;
    readonly snapshot: SessionCompactionUpdatedPayload;
  } | null>(null);
  const [sessionCompactionMutation, setSessionCompactionMutation] = useState<{
    readonly scopeKey: string;
    readonly id: number;
    readonly action: "compact" | "abort" | "auto";
  } | null>(null);
  const sessionCompactionScopeRef = useRef(sessionCompactionScopeKey);
  sessionCompactionScopeRef.current = sessionCompactionScopeKey;
  const sessionCompactionMutationRef = useRef(sessionCompactionMutation);
  sessionCompactionMutationRef.current = sessionCompactionMutation;
  const sessionCompactionRequestIdRef = useRef(0);
  const lastCompactionActivityRef = useRef<{ scopeKey: string; updatedAt: string } | null>(null);
  const sessionCompaction =
    sessionCompactionScopeKey &&
    authoritativeSessionCompaction?.scopeKey === sessionCompactionScopeKey
      ? authoritativeSessionCompaction.snapshot
      : activitySessionCompaction;
  const showSessionCompaction =
    sessionCompactionScopeKey !== null && supportsSessionCompaction(activeSessionProviderStatus);

  useEffect(() => {
    const scopeKey = sessionCompactionScopeKey;
    const requestId = ++sessionCompactionRequestIdRef.current;
    sessionCompactionMutationRef.current = null;
    setSessionCompactionMutation(null);
    if (
      !scopeKey ||
      !supportsSessionCompaction(activeSessionProviderStatus) ||
      (activeThread?.session?.status !== "ready" && activeThread?.session?.status !== "running")
    ) {
      setAuthoritativeSessionCompaction(null);
      return;
    }
    if (activitySessionCompaction) {
      lastCompactionActivityRef.current = {
        scopeKey,
        updatedAt: activitySessionCompaction.updatedAt,
      };
      setAuthoritativeSessionCompaction({ scopeKey, snapshot: activitySessionCompaction });
    } else {
      lastCompactionActivityRef.current = null;
      setAuthoritativeSessionCompaction(null);
    }
    if (activitySessionCompaction?.available === false) return;
    void onGetSessionCompaction().then((snapshot) => {
      if (
        snapshot &&
        isCurrentSessionCompactionRequest(
          sessionCompactionScopeRef.current,
          sessionCompactionRequestIdRef.current,
          { scopeKey, id: requestId },
        )
      ) {
        setAuthoritativeSessionCompaction({ scopeKey, snapshot });
      }
    });
  }, [
    activeSessionProviderStatus,
    activeThread?.session?.status,
    onGetSessionCompaction,
    sessionCompactionScopeKey,
  ]);

  useEffect(() => {
    const scopeKey = sessionCompactionScopeKey;
    const snapshot = activitySessionCompaction;
    if (!scopeKey || !snapshot) return;
    const last = lastCompactionActivityRef.current;
    if (last?.scopeKey === scopeKey && last.updatedAt === snapshot.updatedAt) return;
    lastCompactionActivityRef.current = { scopeKey, updatedAt: snapshot.updatedAt };
    sessionCompactionRequestIdRef.current += 1;
    sessionCompactionMutationRef.current = null;
    setSessionCompactionMutation(null);
    setAuthoritativeSessionCompaction({ scopeKey, snapshot });
  }, [activitySessionCompaction, sessionCompactionScopeKey]);

  const runSessionCompactionMutation = useCallback(
    async (
      action: "compact" | "abort" | "auto",
      mutate: () => Promise<SessionCompactionUpdatedPayload | null>,
    ) => {
      const scopeKey = sessionCompactionScopeRef.current;
      if (!scopeKey || sessionCompactionMutationRef.current?.scopeKey === scopeKey) return;
      const id = ++sessionCompactionRequestIdRef.current;
      const mutation = { scopeKey, id, action } as const;
      sessionCompactionMutationRef.current = mutation;
      setSessionCompactionMutation(mutation);
      const snapshot = await mutate();
      if (
        !isCurrentSessionCompactionRequest(
          sessionCompactionScopeRef.current,
          sessionCompactionRequestIdRef.current,
          mutation,
        )
      ) {
        return;
      }
      sessionCompactionMutationRef.current = null;
      setSessionCompactionMutation((current) => (current?.id === id ? null : current));
      if (snapshot) {
        setAuthoritativeSessionCompaction({ scopeKey, snapshot });
      }
    },
    [],
  );
  const contextCompactionConnected =
    (activeThread?.session?.status === "ready" || activeThread?.session?.status === "running") &&
    !isConnecting &&
    environmentUnavailable === null;
  const contextCompactionControl =
    showSessionCompaction && sessionCompaction?.available
      ? {
          snapshot: sessionCompaction,
          pendingAction:
            sessionCompactionMutation?.scopeKey === sessionCompactionScopeKey
              ? sessionCompactionMutation.action
              : null,
          canCompact:
            contextCompactionConnected &&
            sessionCompactionMutation === null &&
            canStartSessionCompaction(activeSessionProviderStatus, sessionCompaction),
          canAbort:
            contextCompactionConnected &&
            sessionCompactionMutation === null &&
            canAbortSessionCompaction(activeSessionProviderStatus, sessionCompaction),
          canSetAuto:
            contextCompactionConnected &&
            sessionCompactionMutation === null &&
            canConfigureSessionAutoCompaction(activeSessionProviderStatus, sessionCompaction),
          onCompact: () => {
            if (
              !contextCompactionConnected ||
              !canStartSessionCompaction(activeSessionProviderStatus, sessionCompaction) ||
              !globalThis.confirm("Compact the current provider session's context now?")
            ) {
              return;
            }
            void runSessionCompactionMutation("compact", onCompactSession);
          },
          onAbort: () => {
            if (
              !contextCompactionConnected ||
              !canAbortSessionCompaction(activeSessionProviderStatus, sessionCompaction)
            ) {
              return;
            }
            void runSessionCompactionMutation("abort", onAbortSessionCompaction);
          },
          onSetAuto: (enabled: boolean) => {
            if (
              !contextCompactionConnected ||
              !canConfigureSessionAutoCompaction(activeSessionProviderStatus, sessionCompaction)
            ) {
              return;
            }
            void runSessionCompactionMutation("auto", () => onSetSessionAutoCompaction(enabled));
          },
        }
      : null;

  const sessionHarnessRefinementScopeKey = buildSessionHarnessRefinementScopeKey({
    sessionScopeKey: sessionCompactionScopeKey,
    sessionStartedAt: activeThread?.session?.startedAt,
  });
  const sessionHarnessRefinementScopeRef = useRef(sessionHarnessRefinementScopeKey);
  sessionHarnessRefinementScopeRef.current = sessionHarnessRefinementScopeKey;
  const sessionHarnessRefinementLifecycle =
    activeThread?.session?.harnessRefinementStatus ?? "available";
  const sessionHarnessRefinementLifecycleRef = useRef(sessionHarnessRefinementLifecycle);
  sessionHarnessRefinementLifecycleRef.current = sessionHarnessRefinementLifecycle;
  const sessionHarnessRefinementRequestIdRef = useRef(0);
  const pendingSessionHarnessRefinementRef = useRef<{
    readonly scopeKey: string;
    readonly id: number;
  } | null>(null);
  const [pendingSessionHarnessRefinement, setPendingSessionHarnessRefinement] = useState<{
    readonly scopeKey: string;
    readonly id: number;
  } | null>(null);
  const sessionHarnessRefinementUnknownScopeRef = useRef<string | null>(null);
  const [sessionHarnessRefinementUnknownScope, setSessionHarnessRefinementUnknownScope] = useState<
    string | null
  >(null);
  const sessionHarnessRefinementAvailable = canRefineSessionHarness({
    provider: activeSessionProviderStatus,
    hasActiveThread: activeThreadId !== null,
    runtimeMode: activeThread?.session?.runtimeMode ?? runtimeMode,
    sessionStatus: activeThread?.session?.status,
    isConnecting,
    environmentAvailable: environmentUnavailable === null,
    restored: activeThread?.session?.restored === true,
    sessionStartedAt: activeThread?.session?.startedAt,
  });
  const harnessRefinementControlState = sessionHarnessRefinementControlState({
    lifecycle: sessionHarnessRefinementLifecycle,
    locallyPending: pendingSessionHarnessRefinement?.scopeKey === sessionHarnessRefinementScopeKey,
    locallyOutcomeUnknown:
      sessionHarnessRefinementUnknownScope === sessionHarnessRefinementScopeKey,
  });

  useEffect(() => {
    sessionHarnessRefinementRequestIdRef.current += 1;
    pendingSessionHarnessRefinementRef.current = null;
    sessionHarnessRefinementUnknownScopeRef.current = null;
    setPendingSessionHarnessRefinement(null);
    setSessionHarnessRefinementUnknownScope(null);
  }, [sessionHarnessRefinementScopeKey]);

  useEffect(() => {
    if (sessionHarnessRefinementLifecycle === "available") {
      sessionHarnessRefinementUnknownScopeRef.current = null;
      setSessionHarnessRefinementUnknownScope(null);
    }
  }, [sessionHarnessRefinementLifecycle]);

  const refineSessionHarness = useCallback(async () => {
    const scopeKey = sessionHarnessRefinementScopeRef.current;
    if (
      !scopeKey ||
      !sessionHarnessRefinementAvailable ||
      pendingSessionHarnessRefinementRef.current?.scopeKey === scopeKey ||
      sessionHarnessRefinementUnknownScopeRef.current === scopeKey ||
      sessionHarnessRefinementLifecycleRef.current !== "available" ||
      !globalThis.confirm(SESSION_HARNESS_REFINEMENT_CONFIRMATION)
    ) {
      return;
    }
    const request = {
      scopeKey,
      id: ++sessionHarnessRefinementRequestIdRef.current,
    } as const;
    pendingSessionHarnessRefinementRef.current = request;
    setPendingSessionHarnessRefinement(request);
    try {
      const outcome = await onRefineSessionHarness();
      if (
        outcome &&
        isCurrentSessionHarnessRefinementRequest(
          sessionHarnessRefinementScopeRef.current,
          sessionHarnessRefinementRequestIdRef.current,
          request,
        ) &&
        pendingSessionHarnessRefinementRef.current?.id === request.id
      ) {
        if (outcome === "unknown") {
          sessionHarnessRefinementUnknownScopeRef.current = scopeKey;
          setSessionHarnessRefinementUnknownScope(scopeKey);
        }
        toastManager.add(harnessRefinementToast(outcome));
      }
    } finally {
      if (pendingSessionHarnessRefinementRef.current?.id === request.id) {
        pendingSessionHarnessRefinementRef.current = null;
      }
      setPendingSessionHarnessRefinement((current) =>
        current?.id === request.id ? null : current,
      );
    }
  }, [onRefineSessionHarness, sessionHarnessRefinementAvailable]);

  const sessionHarnessRefinementControl = sessionHarnessRefinementAvailable
    ? {
        pending: harnessRefinementControlState.pending,
        outcomeUnknown: harnessRefinementControlState.outcomeUnknown,
        canRefine: harnessRefinementControlState.canRefine,
        onRefine: () => void refineSessionHarness(),
      }
    : null;

  const activeSessionResources = useMemo(() => {
    const instanceId = activeThread?.session?.providerInstanceId;
    return instanceId === undefined
      ? null
      : deriveCurrentSessionResources(
          activeThreadActivities ?? [],
          instanceId,
          activeThread?.session?.startedAt,
        );
  }, [activeThread?.session, activeThreadActivities]);
  const sessionResourceInventory = useMemo(
    () => presentSessionResourceInventory(activeSessionResources, activeSessionProviderStatus),
    [activeSessionProviderStatus, activeSessionResources],
  );
  const [isSessionResourcesOpen, setIsSessionResourcesOpen] = useState(false);
  const sessionResourcesIdentity = sessionResourceViewIdentity({
    environmentId,
    threadId: activeThreadId ?? "none",
    providerInstanceId: activeThread?.session?.providerInstanceId,
    sessionStartedAt: activeThread?.session?.startedAt,
  });
  useEffect(() => {
    setIsSessionResourcesOpen(false);
  }, [sessionResourcesIdentity]);
  const providerSlashCommands = useMemo(
    () =>
      resolveSessionSlashCommands(
        selectedProviderStatus?.featureCapabilities?.resources?.operations.includes("commands") &&
          activeSessionResources?.providerInstanceId === selectedInstanceId
          ? activeSessionResources
          : null,
        selectedProviderStatus?.slashCommands ?? [],
      ),
    [
      selectedProviderStatus?.featureCapabilities?.resources?.operations,
      selectedProviderStatus?.slashCommands,
      activeSessionResources,
      selectedInstanceId,
    ],
  );
  const selectedProviderModels = useMemo<ReadonlyArray<ServerProvider["models"][number]>>(
    () => selectedProviderEntry?.models ?? [],
    [selectedProviderEntry],
  );

  const composerPromptInjectionState = useMemo(
    () => getComposerPromptInjectionState(prompt),
    [prompt],
  );
  const composerProviderState = useMemo(
    () =>
      getComposerProviderState({
        provider: selectedProvider,
        model: selectedModel,
        models: selectedProviderModels,
        promptInjectionState: composerPromptInjectionState,
        modelOptions: composerModelOptions?.[selectedInstanceId],
        planModeEnabled: settings.planModeEnabled,
      }),
    [
      composerModelOptions,
      composerPromptInjectionState,
      selectedInstanceId,
      selectedModel,
      selectedProvider,
      selectedProviderModels,
      settings.planModeEnabled,
    ],
  );

  const selectedPromptEffort = composerProviderState.promptEffort;
  const selectedModelOptionsForDispatch = composerProviderState.modelOptionsForDispatch;
  // Plan mode is legacy and off by default. Gating here covers both entry
  // points, because the /plan and /default slash commands are derived from
  // this same flag. ChatView forces the effective mode back to "default" while
  // it is off, so hiding the toggle cannot strand a thread in plan mode.
  const planModeUiEnabled = settings.planModeEnabled;
  const composerProviderControls = useMemo(
    () => ({
      showInteractionModeToggle:
        planModeUiEnabled &&
        (selectedProviderEntry?.snapshot.showInteractionModeToggle ??
          getProviderInteractionModeToggle(providerStatuses, selectedProvider)),
      supportedRuntimeModes: getServerProviderSupportedRuntimeModes(
        selectedProviderEntry?.snapshot,
      ),
    }),
    [planModeUiEnabled, providerStatuses, selectedProvider, selectedProviderEntry],
  );
  const resolvedRuntimeMode = resolveServerProviderRuntimeMode(
    selectedProviderEntry?.snapshot,
    runtimeMode,
  );
  useEffect(() => {
    if (resolvedRuntimeMode !== runtimeMode) {
      handleRuntimeModeChange(resolvedRuntimeMode);
    }
  }, [handleRuntimeModeChange, resolvedRuntimeMode, runtimeMode]);
  const selectedModelSelection = useMemo<ModelSelection>(
    () => createModelSelection(selectedInstanceId, selectedModel, selectedModelOptionsForDispatch),
    [selectedInstanceId, selectedModel, selectedModelOptionsForDispatch],
  );
  const selectedModelForPicker = selectedModel;
  // Instance-keyed option list so the picker can show each configured
  // instance (built-in + custom) as a first-class sidebar entry. The
  // options are server-reported models plus that exact instance's
  // configured custom models; selected slugs are not injected into lists.
  const modelOptionsByInstance = useMemo<
    ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>
  >(() => {
    const out = new Map<ProviderInstanceId, ReadonlyArray<AppModelOption>>();
    for (const entry of providerInstanceEntries) {
      out.set(entry.instanceId, getAppModelOptionsForInstance(settings, entry));
    }
    return out;
  }, [providerInstanceEntries, settings]);
  const selectedModelForPickerWithCustomFallback = useMemo(() => {
    const currentOptions = modelOptionsByInstance.get(selectedInstanceId) ?? [];
    return currentOptions.some((option) => option.slug === selectedModelForPicker)
      ? selectedModelForPicker
      : (normalizeModelSlug(selectedModelForPicker, selectedProvider) ?? selectedModelForPicker);
  }, [modelOptionsByInstance, selectedInstanceId, selectedModelForPicker, selectedProvider]);

  // ------------------------------------------------------------------
  // Context window
  // ------------------------------------------------------------------
  const activeContextWindow = useMemo(
    () => deriveLatestContextWindowSnapshot(activeThreadActivities ?? []),
    [activeThreadActivities],
  );
  // The running session's instance is the source of truth for the popover's usage
  // limits, so the accounts listed can never describe a different provider. The
  // meter's own label names the selected model rather than the provider.
  const activeThreadProviderInstanceId =
    activeThread?.session?.providerInstanceId ?? activeThreadModelSelection?.instanceId;
  const activeThreadModelDisplayName = useMemo(
    () => resolveContextWindowModelDisplayName(activeThreadModelSelection, modelOptionsByInstance),
    [activeThreadModelSelection, modelOptionsByInstance],
  );
  // Every configured account for the active thread's driver, not just the one
  // the thread is bound to: Pylon routes threads across several accounts of the
  // same provider, so remaining capacity is a question about all of them.
  const activeProviderUsageAccounts = useMemo((): readonly ProviderUsageAccount[] => {
    if (!settings.showProviderUsageInContextPopover) return [];
    const activeProvider = providerStatuses.find(
      (provider) => provider.instanceId === activeThreadProviderInstanceId,
    );
    if (!activeProvider) return [];
    return providerStatuses
      .filter((provider) => provider.driver === activeProvider.driver && provider.usageLimits)
      .map((provider) => ({
        instanceId: provider.instanceId,
        displayName: provider.displayName ?? formatProviderDisplayName(provider.instanceId),
        accentColor: provider.accentColor,
        // Narrowed by the `provider.usageLimits` filter above.
        usageLimits: provider.usageLimits as NonNullable<typeof provider.usageLimits>,
        isActive: provider.instanceId === activeThreadProviderInstanceId,
      }));
  }, [
    settings.showProviderUsageInContextPopover,
    providerStatuses,
    activeThreadProviderInstanceId,
  ]);

  // ------------------------------------------------------------------
  // Composer-local state
  // ------------------------------------------------------------------
  const [composerCursor, setComposerCursor] = useState(() =>
    collapseExpandedComposerCursor(prompt, prompt.length),
  );
  const [composerTrigger, setComposerTrigger] = useState<ComposerTrigger | null>(() =>
    detectComposerTrigger(prompt, prompt.length),
  );
  const [composerHighlightedItemId, setComposerHighlightedItemId] = useState<string | null>(null);
  const [composerHighlightedSearchKey, setComposerHighlightedSearchKey] = useState<string | null>(
    null,
  );
  const [isDragOverComposer, setIsDragOverComposer] = useState(false);
  const [isComposerFooterCompact, setIsComposerFooterCompact] = useState(false);
  const [isComposerPrimaryActionsCompact, setIsComposerPrimaryActionsCompact] = useState(false);
  const [isComposerModelPickerOpen, setIsComposerModelPickerOpen] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const [composerSubmissionError, setComposerSubmissionError] = useState<string | null>(null);
  const [providerInputSubmissionError, setProviderInputSubmissionError] = useState<string | null>(
    null,
  );
  const [composerMenuAnchor, setComposerMenuAnchor] = useState<HTMLDivElement | null>(null);
  const [isStashMenuOpen, setIsStashMenuOpen] = useState(false);
  const [isTasksDrawerOpen, setIsTasksDrawerOpen] = useState(false);
  const [dismissedTasksTurnId, setDismissedTasksTurnId] = useState<TurnId | null>(null);
  const [stashPulse, setStashPulse] = useState<{ key: number; active: boolean }>({
    key: 0,
    active: false,
  });
  const isMobileViewport = useMediaQuery("max-sm");
  const isComposerCollapsedMobile =
    isMobileViewport && !forceExpandedOnMobile && !isComposerFocused;

  // ------------------------------------------------------------------
  // Refs
  // ------------------------------------------------------------------
  const composerEditorRef = useRef<ComposerPromptEditorHandle>(null);
  const composerFormRef = useRef<HTMLFormElement>(null);
  const composerSurfaceRef = useRef<HTMLDivElement>(null);
  const providerInputRejectedRef = useRef(false);
  const composerSelectLockRef = useRef(false);
  const composerMenuOpenRef = useRef(false);
  const composerMenuItemsRef = useRef<ComposerCommandItem[]>([]);
  const activeComposerMenuItemRef = useRef<ComposerCommandItem | null>(null);
  const composerBlurFrameRef = useRef<number | null>(null);
  const mobileComposerExpandFrameRef = useRef<number | null>(null);
  const mobileComposerExpandReleaseFrameRef = useRef<number | null>(null);
  const mobileComposerExpandInFlightRef = useRef(false);
  const stashPulseKeyRef = useRef(0);
  const stashPulseTimeoutRef = useRef<number | null>(null);
  /**
   * Snapshots currently being encoded, keyed by target+prompt+image ids.
   * Keyed rather than boolean so a genuinely different prompt (or a different
   * thread) can still be stashed while an earlier encode is running.
   */
  const stashInFlightRef = useRef<Set<string>>(new Set());
  /**
   * Count of pasted images still being compressed, per thread. Reserved
   * against the attachment limit so concurrent pastes can't overshoot it,
   * and checked by `submitComposer` so a send can't race an image into the
   * next draft.
   */
  const pendingImageCompressionsRef = useRef<Map<ThreadId, number>>(new Map());

  // ------------------------------------------------------------------
  // Derived: composer send state
  // ------------------------------------------------------------------
  const composerSendState = useMemo(
    () =>
      deriveComposerSendState({
        prompt,
        imageCount: composerImages.length,
        terminalContexts: composerTerminalContexts,
        elementContextCount:
          composerElementContexts.length +
          composerPreviewAnnotations.length +
          composerReviewComments.length,
      }),
    [
      composerElementContexts.length,
      composerImages.length,
      composerPreviewAnnotations.length,
      composerReviewComments.length,
      composerTerminalContexts,
      prompt,
    ],
  );

  // ------------------------------------------------------------------
  // Derived: composer trigger / menu
  // ------------------------------------------------------------------
  const composerTriggerKind = composerTrigger?.kind ?? null;
  const pathTriggerQuery = composerTrigger?.kind === "path" ? composerTrigger.query : "";
  const isPathTrigger = composerTriggerKind === "path";
  const workspaceEntries = useComposerPathSearch({
    environmentId,
    cwd: isPathTrigger ? gitCwd : null,
    query: isPathTrigger ? pathTriggerQuery : null,
  });

  const composerMenuItems = useMemo<ComposerCommandItem[]>(() => {
    if (!composerTrigger) return [];
    if (composerTrigger.kind === "path") {
      return workspaceEntries.entries.map((entry) => ({
        id: `path:${entry.kind}:${entry.path}`,
        type: "path",
        path: entry.path,
        pathKind: entry.kind,
        label: basenameOfPath(entry.path),
        description: entry.path.slice(0, Math.max(0, entry.path.lastIndexOf("/"))),
      }));
    }
    if (composerTrigger.kind === "slash-command") {
      const builtInSlashCommandItems = [
        {
          id: "slash:model",
          type: "slash-command",
          command: "model",
          label: "/model",
          description: "Switch response model for this thread",
        },
        ...(composerProviderControls.showInteractionModeToggle
          ? [
              {
                id: "slash:plan" as const,
                type: "slash-command" as const,
                command: "plan" as const,
                label: "/plan",
                description: "Switch this thread into plan mode",
              },
              {
                id: "slash:default" as const,
                type: "slash-command" as const,
                command: "default" as const,
                label: "/default",
                description: "Switch this thread back to normal build mode",
              },
            ]
          : []),
      ] satisfies ReadonlyArray<Extract<ComposerCommandItem, { type: "slash-command" }>>;
      const providerSlashCommandItems = providerSlashCommands.map((command) => ({
        id: `provider-slash-command:${selectedProvider}:${command.name}`,
        type: "provider-slash-command" as const,
        provider: selectedProvider,
        command,
        label: `/${command.name}`,
        description: formatProviderSlashCommandDescription(command),
      }));
      const query = composerTrigger.query.trim().toLowerCase();
      const skillItems = (selectedProviderStatus?.skills ?? [])
        .filter((skill) => skill.enabled)
        .map((skill) => ({
          id: `skill:${selectedProvider}:${skill.name}`,
          type: "skill" as const,
          provider: selectedProvider,
          skill,
          label: `skill:${skill.name}`,
          description:
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : ""),
        }));
      const slashCommandItems = [
        ...builtInSlashCommandItems,
        ...providerSlashCommandItems,
        ...skillItems,
      ];
      return searchSlashCommandItems(slashCommandItems, query);
    }
    if (composerTrigger.kind === "skill") {
      return searchProviderSkills(selectedProviderStatus?.skills ?? [], composerTrigger.query).map(
        (skill) => ({
          id: `skill:${selectedProvider}:${skill.name}`,
          type: "skill" as const,
          provider: selectedProvider,
          skill,
          label: formatProviderSkillDisplayName(skill),
          description:
            skill.shortDescription ??
            skill.description ??
            (skill.scope ? `${skill.scope} skill` : "Run provider skill"),
        }),
      );
    }
    return [];
  }, [
    composerProviderControls.showInteractionModeToggle,
    composerTrigger,
    providerSlashCommands,
    selectedProvider,
    selectedProviderStatus,
    workspaceEntries.entries,
  ]);

  const composerMenuOpen = Boolean(composerTrigger);
  const composerMenuSearchKey = composerTrigger
    ? `${composerTrigger.kind}:${composerTrigger.query.trim().toLowerCase()}`
    : null;
  const activeComposerMenuItem = useMemo(() => {
    const activeItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    return composerMenuItems.find((item) => item.id === activeItemId) ?? null;
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuSearchKey,
  ]);

  composerMenuOpenRef.current = composerMenuOpen;
  composerMenuItemsRef.current = composerMenuItems;
  activeComposerMenuItemRef.current = activeComposerMenuItem;

  const nonPersistedComposerImageIdSet = useMemo(
    () => new Set(nonPersistedComposerImageIds),
    [nonPersistedComposerImageIds],
  );

  const isComposerApprovalState = activePendingApproval !== null;
  const activePendingUserInput = pendingUserInputs[0] ?? null;
  const showComposerTopDrawer =
    isComposerApprovalState ||
    pendingUserInputs.length > 0 ||
    (!isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan !== null);
  const showCollapsedMobilePromptRow =
    isComposerCollapsedMobile && !isComposerApprovalState && pendingUserInputs.length === 0;

  const composerFooterHasWideActions = showPlanFollowUpPrompt || activePendingProgress !== null;
  const composerFooterActionLayoutKey = useMemo(() => {
    if (activePendingProgress) {
      return `pending:${activePendingProgress.questionIndex}:${activePendingProgress.isLastQuestion}:${activePendingIsResponding}`;
    }
    if (phase === "running") {
      return "running";
    }
    if (showPlanFollowUpPrompt) {
      return prompt.trim().length > 0 ? "plan:refine" : "plan:implement";
    }
    return `idle:${composerSendState.hasSendableContent}:${isSendBusy}:${isConnecting}:${isPreparingWorktree}`;
  }, [
    activePendingIsResponding,
    activePendingProgress,
    composerSendState.hasSendableContent,
    isConnecting,
    isPreparingWorktree,
    isSendBusy,
    phase,
    prompt,
    showPlanFollowUpPrompt,
  ]);

  const isComposerMenuLoading =
    composerTriggerKind === "path" && pathTriggerQuery.length > 0 && workspaceEntries.isPending;
  const composerMenuEmptyState = useMemo(() => {
    if (composerTriggerKind === "skill") {
      return "No skills found. Try / to browse provider commands.";
    }
    return composerTriggerKind === "path"
      ? "No matching files or folders."
      : "No matching command.";
  }, [composerTriggerKind]);

  // ------------------------------------------------------------------
  // Provider traits UI
  // ------------------------------------------------------------------
  const setPromptFromTraits = useCallback(
    (nextPrompt: string) => {
      if (nextPrompt === promptRef.current) {
        scheduleComposerFocus();
        return;
      }
      promptRef.current = nextPrompt;
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
      const nextCursor = collapseExpandedComposerCursor(nextPrompt, nextPrompt.length);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(nextPrompt, nextPrompt.length));
      scheduleComposerFocus();
    },
    [composerDraftTarget, promptRef, scheduleComposerFocus, setComposerDraftPrompt],
  );

  const providerTraitsMenuContent = renderProviderTraitsMenuContent({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
    planModeEnabled: settings.planModeEnabled,
  });
  const providerTraitsPicker = renderProviderTraitsPicker({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server" ? { threadRef: routeThreadRef } : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    prompt,
    onPromptChange: setPromptFromTraits,
    planModeEnabled: settings.planModeEnabled,
  });
  const pendingPrimaryAction = useMemo(
    () =>
      activePendingProgress
        ? {
            questionIndex: activePendingProgress.questionIndex,
            isLastQuestion: activePendingProgress.isLastQuestion,
            canAdvance: activePendingProgress.canAdvance,
            isResponding: activePendingIsResponding,
            isComplete: Boolean(activePendingResolvedAnswers),
          }
        : null,
    [activePendingIsResponding, activePendingProgress, activePendingResolvedAnswers],
  );
  const collapsedComposerPrimaryActionDisabled =
    phase === "running" ||
    isSendBusy ||
    isSendDisabled ||
    isConnecting ||
    noProviderAvailable ||
    projectSelectionRequired ||
    environmentUnavailable !== null ||
    !composerSendState.hasSendableContent;
  const collapsedComposerPrimaryActionLabel = "Send message";
  const showMobilePendingAnswerActions =
    isMobileViewport && !isComposerCollapsedMobile && pendingPrimaryAction !== null;

  // ------------------------------------------------------------------
  // Prompt helpers
  // ------------------------------------------------------------------
  const setPrompt = useCallback(
    (nextPrompt: string) => {
      setComposerDraftPrompt(composerDraftTarget, nextPrompt);
    },
    [composerDraftTarget, setComposerDraftPrompt],
  );

  const addComposerImage = useCallback(
    (image: ComposerImageAttachment) => {
      addComposerDraftImage(composerDraftTarget, image);
    },
    [composerDraftTarget, addComposerDraftImage],
  );

  const addComposerImagesToDraft = useCallback(
    (images: ComposerImageAttachment[]) => {
      addComposerDraftImages(composerDraftTarget, images);
    },
    [composerDraftTarget, addComposerDraftImages],
  );

  const removeComposerImageFromDraft = useCallback(
    (imageId: string) => {
      removeComposerDraftImage(composerDraftTarget, imageId);
    },
    [composerDraftTarget, removeComposerDraftImage],
  );

  const removeComposerTerminalContextFromDraft = useCallback(
    (contextId: string) => {
      const contextIndex = composerTerminalContexts.findIndex(
        (context) => context.id === contextId,
      );
      if (contextIndex < 0) return;
      const removal = removeInlineTerminalContextPlaceholder(promptRef.current, contextIndex);
      promptRef.current = removal.prompt;
      setPrompt(removal.prompt);
      removeComposerDraftTerminalContext(composerDraftTarget, contextId);
      const nextCursor = collapseExpandedComposerCursor(removal.prompt, removal.cursor);
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(removal.prompt, removal.cursor));
    },
    [
      composerDraftTarget,
      composerTerminalContexts,
      promptRef,
      removeComposerDraftTerminalContext,
      setPrompt,
    ],
  );

  // ------------------------------------------------------------------
  // Sync refs back to parent
  // ------------------------------------------------------------------
  useEffect(() => {
    promptRef.current = prompt;
    setComposerCursor((existing) => clampCollapsedComposerCursor(prompt, existing));
  }, [prompt, promptRef]);

  useEffect(() => {
    if (composerSubmissionError === null) return;
    const nextError = getComposerPromptLengthValidationMessage(prompt);
    if (nextError !== composerSubmissionError) {
      setComposerSubmissionError(nextError);
    }
  }, [composerSubmissionError, prompt]);

  useEffect(() => {
    setProviderInputSubmissionError(null);
  }, [
    composerElementContexts,
    composerPreviewAnnotations,
    composerReviewComments,
    composerTerminalContexts,
    prompt,
    selectedModel,
    selectedPromptEffort,
    selectedProvider,
  ]);

  useEffect(() => {
    composerImagesRef.current = composerImages;
  }, [composerImages, composerImagesRef]);

  useEffect(() => {
    composerTerminalContextsRef.current = composerTerminalContexts;
  }, [composerTerminalContexts, composerTerminalContextsRef]);

  useEffect(() => {
    composerElementContextsRef.current = composerElementContexts;
  }, [composerElementContexts, composerElementContextsRef]);

  // ------------------------------------------------------------------
  // Composer menu highlight sync
  // ------------------------------------------------------------------
  useEffect(() => {
    if (!composerMenuOpen) {
      setComposerHighlightedItemId(null);
      setComposerHighlightedSearchKey(null);
      return;
    }
    const nextActiveItemId = resolveComposerMenuActiveItemId({
      items: composerMenuItems,
      highlightedItemId: composerHighlightedItemId,
      currentSearchKey: composerMenuSearchKey,
      highlightedSearchKey: composerHighlightedSearchKey,
    });
    setComposerHighlightedItemId((existing) =>
      existing === nextActiveItemId ? existing : nextActiveItemId,
    );
    setComposerHighlightedSearchKey((existing) =>
      existing === composerMenuSearchKey ? existing : composerMenuSearchKey,
    );
  }, [
    composerHighlightedItemId,
    composerHighlightedSearchKey,
    composerMenuItems,
    composerMenuOpen,
    composerMenuSearchKey,
  ]);

  const lastSyncedPendingInputRef = useRef<{
    requestId: string | null;
    questionId: string | null;
  } | null>(null);

  useEffect(() => {
    const nextCustomAnswer = activePendingProgress?.customAnswer;
    if (typeof nextCustomAnswer !== "string") {
      lastSyncedPendingInputRef.current = null;
      return;
    }

    const nextRequestId = activePendingUserInput?.requestId ?? null;
    const nextQuestionId = activePendingProgress?.activeQuestion?.id ?? null;
    const questionChanged =
      lastSyncedPendingInputRef.current?.requestId !== nextRequestId ||
      lastSyncedPendingInputRef.current?.questionId !== nextQuestionId;
    const textChangedExternally = promptRef.current !== nextCustomAnswer;

    lastSyncedPendingInputRef.current = {
      requestId: nextRequestId,
      questionId: nextQuestionId,
    };

    if (!questionChanged && !textChangedExternally) {
      return;
    }

    promptRef.current = nextCustomAnswer;
    const nextCursor = collapseExpandedComposerCursor(nextCustomAnswer, nextCustomAnswer.length);
    setComposerCursor(nextCursor);
    setComposerTrigger(
      detectComposerTrigger(
        nextCustomAnswer,
        expandCollapsedComposerCursor(nextCustomAnswer, nextCursor),
      ),
    );
    setComposerHighlightedItemId(null);
  }, [
    activePendingProgress?.customAnswer,
    activePendingProgress?.activeQuestion?.id,
    activePendingUserInput?.requestId,
    promptRef,
  ]);

  // ------------------------------------------------------------------
  // Reset compositor state on thread/draft change
  // ------------------------------------------------------------------
  useEffect(() => {
    setComposerHighlightedItemId(null);
    setComposerSubmissionError(null);
    setProviderInputSubmissionError(null);
    setComposerCursor(collapseExpandedComposerCursor(promptRef.current, promptRef.current.length));
    setComposerTrigger(detectComposerTrigger(promptRef.current, promptRef.current.length));
    setIsDragOverComposer(false);
  }, [draftId, activeThreadId, promptRef]);

  // ------------------------------------------------------------------
  // Footer compact layout observation
  // ------------------------------------------------------------------
  useLayoutEffect(() => {
    const composerForm = composerFormRef.current;
    if (!composerForm) return;
    const measureComposerFormWidth = () => composerForm.clientWidth;
    const measureFooterCompactness = () => {
      const composerFormWidth = measureComposerFormWidth();
      const footerCompact = shouldUseCompactComposerFooter(composerFormWidth, {
        hasWideActions: composerFooterHasWideActions,
      });
      const primaryActionsCompact =
        footerCompact &&
        shouldUseCompactComposerPrimaryActions(composerFormWidth, {
          hasWideActions: composerFooterHasWideActions,
        });
      return {
        primaryActionsCompact,
        footerCompact,
      };
    };

    const initialCompactness = measureFooterCompactness();
    setIsComposerPrimaryActionsCompact(initialCompactness.primaryActionsCompact);
    setIsComposerFooterCompact(initialCompactness.footerCompact);
    if (typeof ResizeObserver === "undefined") return;

    const observer = new ResizeObserver(() => {
      const nextCompactness = measureFooterCompactness();
      setIsComposerPrimaryActionsCompact((previous) =>
        previous === nextCompactness.primaryActionsCompact
          ? previous
          : nextCompactness.primaryActionsCompact,
      );
      setIsComposerFooterCompact((previous) =>
        previous === nextCompactness.footerCompact ? previous : nextCompactness.footerCompact,
      );
    });

    observer.observe(composerForm);
    return () => {
      observer.disconnect();
    };
  }, [activeThreadId, composerFooterActionLayoutKey, composerFooterHasWideActions]);

  // ------------------------------------------------------------------
  // Image persist effect
  // ------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      if (composerImages.length === 0) {
        clearComposerDraftPersistedAttachments(composerDraftTarget);
        return;
      }
      const getPersistedAttachmentsForThread = () =>
        getComposerDraft(composerDraftTarget)?.persistedAttachments ?? [];
      try {
        const currentPersistedAttachments = getPersistedAttachmentsForThread();
        const existingPersistedById = new Map(
          currentPersistedAttachments.map((attachment) => [attachment.id, attachment]),
        );
        const stagedAttachmentById = new Map<string, PersistedComposerImageAttachment>();
        await Promise.all(
          composerImages.map(async (image) => {
            try {
              const dataUrl = await readFileAsDataUrl(image.file);
              stagedAttachmentById.set(image.id, {
                id: image.id,
                name: image.name,
                mimeType: image.mimeType,
                sizeBytes: image.sizeBytes,
                dataUrl,
              });
            } catch {
              const existingPersisted = existingPersistedById.get(image.id);
              if (existingPersisted) {
                stagedAttachmentById.set(image.id, existingPersisted);
              }
            }
          }),
        );
        const serialized = Array.from(stagedAttachmentById.values());
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, serialized);
      } catch {
        const currentImageIds = new Set(composerImages.map((image) => image.id));
        const fallbackPersistedAttachments = getPersistedAttachmentsForThread();
        const fallbackPersistedIds: Array<string> = [];
        for (const attachment of fallbackPersistedAttachments) {
          if (currentImageIds.has(attachment.id)) {
            fallbackPersistedIds.push(attachment.id);
          }
        }
        const fallbackPersistedIdSet = new Set(fallbackPersistedIds);
        const fallbackAttachments = fallbackPersistedAttachments.filter((attachment) =>
          fallbackPersistedIdSet.has(attachment.id),
        );
        if (cancelled) return;
        syncComposerDraftPersistedAttachments(composerDraftTarget, fallbackAttachments);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [
    composerDraftTarget,
    clearComposerDraftPersistedAttachments,
    composerImages,
    getComposerDraft,
    syncComposerDraftPersistedAttachments,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: prompt change
  // ------------------------------------------------------------------
  const onPromptChange = useCallback(
    (
      nextPrompt: string,
      nextCursor: number,
      expandedCursor: number,
      cursorAdjacentToMention: boolean,
      terminalContextIds: string[],
    ) => {
      if (activePendingProgress?.activeQuestion && pendingUserInputs.length > 0) {
        setComposerCursor(nextCursor);
        setComposerTrigger(
          cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
        );
        onChangeActivePendingUserInputCustomAnswer(
          activePendingProgress.activeQuestion.id,
          nextPrompt,
          nextCursor,
          expandedCursor,
          cursorAdjacentToMention,
        );
        return;
      }
      promptRef.current = nextPrompt;
      setPrompt(nextPrompt);
      if (!terminalContextIdListsEqual(composerTerminalContexts, terminalContextIds)) {
        setComposerDraftTerminalContexts(
          composerDraftTarget,
          syncTerminalContextsByIds(composerTerminalContexts, terminalContextIds),
        );
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(
        cursorAdjacentToMention ? null : detectComposerTrigger(nextPrompt, expandedCursor),
      );
    },
    [
      activePendingProgress?.activeQuestion,
      pendingUserInputs.length,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
      composerDraftTarget,
      composerTerminalContexts,
      setComposerDraftTerminalContexts,
    ],
  );

  // ------------------------------------------------------------------
  // Callbacks: prompt replacement / menu
  // ------------------------------------------------------------------
  const applyPromptReplacement = useCallback(
    (
      rangeStart: number,
      rangeEnd: number,
      replacement: string,
      options?: { expectedText?: string; focusEditorAfterReplace?: boolean },
    ): boolean => {
      const currentText = promptRef.current;
      const safeStart = Math.max(0, Math.min(currentText.length, rangeStart));
      const safeEnd = Math.max(safeStart, Math.min(currentText.length, rangeEnd));
      if (
        options?.expectedText !== undefined &&
        currentText.slice(safeStart, safeEnd) !== options.expectedText
      ) {
        return false;
      }
      const next = replaceTextRange(promptRef.current, rangeStart, rangeEnd, replacement);
      const nextCursor = collapseExpandedComposerCursor(next.text, next.cursor);
      const nextExpandedCursor = expandCollapsedComposerCursor(next.text, nextCursor);
      promptRef.current = next.text;
      const activePendingQuestion = activePendingProgress?.activeQuestion;
      if (activePendingQuestion && activePendingUserInput) {
        onChangeActivePendingUserInputCustomAnswer(
          activePendingQuestion.id,
          next.text,
          nextCursor,
          nextExpandedCursor,
          false,
        );
      } else {
        setPrompt(next.text);
      }
      setComposerCursor(nextCursor);
      setComposerTrigger(detectComposerTrigger(next.text, nextExpandedCursor));
      if (options?.focusEditorAfterReplace !== false) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCursor);
        });
      }
      return true;
    },
    [
      activePendingProgress?.activeQuestion,
      activePendingUserInput,
      onChangeActivePendingUserInputCustomAnswer,
      promptRef,
      setPrompt,
    ],
  );

  const readComposerSnapshot = useCallback((): {
    value: string;
    cursor: number;
    expandedCursor: number;
    terminalContextIds: string[];
  } => {
    const editorSnapshot = composerEditorRef.current?.readSnapshot();
    if (editorSnapshot) {
      return editorSnapshot;
    }
    return {
      value: promptRef.current,
      cursor: composerCursor,
      expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
      terminalContextIds: composerTerminalContexts.map((context) => context.id),
    };
  }, [composerCursor, composerTerminalContexts, promptRef]);

  const resolveActiveComposerTrigger = useCallback((): {
    snapshot: { value: string; cursor: number; expandedCursor: number };
    trigger: ComposerTrigger | null;
  } => {
    const snapshot = readComposerSnapshot();
    return {
      snapshot,
      trigger: detectComposerTrigger(snapshot.value, snapshot.expandedCursor),
    };
  }, [readComposerSnapshot]);

  const onSelectComposerItem = useCallback(
    (item: ComposerCommandItem) => {
      if (composerSelectLockRef.current) return;
      composerSelectLockRef.current = true;
      window.requestAnimationFrame(() => {
        composerSelectLockRef.current = false;
      });
      const { snapshot, trigger } = resolveActiveComposerTrigger();
      if (!trigger) return;
      if (item.type === "path") {
        const replacement = `${serializeComposerFileLink(item.path)} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "slash-command") {
        if (item.command === "model") {
          const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
            expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
            focusEditorAfterReplace: false,
          });
          if (applied) {
            setComposerHighlightedItemId(null);
            setIsComposerModelPickerOpen(true);
          }
          return;
        }
        void handleInteractionModeChange(item.command === "plan" ? "plan" : "default");
        const applied = applyPromptReplacement(trigger.rangeStart, trigger.rangeEnd, "", {
          expectedText: snapshot.value.slice(trigger.rangeStart, trigger.rangeEnd),
        });
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "provider-slash-command") {
        const replacement = `/${item.command.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
      if (item.type === "skill") {
        const replacement = `$${item.skill.name} `;
        const replacementRangeEnd = extendReplacementRangeForTrailingSpace(
          snapshot.value,
          trigger.rangeEnd,
          replacement,
        );
        const applied = applyPromptReplacement(
          trigger.rangeStart,
          replacementRangeEnd,
          replacement,
          { expectedText: snapshot.value.slice(trigger.rangeStart, replacementRangeEnd) },
        );
        if (applied) {
          setComposerHighlightedItemId(null);
        }
        return;
      }
    },
    [applyPromptReplacement, handleInteractionModeChange, resolveActiveComposerTrigger],
  );

  const onComposerMenuItemHighlighted = useCallback(
    (itemId: string | null) => {
      setComposerHighlightedItemId(itemId);
      setComposerHighlightedSearchKey(composerMenuSearchKey);
    },
    [composerMenuSearchKey],
  );

  const nudgeComposerMenuHighlight = useCallback(
    (key: "ArrowDown" | "ArrowUp") => {
      if (composerMenuItems.length === 0) return;
      const highlightedIndex = composerMenuItems.findIndex(
        (item) => item.id === composerHighlightedItemId,
      );
      const normalizedIndex =
        highlightedIndex >= 0 ? highlightedIndex : key === "ArrowDown" ? -1 : 0;
      const offset = key === "ArrowDown" ? 1 : -1;
      const nextIndex =
        (normalizedIndex + offset + composerMenuItems.length) % composerMenuItems.length;
      const nextItem = composerMenuItems[nextIndex];
      setComposerHighlightedItemId(nextItem?.id ?? null);
    },
    [composerHighlightedItemId, composerMenuItems],
  );

  const blurMobileComposerAfterSend = useCallback(() => {
    if (!isMobileViewport) return;
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    const activeElement = document.activeElement;
    if (activeElement instanceof HTMLElement) {
      activeElement.blur();
    }
    setIsComposerFocused(false);
  }, [isMobileViewport]);

  const shouldBlurMobileComposerOnSubmit = useCallback(() => {
    if (!isMobileViewport) return false;
    if (
      isSendBusy ||
      isSendDisabled ||
      isConnecting ||
      noProviderAvailable ||
      environmentUnavailable !== null ||
      phase === "running"
    ) {
      return false;
    }
    if (activePendingProgress) {
      return activePendingProgress.isLastQuestion && Boolean(activePendingResolvedAnswers);
    }
    return showPlanFollowUpPrompt || composerSendState.hasSendableContent;
  }, [
    activePendingProgress,
    activePendingResolvedAnswers,
    composerSendState.hasSendableContent,
    environmentUnavailable,
    isConnecting,
    isMobileViewport,
    isSendBusy,
    isSendDisabled,
    noProviderAvailable,
    phase,
    showPlanFollowUpPrompt,
  ]);

  const submitComposer = useCallback(
    (event?: { preventDefault: () => void }, intent: ComposerSubmissionIntent = "foreground") => {
      if (noProviderAvailable || isSendDisabled) {
        event?.preventDefault();
        return;
      }
      // A send while a pasted image is still compressing would strand that
      // image: the turn snapshot wouldn't include it, and it would surface
      // in the *next* draft instead. Only oversized images hit this — small
      // files clear the pending counter within a microtask.
      if (activeThreadId && (pendingImageCompressionsRef.current.get(activeThreadId) ?? 0) > 0) {
        event?.preventDefault();
        toastManager.add({
          type: "info",
          title: "Still compressing a pasted image.",
          description: "Send again once its thumbnail appears.",
        });
        return;
      }
      const submission = submitComposerDraft({
        prompt: promptRef.current,
        submissionTarget: activePendingProgress ? "pending-user-input" : "provider-turn",
        event,
        onSend: (sendEvent) => {
          // ChatView reports its final composed-input preflight through the
          // composer handle before its first asynchronous send step.
          providerInputRejectedRef.current = false;
          onSend(sendEvent, intent);
          return !providerInputRejectedRef.current;
        },
      });
      setComposerSubmissionError(submission.validationMessage);
      if (!submission.didDispatch) return;
      if (shouldBlurMobileComposerOnSubmit()) {
        blurMobileComposerAfterSend();
      }
    },
    [
      activeThreadId,
      activePendingProgress,
      blurMobileComposerAfterSend,
      isSendDisabled,
      noProviderAvailable,
      onSend,
      promptRef,
      shouldBlurMobileComposerOnSubmit,
    ],
  );
  const expandMobileComposer = useCallback(() => {
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
      composerBlurFrameRef.current = null;
    }
    if (mobileComposerExpandFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
    }
    if (mobileComposerExpandReleaseFrameRef.current !== null) {
      window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
    }
    mobileComposerExpandInFlightRef.current = true;
    setIsComposerFocused(true);
    mobileComposerExpandFrameRef.current = window.requestAnimationFrame(() => {
      mobileComposerExpandFrameRef.current = null;
      composerEditorRef.current?.focusAtEnd();
      mobileComposerExpandReleaseFrameRef.current = window.requestAnimationFrame(() => {
        mobileComposerExpandReleaseFrameRef.current = null;
        mobileComposerExpandInFlightRef.current = false;
      });
    });
  }, []);

  // ------------------------------------------------------------------
  // Callbacks: command key
  // ------------------------------------------------------------------
  const onComposerCommandKey = (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab",
    event: KeyboardEvent,
  ) => {
    if (key === "Tab" && event.shiftKey) {
      toggleInteractionMode();
      return true;
    }
    const { trigger } = resolveActiveComposerTrigger();
    const menuIsActive = composerMenuOpenRef.current || trigger !== null;
    if (menuIsActive) {
      const currentItems = composerMenuItemsRef.current;
      const selectedItem = activeComposerMenuItemRef.current ?? currentItems[0];
      if (key === "ArrowDown" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowDown");
        return true;
      }
      if (key === "ArrowUp" && currentItems.length > 0) {
        nudgeComposerMenuHighlight("ArrowUp");
        return true;
      }
      if ((key === "Enter" || key === "Tab") && selectedItem) {
        onSelectComposerItem(selectedItem);
        return true;
      }
    }
    const submissionIntent =
      key === "Enter"
        ? composerSubmissionIntentForEnter({
            isMobileViewport,
            shiftKey: event.shiftKey,
            modifierKey: event.metaKey || event.ctrlKey,
            isDraftThread: routeKind === "draft",
          })
        : null;
    if (submissionIntent) {
      submitComposer(undefined, submissionIntent);
      return true;
    }
    return false;
  };

  // ------------------------------------------------------------------
  // Prompt stash (⌘S)
  // ------------------------------------------------------------------
  // One global queue. Stashed prompts carry only text + images so they can be
  // restored into any thread or provider — stash, switch, restore is the
  // whole point.
  const stashQueue = usePromptStashStore((state) => state.entries);
  const stashEntryToQueue = usePromptStashStore((state) => state.stashEntry);
  const takeStashEntry = usePromptStashStore((state) => state.takeEntry);
  const finalizeStashEntryImages = usePromptStashStore((state) => state.finalizeEntryImages);

  useEffect(() => {
    return () => {
      if (stashPulseTimeoutRef.current !== null) {
        window.clearTimeout(stashPulseTimeoutRef.current);
      }
    };
  }, []);

  /** Briefly highlight the badge so the save registers without a flourish. */
  const pulseStashBadge = useCallback(() => {
    stashPulseKeyRef.current += 1;
    setStashPulse({ key: stashPulseKeyRef.current, active: true });
    if (stashPulseTimeoutRef.current !== null) {
      window.clearTimeout(stashPulseTimeoutRef.current);
    }
    stashPulseTimeoutRef.current = window.setTimeout(() => {
      stashPulseTimeoutRef.current = null;
      setStashPulse((current) => ({ ...current, active: false }));
    }, 1200);
  }, []);

  const restoreStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      // Remove first so a double activation (click + Enter) can't restore twice.
      const { entry: taken, durable } = takeStashEntry(entry.id);
      if (!taken) return;
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Restored prompt may reappear in the stash",
          description:
            "Browser storage rejected the update, so this entry could still be there after a reload.",
          data: { hideCopyButton: true },
        });
      }
      setIsStashMenuOpen(false);

      const currentPrompt = promptRef.current;
      // An image-only stash must not append blank lines to whatever is
      // already in the composer.
      const nextPrompt =
        entry.prompt.length === 0
          ? currentPrompt
          : currentPrompt.trim().length
            ? `${currentPrompt.replace(/\s+$/, "")}\n\n${entry.prompt}`
            : entry.prompt;
      const promptChanged = nextPrompt !== currentPrompt;
      if (promptChanged) {
        promptRef.current = nextPrompt;
        setComposerDraftPrompt(composerDraftTarget, nextPrompt);
        setComposerCursor(collapseExpandedComposerCursor(nextPrompt, nextPrompt.length));
        setComposerTrigger(null);
      }

      let unrestoredImageNames: string[] = [];
      if (entry.attachments.length > 0) {
        const existingIds = new Set(composerImagesRef.current.map((image) => image.id));
        // The draft store also dedupes by mimeType+sizeBytes+name, so filter
        // on the same key here. Counting a duplicate against capacity would
        // burn a slot the store then refuses to fill, pushing a genuinely
        // unique image into the overflow list for nothing.
        const existingDedupKeys = new Set(
          composerImagesRef.current.map(
            (image) => `${image.mimeType} ${image.sizeBytes} ${image.name}`,
          ),
        );
        const capacity = Math.max(
          0,
          PROVIDER_SEND_TURN_MAX_ATTACHMENTS - composerImagesRef.current.length,
        );
        const pending = entry.attachments.filter(
          (attachment) =>
            !existingIds.has(attachment.id) &&
            !existingDedupKeys.has(
              `${attachment.mimeType} ${attachment.sizeBytes} ${attachment.name}`,
            ),
        );
        // Anything past the attachment limit cannot be restored. The entry is
        // already out of the queue, so report the overflow by name instead of
        // discarding it silently.
        unrestoredImageNames = pending.slice(capacity).map((attachment) => attachment.name);
        const restoredImages = hydrateImagesFromPersisted(pending.slice(0, capacity));
        if (restoredImages.length > 0) {
          addComposerDraftImages(composerDraftTarget, restoredImages);
        }
      }

      // Deliberately no model/provider restore: the stash exists to carry a
      // prompt across threads and providers, so whatever the composer has
      // selected right now stays selected.

      // Each cause gets its own sentence so "too large" is never blamed for a
      // file that actually failed to decode, or for one the composer simply
      // had no room to take back.
      const missingImageReasons: string[] = [];
      if (entry.droppedImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.droppedImageNames.join(", ")} exceeded the stash size limit when this prompt was saved.`,
        );
      }
      if (entry.unreadableImageNames && entry.unreadableImageNames.length > 0) {
        missingImageReasons.push(
          `${entry.unreadableImageNames.join(", ")} could not be read when this prompt was saved.`,
        );
      }
      if (unrestoredImageNames.length > 0) {
        missingImageReasons.push(
          `${unrestoredImageNames.join(", ")} could not be restored: the composer is at its ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS}-image limit.`,
        );
      }
      if (missingImageReasons.length > 0) {
        toastManager.add({
          type: "warning",
          title: "Some images were not restored",
          description: missingImageReasons.join(" "),
        });
      }

      // Only yank the caret to the end when text was actually inserted;
      // restoring images alone should leave the user where they were typing.
      if (promptChanged) {
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAtEnd();
        });
      }
    },
    [
      addComposerDraftImages,
      composerDraftTarget,
      composerImagesRef,
      promptRef,
      setComposerDraftPrompt,
      takeStashEntry,
    ],
  );

  const deleteStashEntry = useCallback(
    (entry: PromptStashEntry) => {
      const { durable } = takeStashEntry(entry.id);
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stash entry may come back",
          description:
            "Browser storage rejected the delete, so this prompt could reappear after a reload.",
          data: { hideCopyButton: true },
        });
      }
    },
    [takeStashEntry],
  );

  const stashCurrentPrompt = useCallback(async () => {
    // Terminal-context placeholders reference live sessions the stash can't
    // round-trip, so they are stripped from the stashed prompt.
    const prompt = promptRef.current.split(INLINE_TERMINAL_CONTEXT_PLACEHOLDER).join("").trim();
    const images = [...composerImagesRef.current];
    if (prompt.length === 0 && images.length === 0) {
      setIsStashMenuOpen((open) => !open);
      return;
    }
    // A repeat ⌘S on the *same* still-unencoded snapshot would stash it
    // twice. Guard on the snapshot itself rather than a bare boolean: once
    // the composer has been cleared the user can type something genuinely
    // new (or switch threads) while encoding continues, and that deserves its
    // own entry.
    const snapshotKey = `${String(composerDraftTarget)} ${prompt} ${images
      .map((image) => image.id)
      .join(",")}`;
    if (stashInFlightRef.current.has(snapshotKey)) return;
    stashInFlightRef.current.add(snapshotKey);

    const stashTarget = composerDraftTarget;
    const entryId = randomUUID();
    try {
      // Persist the text-only entry *first*, then clear. Ordering matters in
      // both directions: writing before clearing means a crash or closed tab
      // mid-encode still leaves the prompt recoverable, while clearing before
      // the async image work means edits typed during encoding are not wiped.
      // Images are appended to the stored entry as they finish encoding.
      const { evicted, written, durable } = stashEntryToQueue({
        id: entryId,
        createdAt: new Date().toISOString(),
        prompt,
        attachments: [],
        droppedImageNames: [],
        unreadableImageNames: [],
        pendingImageCount: images.length,
      });

      // Clearing the composer is only safe once the write actually landed.
      // If it was rejected (quota) the store has already rolled itself back,
      // so leave the composer untouched rather than making it the second
      // casualty of a reload.
      if (!written) {
        toastManager.add({
          type: "error",
          title: "Could not stash this prompt",
          description:
            "Browser storage rejected the write, so the composer was left as-is. Free up site data and try again.",
          data: { hideCopyButton: true },
        });
        return;
      }
      // Written but only into the in-memory fallback (localStorage blocked):
      // the entry is visible and restorable this session, so proceed with the
      // clear, but say it won't survive a reload.
      if (!durable) {
        toastManager.add({
          type: "warning",
          title: "Stashed prompt will not survive a reload",
          description:
            "Browser storage is unavailable, so this stash is kept in memory only for this session.",
          data: { hideCopyButton: true },
        });
      }

      // Only the prompt and images are cleared — terminal/element contexts,
      // preview annotations, and review comments are not stashable, so
      // destroying them here would be unrecoverable.
      promptRef.current = "";
      clearComposerDraftPromptAndImages(stashTarget);
      setComposerCursor(0);
      setComposerTrigger(null);
      pulseStashBadge();

      if (evicted) {
        toastManager.add({
          type: "warning",
          title: "Oldest stashed prompt discarded",
          description: `The stash holds ${MAX_STASH_ENTRIES} prompts; the oldest was removed to make room.`,
          data: { hideCopyButton: true },
        });
      }

      // Images are re-encoded for the stash rather than stored verbatim: the
      // composer allows up to 10MB per image, but localStorage gives the whole
      // origin ~5MB. Only the stashed copy shrinks; the live attachment (and
      // anything sent without stashing) keeps the original file.
      const candidateAttachments: PersistedComposerImageAttachment[] = [];
      const oversizedImageNames: string[] = [];
      const unreadableImageNames: string[] = [];
      for (const image of images) {
        const result = await compressImageForStash(image.file);
        if (!result.ok) {
          // "too large" and "could not be read" are distinct outcomes; the
          // menu and restore toast report them separately.
          (result.reason === "too-large" ? oversizedImageNames : unreadableImageNames).push(
            image.name,
          );
          continue;
        }
        candidateAttachments.push({
          id: image.id,
          name: image.name,
          mimeType: result.image.mimeType,
          sizeBytes: result.image.sizeBytes,
          dataUrl: result.image.dataUrl,
        });
      }
      const { kept, droppedNames } = partitionStashAttachments(candidateAttachments);

      const { attached, durable: imagesDurable } = finalizeStashEntryImages(entryId, {
        attachments: kept,
        droppedImageNames: [...oversizedImageNames, ...droppedNames],
        unreadableImageNames,
      });
      if (attached) {
        // The second phase can be rejected on its own: the text-only entry
        // fit, but adding image payloads pushed past the quota. Disk would
        // then still hold the phase-one entry with pendingImageCount set,
        // which reads as an orphan after reload — so say so now. Gated on the
        // entry write having been durable: on the in-memory fallback nothing
        // is ever durable, and the session-only warning already covered it.
        if (!imagesDurable && durable && images.length > 0) {
          toastManager.add({
            type: "warning",
            title: "Stashed images were not saved",
            description:
              "The prompt was stashed, but browser storage rejected its images. They will be missing if you reload.",
            data: { hideCopyButton: true },
          });
        }
      } else if (kept.length > 0) {
        // The entry was restored or deleted before its images finished
        // encoding, so they have nowhere to land. Say so rather than letting
        // them evaporate.
        toastManager.add({
          type: "warning",
          title: "Stashed images did not attach",
          description: `That prompt was restored or deleted before ${kept.length} image${kept.length === 1 ? "" : "s"} finished saving. Re-attach ${kept.length === 1 ? "it" : "them"} if you still need ${kept.length === 1 ? "it" : "them"}.`,
          data: { hideCopyButton: true },
        });
      }
    } finally {
      // Must clear on every path: a throw that left this set would wedge this
      // snapshot's ⌘S until the composer remounts.
      stashInFlightRef.current.delete(snapshotKey);
    }
  }, [
    clearComposerDraftPromptAndImages,
    composerDraftTarget,
    composerImagesRef,
    finalizeStashEntryImages,
    promptRef,
    pulseStashBadge,
    stashEntryToQueue,
  ]);

  const toggleStashMenu = useCallback(() => {
    setIsStashMenuOpen((open) => !open);
  }, []);
  const toggleInlineStashMenu = useCallback(() => {
    if (isComposerCollapsedMobile) {
      expandMobileComposer();
      setIsStashMenuOpen(true);
      return;
    }
    toggleStashMenu();
  }, [expandMobileComposer, isComposerCollapsedMobile, toggleStashMenu]);
  const toggleTasksDrawer = useCallback(() => {
    setIsTasksDrawerOpen((open) => !open);
  }, []);
  const activeTasksTurnId = activeThread?.latestTurn?.turnId ?? null;
  const tasksDismissedForActiveTurn =
    activeTasksTurnId !== null && dismissedTasksTurnId === activeTasksTurnId;
  const visibleTasksProgress = tasksDismissedForActiveTurn ? null : activeTasksProgress;
  const visibleTaskSteps = tasksDismissedForActiveTurn ? null : activeTaskSteps;
  const hasBlockingComposerTopDrawer =
    activePendingApproval !== null || pendingUserInputs.length > 0;
  const dismissTasks = useCallback(() => {
    if (activeTasksTurnId !== null) {
      setDismissedTasksTurnId(activeTasksTurnId);
    }
    setIsTasksDrawerOpen(false);
  }, [activeTasksTurnId]);
  const showInlineStashBadge =
    stashQueue.length > 0 &&
    !isComposerApprovalState &&
    (props.externalDrawerAttached ||
      showComposerTopDrawer ||
      isTasksDrawerOpen ||
      isComposerCollapsedMobile);
  const inlineStashBadge = showInlineStashBadge ? (
    <ComposerStashBadge
      count={stashQueue.length}
      menuOpen={isStashMenuOpen}
      placement="inline"
      pulseKey={stashPulse.key}
      pulsing={stashPulse.active}
      onToggleMenu={toggleInlineStashMenu}
    />
  ) : null;
  const showInlineTasksBadge =
    visibleTasksProgress !== null &&
    visibleTaskSteps !== null &&
    !isTasksDrawerOpen &&
    !hasBlockingComposerTopDrawer &&
    (props.externalDrawerAttached || showComposerTopDrawer || isComposerCollapsedMobile);
  const inlineTasksBadge = showInlineTasksBadge ? (
    <ComposerTasksBadge
      expanded={false}
      onDismiss={dismissTasks}
      onToggle={toggleTasksDrawer}
      placement="inline"
      progress={visibleTasksProgress}
      steps={visibleTaskSteps}
    />
  ) : null;
  const showShoulderTabs =
    !props.externalDrawerAttached &&
    !showComposerTopDrawer &&
    !isTasksDrawerOpen &&
    !isComposerCollapsedMobile;
  const hasShoulderTab =
    showShoulderTabs &&
    (stashQueue.length > 0 ||
      (visibleTasksProgress !== null &&
        visibleTaskSteps !== null &&
        visibleTasksProgress.totalSteps > 0));
  useEffect(() => {
    if (visibleTasksProgress === null || visibleTaskSteps === null) {
      setIsTasksDrawerOpen(false);
    }
  }, [visibleTaskSteps, visibleTasksProgress]);

  useEffect(() => {
    if (hasBlockingComposerTopDrawer) {
      setIsTasksDrawerOpen(false);
    }
  }, [hasBlockingComposerTopDrawer]);

  useEffect(() => {
    setIsTasksDrawerOpen(false);
  }, [activeThreadId]);

  // Close the stash menu whenever the trigger-driven command menu opens so
  // the two popovers never stack in the same layer, and when the user
  // resumes typing (the menu is a transient picker, not a panel).
  useEffect(() => {
    if (composerMenuOpen) {
      setIsStashMenuOpen(false);
    }
  }, [composerMenuOpen]);
  useEffect(() => {
    setIsStashMenuOpen(false);
  }, [prompt]);

  useEffect(() => {
    const handler = (event: globalThis.KeyboardEvent) => {
      const command = resolveShortcutCommand(event, keybindings, {
        context: {
          terminalFocus: getTerminalFocusOwner() !== null,
          terminalOpen,
          modelPickerOpen: isComposerModelPickerOpen,
        },
      });
      if (command !== "composer.stash") return;
      // Always claim the shortcut so the browser save dialog never opens,
      // even when the composer is in a state that can't stash.
      event.preventDefault();
      event.stopPropagation();
      if (isCommandPaletteOpen()) {
        return;
      }
      if (pendingUserInputs.length > 0 && !isComposerApprovalState) {
        setIsStashMenuOpen((open) => !open);
        return;
      }
      if (isComposerApprovalState || projectSelectionRequired || activePendingProgress !== null) {
        return;
      }
      void stashCurrentPrompt();
    };
    window.addEventListener("keydown", handler, true);
    return () => window.removeEventListener("keydown", handler, true);
  }, [
    activePendingProgress,
    isComposerApprovalState,
    isComposerModelPickerOpen,
    keybindings,
    pendingUserInputs.length,
    projectSelectionRequired,
    stashCurrentPrompt,
    terminalOpen,
  ]);

  // ------------------------------------------------------------------
  // Callbacks: images
  // ------------------------------------------------------------------
  const addComposerImages = async (files: File[]) => {
    if (!activeThreadId || files.length === 0) return;
    if (pendingUserInputs.length > 0) {
      toastManager.add({
        type: "error",
        title: "Attach images after answering plan questions.",
      });
      return;
    }
    // Captured before the awaits below: the user may switch threads while a
    // large image is being compressed, and the attachments and errors belong
    // to the thread the paste happened in.
    const threadId = activeThreadId;

    // Validation happens synchronously so concurrent pastes see each other:
    // accepted files reserve their attachment slots (via the pending counter)
    // before the first await, keeping the total under the limit.
    const pendingCount = pendingImageCompressionsRef.current.get(threadId) ?? 0;
    let reservedCount = composerImagesRef.current.length + pendingCount;
    const acceptedFiles: File[] = [];
    let error: string | null = null;
    for (const file of files) {
      if (!file.type.startsWith("image/")) {
        error = `Unsupported file type for '${file.name}'. Please attach image files only.`;
        continue;
      }
      if (!isProviderSendTurnSupportedImageMimeType(file.type)) {
        error = `'${file.name}' is not a supported image type. Attach GIF, JPEG, PNG, or WebP images.`;
        continue;
      }
      if (reservedCount >= PROVIDER_SEND_TURN_MAX_ATTACHMENTS) {
        error = `You can attach up to ${PROVIDER_SEND_TURN_MAX_ATTACHMENTS} images per message.`;
        break;
      }
      acceptedFiles.push(file);
      reservedCount += 1;
    }
    setThreadError(threadId, error);
    if (acceptedFiles.length === 0) return;

    pendingImageCompressionsRef.current.set(threadId, pendingCount + acceptedFiles.length);
    try {
      const nextImages: ComposerImageAttachment[] = [];
      let compressionError: string | null = null;
      for (const file of acceptedFiles) {
        // Images over the wire cap are downscaled to fit rather than
        // refused; files already within it pass through byte-for-byte.
        const compressed = await compressImageToByteLimit(file, PROVIDER_SEND_TURN_MAX_IMAGE_BYTES);
        if (!compressed.ok) {
          compressionError =
            compressed.reason === "unreadable"
              ? `'${file.name}' could not be read as an image.`
              : `'${file.name}' is too large to attach, even after compression.`;
          continue;
        }
        const attachmentFile = compressed.file;
        const previewUrl = URL.createObjectURL(attachmentFile);
        nextImages.push({
          type: "image",
          id: randomUUID(),
          name: attachmentFile.name || "image",
          mimeType: attachmentFile.type,
          sizeBytes: attachmentFile.size,
          previewUrl,
          file: attachmentFile,
        });
      }
      if (nextImages.length === 1 && nextImages[0]) {
        addComposerImage(nextImages[0]);
      } else if (nextImages.length > 1) {
        addComposerImagesToDraft(nextImages);
      }
      // Only failures are reported here. Success must not pass `null`: by
      // now other work (a failed send, an overlapping paste) may have set a
      // thread error this call knows nothing about, and clearing it would
      // swallow that message.
      if (compressionError !== null) {
        setThreadError(threadId, compressionError);
      }
    } finally {
      const remaining =
        (pendingImageCompressionsRef.current.get(threadId) ?? 0) - acceptedFiles.length;
      if (remaining > 0) {
        pendingImageCompressionsRef.current.set(threadId, remaining);
      } else {
        pendingImageCompressionsRef.current.delete(threadId);
      }
    }
  };

  const removeComposerImage = (imageId: string) => {
    removeComposerImageFromDraft(imageId);
  };

  // ------------------------------------------------------------------
  // Callbacks: paste / drag
  // ------------------------------------------------------------------
  const onComposerPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    const imageFiles = files.filter((file) => file.type.startsWith("image/"));
    if (imageFiles.length === 0) return;
    event.preventDefault();
    void addComposerImages(imageFiles);
  };

  const insertComposerTextAtEnd = (
    text: string,
    options?: { ensureLeadingBoundary?: boolean },
  ): boolean => {
    if (
      text.length === 0 ||
      isConnecting ||
      isComposerApprovalState ||
      pendingUserInputs.length > 0 ||
      projectSelectionRequired
    ) {
      return false;
    }
    const prompt = promptRef.current;
    const needsLeadingSpace =
      (options?.ensureLeadingBoundary ?? false) && prompt.length > 0 && !/\s$/.test(prompt);
    return applyPromptReplacement(
      prompt.length,
      prompt.length,
      needsLeadingSpace ? ` ${text}` : text,
    );
  };

  // File-tree drags land as mentions. Handled in the capture phase so the
  // editor never sees the drop; the load-bearing rules (native stop, "move"
  // effect, no eager focus) live in makeComposerMentionDragHandlers.
  const composerMentionDragHandlers = makeComposerMentionDragHandlers({
    insertMentionAtEnd: (text) => insertComposerTextAtEnd(text, { ensureLeadingBoundary: true }),
    setDragActive: setIsDragOverComposer,
    onInsertRejected: () => {
      toastManager.add({
        type: "error",
        title: "Unable to add to chat",
        description: "The composer is busy; try again once it is ready.",
      });
    },
  });

  const onComposerMentionDragLeaveCapture = (event: React.DragEvent<HTMLFormElement>) => {
    if (!dataTransferHasComposerMention(event.dataTransfer.types)) return;
    event.stopPropagation();
    const nextTarget = event.relatedTarget;
    if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return;
    setIsDragOverComposer(false);
  };

  // A cancelled drag (Escape) can end without a dragleave on the hovered
  // target, which would leave the drop highlight stuck. dragend always fires
  // on the in-page drag source and bubbles to window, so it is the reset of
  // last resort while the highlight is up.
  useEffect(() => {
    if (!isDragOverComposer) return;
    const onWindowDragEnd = () => {
      setIsDragOverComposer(false);
    };
    window.addEventListener("dragend", onWindowDragEnd);
    return () => window.removeEventListener("dragend", onWindowDragEnd);
  }, [isDragOverComposer]);
  const handleInterruptPrimaryAction = useCallback(() => {
    void onInterrupt();
  }, [onInterrupt]);
  const handleImplementPlanInNewThreadPrimaryAction = useCallback(() => {
    void onImplementPlanInNewThread();
  }, [onImplementPlanInNewThread]);
  const scheduleComposerCollapseCheck = useCallback(() => {
    if (!isMobileViewport) {
      return;
    }
    if (mobileComposerExpandInFlightRef.current) {
      return;
    }
    if (composerBlurFrameRef.current !== null) {
      window.cancelAnimationFrame(composerBlurFrameRef.current);
    }
    composerBlurFrameRef.current = window.requestAnimationFrame(() => {
      composerBlurFrameRef.current = null;
      if (mobileComposerExpandInFlightRef.current) {
        return;
      }
      const composerSurface = composerSurfaceRef.current;
      const composerForm = composerFormRef.current;
      const activeElement = document.activeElement;
      if (activeElement instanceof Element && isInsideComposerFloatingLayer(activeElement)) {
        return;
      }
      if (
        activeElement instanceof Node &&
        ((composerSurface && composerSurface.contains(activeElement)) ||
          (composerForm && composerForm.contains(activeElement)))
      ) {
        return;
      }
      setIsComposerFocused(false);
    });
  }, [isMobileViewport]);

  useEffect(() => {
    return () => {
      if (composerBlurFrameRef.current !== null) {
        window.cancelAnimationFrame(composerBlurFrameRef.current);
      }
      if (mobileComposerExpandFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandFrameRef.current);
      }
      if (mobileComposerExpandReleaseFrameRef.current !== null) {
        window.cancelAnimationFrame(mobileComposerExpandReleaseFrameRef.current);
      }
    };
  }, []);

  // ------------------------------------------------------------------
  // Imperative handle
  // ------------------------------------------------------------------
  useImperativeHandle(
    composerRef,
    () => ({
      focusAtEnd: () => {
        composerEditorRef.current?.focusAtEnd();
      },
      focusAt: (cursor: number) => {
        composerEditorRef.current?.focusAt(cursor);
      },
      addDroppedFiles: (files: File[]) => {
        void addComposerImages(files);
        focusComposer();
      },
      insertTextAtEnd: insertComposerTextAtEnd,
      openModelPicker: () => {
        setIsComposerModelPickerOpen(true);
      },
      toggleModelPicker: () => {
        setIsComposerModelPickerOpen((open) => !open);
      },
      isModelPickerOpen: () => isComposerModelPickerOpen,
      canOpenQuickQuestion: () => quickQuestionAvailable,
      openQuickQuestion: () => {
        if (!quickQuestionAvailable) return false;
        setIsQuickQuestionOpen(true);
        return true;
      },
      canOpenSessionResources: () => sessionResourceInventory !== null,
      openSessionResources: () => {
        if (sessionResourceInventory === null) return false;
        setIsSessionResourcesOpen(true);
        return true;
      },
      readSnapshot: () => {
        return readComposerSnapshot();
      },
      resetCursorState: (options?: {
        cursor?: number;
        prompt?: string;
        detectTrigger?: boolean;
      }) => {
        const promptForState = options?.prompt ?? promptRef.current;
        const cursor = clampCollapsedComposerCursor(promptForState, options?.cursor ?? 0);
        setComposerHighlightedItemId(null);
        setComposerCursor(cursor);
        setComposerTrigger(
          options?.detectTrigger
            ? detectComposerTrigger(
                promptForState,
                expandCollapsedComposerCursor(promptForState, cursor),
              )
            : null,
        );
      },
      addTerminalContext: (selection: TerminalContextSelection) => {
        if (!activeThread) return;
        const snapshot = composerEditorRef.current?.readSnapshot() ?? {
          value: promptRef.current,
          cursor: composerCursor,
          expandedCursor: expandCollapsedComposerCursor(promptRef.current, composerCursor),
          terminalContextIds: composerTerminalContexts.map((context) => context.id),
        };
        const insertion = insertInlineTerminalContextPlaceholder(
          snapshot.value,
          snapshot.expandedCursor,
        );
        const nextCollapsedCursor = collapseExpandedComposerCursor(
          insertion.prompt,
          insertion.cursor,
        );
        const inserted = insertComposerDraftTerminalContext(
          composerDraftTarget,
          insertion.prompt,
          {
            id: randomUUID(),
            threadId: activeThread.id,
            createdAt: new Date().toISOString(),
            ...selection,
          },
          insertion.contextIndex,
        );
        if (!inserted) return;
        promptRef.current = insertion.prompt;
        setComposerCursor(nextCollapsedCursor);
        setComposerTrigger(detectComposerTrigger(insertion.prompt, insertion.cursor));
        window.requestAnimationFrame(() => {
          composerEditorRef.current?.focusAt(nextCollapsedCursor);
        });
      },
      getSendContext: () => ({
        prompt: promptRef.current,
        images: composerImagesRef.current,
        terminalContexts: composerTerminalContextsRef.current,
        elementContexts: composerElementContextsRef.current,
        previewAnnotations: composerPreviewAnnotations,
        reviewComments: composerReviewComments,
        selectedPromptEffort,
        selectedModelOptionsForDispatch,
        selectedModelSelection,
        providerAvailable: !noProviderAvailable,
        selectedProvider,
        selectedModel,
        selectedProviderModels,
      }),
      validateProviderInput: (providerInput: string) => {
        const validationMessage = getComposerSubmissionValidationMessage({
          prompt: promptRef.current,
          providerInput,
          submissionTarget: "provider-turn",
        });
        providerInputRejectedRef.current = validationMessage !== null;
        setProviderInputSubmissionError(validationMessage);
        return validationMessage === null;
      },
    }),
    [
      activeThread,
      addComposerImages,
      composerDraftTarget,
      composerCursor,
      composerTerminalContexts,
      insertComposerDraftTerminalContext,
      promptRef,
      composerImagesRef,
      composerTerminalContextsRef,
      composerElementContextsRef,
      composerPreviewAnnotations,
      composerReviewComments,
      focusComposer,
      isConnecting,
      isComposerApprovalState,
      pendingUserInputs.length,
      projectSelectionRequired,
      applyPromptReplacement,
      isComposerModelPickerOpen,
      quickQuestionAvailable,
      sessionResourceInventory,
      readComposerSnapshot,
      selectedModel,
      selectedModelOptionsForDispatch,
      selectedModelSelection,
      noProviderAvailable,
      selectedPromptEffort,
      selectedProvider,
      selectedProviderModels,
    ],
  );

  // Render
  // ------------------------------------------------------------------
  return (
    <>
      <form
        ref={composerFormRef}
        onSubmit={submitComposer}
        onFocusCapture={(event) => {
          const activeElement = event.target;
          if (
            isComposerCollapsedMobile &&
            activeElement instanceof HTMLElement &&
            activeElement.closest('[data-chat-composer-collapsed-controls="true"]')
          ) {
            return;
          }
          if (composerBlurFrameRef.current !== null) {
            window.cancelAnimationFrame(composerBlurFrameRef.current);
            composerBlurFrameRef.current = null;
          }
          setIsComposerFocused(true);
        }}
        onBlurCapture={() => {
          scheduleComposerCollapseCheck();
        }}
        onDragEnterCapture={composerMentionDragHandlers.onDragEnter}
        onDragOverCapture={composerMentionDragHandlers.onDragOver}
        onDragLeaveCapture={onComposerMentionDragLeaveCapture}
        onDropCapture={composerMentionDragHandlers.onDrop}
        className={cn("mx-auto w-full min-w-0 max-w-3xl", hasShoulderTab && "pt-7")}
        data-chat-composer-form="true"
      >
        {/*
        Sits on the composer's top edge rather than inside it: the offer is
        about the thread, not about the message being written, and it must not
        move the input when it appears.
      */}
        <ThreadHandoffTab
          offer={threadHandoffOffer}
          onContinue={onContinueThreadOnAccount}
          isBusy={isContinuingThreadOnAccount}
        />
        {showComposerTopDrawer && (!isTasksDrawerOpen || hasBlockingComposerTopDrawer) ? (
          <div
            className="chat-composer-top-drawer"
            data-chat-composer-top-drawer="true"
            data-variant={activePendingApproval ? "warning" : "info"}
          >
            {!isComposerCollapsedMobile && activePendingApproval ? (
              <div className="flex min-w-0 flex-wrap items-center gap-1 px-3 py-1.5 sm:px-4">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                />
                <div className="flex min-w-0 flex-wrap items-center gap-0.5">
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              </div>
            ) : !isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
              <ComposerPendingUserInputPanel
                pendingUserInputs={pendingUserInputs}
                respondingRequestIds={respondingRequestIds}
                answers={activePendingDraftAnswers}
                questionIndex={activePendingQuestionIndex}
                onToggleOption={onSelectActivePendingUserInputOption}
                onAdvance={onAdvanceActivePendingUserInput}
              />
            ) : !isComposerCollapsedMobile && showPlanFollowUpPrompt && activeProposedPlan ? (
              <ComposerPlanFollowUpBanner
                key={activeProposedPlan.id}
                planTitle={proposedPlanTitle(activeProposedPlan.planMarkdown) ?? null}
              />
            ) : isComposerCollapsedMobile && activePendingApproval ? (
              <div data-chat-composer-collapsed-controls="true">
                <ComposerPendingApprovalPanel
                  approval={activePendingApproval}
                  pendingCount={pendingApprovals.length}
                  className="px-3 pt-2 sm:px-4"
                />
                <div className="flex flex-wrap items-center justify-end gap-1 px-3 pt-2 pb-3 sm:px-4">
                  <ComposerPendingApprovalActions
                    requestId={activePendingApproval.requestId}
                    isResponding={respondingRequestIds.includes(activePendingApproval.requestId)}
                    onRespondToApproval={onRespondToApproval}
                  />
                </div>
              </div>
            ) : isComposerCollapsedMobile && pendingUserInputs.length > 0 ? (
              <div data-chat-composer-collapsed-controls="true">
                <ComposerPendingUserInputPanel
                  pendingUserInputs={pendingUserInputs}
                  respondingRequestIds={respondingRequestIds}
                  answers={activePendingDraftAnswers}
                  questionIndex={activePendingQuestionIndex}
                  onToggleOption={onSelectActivePendingUserInputOption}
                  onAdvance={onAdvanceActivePendingUserInput}
                />
                <div className="px-3 pb-3 sm:px-4">
                  <div
                    data-chat-composer-mobile-pending-compact="true"
                    className={cn(
                      "flex min-w-0 items-center gap-2 rounded-lg border border-border/55 bg-background/55 p-1.5 pl-3 transition-colors hover:bg-background/80",
                      !activePendingProgress?.activeQuestion?.multiSelect && "p-0",
                    )}
                  >
                    <button
                      type="button"
                      className={cn(
                        "min-w-0 flex-1 truncate bg-transparent py-1.5 text-left text-sm",
                        activePendingProgress?.customAnswer
                          ? "text-foreground"
                          : "text-placeholder",
                        !activePendingProgress?.activeQuestion?.multiSelect && "px-3 py-2",
                      )}
                      onPointerDown={(event) => event.preventDefault()}
                      onClick={expandMobileComposer}
                      aria-label="Write custom answer"
                    >
                      {activePendingProgress?.customAnswer || "Write custom answer"}
                    </button>
                    {inlineTasksBadge}
                    {inlineStashBadge}
                    {activePendingProgress?.activeQuestion?.multiSelect ? (
                      <ComposerPrimaryActions
                        compact
                        pendingAction={pendingPrimaryAction}
                        isRunning={false}
                        canQueueFollowUp={false}
                        onQueueFollowUp={() => undefined}
                        showPlanFollowUpPrompt={false}
                        promptHasText={false}
                        isSendBusy={isSendBusy}
                        sendDisabledReason={sendDisabledReason}
                        isConnecting={isConnecting}
                        isEnvironmentUnavailable={
                          environmentUnavailable !== null ||
                          noProviderAvailable ||
                          projectSelectionRequired
                        }
                        isPreparingWorktree={false}
                        hasSendableContent={false}
                        preserveComposerFocusOnPointerDown
                        onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                        onInterrupt={handleInterruptPrimaryAction}
                        onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                      />
                    ) : null}
                  </div>
                </div>
              </div>
            ) : null}
          </div>
        ) : null}
        {isTasksDrawerOpen &&
        !hasBlockingComposerTopDrawer &&
        visibleTasksProgress &&
        visibleTaskSteps ? (
          <ComposerTasksDrawer
            onDismiss={dismissTasks}
            onCollapse={toggleTasksDrawer}
            progress={visibleTasksProgress}
            steps={visibleTaskSteps}
          />
        ) : null}
        <div className="relative">
          {showShoulderTabs && visibleTasksProgress && visibleTaskSteps ? (
            <ComposerTasksBadge
              expanded={false}
              hasTrailingShoulder={stashQueue.length > 0}
              onDismiss={dismissTasks}
              onToggle={toggleTasksDrawer}
              progress={visibleTasksProgress}
              steps={visibleTaskSteps}
            />
          ) : null}
          {showShoulderTabs ? (
            <ComposerStashBadge
              count={stashQueue.length}
              menuOpen={isStashMenuOpen}
              pulseKey={stashPulse.key}
              pulsing={stashPulse.active}
              onToggleMenu={toggleStashMenu}
            />
          ) : null}
          <div
            data-chat-composer-main-surface="true"
            className={cn(
              "group relative z-10 rounded-[22px] p-px transition-colors duration-200",
              composerProviderState.composerFrameClassName,
            )}
          >
            <div
              ref={composerSurfaceRef}
              data-chat-composer-surface="true"
              data-chat-composer-mobile-collapsed={isComposerCollapsedMobile ? "true" : "false"}
              className={cn(
                "rounded-[20px] transition-[background-color] duration-200",
                isDragOverComposer ? "bg-accent/45 ring-1 ring-primary/70" : null,
                projectSelectionRequired ? "opacity-75" : null,
                composerProviderState.composerSurfaceClassName,
              )}
            >
              {showCollapsedMobilePromptRow ? (
                <div className="flex items-center justify-between gap-2 px-3 py-2">
                  <button
                    type="button"
                    className={cn(
                      "min-w-0 flex-1 truncate bg-transparent p-0 text-left text-[14px] focus:outline-none",
                      (activePendingProgress ? activePendingProgress.customAnswer : prompt.trim())
                        ? "text-foreground"
                        : "text-placeholder",
                    )}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={expandMobileComposer}
                    aria-label="Expand composer"
                  >
                    {activePendingProgress
                      ? activePendingProgress.customAnswer ||
                        "Type your own answer, or leave this blank to use the selected option"
                      : prompt.trim() ||
                        (noProviderAvailable ? "Enable a provider in Settings" : "Ask anything...")}
                  </button>
                  {inlineTasksBadge}
                  {inlineStashBadge}
                  <button
                    type="button"
                    className="flex size-8 shrink-0 items-center justify-center rounded-full bg-message-action text-message-action-foreground hover:bg-message-action-hover disabled:opacity-30"
                    disabled={collapsedComposerPrimaryActionDisabled}
                    aria-label={collapsedComposerPrimaryActionLabel}
                    onPointerDown={(event) => event.preventDefault()}
                    onClick={(event) => {
                      event.stopPropagation();
                      submitComposer();
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                      <path
                        d="M8 3L8 13M8 3L4 7M8 3L12 7"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </button>
                </div>
              ) : null}

              <div
                ref={setComposerMenuAnchor}
                className={cn(
                  "relative px-3 pb-2 sm:px-4",
                  "pt-3.5 sm:pt-4",
                  isComposerApprovalState && "pb-3 sm:pb-4",
                  isComposerCollapsedMobile && "hidden",
                )}
              >
                {isStashMenuOpen && !composerMenuOpen && !isComposerApprovalState && (
                  <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                    <ComposerStashMenu
                      entries={stashQueue}
                      onRestore={restoreStashEntry}
                      onDelete={deleteStashEntry}
                      onClose={() => setIsStashMenuOpen(false)}
                    />
                  </ComposerCommandMenuLayer>
                )}

                {composerMenuOpen && !isComposerApprovalState && (
                  <ComposerCommandMenuLayer anchor={composerMenuAnchor}>
                    <ComposerCommandMenu
                      items={composerMenuItems}
                      resolvedTheme={resolvedTheme}
                      isLoading={isComposerMenuLoading}
                      triggerKind={composerTriggerKind}
                      emptyStateText={composerMenuEmptyState}
                      activeItemId={activeComposerMenuItem?.id ?? null}
                      onHighlightedItemChange={onComposerMenuItemHighlighted}
                      onSelect={onSelectComposerItem}
                    />
                  </ComposerCommandMenuLayer>
                )}

                {!isComposerCollapsedMobile &&
                  !isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  composerPreviewAnnotations.length > 0 && (
                    <ComposerPreviewAnnotationCards
                      annotations={composerPreviewAnnotations}
                      images={composerImages}
                      onRemove={(annotationId) =>
                        removeComposerDraftPreviewAnnotation(composerDraftTarget, annotationId)
                      }
                      onExpandImage={(imageId) => {
                        const preview = buildExpandedImagePreview(composerImages, imageId);
                        if (preview) onExpandImage(preview);
                      }}
                      className="mb-3"
                    />
                  )}

                {!isComposerCollapsedMobile &&
                  !isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  composerReviewComments.length > 0 && (
                    <ComposerPendingReviewComments
                      comments={composerReviewComments}
                      onRemove={(commentId) =>
                        removeComposerDraftReviewComment(composerDraftTarget, commentId)
                      }
                      className="mb-3"
                    />
                  )}

                {!isComposerCollapsedMobile &&
                  !isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  composerElementContexts.length > 0 && (
                    <ComposerPendingElementContexts
                      contexts={composerElementContexts}
                      onRemove={(contextId) =>
                        removeComposerDraftElementContext(composerDraftTarget, contextId)
                      }
                      className="mb-3"
                    />
                  )}

                {!isComposerCollapsedMobile &&
                  !isComposerApprovalState &&
                  pendingUserInputs.length === 0 &&
                  composerImages.some(
                    (image) =>
                      !composerPreviewAnnotations.some((annotation) => annotation.id === image.id),
                  ) && (
                    <div className="mb-3 flex flex-wrap gap-2">
                      {composerImages
                        .filter(
                          (image) =>
                            !composerPreviewAnnotations.some(
                              (annotation) => annotation.id === image.id,
                            ),
                        )
                        .map((image) => (
                          <div
                            key={image.id}
                            className="relative h-16 w-16 overflow-hidden rounded-lg border border-border/80 bg-background"
                          >
                            {image.previewUrl ? (
                              <button
                                type="button"
                                className="h-full w-full cursor-zoom-in"
                                aria-label={`Preview ${image.name}`}
                                onClick={() => {
                                  const preview = buildExpandedImagePreview(
                                    composerImages,
                                    image.id,
                                  );
                                  if (!preview) return;
                                  onExpandImage(preview);
                                }}
                              >
                                <img
                                  src={image.previewUrl}
                                  alt={image.name}
                                  className="h-full w-full object-cover"
                                />
                              </button>
                            ) : (
                              <div className="flex h-full w-full items-center justify-center px-1 text-center text-[10px] text-secondary-label">
                                {image.name}
                              </div>
                            )}
                            {nonPersistedComposerImageIdSet.has(image.id) && (
                              <Tooltip>
                                <TooltipTrigger
                                  render={
                                    <span
                                      role="img"
                                      aria-label="Draft attachment may not persist"
                                      className="absolute left-1 top-1 inline-flex items-center justify-center rounded bg-background/85 p-0.5 text-amber-600"
                                    >
                                      <CircleAlertIcon className="size-3" />
                                    </span>
                                  }
                                />
                                <TooltipPopup
                                  side="top"
                                  className="max-w-64 whitespace-normal leading-tight"
                                >
                                  Draft attachment could not be saved locally and may be lost on
                                  navigation.
                                </TooltipPopup>
                              </Tooltip>
                            )}
                            <Button
                              variant="ghost"
                              size="icon-xs"
                              className="absolute right-1 top-1 bg-background/80 hover:bg-background/90"
                              onClick={() => removeComposerImage(image.id)}
                              aria-label={`Remove ${image.name}`}
                            >
                              <XIcon />
                            </Button>
                          </div>
                        ))}
                    </div>
                  )}

                <div className="relative">
                  <ComposerPromptEditor
                    editorRef={composerEditorRef}
                    value={
                      isComposerApprovalState
                        ? ""
                        : activePendingProgress
                          ? activePendingProgress.customAnswer
                          : prompt
                    }
                    cursor={composerCursor}
                    terminalContexts={
                      !isComposerApprovalState && pendingUserInputs.length === 0
                        ? composerTerminalContexts
                        : []
                    }
                    skills={selectedProviderStatus?.skills ?? []}
                    {...(showMobilePendingAnswerActions ? { className: "max-sm:pb-11" } : {})}
                    onRemoveTerminalContext={removeComposerTerminalContextFromDraft}
                    onChange={onPromptChange}
                    onCommandKeyDown={onComposerCommandKey}
                    onPaste={onComposerPaste}
                    placeholder={
                      isComposerApprovalState
                        ? (activePendingApproval?.detail ??
                          "Resolve this approval request to continue")
                        : activePendingProgress
                          ? "Type your own answer, or leave this blank to use the selected option"
                          : showPlanFollowUpPrompt && activeProposedPlan
                            ? "Add feedback to refine the plan, or leave this blank to implement it"
                            : projectSelectionRequired
                              ? "Choose a project above to start a thread"
                              : noProviderAvailable
                                ? "Enable a provider in Settings to send a message"
                                : phase === "disconnected"
                                  ? DISCONNECTED_COMPOSER_PLACEHOLDER
                                  : "Ask anything, @tag files/folders, $use skills, or / for commands"
                    }
                    disabled={isConnecting || isComposerApprovalState || projectSelectionRequired}
                  />
                  {showMobilePendingAnswerActions ? (
                    <div
                      data-chat-composer-mobile-pending-actions="true"
                      className="absolute bottom-0 right-0 flex items-center justify-end gap-1"
                    >
                      {inlineTasksBadge}
                      {inlineStashBadge}
                      <ComposerPrimaryActions
                        compact
                        pendingAction={pendingPrimaryAction}
                        isRunning={false}
                        canQueueFollowUp={false}
                        onQueueFollowUp={() => undefined}
                        showPlanFollowUpPrompt={false}
                        promptHasText={false}
                        isSendBusy={isSendBusy}
                        sendDisabledReason={sendDisabledReason}
                        isConnecting={isConnecting}
                        isEnvironmentUnavailable={
                          environmentUnavailable !== null ||
                          noProviderAvailable ||
                          projectSelectionRequired
                        }
                        isPreparingWorktree={false}
                        hasSendableContent={false}
                        preserveComposerFocusOnPointerDown
                        onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                        onInterrupt={handleInterruptPrimaryAction}
                        onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                      />
                    </div>
                  ) : null}
                </div>
              </div>

              <ComposerPromptLengthValidation
                message={providerInputSubmissionError ?? composerSubmissionError}
              />

              {/* Bottom toolbar */}
              {isComposerCollapsedMobile || isComposerApprovalState ? null : (
                <div
                  data-chat-composer-footer="true"
                  data-chat-composer-footer-compact={isComposerFooterCompact ? "true" : "false"}
                  className={cn(
                    "flex min-w-0 flex-nowrap items-center justify-between gap-2 overflow-visible px-3 pb-3 sm:px-4 sm:pb-4",
                    pendingUserInputs.length > 0 && "pt-2",
                    isComposerFooterCompact ? "gap-1.5" : "gap-2 sm:gap-0",
                    showMobilePendingAnswerActions && "hidden sm:flex",
                  )}
                >
                  <div className="-m-1 -ms-3.5 flex min-w-0 flex-1 items-center gap-1 overflow-x-auto p-1 ps-3.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
                    {noProviderAvailable ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled
                        data-chat-provider-unavailable="true"
                        className="shrink-0 gap-2 px-2 text-secondary-label sm:px-3"
                      >
                        <CircleAlertIcon className="size-4" />
                        No provider available
                      </Button>
                    ) : (
                      <ProviderModelPicker
                        compact={isComposerFooterCompact}
                        activeInstanceId={selectedInstanceId}
                        model={selectedModelForPickerWithCustomFallback}
                        lockedProvider={lockedProvider}
                        lockedContinuationGroupKey={lockedContinuationGroupKey}
                        instanceEntries={providerInstanceEntries}
                        keybindings={keybindings}
                        modelOptionsByInstance={modelOptionsByInstance}
                        triggerClassName="-ms-2.5"
                        terminalOpen={terminalOpen}
                        open={isComposerModelPickerOpen}
                        {...(composerProviderState.modelPickerIconClassName
                          ? {
                              activeProviderIconClassName:
                                composerProviderState.modelPickerIconClassName,
                            }
                          : {})}
                        onOpenChange={(open) => {
                          setIsComposerModelPickerOpen(open);
                        }}
                        getModelDisabledReason={getModelDisabledReason}
                        onInstanceModelChange={onProviderModelSelect}
                      />
                    )}

                    {isComposerFooterCompact ? (
                      <CompactComposerControlsMenu
                        interactionMode={interactionMode}
                        runtimeMode={resolvedRuntimeMode}
                        supportedRuntimeModes={composerProviderControls.supportedRuntimeModes}
                        showInteractionModeToggle={
                          composerProviderControls.showInteractionModeToggle
                        }
                        traitsMenuContent={providerTraitsMenuContent}
                        onToggleInteractionMode={toggleInteractionMode}
                        onRuntimeModeChange={handleRuntimeModeChange}
                      />
                    ) : (
                      <>
                        {providerTraitsPicker ? (
                          <>
                            <Separator
                              orientation="vertical"
                              className="mx-0.5 hidden h-4 sm:block"
                            />
                            {providerTraitsPicker}
                          </>
                        ) : null}
                        <ComposerFooterModeControls
                          showInteractionModeToggle={
                            composerProviderControls.showInteractionModeToggle
                          }
                          interactionMode={interactionMode}
                          runtimeMode={resolvedRuntimeMode}
                          supportedRuntimeModes={composerProviderControls.supportedRuntimeModes}
                          onToggleInteractionMode={toggleInteractionMode}
                          onRuntimeModeChange={handleRuntimeModeChange}
                        />
                      </>
                    )}
                    {quickQuestionAvailable ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <ComposerControl
                              type="button"
                              data-testid="quick-question-trigger"
                              aria-label="Quick question"
                              className="shrink-0"
                              onClick={() => setIsQuickQuestionOpen(true)}
                            />
                          }
                        >
                          <ComposerControlIcon icon={MessageCircleQuestionIcon} />
                          {!isComposerFooterCompact ? <span>Quick question</span> : null}
                        </TooltipTrigger>
                        <TooltipPopup side="top">Quick question</TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {showSessionInputQueueModes && sessionInputQueue ? (
                      <SessionInputQueueControl
                        snapshot={sessionInputQueue}
                        count={sessionInputCount}
                        canSetModes={canSetSessionInputQueueModes}
                        isSettingMode={isSettingSessionInputQueueMode}
                        canClear={canClearSessionInputQueue}
                        isClearing={isClearingSessionInputQueue}
                        canRemove={canRemoveOnlySessionInputQueueItem}
                        isRemoving={isRemovingSessionInputQueueItem}
                        onSetMode={(queue, value) => void setSessionInputQueueMode(queue, value)}
                        onRemove={(queue) => void removeOnlySessionInputQueueItem(queue)}
                        onClear={() => void clearSessionInputQueue()}
                      />
                    ) : showSessionInputQueue ? (
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <ComposerControl
                              type="button"
                              aria-label={`Session inputs ${sessionInputCount}: ${sessionInputQueue?.steeringCount ?? 0} steering, ${sessionInputQueue?.followUpCount ?? 0} follow-ups. Clear all pending inputs`}
                              disabled={!canClearSessionInputQueue || isClearingSessionInputQueue}
                              onClick={() => void clearSessionInputQueue()}
                            />
                          }
                        >
                          <span className="text-xs font-medium">
                            Session inputs · {sessionInputCount}
                          </span>
                          <ComposerControlIcon icon={XIcon} />
                        </TooltipTrigger>
                        <TooltipPopup side="top">
                          {isClearingSessionInputQueue
                            ? "Clearing pending session inputs…"
                            : "Clear all pending session inputs"}
                        </TooltipPopup>
                      </Tooltip>
                    ) : null}
                    {showSessionAgentDepth ||
                    sessionResourceInventory !== null ||
                    showSessionResourceReload ? (
                      <SessionHarnessControl
                        agentDepth={showSessionAgentDepth ? sessionAgentDepth : null}
                        agentDepthDisabled={sessionAgentDepthDisabled}
                        agentDepthAccessibleLabel={
                          showSessionAgentDepth ? sessionAgentDepthAccessibleLabel : null
                        }
                        resourceInventory={sessionResourceInventory}
                        showResourceReload={showSessionResourceReload}
                        resourceReloadDisabled={sessionResourceReloadDisabled}
                        isReloadingResources={isReloadingSessionResources}
                        onSetAgentDepth={(maxDepth) => void setSessionAgentDepth(String(maxDepth))}
                        onOpenResources={() => setIsSessionResourcesOpen(true)}
                        onReloadResources={() => void reloadSessionResources()}
                      />
                    ) : null}
                  </div>

                  {/* Right side: send / stop button */}
                  <div
                    data-chat-composer-actions="right"
                    data-chat-composer-primary-actions-compact={
                      isComposerPrimaryActionsCompact ? "true" : "false"
                    }
                    className="flex shrink-0 flex-nowrap items-center justify-end gap-2"
                  >
                    {showMobilePendingAnswerActions ? null : inlineTasksBadge}
                    {showMobilePendingAnswerActions ? null : inlineStashBadge}
                    <ComposerFooterPrimaryActions
                      compact={isComposerPrimaryActionsCompact}
                      activeContextWindow={activeContextWindow}
                      activeThreadModelDisplayName={activeThreadModelDisplayName}
                      activeProviderUsageAccounts={activeProviderUsageAccounts}
                      timestampFormat={settings.timestampFormat}
                      contextCompaction={contextCompactionControl}
                      harnessRefinement={sessionHarnessRefinementControl}
                      sessionGoal={sessionGoal}
                      pendingAction={pendingPrimaryAction}
                      isRunning={phase === "running"}
                      canQueueFollowUp={canQueueSessionFollowUp}
                      onQueueFollowUp={onQueueFollowUp}
                      showPlanFollowUpPrompt={
                        pendingUserInputs.length === 0 && showPlanFollowUpPrompt
                      }
                      promptHasText={prompt.trim().length > 0}
                      isSendBusy={isSendBusy}
                      sendDisabledReason={sendDisabledReason}
                      isConnecting={isConnecting}
                      isEnvironmentUnavailable={
                        environmentUnavailable !== null ||
                        noProviderAvailable ||
                        projectSelectionRequired
                      }
                      isPreparingWorktree={isPreparingWorktree}
                      hasSendableContent={composerSendState.hasSendableContent}
                      preserveComposerFocusOnPointerDown={isMobileViewport}
                      showSendWhileRunning={isMobileViewport}
                      onPreviousPendingQuestion={onPreviousActivePendingUserInputQuestion}
                      onInterrupt={handleInterruptPrimaryAction}
                      onImplementPlanInNewThread={handleImplementPlanInNewThreadPrimaryAction}
                    />
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </form>
      <QuickQuestionDialog
        available={quickQuestionAvailable}
        identity={quickQuestionIdentity}
        open={isQuickQuestionOpen}
        onOpenChange={setIsQuickQuestionOpen}
        onAsk={onAskQuickQuestion}
        onCancel={onCancelQuickQuestion}
      />
      {sessionResourceInventory !== null && activeSessionResources !== null ? (
        <SessionResourcesDialog
          identity={sessionResourcesIdentity}
          inventory={sessionResourceInventory}
          snapshot={activeSessionResources}
          open={isSessionResourcesOpen}
          onOpenChange={setIsSessionResourcesOpen}
          showReload={showSessionResourceReload}
          reloadDisabled={sessionResourceReloadDisabled}
          isReloading={isReloadingSessionResources}
          onReload={reloadSessionResources}
        />
      ) : null}
    </>
  );
});
