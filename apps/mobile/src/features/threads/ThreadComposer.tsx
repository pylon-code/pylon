import { useAtomValue } from "@effect/atom-react";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { resolveProviderContinuationTransition } from "@t3tools/client-runtime/providerContinuation";
import {
  formatSessionGoalStatus,
  type SessionGoalSnapshot,
} from "@t3tools/client-runtime/state/session-goal";
import {
  canAbortSessionCompaction,
  canConfigureSessionAutoCompaction,
  canStartSessionCompaction,
  isSessionCompactionInProgress,
  type SessionCompactionControlSnapshot,
} from "@t3tools/client-runtime/state/context-compaction";
import {
  canMessageSessionAgent,
  isActiveSubagentStatus,
  supportsSessionAgentCancel,
  supportsSessionAgentMessage,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  canWatchSessionAgentLiveActivity,
  sessionAgentLiveActivitySelectionIsOpen,
  type SessionAgentLiveActivitySelection,
} from "@t3tools/client-runtime/state/session-agent-live-activity";
import {
  hasSessionInputQueueModes,
  sessionInputQueueCount,
  supportsSessionInputQueue,
  supportsSessionInputQueueClear,
  supportsSessionInputQueueFollowUp,
  supportsSessionInputQueueRemove,
  supportsSessionInputQueueSetModes,
  type SessionInputQueueSnapshot,
} from "@t3tools/client-runtime/state/session-input-queue";
import {
  canSetSessionAgentDepth,
  supportsSessionAgentDepth,
  type SessionAgentDepthSnapshot,
} from "@t3tools/client-runtime/state/session-agent-depth";
import {
  presentSessionResourceInventory,
  sessionResourceViewIdentity,
  supportsSessionResourceReload,
  type SessionResourcesSnapshot,
} from "@t3tools/client-runtime/state/session-resources";
import { PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS } from "@t3tools/contracts";
import { isPrimeAgentDefaultModelUnavailable } from "@t3tools/shared/model";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderAskSessionSideQuestionResult,
  ProviderInteractionMode,
  ProviderRefineSessionHarnessResult,
  ProviderSessionSideQuestionRequestId,
  RuntimeMode,
  ServerConfig as T3ServerConfig,
} from "@t3tools/contracts";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Alert,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  useColorScheme,
  View,
  type ViewStyle,
} from "react-native";
import { FilePreviewModal, type FilePreviewSource } from "../../components/FilePreviewModal";
import {
  composerAttachmentUploadBlockReason,
  composerAttachmentUploadsAtom,
} from "../../state/composer-attachment-uploads";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  LinearTransition,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useUniwindTheme } from "../../lib/useUniwindTheme";
import { presentMobileContextWindow } from "../../lib/contextWindow";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentButton } from "../../components/ComposerAttachmentButton";
import {
  ComposerAttachmentStrip,
  ComposerAttachmentThumbnail,
} from "../../components/ComposerAttachmentStrip";
import { VideoPreviewModal, type VideoPreviewSource } from "../../components/VideoPreviewModal";
import { GlassSurface } from "../../components/GlassSurface";
import { ComposerEditor, type ComposerEditorHandle } from "../../components/ComposerEditor";
import {
  ComposerInlineControl,
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import type {
  DraftComposerAttachment,
  DraftComposerFileAttachment,
} from "../../lib/composerImages";
import {
  buildModelOptions,
  type ModelOption,
  groupByProvider,
  resolveModelSelectionRuntimeMode,
  showModelSelectionInteractionModeToggle,
} from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { ComposerCommandPopover } from "./ComposerCommandPopover";
import { ProviderUnavailableNotice } from "./ProviderUnavailableNotice";
import {
  resolveThreadComposerAdmissionReason,
  resolveThreadComposerAuthority,
  threadComposerShowsStopAction,
} from "./ThreadComposer.logic";
import { useComposerCommandMenu } from "./use-composer-command-menu";
import {
  ComposerDictationCancelAction,
  ComposerDictationDraftContent,
  ComposerDictationPrimaryAction,
  ComposerDictationStatus,
  ComposerDictationToolbar,
} from "../voice-input/ComposerDictationControl";
import { useVoiceInputController } from "../voice-input/useVoiceInputController";
import { resolveVoiceComposerPresentation } from "../voice-input/voiceInputPresentation";
import {
  type ExistingThreadSettingsRouteSession,
  useExistingThreadSettingsRoutePresentation,
} from "./ThreadSettingsSheet";
import {
  useThreadSettingsSheetPresentation,
  type NavigationWithFinishTransitioning,
} from "./use-thread-settings-sheet-presentation";
import {
  buildSessionInputQueueMenuActions,
  parseSessionInputQueueModeAction,
  parseSessionInputQueueRemoveAction,
} from "./sessionInputQueueMenu";
import {
  buildSessionCompactionMenuActions,
  parseSessionCompactionMenuAction,
  type SessionCompactionMenuAction,
} from "./sessionCompactionMenu";
import { buildSessionAgentMenuActions, parseSessionAgentMenuAction } from "./sessionAgentMenu";
import { buildSessionGoalMenuActions } from "./sessionGoalMenu";
import {
  buildSessionHarnessRefinementMenuActions,
  canRefineSessionHarness,
  parseSessionHarnessRefinementAction,
  sessionHarnessRefinementScopeKey as buildSessionHarnessRefinementScopeKey,
} from "./sessionHarnessRefinementMenu";
import { SessionAgentLiveActivityModal } from "./SessionAgentLiveActivityModal";
import { SessionResourcesModal } from "./SessionResourcesModal";
import { QuickQuestionModal, QuickQuestionTrigger } from "./QuickQuestionModal";
import {
  canOpenQuickQuestion,
  quickQuestionOpenScopeAfterAvailability,
  quickQuestionSessionScopeKey,
} from "./quickQuestionToolbar";

const AGENT_MESSAGE_UNAVAILABLE_ERROR = "This agent is no longer available for direct messages.";

/**
 * Height of the collapsed composer (pill + vertical padding, excluding safe-area inset).
 * Exported so the parent can compute feed overlap / content insets.
 */
export const COMPOSER_COLLAPSED_CHROME = 60;

/**
 * Height of the expanded composer (card + toolbar + vertical padding, excluding safe-area inset).
 * Used by the parent to compute the larger feed bottom inset when the composer is focused.
 */
export const COMPOSER_EXPANDED_CHROME = 156;

export interface ThreadComposerProps {
  readonly draftMessage: string;
  readonly draftAttachments: ReadonlyArray<DraftComposerAttachment>;
  readonly placeholder: string;
  readonly contentMaxWidth?: number;
  readonly bottomInset?: number;
  readonly connectionState: RemoteClientConnectionState;
  readonly connectionError: string | null;
  readonly environmentLabel: string | null;
  /**
   * Message sync phase for the selected thread (drives the status pill):
   * "loading" = first fetch, nothing to show yet; "syncing" = cached messages
   * are on screen while they reconcile with the server.
   */
  readonly threadSyncPhase?: "loading" | "syncing" | null;
  readonly selectedThread: OrchestrationThreadShell;
  readonly serverConfig: T3ServerConfig | null;
  readonly localOutboxCount: number;
  readonly onManagePendingSends: () => void;
  readonly contextWindow: ContextWindowSnapshot | null;
  readonly sessionResources: SessionResourcesSnapshot | null;
  readonly sessionAgentDepth: SessionAgentDepthSnapshot | null;
  readonly sessionAgents: ReadonlyArray<RuntimeSubagent>;
  readonly sessionInputQueue: SessionInputQueueSnapshot | null;
  readonly sessionGoal: SessionGoalSnapshot | null;
  readonly sessionCompaction: SessionCompactionControlSnapshot | null;
  readonly sessionCompactionScopeKey: string | null;
  readonly sessionCompactionPendingAction: SessionCompactionMenuAction | null;
  readonly activeThreadBusy: boolean;
  readonly sessionInputBlocked: boolean;
  readonly environmentId: EnvironmentId;
  readonly projectCwd: string | null;
  readonly editorRef?: RefObject<ComposerEditorHandle | null>;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onPickDraftMedia: () => Promise<void>;
  readonly onPickDraftFiles: () => Promise<void>;
  readonly onNativePasteImages: (uris: ReadonlyArray<string>) => Promise<void>;
  readonly onRemoveDraftImage: (imageId: string) => void;
  readonly onStopThread: () => void;
  readonly onReloadSessionResources: () => Promise<void>;
  readonly onRefineSessionHarness: () => Promise<ProviderRefineSessionHarnessResult | null>;
  readonly onAskSessionSideQuestion: (
    requestId: ProviderSessionSideQuestionRequestId,
    question: string,
  ) => Promise<ProviderAskSessionSideQuestionResult | null>;
  readonly onCancelSessionSideQuestion: (
    requestId: ProviderSessionSideQuestionRequestId,
  ) => Promise<void>;
  readonly onSetSessionAgentDepth: (maxDepth: number) => Promise<void>;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onQueueFollowUp: () => Promise<MessageId | null>;
  readonly onClearSessionInputQueue: () => Promise<boolean>;
  readonly onRemoveOnlySessionInputQueueItem: (queue: "steering" | "follow-up") => Promise<boolean>;
  readonly onSetSessionInputQueueMode: (
    queue: "steering" | "follow-up",
    mode: "all-at-once" | "one-at-a-time",
  ) => Promise<boolean>;
  readonly onRunSessionCompactionAction: (action: SessionCompactionMenuAction) => Promise<boolean>;
  readonly onCancelSessionAgent: (agentId: string) => Promise<boolean>;
  readonly onMessageSessionAgent: (
    agentId: string,
    message: string,
  ) => Promise<"delivered" | "queued" | "delivery-unknown" | null>;
  readonly onUpdateModelSelection: (modelSelection: ModelSelection) => void;
  readonly onUpdateRuntimeMode: (runtimeMode: RuntimeMode) => void;
  readonly onUpdateInteractionMode: (interactionMode: ProviderInteractionMode) => void;
  readonly onReconnectEnvironment: () => void;
  readonly onExpandedChange?: (expanded: boolean) => void;
  /** Fires on editor focus/blur; hosts use it to vet stale keyboard state. */
  readonly onEditorFocusChange?: (focused: boolean) => void;
}

/**
 * The pill / card container — renders with Expo's native GlassView on supported
 * iOS 26+ devices and keeps the existing opaque fallback elsewhere.
 * Exported so NewTaskDraftScreen can render the same composer chrome.
 */
// One timing for every piece of the expanded↔compact morph so the surface,
// toolbar, and siblings move together instead of popping between layouts.
// Android gets NO layout transition: the composer rides the keyboard via
// KeyboardStickyView (frame-synced to the IME), and a time-based morph
// running alongside that translate reads as jitter. Snapping the layout and
// letting the keyboard-synced slide be the only motion looks native there.
export const COMPOSER_TRANSITION_DURATION_MS = 220;
export const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android"
    ? undefined
    : LinearTransition.duration(COMPOSER_TRANSITION_DURATION_MS).reduceMotion(ReduceMotion.System);

const AnimatedGlassSurface = Animated.createAnimatedComponent(GlassSurface);

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  /** Morphs between the compact and expanded composer layouts. */
  readonly animateLayout?: boolean;
}) {
  // Drop shadow lives on a wrapper: `overflow: "hidden"` on the surface itself
  // (needed to clip content to the pill shape) would clip the shadow on iOS.
  //
  // The colour is set here rather than through a `shadow-adaptive-*` class. A
  // bare Tailwind shadow-colour utility emits only `--tw-shadow-color` and no
  // `box-shadow`, and Uniwind's native store only maps a style when
  // `result.boxShadow` is defined — so the class contributes nothing to the RN
  // style and `shadowOpacity: 1` would fall back to RN's default opaque black.
  const shadowColor = useUniwindTheme()["--color-primary-shadow"];
  const isDarkMode = useColorScheme() === "dark";
  // #8793's shape morph, adopted without its toolbar restructure. Animating the
  // radius on a shared value keeps the pill/card corners interpolating with the
  // layout instead of snapping on the first frame. Every native frame carries
  // the same transition: animating only the outer clip leaves the glass and the
  // content at their final height immediately.
  const targetBorderRadius =
    typeof props.style.borderRadius === "number" ? props.style.borderRadius : 0;
  const animatedBorderRadius = useSharedValue(targetBorderRadius);
  const shouldAnimate = props.animateLayout !== false && Platform.OS !== "android";
  useLayoutEffect(() => {
    animatedBorderRadius.value = shouldAnimate
      ? withTiming(targetBorderRadius, {
          duration: COMPOSER_TRANSITION_DURATION_MS,
          reduceMotion: ReduceMotion.System,
        })
      : targetBorderRadius;
  }, [animatedBorderRadius, shouldAnimate, targetBorderRadius]);
  const animatedShapeStyle = useAnimatedStyle(() => ({
    borderRadius: animatedBorderRadius.value,
  }));
  const layoutTransition = shouldAnimate ? COMPOSER_LAYOUT_TRANSITION : undefined;
  const shadowStyle: ViewStyle = {
    shadowColor,
    shadowOpacity: isDarkMode ? 0.35 : 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  };

  return (
    <Animated.View layout={layoutTransition} style={[shadowStyle, animatedShapeStyle]}>
      <AnimatedGlassSurface
        chrome="none"
        fallbackClassName="border border-border bg-card-translucent"
        glassEffectStyle="regular"
        // Keep native glass out of the interactive content's layout path: the
        // content is now a sibling of this layer, not a child of it.
        pointerEvents="none"
        tintColor="transparent"
        layout={layoutTransition}
        style={[{ position: "absolute", inset: 0 }, animatedShapeStyle]}
      >
        {null}
      </AnimatedGlassSurface>
      <Animated.View
        collapsable={false}
        layout={layoutTransition}
        style={[props.style, animatedShapeStyle]}
      >
        {props.children}
      </Animated.View>
    </Animated.View>
  );
}

type ComposerStatusPillState = {
  readonly kind: "unavailable" | "reconnecting" | "syncing";
  readonly label: string;
};

function composerConnectionStatus(input: {
  readonly connectionError: string | null;
  readonly connectionState: RemoteClientConnectionState;
  readonly environmentLabel: string | null;
  readonly threadSyncPhase?: "loading" | "syncing" | null;
}): ComposerStatusPillState | null {
  const environmentLabel = input.environmentLabel ?? "Environment";

  switch (input.connectionState) {
    case "connecting":
    case "reconnecting":
      return {
        kind: "reconnecting",
        label:
          input.connectionError === null
            ? `Reconnecting to ${environmentLabel}...`
            : `Failed to connect. Retrying ${environmentLabel}...`,
      };
    case "offline":
      return { kind: "unavailable", label: "You are offline" };
    case "error":
      return {
        kind: "unavailable",
        label: input.connectionError
          ? `Failed to connect to ${environmentLabel}: ${input.connectionError}`
          : `Failed to connect to ${environmentLabel}`,
      };
    case "available":
      return { kind: "unavailable", label: `${environmentLabel} is not connected` };
    case "connected":
      break;
  }

  // Connected: the pill is the single loading/sync indicator. One stable
  // label per open — "Loading" when starting from scratch, "Syncing" when
  // cached messages are already visible.
  switch (input.threadSyncPhase) {
    case "loading":
      return { kind: "syncing", label: "Loading messages..." };
    case "syncing":
      return { kind: "syncing", label: "Syncing messages..." };
    default:
      return null;
  }
}

const ComposerConnectionStatusPill = memo(function ComposerConnectionStatusPill(props: {
  readonly onPress: () => void;
  readonly status: ComposerStatusPillState;
}) {
  const isReconnecting = props.status.kind !== "unavailable";
  return (
    <Animated.View
      className="absolute inset-x-0 bottom-full items-center pb-2"
      entering={FadeInDown.duration(180)}
      exiting={FadeOutDown.duration(140)}
      pointerEvents="box-none"
    >
      <Pressable
        accessibilityRole="button"
        onPress={props.onPress}
        className="max-w-full flex-row items-center gap-2 rounded-full bg-card px-3 py-2 shadow-sm active:opacity-70"
      >
        {isReconnecting ? (
          <ActivityIndicator size="small" colorClassName={"accent-icon-muted"} />
        ) : (
          <View className="h-2 w-2 rounded-full bg-red-500" />
        )}
        <Text
          className="max-w-[260px] text-sm font-t3-bold leading-snug text-foreground"
          numberOfLines={1}
        >
          {props.status.label}
        </Text>
      </Pressable>
    </Animated.View>
  );
});

const ContextWindowIndicator = memo(function ContextWindowIndicator(props: {
  readonly snapshot: ContextWindowSnapshot;
  readonly expanded: boolean;
}) {
  const presentation = presentMobileContextWindow(props.snapshot);
  if (presentation === null) return null;
  const knownMaximum = props.snapshot.maxTokens !== null;
  return (
    <View
      accessible
      accessibilityLabel="Context window usage"
      accessibilityRole={knownMaximum ? "progressbar" : "text"}
      accessibilityValue={
        knownMaximum
          ? {
              min: 0,
              max: props.snapshot.maxTokens ?? undefined,
              now: Math.min(props.snapshot.usedTokens, props.snapshot.maxTokens ?? 0),
              text: presentation.accessibilityText,
            }
          : undefined
      }
      className="mx-1 rounded-full bg-subtle px-2.5 py-1"
    >
      <Text
        className={
          presentation.warning
            ? "text-xs font-t3-bold tabular-nums text-danger-foreground"
            : "text-xs font-t3-medium tabular-nums text-foreground-muted"
        }
        numberOfLines={1}
      >
        {props.expanded ? presentation.expandedLabel : presentation.compactLabel}
      </Text>
    </View>
  );
});

export const ThreadComposer = memo(function ThreadComposer(props: ThreadComposerProps) {
  const navigation = useNavigation();
  const foregroundColor = useUniwindTheme()["--color-foreground"];
  const bodyText = useScaledTextRole("body");
  const fallbackInputRef = useRef<ComposerEditorHandle>(null);
  const inputRef = props.editorRef ?? fallbackInputRef;
  const [isFocused, setIsFocused] = useState(false);
  const settingsSheetPresentation = useThreadSettingsSheetPresentation({
    editorRef: inputRef,
    isEditorFocused: isFocused,
  });
  const settingsRoutePresentation = useExistingThreadSettingsRoutePresentation();
  const settingsRoutePresentedRef = useRef(false);
  const wasExpandedBeforePreviewRef = useRef(false);
  const inFlightThreadIdsRef = useRef(new Set<string>());
  const { onExpandedChange } = props;

  const [previewFile, setPreviewFile] = useState<FilePreviewSource | null>(null);
  const [previewVideo, setPreviewVideo] = useState<VideoPreviewSource | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  // Opening and presentation count as active so the composer stays expanded
  // while focus moves between its native editor and the settings picker.
  const isExpanded = isFocused || settingsSheetPresentation.isActive;

  // Notify the parent from the derived value, not focus events: the parent
  // sizes the feed inset from this, and blur-during-sheet would otherwise
  // report collapsed while the composer still renders expanded.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressPreview = useCallback(
    (source: FilePreviewSource) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewVideo(null);
      setPreviewFile((current) => current ?? source);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewFile(null);
    setPreviewVideo(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => {
        if (navigation.isFocused()) inputRef.current?.focus();
      }, 100);
    }
  }, [inputRef, navigation]);

  const onPressVideo = useCallback(
    (attachment: DraftComposerFileAttachment, sourceIdentifier: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewFile(null);
      setPreviewVideo((current) => current ?? { type: "local", attachment, sourceIdentifier });
    },
    [isFocused],
  );

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange]);
  const composerAuthority = resolveThreadComposerAuthority({
    serverConfig: props.serverConfig,
    modelSelection: props.selectedThread.modelSelection,
    sessionProviderInstanceId: props.selectedThread.session?.providerInstanceId,
  });
  // #8843: an empty composer shows the interrupt button while the agent works;
  // adding text or an attachment swaps it for send. Provider admission never
  // removes that active turn escape hatch.
  const showStopAction =
    !hasContent && threadComposerShowsStopAction(props.selectedThread.session?.status);
  // A mismatched persisted selection is presentation-only. Admission remains
  // blocked until the user selects an exact model for the bound instance.
  const currentModelSelection =
    composerAuthority.modelSelection ?? props.selectedThread.modelSelection;
  const currentRuntimeMode = resolveModelSelectionRuntimeMode(
    props.serverConfig,
    currentModelSelection,
    props.selectedThread.runtimeMode,
  );
  const showInteractionModeToggle = showModelSelectionInteractionModeToggle(
    props.serverConfig,
    currentModelSelection,
  );
  const connectionStatus = composerConnectionStatus({
    connectionError: props.connectionError,
    connectionState: props.connectionState,
    environmentLabel: props.environmentLabel,
    threadSyncPhase: props.threadSyncPhase,
  });
  const selectedProviderStatus = composerAuthority.provider;
  const providerAdmissionReason = composerAuthority.providerAdmissionReason;
  const projectAdmissionReason =
    props.projectCwd === null ? "This thread's project workspace is unavailable." : null;
  const blockingAdmissionReason = providerAdmissionReason ?? projectAdmissionReason;
  const composerAdmissionReason = resolveThreadComposerAdmissionReason({
    providerReason: providerAdmissionReason,
    projectCwd: props.projectCwd,
    connectionState: props.connectionState,
  });
  const selectedProviderUnavailable =
    blockingAdmissionReason === null
      ? null
      : { headline: "Unavailable" as const, detail: blockingAdmissionReason };
  const uploadStates = useAtomValue(composerAttachmentUploadsAtom);
  const attachmentBlockReason = composerAttachmentUploadBlockReason({
    environmentId: props.environmentId,
    attachments: props.draftAttachments,
    connected: props.connectionState === "connected",
    serverConfig: props.serverConfig,
    states: uploadStates,
  });
  const canSend =
    hasContent &&
    !props.sessionInputBlocked &&
    composerAuthority.providerAdmissionAvailable &&
    props.projectCwd !== null &&
    attachmentBlockReason === null &&
    props.sessionCompactionPendingAction !== "compact" &&
    !isSessionCompactionInProgress(props.sessionCompaction);
  const activeSessionProviderStatus = useMemo(() => {
    const instanceId = props.selectedThread.session?.providerInstanceId;
    if (!props.serverConfig || instanceId === undefined) return null;
    return (
      props.serverConfig.providers.find((provider) => provider.instanceId === instanceId) ?? null
    );
  }, [props.selectedThread.session?.providerInstanceId, props.serverConfig]);
  const modelChangesLocked =
    props.selectedThread.session != null &&
    (selectedProviderStatus?.requiresNewThreadForModelChange === true ||
      activeSessionProviderStatus?.requiresNewThreadForModelChange === true);
  const getModelChangeDisabledReason = useCallback(
    (option: ModelOption) => {
      if (props.sessionInputBlocked) {
        return "Provider changes are blocked while this thread has a pending safety operation";
      }
      const boundInstanceId = props.selectedThread.session?.providerInstanceId;
      if (boundInstanceId) {
        const transition = resolveProviderContinuationTransition({
          providers: props.serverConfig?.providers ?? [],
          currentInstanceId: boundInstanceId,
          targetInstanceId: option.selection.instanceId,
        });
        if (!transition.compatible) return transition.reason;
      }
      const isCurrent =
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model;
      if (isCurrent || props.selectedThread.session == null) return undefined;
      if (
        isPrimeAgentDefaultModelUnavailable({
          providerDriver: option.providerDriver,
          nextModel: option.selection.model,
          currentModel: currentModelSelection.model,
          hasStartedSession: true,
        })
      ) {
        return "Start a new thread to use Prime Agent Default";
      }
      return modelChangesLocked || option.requiresNewThreadForModelChange
        ? "Start a new thread to use this model"
        : undefined;
    },
    [
      currentModelSelection,
      modelChangesLocked,
      props.selectedThread.session,
      props.serverConfig,
      props.sessionInputBlocked,
    ],
  );
  const quickQuestionAvailable =
    !props.sessionInputBlocked &&
    canOpenQuickQuestion({
      connectionState: props.connectionState,
      session: props.selectedThread.session,
      provider: activeSessionProviderStatus,
    });
  const quickQuestionScopeKey = quickQuestionSessionScopeKey({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    providerInstanceId: props.selectedThread.session?.providerInstanceId,
    sessionStartedAt: props.selectedThread.session?.startedAt,
  });
  const [quickQuestionOpenScopeKey, setQuickQuestionOpenScopeKey] = useState<string | null>(null);
  useEffect(() => {
    setQuickQuestionOpenScopeKey((current) =>
      quickQuestionOpenScopeAfterAvailability(current, quickQuestionAvailable),
    );
  }, [quickQuestionAvailable]);
  const sessionHarnessRefinementScopeKey = buildSessionHarnessRefinementScopeKey({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    providerInstanceId: props.selectedThread.session?.providerInstanceId,
    sessionStartedAt: props.selectedThread.session?.startedAt,
  });
  const sessionHarnessRefinementAvailable = canRefineSessionHarness({
    connectionState: props.connectionState,
    session: props.selectedThread.session,
    provider: activeSessionProviderStatus,
  });
  const [sessionHarnessRefinementPendingScopeKey, setSessionHarnessRefinementPendingScopeKey] =
    useState<string | null>(null);
  const sessionHarnessRefinementPendingRef = useRef<string | null>(null);
  const sessionHarnessRefinementOutcomeUnknownRef = useRef<string | null>(null);
  const [
    sessionHarnessRefinementOutcomeUnknownScopeKey,
    setSessionHarnessRefinementOutcomeUnknownScopeKey,
  ] = useState<string | null>(null);
  const sessionHarnessRefinementControlRef = useRef({
    scopeKey: sessionHarnessRefinementScopeKey,
    available:
      sessionHarnessRefinementAvailable &&
      (props.selectedThread.session?.harnessRefinementStatus === undefined ||
        props.selectedThread.session.harnessRefinementStatus === "available"),
    onRefine: props.onRefineSessionHarness,
  });
  sessionHarnessRefinementControlRef.current = {
    scopeKey: sessionHarnessRefinementScopeKey,
    available:
      sessionHarnessRefinementAvailable &&
      (props.selectedThread.session?.harnessRefinementStatus === undefined ||
        props.selectedThread.session.harnessRefinementStatus === "available"),
    onRefine: props.onRefineSessionHarness,
  };
  useEffect(() => {
    sessionHarnessRefinementPendingRef.current = null;
    sessionHarnessRefinementOutcomeUnknownRef.current = null;
    setSessionHarnessRefinementPendingScopeKey(null);
    setSessionHarnessRefinementOutcomeUnknownScopeKey(null);
  }, [sessionHarnessRefinementScopeKey]);
  useEffect(() => {
    if (
      props.selectedThread.session?.harnessRefinementStatus === undefined ||
      props.selectedThread.session.harnessRefinementStatus === "available"
    ) {
      sessionHarnessRefinementOutcomeUnknownRef.current = null;
      setSessionHarnessRefinementOutcomeUnknownScopeKey(null);
    }
  }, [props.selectedThread.session?.harnessRefinementStatus]);

  const sessionHarnessRefinementActions = useMemo(
    () =>
      buildSessionHarnessRefinementMenuActions({
        scopeKey: sessionHarnessRefinementScopeKey,
        connectionState: props.connectionState,
        session: props.selectedThread.session ?? null,
        provider: activeSessionProviderStatus,
        pendingScopeKey: sessionHarnessRefinementPendingScopeKey,
        outcomeUnknownScopeKey: sessionHarnessRefinementOutcomeUnknownScopeKey,
      }),
    [
      activeSessionProviderStatus,
      props.connectionState,
      props.selectedThread.session,
      sessionHarnessRefinementOutcomeUnknownScopeKey,
      sessionHarnessRefinementPendingScopeKey,
      sessionHarnessRefinementScopeKey,
    ],
  );
  const runSessionHarnessRefinement = useCallback(async (expectedScopeKey: string) => {
    const control = sessionHarnessRefinementControlRef.current;
    if (
      control.scopeKey !== expectedScopeKey ||
      !control.available ||
      sessionHarnessRefinementPendingRef.current !== null ||
      sessionHarnessRefinementOutcomeUnknownRef.current === expectedScopeKey
    ) {
      return;
    }
    sessionHarnessRefinementPendingRef.current = expectedScopeKey;
    setSessionHarnessRefinementPendingScopeKey(expectedScopeKey);
    let result: ProviderRefineSessionHarnessResult | null = null;
    try {
      result = await control.onRefine();
    } catch {
      result = null;
    }
    if (sessionHarnessRefinementControlRef.current.scopeKey !== expectedScopeKey) return;
    sessionHarnessRefinementPendingRef.current = null;
    setSessionHarnessRefinementPendingScopeKey(null);
    if (result?.outcome === "completed") {
      Alert.alert("Local harness refined", "This thread's private session harness was improved.");
      return;
    }
    if (result?.outcome === "partial") {
      Alert.alert(
        "Local harness partly refined",
        "Some private session harness improvements could not be completed.",
      );
      return;
    }
    if (result?.outcome === "failed") {
      Alert.alert(
        "Local harness refinement failed",
        "The private refinement for this thread could not be completed.",
      );
      return;
    }
    sessionHarnessRefinementOutcomeUnknownRef.current = expectedScopeKey;
    setSessionHarnessRefinementOutcomeUnknownScopeKey(expectedScopeKey);
    Alert.alert(
      "Refinement outcome unavailable",
      "Pylon could not confirm whether the private refinement completed and will not retry it automatically.",
    );
  }, []);
  const confirmSessionHarnessRefinement = useCallback(
    (expectedScopeKey: string) => {
      const control = sessionHarnessRefinementControlRef.current;
      if (
        control.scopeKey !== expectedScopeKey ||
        !control.available ||
        sessionHarnessRefinementPendingRef.current !== null ||
        sessionHarnessRefinementOutcomeUnknownRef.current === expectedScopeKey
      ) {
        return;
      }
      Alert.alert(
        "Refine local harness?",
        "This privately improves only this thread's session harness. It may take time, and it cannot be cancelled or rolled back here.",
        [
          { text: "Not now", style: "cancel" },
          {
            text: "Refine",
            onPress: () => void runSessionHarnessRefinement(expectedScopeKey),
          },
        ],
      );
    },
    [runSessionHarnessRefinement],
  );
  const sessionQueueCount = sessionInputQueueCount(props.sessionInputQueue);
  const showSessionInputQueue =
    props.sessionInputQueue !== null &&
    sessionQueueCount > 0 &&
    supportsSessionInputQueue(activeSessionProviderStatus);
  const canQueueFollowUp =
    props.connectionState === "connected" &&
    composerAuthority.providerAdmissionAvailable &&
    props.selectedThread.session?.status === "running" &&
    !props.sessionInputBlocked &&
    props.localOutboxCount === 0 &&
    supportsSessionInputQueueFollowUp(activeSessionProviderStatus);
  const canClearSessionInputQueue =
    !props.sessionInputBlocked &&
    props.connectionState === "connected" &&
    props.selectedThread.session?.status === "running" &&
    props.selectedThread.session.activeTurnId != null &&
    sessionQueueCount > 0 &&
    supportsSessionInputQueueClear(activeSessionProviderStatus);
  const canRemoveOnlySessionInputQueueItem =
    !props.sessionInputBlocked &&
    props.connectionState === "connected" &&
    props.selectedThread.session?.status === "running" &&
    props.selectedThread.session.activeTurnId != null &&
    supportsSessionInputQueueRemove(activeSessionProviderStatus);
  const showSessionInputQueueModes =
    hasSessionInputQueueModes(props.sessionInputQueue) &&
    supportsSessionInputQueueSetModes(activeSessionProviderStatus);
  const sessionInputQueueScopeKey = `${scopedThreadKey(props.environmentId, props.selectedThread.id)}:${props.selectedThread.session?.providerInstanceId ?? "none"}`;
  const [sessionInputQueueMutation, setSessionInputQueueMutation] = useState<{
    readonly scopeKey: string;
  } | null>(null);
  const isMutatingSessionInputQueue =
    sessionInputQueueMutation?.scopeKey === sessionInputQueueScopeKey;
  const canSetSessionInputQueueModes =
    showSessionInputQueueModes &&
    !props.sessionInputBlocked &&
    props.connectionState === "connected" &&
    composerAuthority.providerAdmissionAvailable &&
    (props.selectedThread.session?.status === "ready" ||
      props.selectedThread.session?.status === "running") &&
    !isMutatingSessionInputQueue;
  // A busy thread is no longer a reason to hold a message back: the outbox now
  // delivers while a turn runs so the message steers it. Only a lost connection
  // or an already-queued message still means "saved rather than sent".
  const sendLabel = selectedProviderUnavailable
    ? `Send unavailable. ${selectedProviderUnavailable.detail}`
    : canQueueFollowUp
      ? "Queue follow-up"
      : props.connectionState !== "connected"
        ? `Save pending send. ${composerAdmissionReason ?? "The environment is disconnected."}`
        : props.localOutboxCount > 0
          ? "Save pending send"
          : "Send";

  const showSessionResourceReload =
    props.selectedThread.session?.runtimeMode === "full-access" &&
    supportsSessionResourceReload(activeSessionProviderStatus);
  const sessionResourceReloadDisabled =
    props.connectionState !== "connected" ||
    props.activeThreadBusy ||
    props.selectedThread.session?.status !== "ready";
  const sessionResourceInventory = useMemo(
    () => presentSessionResourceInventory(props.sessionResources, activeSessionProviderStatus),
    [activeSessionProviderStatus, props.sessionResources],
  );
  const [isSessionResourcesOpen, setIsSessionResourcesOpen] = useState(false);
  const sessionResourcesScopeKey = sessionResourceViewIdentity({
    environmentId: props.environmentId,
    threadId: props.selectedThread.id,
    providerInstanceId: props.selectedThread.session?.providerInstanceId,
    sessionStartedAt: props.selectedThread.session?.startedAt,
  });
  useEffect(() => {
    setIsSessionResourcesOpen(false);
  }, [sessionResourcesScopeKey]);
  const [isReloadingSessionResources, setIsReloadingSessionResources] = useState(false);
  const reloadSessionResources = useCallback(async () => {
    if (sessionResourceReloadDisabled || isReloadingSessionResources) return;
    setIsReloadingSessionResources(true);
    try {
      await props.onReloadSessionResources();
    } finally {
      setIsReloadingSessionResources(false);
    }
  }, [isReloadingSessionResources, props.onReloadSessionResources, sessionResourceReloadDisabled]);

  const activeSessionAgents = useMemo(
    () => props.sessionAgents.filter((agent) => isActiveSubagentStatus(agent.status)),
    [props.sessionAgents],
  );
  const sessionAgentReady =
    props.connectionState === "connected" &&
    (props.selectedThread.session?.status === "ready" ||
      props.selectedThread.session?.status === "running");
  const canCancelSessionAgents =
    sessionAgentReady &&
    props.selectedThread.session?.runtimeMode === "full-access" &&
    supportsSessionAgentCancel(activeSessionProviderStatus);
  const canMessageSessionAgents =
    sessionAgentReady &&
    props.selectedThread.session?.runtimeMode === "full-access" &&
    supportsSessionAgentMessage(activeSessionProviderStatus);
  const canWatchSessionAgentActivity =
    props.connectionState === "connected" &&
    canWatchSessionAgentLiveActivity(activeSessionProviderStatus, props.selectedThread.session);
  const sessionAgentScopeKey = JSON.stringify([
    props.environmentId,
    props.selectedThread.id,
    props.selectedThread.session?.providerInstanceId,
    props.selectedThread.session?.runtimeMode,
  ]);
  const [cancellingAgentIds, setCancellingAgentIds] = useState<ReadonlySet<string>>(new Set());
  const [liveActivitySelection, setLiveActivitySelection] =
    useState<SessionAgentLiveActivitySelection | null>(null);
  const [messageAgentId, setMessageAgentId] = useState<string | null>(null);
  const [messageStateScopeKey, setMessageStateScopeKey] = useState(sessionAgentScopeKey);
  const [agentMessageDraft, setAgentMessageDraft] = useState("");
  const [agentMessagePending, setAgentMessagePending] = useState(false);
  const [agentMessageError, setAgentMessageError] = useState<string | null>(null);
  useEffect(() => {
    const activeIds = new Set(activeSessionAgents.map((agent) => agent.id));
    setCancellingAgentIds((current) => {
      const next = new Set([...current].filter((agentId) => activeIds.has(agentId)));
      return next.size === current.size ? current : next;
    });
  }, [activeSessionAgents]);
  useEffect(() => {
    setCancellingAgentIds(new Set());
    setLiveActivitySelection(null);
    setMessageStateScopeKey(sessionAgentScopeKey);
    setMessageAgentId(null);
    setAgentMessageDraft("");
    setAgentMessageError(null);
    setAgentMessagePending(false);
  }, [sessionAgentScopeKey]);
  const messageDialogAgentIdRef = useRef(messageAgentId);
  messageDialogAgentIdRef.current = messageAgentId;
  const sessionAgentControlRef = useRef({
    scopeKey: sessionAgentScopeKey,
    agents: props.sessionAgents,
    provider: activeSessionProviderStatus,
    canCancel: canCancelSessionAgents,
    canMessage: canMessageSessionAgents,
    cancellingAgentIds,
    onCancel: props.onCancelSessionAgent,
    onMessage: props.onMessageSessionAgent,
  });
  sessionAgentControlRef.current = {
    scopeKey: sessionAgentScopeKey,
    agents: props.sessionAgents,
    provider: activeSessionProviderStatus,
    canCancel: canCancelSessionAgents,
    canMessage: canMessageSessionAgents,
    cancellingAgentIds,
    onCancel: props.onCancelSessionAgent,
    onMessage: props.onMessageSessionAgent,
  };
  const sessionAgentActions = useMemo(
    () =>
      buildSessionAgentMenuActions({
        scopeKey: sessionAgentScopeKey,
        agents: activeSessionAgents,
        canMessage: canMessageSessionAgents,
        canCancel: canCancelSessionAgents,
        canWatchLiveActivity: canWatchSessionAgentActivity,
        cancellingAgentIds,
      }),
    [
      activeSessionAgents,
      canCancelSessionAgents,
      canMessageSessionAgents,
      canWatchSessionAgentActivity,
      cancellingAgentIds,
      sessionAgentScopeKey,
    ],
  );
  const cancelSessionAgent = useCallback(async (agentId: string, expectedScopeKey: string) => {
    const control = sessionAgentControlRef.current;
    const current = control.agents.find((candidate) => candidate.id === agentId);
    if (
      control.scopeKey !== expectedScopeKey ||
      !control.canCancel ||
      current === undefined ||
      !isActiveSubagentStatus(current.status) ||
      control.cancellingAgentIds.has(agentId)
    ) {
      return;
    }
    const pendingIds = new Set(control.cancellingAgentIds).add(agentId);
    sessionAgentControlRef.current = { ...control, cancellingAgentIds: pendingIds };
    setCancellingAgentIds(pendingIds);
    const accepted = await control.onCancel(agentId);
    if (!accepted && sessionAgentControlRef.current.scopeKey === expectedScopeKey) {
      setCancellingAgentIds((ids) => {
        const next = new Set(ids);
        next.delete(agentId);
        return next;
      });
      Alert.alert(
        "Could not stop agent",
        "The agent status was refreshed. Try again if it is still active.",
      );
    }
  }, []);
  const closeAgentMessage = useCallback(() => {
    if (agentMessagePending) return;
    setMessageAgentId(null);
    setAgentMessageDraft("");
    setAgentMessageError(null);
  }, [agentMessagePending]);
  const sendAgentMessage = useCallback(async () => {
    const control = sessionAgentControlRef.current;
    const agentId = messageDialogAgentIdRef.current;
    const message = agentMessageDraft.trim();
    const agent = control.agents.find((candidate) => candidate.id === agentId);
    if (agentId === null || agentMessagePending) return;
    if (
      agent === undefined ||
      !control.canMessage ||
      !canMessageSessionAgent(control.provider, agent)
    ) {
      setAgentMessageError(AGENT_MESSAGE_UNAVAILABLE_ERROR);
      return;
    }
    if (message.length === 0) {
      setAgentMessageError("Enter a message for the agent.");
      return;
    }
    const expectedScopeKey = control.scopeKey;
    setAgentMessagePending(true);
    setAgentMessageError(null);
    let disposition: "delivered" | "queued" | "delivery-unknown" | null = null;
    try {
      disposition = await control.onMessage(agentId, message);
    } catch {
      disposition = null;
    }
    const latest = sessionAgentControlRef.current;
    if (
      latest.scopeKey !== expectedScopeKey ||
      messageDialogAgentIdRef.current !== agentId ||
      !latest.agents.some((candidate) => candidate.id === agentId)
    ) {
      return;
    }
    setAgentMessagePending(false);
    if (disposition === "delivery-unknown") {
      setAgentMessageError("Delivery could not be confirmed. Sending again may duplicate it.");
      return;
    }
    if (disposition === null) {
      setAgentMessageError(
        "Could not send the message. Check the agent's live status and try again.",
      );
      return;
    }
    setMessageAgentId(null);
    setAgentMessageDraft("");
    setAgentMessageError(null);
    Alert.alert(
      disposition === "delivered" ? "Message delivered" : "Message queued",
      disposition === "delivered"
        ? `Your message was delivered to ${agent.title}.`
        : `Your message will be delivered to ${agent.title} when it can receive it.`,
    );
  }, [agentMessageDraft, agentMessagePending]);
  const handleSessionAgentAction = useCallback(
    (eventId: string) => {
      const action = parseSessionAgentMenuAction(eventId);
      if (action === null) return;
      const control = sessionAgentControlRef.current;
      if (action.scopeKey !== control.scopeKey) return;
      const agent = control.agents.find((candidate) => candidate.id === action.agentId);
      if (!agent || !isActiveSubagentStatus(agent.status)) return;
      if (action.kind === "live-activity") {
        if (!canWatchSessionAgentActivity || agent.kind === "workflow") return;
        setLiveActivitySelection({ agentId: agent.id, scopeKey: control.scopeKey });
        return;
      }
      if (action.kind === "message") {
        if (!control.canMessage || !canMessageSessionAgent(control.provider, agent)) return;
        setMessageStateScopeKey(control.scopeKey);
        setAgentMessageDraft("");
        setAgentMessageError(null);
        setMessageAgentId(agent.id);
        return;
      }
      if (!control.canCancel || control.cancellingAgentIds.has(agent.id)) return;
      const expectedScopeKey = control.scopeKey;
      Alert.alert(
        `Stop ${agent.title}?`,
        "Its current work will end. Completed output and activity stay in the thread.",
        [
          { text: "Keep running", style: "cancel" },
          {
            text: "Stop agent",
            style: "destructive",
            onPress: () => void cancelSessionAgent(agent.id, expectedScopeKey),
          },
        ],
      );
    },
    [canWatchSessionAgentActivity, cancelSessionAgent],
  );
  const selectedLiveActivityAgent =
    liveActivitySelection === null
      ? null
      : (props.sessionAgents.find((candidate) => candidate.id === liveActivitySelection.agentId) ??
        null);
  const liveActivityOpen = sessionAgentLiveActivitySelectionIsOpen({
    selection: liveActivitySelection,
    currentScopeKey: sessionAgentScopeKey,
    capabilityEnabled: canWatchSessionAgentActivity,
    agent: selectedLiveActivityAgent,
  });
  useEffect(() => {
    if (liveActivitySelection !== null && !liveActivityOpen) {
      setLiveActivitySelection(null);
    }
  }, [liveActivityOpen, liveActivitySelection]);
  const messageAgent =
    messageAgentId === null || messageStateScopeKey !== sessionAgentScopeKey
      ? null
      : (props.sessionAgents.find((agent) => agent.id === messageAgentId) ?? null);
  const messageAgentCanSend =
    messageAgent !== null &&
    canMessageSessionAgents &&
    canMessageSessionAgent(activeSessionProviderStatus, messageAgent);
  useEffect(() => {
    if (messageAgentId === null) return;
    if (messageAgent === null) {
      setMessageAgentId(null);
      setAgentMessageDraft("");
      setAgentMessageError(null);
      setAgentMessagePending(false);
      return;
    }
    if (agentMessagePending) return;
    setAgentMessageError((current) =>
      messageAgentCanSend
        ? current === AGENT_MESSAGE_UNAVAILABLE_ERROR
          ? null
          : current
        : AGENT_MESSAGE_UNAVAILABLE_ERROR,
    );
  }, [agentMessagePending, messageAgent, messageAgentCanSend, messageAgentId]);

  const showSessionAgentDepth =
    props.sessionAgentDepth !== null && supportsSessionAgentDepth(activeSessionProviderStatus);
  const [isSettingSessionAgentDepth, setIsSettingSessionAgentDepth] = useState(false);
  const sessionAgentDepthDisabled =
    !canSetSessionAgentDepth(activeSessionProviderStatus, props.sessionAgentDepth) ||
    props.connectionState !== "connected" ||
    props.activeThreadBusy ||
    props.localOutboxCount > 0 ||
    props.selectedThread.session?.status !== "ready" ||
    isReloadingSessionResources ||
    isSettingSessionAgentDepth;
  const sessionAgentDepthActions = useMemo(
    () =>
      Array.from(
        { length: (props.sessionAgentDepth?.maxSettableDepth ?? -1) + 1 },
        (_, maxDepth) => ({
          id: `agent-depth:${maxDepth}`,
          title: `Depth ${maxDepth}`,
          subtitle:
            maxDepth === 0
              ? "Do not spawn recursive agents"
              : maxDepth === 1
                ? "Allow direct child agents"
                : `Allow up to ${maxDepth} recursive levels`,
          state: props.sessionAgentDepth?.maxDepth === maxDepth ? ("on" as const) : undefined,
          attributes: sessionAgentDepthDisabled ? ({ disabled: true } as const) : undefined,
        }),
      ),
    [props.sessionAgentDepth, sessionAgentDepthDisabled],
  );
  const setSessionAgentDepth = useCallback(
    async (eventId: string) => {
      if (sessionAgentDepthDisabled || !eventId.startsWith("agent-depth:")) return;
      const maxDepth = Number(eventId.slice("agent-depth:".length));
      if (!Number.isInteger(maxDepth)) return;
      setIsSettingSessionAgentDepth(true);
      try {
        await props.onSetSessionAgentDepth(maxDepth);
      } finally {
        setIsSettingSessionAgentDepth(false);
      }
    },
    [props.onSetSessionAgentDepth, sessionAgentDepthDisabled],
  );

  const sessionCompactionScopeKey = props.sessionCompactionScopeKey;
  const sessionCompactionConnected =
    props.connectionState === "connected" &&
    (props.selectedThread.session?.status === "ready" ||
      props.selectedThread.session?.status === "running");
  const canCompactSessionContext =
    sessionCompactionConnected &&
    composerAuthority.providerAdmissionAvailable &&
    props.sessionCompactionPendingAction === null &&
    canStartSessionCompaction(activeSessionProviderStatus, props.sessionCompaction);
  const canAbortSessionContext =
    sessionCompactionConnected &&
    props.sessionCompactionPendingAction === null &&
    canAbortSessionCompaction(activeSessionProviderStatus, props.sessionCompaction);
  const canSetSessionAutoCompaction =
    sessionCompactionConnected &&
    composerAuthority.providerAdmissionAvailable &&
    props.sessionCompactionPendingAction === null &&
    canConfigureSessionAutoCompaction(activeSessionProviderStatus, props.sessionCompaction);
  const sessionCompactionControlRef = useRef({
    scopeKey: sessionCompactionScopeKey,
    pendingAction: props.sessionCompactionPendingAction,
    snapshot: props.sessionCompaction,
    canCompact: canCompactSessionContext,
    canAbort: canAbortSessionContext,
    canSetAuto: canSetSessionAutoCompaction,
  });
  sessionCompactionControlRef.current = {
    scopeKey: sessionCompactionScopeKey,
    pendingAction: props.sessionCompactionPendingAction,
    snapshot: props.sessionCompaction,
    canCompact: canCompactSessionContext,
    canAbort: canAbortSessionContext,
    canSetAuto: canSetSessionAutoCompaction,
  };
  const contextWindowPresentation = presentMobileContextWindow(props.contextWindow);
  const sessionGoalActions = useMemo(
    () => (props.sessionGoal ? buildSessionGoalMenuActions(props.sessionGoal) : []),
    [props.sessionGoal],
  );
  const sessionCompactionActions = useMemo(
    () =>
      props.sessionCompaction?.available && sessionCompactionScopeKey
        ? buildSessionCompactionMenuActions({
            scopeKey: sessionCompactionScopeKey,
            snapshot: props.sessionCompaction,
            canCompact: canCompactSessionContext,
            canAbort: canAbortSessionContext,
            canSetAuto: canSetSessionAutoCompaction,
            pendingAction: props.sessionCompactionPendingAction,
          })
        : [],
    [
      canAbortSessionContext,
      canCompactSessionContext,
      canSetSessionAutoCompaction,
      props.sessionCompaction,
      props.sessionCompactionPendingAction,
      sessionCompactionScopeKey,
    ],
  );
  const runSessionCompactionAction = useCallback(
    (action: SessionCompactionMenuAction, expectedScopeKey: string) => {
      const current = sessionCompactionControlRef.current;
      if (
        current.scopeKey !== expectedScopeKey ||
        current.snapshot === null ||
        current.pendingAction !== null ||
        (action === "compact" && !current.canCompact) ||
        (action === "abort" && !current.canAbort) ||
        ((action === "auto-enable" || action === "auto-disable") && !current.canSetAuto)
      ) {
        return;
      }
      void props.onRunSessionCompactionAction(action).then((accepted) => {
        if (!accepted && sessionCompactionControlRef.current.scopeKey === expectedScopeKey) {
          Alert.alert(
            "Could not update compaction",
            "The provider status was refreshed. Try again.",
          );
        }
      });
    },
    [props.onRunSessionCompactionAction],
  );
  const handleSessionCompactionAction = useCallback(
    (eventId: string) => {
      const current = sessionCompactionControlRef.current;
      if (!current.scopeKey || !current.snapshot || current.pendingAction !== null) return;
      const action = parseSessionCompactionMenuAction(eventId, current.scopeKey);
      if (
        !action ||
        (action === "compact" && !current.canCompact) ||
        (action === "abort" && !current.canAbort) ||
        ((action === "auto-enable" || action === "auto-disable") && !current.canSetAuto)
      ) {
        return;
      }
      runSessionCompactionAction(action, current.scopeKey);
    },
    [runSessionCompactionAction],
  );

  // ── Composer command menu ────────────────────────────────
  const composerOwnerKey = scopedThreadKey(props.environmentId, props.selectedThread.id);

  const composerMenu = useComposerCommandMenu({
    draftMessage: props.draftMessage,
    ownerKey: composerOwnerKey,
    environmentId: props.environmentId,
    projectCwd: props.projectCwd,
    selectedProviderStatus,
    sessionResources: props.sessionResources,
    showInteractionModeToggle,
    hasThread: true,
    enabled: !props.sessionInputBlocked,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onUpdateInteractionMode: props.onUpdateInteractionMode,
  });
  const voiceInput = useVoiceInputController({
    ownerKey: composerOwnerKey,
    draftMessage: props.draftMessage,
    selection: composerMenu.selection,
    onChangeDraftMessage: props.onChangeDraftMessage,
    onChangeSelection: composerMenu.onSelectionChange,
  });
  const voicePresentation = resolveVoiceComposerPresentation(
    voiceInput.state,
    voiceInput.elapsedSeconds,
  );
  const isVoiceInputPresented = voicePresentation.statusLabel !== null;
  // An open draft stays visible; only a collapsed composer becomes a voice strip.
  const showsCompactDictation = isVoiceInputPresented && !isExpanded;
  const isToolbarVisible = isExpanded || isVoiceInputPresented;

  const { onSendMessage } = props;

  const handleSend = useCallback(async () => {
    // canSend is derived above voiceInput, so the block lives here.
    // Reachable via a hardware-keyboard Return while recording.
    if (voiceInput.blocksSubmission) return;
    if (!canSend) return;
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey)) return;
    inFlightThreadIdsRef.current.add(threadKey);
    try {
      const messageId = await onSendMessage();
      if (messageId === null) {
        return;
      }
      // Sending a prompt starts agent work: arm the lock-screen card while the
      // app is foregrounded and the activity token can be registered. Armed
      // after the send so its preference read and native Activity start don't
      // contend with the queued-message feedback on the tap frame.
      armAgentAwarenessLiveActivityForLocalWork({
        environmentId: props.environmentId,
        threadTitle: props.selectedThread.title,
        projectTitle: props.environmentLabel ?? "Pylon",
      });
    } finally {
      inFlightThreadIdsRef.current.delete(threadKey);
    }
  }, [
    canSend,
    onSendMessage,
    props.environmentId,
    props.environmentLabel,
    props.selectedThread.id,
    props.selectedThread.title,
    voiceInput.blocksSubmission,
  ]);
  const handleQueueFollowUp = useCallback(async () => {
    // canSend is derived above voiceInput, so the block lives here.
    // Reachable via a hardware-keyboard Return while recording.
    if (voiceInput.blocksSubmission) return;
    if (!canSend) return;
    const threadKey = scopedThreadKey(props.environmentId, props.selectedThread.id);
    if (inFlightThreadIdsRef.current.has(threadKey) || isMutatingSessionInputQueue) return;
    inFlightThreadIdsRef.current.add(threadKey);
    const mutation = { scopeKey: sessionInputQueueScopeKey };
    setSessionInputQueueMutation(mutation);
    try {
      await props.onQueueFollowUp();
    } finally {
      setSessionInputQueueMutation((current) => (current === mutation ? null : current));
      inFlightThreadIdsRef.current.delete(threadKey);
    }
  }, [
    canSend,
    isMutatingSessionInputQueue,
    props.environmentId,
    props.onQueueFollowUp,
    props.selectedThread.id,
    sessionInputQueueScopeKey,
  ]);

  const confirmClearSessionInputQueue = useCallback(() => {
    if (!canClearSessionInputQueue || isMutatingSessionInputQueue) return;
    Alert.alert(
      "Clear pending session inputs?",
      "This removes queued follow-ups and steering inputs without stopping current work.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Clear all",
          style: "destructive",
          onPress: () => {
            const mutation = { scopeKey: sessionInputQueueScopeKey };
            setSessionInputQueueMutation(mutation);
            void props.onClearSessionInputQueue().finally(() => {
              setSessionInputQueueMutation((current) => (current === mutation ? null : current));
            });
          },
        },
      ],
    );
  }, [
    canClearSessionInputQueue,
    isMutatingSessionInputQueue,
    props.onClearSessionInputQueue,
    sessionInputQueueScopeKey,
  ]);

  const sessionInputQueueActions = useMemo(
    () =>
      hasSessionInputQueueModes(props.sessionInputQueue)
        ? buildSessionInputQueueMenuActions({
            snapshot: props.sessionInputQueue,
            count: sessionQueueCount,
            canSetModes: canSetSessionInputQueueModes,
            canClear: canClearSessionInputQueue,
            canRemove: canRemoveOnlySessionInputQueueItem,
            mutating: isMutatingSessionInputQueue,
          })
        : [],
    [
      canClearSessionInputQueue,
      canRemoveOnlySessionInputQueueItem,
      canSetSessionInputQueueModes,
      isMutatingSessionInputQueue,
      props.sessionInputQueue,
      sessionQueueCount,
    ],
  );

  const handleSessionInputQueueAction = useCallback(
    (eventId: string) => {
      if (eventId === "session-input-clear") {
        confirmClearSessionInputQueue();
        return;
      }
      const removalQueue = parseSessionInputQueueRemoveAction(eventId);
      if (removalQueue !== null) {
        const count =
          removalQueue === "steering"
            ? (props.sessionInputQueue?.steeringCount ?? 0)
            : (props.sessionInputQueue?.followUpCount ?? 0);
        if (!canRemoveOnlySessionInputQueueItem || isMutatingSessionInputQueue || count !== 1) {
          return;
        }
        const label = removalQueue === "steering" ? "steering" : "follow-up";
        Alert.alert(
          `Remove pending ${label} input?`,
          "This removes that input without stopping current work.",
          [
            { text: "Cancel", style: "cancel" },
            {
              text: "Remove",
              style: "destructive",
              onPress: () => {
                const mutation = { scopeKey: sessionInputQueueScopeKey };
                setSessionInputQueueMutation(mutation);
                void props.onRemoveOnlySessionInputQueueItem(removalQueue).finally(() => {
                  setSessionInputQueueMutation((current) =>
                    current === mutation ? null : current,
                  );
                });
              },
            },
          ],
        );
        return;
      }
      const action = parseSessionInputQueueModeAction(eventId);
      if (!action || !canSetSessionInputQueueModes || isMutatingSessionInputQueue) return;
      const { queue, mode } = action;
      const currentMode =
        queue === "steering"
          ? props.sessionInputQueue?.steeringMode
          : props.sessionInputQueue?.followUpMode;
      if (currentMode === mode) return;
      const mutation = { scopeKey: sessionInputQueueScopeKey };
      setSessionInputQueueMutation(mutation);
      void props.onSetSessionInputQueueMode(queue, mode).finally(() => {
        setSessionInputQueueMutation((current) => (current === mutation ? null : current));
      });
    },
    [
      canRemoveOnlySessionInputQueueItem,
      canSetSessionInputQueueModes,
      confirmClearSessionInputQueue,
      isMutatingSessionInputQueue,
      props.onRemoveOnlySessionInputQueueItem,
      props.onSetSessionInputQueueMode,
      props.sessionInputQueue?.followUpCount,
      props.sessionInputQueue?.followUpMode,
      props.sessionInputQueue?.steeringCount,
      props.sessionInputQueue?.steeringMode,
      sessionInputQueueScopeKey,
    ],
  );

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection),
    [props.serverConfig, currentModelSelection],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  // Keep every configured group visible. `getModelChangeDisabledReason`
  // enables exact continuation peers and explains why every other account
  // needs a new thread.
  const threadProviderGroups = providerGroups;
  const currentModelOption =
    modelOptions.find(
      (option) =>
        option.selection.instanceId === currentModelSelection.instanceId &&
        option.selection.model === currentModelSelection.model,
    ) ?? null;
  const providerOptionDescriptors = useMemo(
    () =>
      resolveProviderOptionDescriptors({
        capabilities: currentModelOption?.capabilities,
        selections: currentModelSelection.options,
      }),
    [currentModelOption?.capabilities, currentModelSelection.options],
  );
  const settingsOwnerId = composerOwnerKey;
  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      environmentId: props.environmentId,
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => {
        if (!props.sessionInputBlocked) props.onUpdateModelSelection(option.selection);
      },
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) => {
        if (!props.sessionInputBlocked) {
          props.onUpdateModelSelection({ ...currentModelSelection, options });
        }
      },
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: (mode) => {
        if (!props.sessionInputBlocked) props.onUpdateRuntimeMode(mode);
      },
      getModelDisabledReason: getModelChangeDisabledReason,
    }),
    [
      confirmSessionHarnessRefinement,
      currentModelSelection,
      currentRuntimeMode,
      getModelChangeDisabledReason,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
      props.sessionInputBlocked,
      providerOptionDescriptors,
      settingsOwnerId,
      threadProviderGroups,
    ],
  );
  const openSettings = useCallback(() => {
    settingsRoutePresentation.present(settingsRouteSession);
    settingsSheetPresentation.open();
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.open]);

  useEffect(() => {
    if (settingsSheetPresentation.isActive) {
      settingsRoutePresentation.present(settingsRouteSession);
    }
  }, [settingsRoutePresentation.present, settingsRouteSession, settingsSheetPresentation.isActive]);

  useEffect(() => {
    if (!settingsSheetPresentation.isVisible || settingsRoutePresentedRef.current) {
      return;
    }

    settingsRoutePresentedRef.current = true;
    navigation.dispatch(StackActions.push("ThreadSettingsSheet"));
  }, [navigation, settingsSheetPresentation.isVisible]);

  useFocusEffect(
    useCallback(() => {
      if (!settingsRoutePresentedRef.current) {
        return;
      }

      settingsRoutePresentedRef.current = false;
      settingsSheetPresentation.onDismissed();
      settingsRoutePresentation.clear(settingsOwnerId);
    }, [settingsOwnerId, settingsRoutePresentation.clear, settingsSheetPresentation.onDismissed]),
  );

  useEffect(
    () =>
      // UIKit's completion callback for the sheet dismissal, surfaced by the
      // native-stack patch. This is when the queued keyboard restore runs.
      (navigation as unknown as NavigationWithFinishTransitioning).addListener(
        "finishTransitioning",
        settingsSheetPresentation.onStackTransitionsFinished,
      ),
    [navigation, settingsSheetPresentation.onStackTransitionsFinished],
  );

  return (
    <Animated.View
      className="px-4"
      layout={COMPOSER_LAYOUT_TRANSITION}
      style={{
        paddingTop: isExpanded ? 8 : 6,
        paddingBottom: (props.bottomInset ?? 0) + (isExpanded ? 8 : 6),
      }}
    >
      {/* The backdrop gradient lives on a plain View: Reanimated's Animated.View
          silently drops experimental_backgroundImage on Android, which left this
          strip fully transparent and the feed text legible through the composer. */}
      <View
        className="absolute inset-0 bg-linear-to-b from-screen/0 via-screen/60 to-screen/90"
        pointerEvents="none"
      />
      <Animated.View
        className="relative w-full self-center"
        layout={COMPOSER_LAYOUT_TRANSITION}
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {!voiceInput.isBusy && composerMenu.trigger && composerMenu.items.length > 0 ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenu.items}
              triggerKind={composerMenu.trigger.kind}
              isLoading={composerMenu.isLoading}
              onSelect={composerMenu.onSelect}
            />
          </View>
        ) : null}

        {connectionStatus ? (
          <ComposerConnectionStatusPill
            status={connectionStatus}
            onPress={props.onReconnectEnvironment}
          />
        ) : null}

        <ProviderUnavailableNotice
          provider={selectedProviderStatus}
          reason={blockingAdmissionReason}
          title={projectAdmissionReason === null ? undefined : "Project unavailable"}
        />

        <ComposerSurface
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingTop: 14,
                }
              : {
                  // Bounded so the radius morph interpolates instead of
                  // travelling from 999; still renders as a capsule at this
                  // pill height.
                  borderRadius: 27,
                  overflow: "hidden" as const,
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  paddingLeft: 18,
                  paddingRight: 5,
                  paddingVertical: showsCompactDictation ? 2 : 5,
                }
          }
        >
          <ComposerDictationDraftContent
            className={isExpanded ? undefined : "flex-row items-center"}
            compact={!isExpanded}
            hidden={showsCompactDictation}
          >
            {!isExpanded ? (
              <ComposerAttachmentButton
                supportsFiles={Boolean(
                  props.serverConfig?.environment.capabilities.fileAttachments,
                )}
                onPickMedia={props.onPickDraftMedia}
                onPickFiles={props.onPickDraftFiles}
              />
            ) : null}
            {isExpanded ? (
              <Animated.View
                className={props.draftAttachments.length > 0 ? "px-[14px] pb-2.5" : undefined}
                entering={FadeIn.duration(160)}
                exiting={FadeOut.duration(120)}
                layout={COMPOSER_LAYOUT_TRANSITION}
              >
                <ComposerAttachmentStrip
                  environmentId={props.environmentId}
                  attachments={props.draftAttachments}
                  onRemove={voiceInput.isBusy ? () => undefined : props.onRemoveDraftImage}
                  onPressPreview={voiceInput.isBusy ? undefined : onPressPreview}
                  onPressVideo={voiceInput.isBusy ? undefined : onPressVideo}
                />
              </Animated.View>
            ) : null}
            <View className={isExpanded ? undefined : "min-w-0 flex-1"}>
              <ComposerEditor
                ref={inputRef}
                multiline
                value={props.draftMessage}
                // Without this the keyboard stays live during dictation, and any
                // keystroke makes resolveTranscriptCommit see a changed draft and
                // discard the whole transcript as stale.
                readOnly={voiceInput.freezesEditor}
                skills={selectedProviderStatus?.skills ?? []}
                selection={composerMenu.selection}
                onChangeText={props.onChangeDraftMessage}
                onSelectionChange={composerMenu.onSelectionChange}
                onPasteImages={(uris) => void props.onNativePasteImages(uris)}
                placeholder={props.placeholder}
                onFocus={handleFocus}
                onBlur={handleBlur}
                onSubmit={handleSend}
                scrollEnabled={isExpanded}
                // Android: collapsed single line centers natively (gravity) in
                // a pill-height box matching the send button; iOS keeps insets.
                singleLineCentered={!isExpanded}
                contentInsetVertical={isExpanded || Platform.OS === "android" ? 0 : 6}
                style={
                  isExpanded
                    ? {
                        minHeight: 72,
                        maxHeight: 160,
                        paddingVertical: 4,
                      }
                    : {
                        height: 36,
                      }
                }
                textStyle={{
                  ...bodyText,
                  color: foregroundColor,
                }}
              />
            </View>
            {!isExpanded && props.draftAttachments.length > 0 ? (
              <View className="flex-row gap-1 pl-1">
                {props.draftAttachments.slice(0, 3).map((attachment) => (
                  <ComposerAttachmentThumbnail
                    environmentId={props.environmentId}
                    key={attachment.id}
                    attachment={attachment}
                    size={30}
                    borderRadius={8}
                    compact
                    onPressPreview={onPressPreview}
                    onPressVideo={onPressVideo}
                  />
                ))}
                {props.draftAttachments.length > 3 ? (
                  <View className="size-[30px] items-center justify-center rounded-lg bg-subtle-strong">
                    <Text className="text-foreground-muted text-2xs font-t3-bold">
                      +{props.draftAttachments.length - 3}
                    </Text>
                  </View>
                ) : null}
              </View>
            ) : null}
            {!isExpanded && props.contextWindow ? (
              <ContextWindowIndicator snapshot={props.contextWindow} expanded={false} />
            ) : null}
            {!isExpanded && !voiceInput.isBusy ? (
              <Animated.View
                className="flex-row items-center gap-1.5"
                entering={FadeIn.duration(180)}
                exiting={FadeOut.duration(100)}
              >
                {voiceInput.isAvailable ? (
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                ) : null}
                {showStopAction ? (
                  <View className="flex-row items-center gap-2">
                    <ControlPill
                      accessibilityLabel="Stop"
                      icon="stop.fill"
                      variant="danger"
                      onPress={props.onStopThread}
                    />
                    {canQueueFollowUp ? (
                      <ControlPill
                        accessibilityLabel={attachmentBlockReason ?? "Queue follow-up"}
                        icon="arrow.up"
                        variant="primary"
                        disabled={!canSend || isMutatingSessionInputQueue}
                        onPress={handleQueueFollowUp}
                      />
                    ) : null}
                  </View>
                ) : (
                  <ControlPill
                    accessibilityLabel={attachmentBlockReason ?? sendLabel}
                    icon="arrow.up"
                    variant="primary"
                    disabled={!canSend}
                    onPress={handleSend}
                  />
                )}
              </Animated.View>
            ) : null}
            {isExpanded ? <View className="h-1" /> : null}
          </ComposerDictationDraftContent>
          {isToolbarVisible ? (
            <ComposerDictationToolbar
              showsDictation={isVoiceInputPresented}
              visible={isToolbarVisible}
            >
              <ComposerToolbarRow
                paddingBottom={0}
                paddingHorizontal={0}
                paddingTop={0}
                style={{ gap: 0 }}
              >
                <ComposerDictationCancelAction
                  presentation={voicePresentation}
                  onCancel={voiceInput.cancel}
                />
                {isVoiceInputPresented ? (
                  <ComposerDictationStatus
                    audioLevels={voiceInput.audioLevels}
                    elapsedSeconds={voiceInput.elapsedSeconds}
                    phase={voiceInput.state.phase}
                    presentation={voicePresentation}
                    onDismissError={voiceInput.cancel}
                  />
                ) : (
                  <ComposerToolbarScroller contentPaddingRight={8}>
                    {/* #8843 replaces the Alert with a native menu anchored to
                        the button. Kept inside Pylon's scroller rather than
                        upstream's fixed left group. */}
                    <ComposerAttachmentButton
                      supportsFiles={Boolean(
                        props.serverConfig?.environment.capabilities.fileAttachments,
                      )}
                      onPickMedia={props.onPickDraftMedia}
                      onPickFiles={props.onPickDraftFiles}
                    />
                    {quickQuestionAvailable ? (
                      <QuickQuestionTrigger
                        onPress={() => setQuickQuestionOpenScopeKey(quickQuestionScopeKey)}
                      />
                    ) : null}
                    <ComposerInlineControl
                      accessibilityLabel="Model and reasoning settings"
                      emphasized
                      iconNode={
                        <ProviderIcon provider={currentModelOption?.providerDriver} size={16} />
                      }
                      label={currentModelOption?.label ?? currentModelSelection.model}
                      maxWidth={152}
                      disabled={props.sessionInputBlocked}
                      accessibilityHint={
                        props.sessionInputBlocked
                          ? "Provider changes are blocked while this thread has a pending safety operation"
                          : undefined
                      }
                      onPress={openSettings}
                    />
                    {sessionHarnessRefinementActions.length > 0 ? (
                      <ControlPillMenu
                        title="Local harness"
                        actions={sessionHarnessRefinementActions}
                        onPressAction={({ nativeEvent }) => {
                          if (
                            parseSessionHarnessRefinementAction(
                              nativeEvent.event,
                              sessionHarnessRefinementScopeKey,
                            ) === "refine"
                          ) {
                            confirmSessionHarnessRefinement(sessionHarnessRefinementScopeKey);
                          }
                        }}
                      >
                        <ComposerToolbarButton
                          accessibilityLabel="Local harness refinement"
                          icon="wand.and.stars"
                          label="Refine"
                        />
                      </ControlPillMenu>
                    ) : null}
                    {props.sessionGoal ? (
                      <ControlPillMenu
                        title="Session goal · Managed in chat"
                        actions={sessionGoalActions}
                      >
                        <ComposerToolbarButton
                          accessibilityLabel={`Session goal ${formatSessionGoalStatus(props.sessionGoal.status).toLowerCase()}. Managed in chat.`}
                          icon="target"
                          label={
                            props.sessionGoal.status === "idle"
                              ? "No goal"
                              : `Goal ${formatSessionGoalStatus(props.sessionGoal.status)}`
                          }
                        />
                      </ControlPillMenu>
                    ) : null}
                    {props.contextWindow ||
                    (props.sessionCompaction?.available && sessionCompactionScopeKey) ? (
                      props.sessionCompaction?.available && sessionCompactionScopeKey ? (
                        <ControlPillMenu
                          title="Context window"
                          actions={sessionCompactionActions}
                          onPressAction={({ nativeEvent }) =>
                            handleSessionCompactionAction(nativeEvent.event)
                          }
                        >
                          <ComposerToolbarButton
                            accessibilityLabel={`${
                              contextWindowPresentation?.accessibilityText ??
                              "Context usage unavailable."
                            } ${
                              isSessionCompactionInProgress(props.sessionCompaction)
                                ? "Compaction in progress."
                                : "Compaction controls."
                            }`}
                            icon="gauge.with.dots.needle.50percent"
                            label={contextWindowPresentation?.compactLabel ?? "Context"}
                          />
                        </ControlPillMenu>
                      ) : props.contextWindow ? (
                        <ContextWindowIndicator snapshot={props.contextWindow} expanded />
                      ) : null
                    ) : null}
                    {sessionAgentActions.length > 0 ? (
                      <ControlPillMenu
                        title="Active agents"
                        actions={[...sessionAgentActions]}
                        onPressAction={({ nativeEvent }) =>
                          handleSessionAgentAction(nativeEvent.event)
                        }
                      >
                        <ComposerToolbarButton
                          accessibilityLabel={`${activeSessionAgents.length} active ${activeSessionAgents.length === 1 ? "agent" : "agents"}. View live activity, message, or stop an agent.`}
                          icon="person.2"
                          label={`${activeSessionAgents.length} ${activeSessionAgents.length === 1 ? "agent" : "agents"}`}
                        />
                      </ControlPillMenu>
                    ) : null}
                    {showSessionInputQueueModes && props.sessionInputQueue ? (
                      <ControlPillMenu
                        title="Session input delivery"
                        actions={sessionInputQueueActions}
                        onPressAction={({ nativeEvent }) =>
                          handleSessionInputQueueAction(nativeEvent.event)
                        }
                      >
                        <ComposerToolbarButton
                          accessibilityLabel={`Session input delivery. ${sessionQueueCount} pending. Steering ${props.sessionInputQueue.steeringMode === "all-at-once" ? "all at once" : "one at a time"}. Follow-ups ${props.sessionInputQueue.followUpMode === "all-at-once" ? "all at once" : "one at a time"}.`}
                          icon="text.badge.plus"
                          label={sessionQueueCount > 0 ? `Inputs ${sessionQueueCount}` : "Inputs"}
                        />
                      </ControlPillMenu>
                    ) : null}
                    {showSessionAgentDepth && props.sessionAgentDepth !== null ? (
                      <ControlPillMenu
                        title="Agent spawn depth"
                        actions={sessionAgentDepthActions}
                        onPressAction={({ nativeEvent }) =>
                          void setSessionAgentDepth(nativeEvent.event)
                        }
                      >
                        <ComposerToolbarButton
                          accessibilityLabel={
                            !props.sessionAgentDepth.writable
                              ? `Agent spawn depth ${props.sessionAgentDepth.maxDepth}, fixed by session policy`
                              : props.sessionAgentDepth.settable
                                ? `Agent spawn depth ${props.sessionAgentDepth.maxDepth}`
                                : `Agent spawn depth ${props.sessionAgentDepth.maxDepth}, unavailable until the session is idle`
                          }
                          icon="person.crop.circle"
                          label={`Depth ${props.sessionAgentDepth.maxDepth}`}
                          disabled={sessionAgentDepthDisabled}
                        />
                      </ControlPillMenu>
                    ) : null}
                    {sessionResourceInventory !== null ? (
                      <ComposerToolbarButton
                        accessibilityLabel={`Session resources. ${sessionResourceInventory.skills.length} skills, ${sessionResourceInventory.prompts.length} prompts.`}
                        label={`Resources ${sessionResourceInventory.skills.length + sessionResourceInventory.prompts.length}`}
                        onPress={() => setIsSessionResourcesOpen(true)}
                        showChevron={false}
                      />
                    ) : showSessionResourceReload ? (
                      <ComposerToolbarButton
                        accessibilityLabel={
                          isReloadingSessionResources
                            ? "Reloading session commands and resources"
                            : "Reload session commands and resources after changing commands, skills, or prompts"
                        }
                        icon="arrow.clockwise"
                        label={isReloadingSessionResources ? "Reloading…" : "Reload resources"}
                        disabled={sessionResourceReloadDisabled || isReloadingSessionResources}
                        onPress={() => void reloadSessionResources()}
                        showChevron={false}
                      />
                    ) : null}
                  </ComposerToolbarScroller>
                )}
                <View className="shrink-0 flex-row items-center gap-2">
                  {/* Stop lives outside the dictation ternary: an agent must stay
                      stoppable for the whole recording and transcription window. */}
                  {showStopAction ? (
                    <ComposerToolbarButton
                      accessibilityLabel="Stop"
                      icon="stop.fill"
                      variant="danger"
                      onPress={props.onStopThread}
                      showChevron={false}
                    />
                  ) : null}
                  <ComposerDictationPrimaryAction
                    state={voiceInput.state}
                    presentation={voicePresentation}
                    isAvailable={voiceInput.isAvailable}
                    onStart={voiceInput.start}
                    onConfirm={voiceInput.stop}
                    onCancel={voiceInput.cancel}
                  />
                  {/* showsSend, not isVoiceInputPresented: the error phase shows a
                      status label AND keeps send, so gating on the label strands
                      the user with no way to send until they dismiss the error. */}
                  {voicePresentation.showsSend ? (
                    <ComposerToolbarButton
                      accessibilityLabel={attachmentBlockReason ?? sendLabel}
                      icon="arrow.up"
                      variant="primary"
                      disabled={!canSend || (canQueueFollowUp && isMutatingSessionInputQueue)}
                      onPress={canQueueFollowUp ? handleQueueFollowUp : handleSend}
                      showChevron={false}
                    />
                  ) : null}
                </View>
              </ComposerToolbarRow>
            </ComposerDictationToolbar>
          ) : null}
        </ComposerSurface>

        {showSessionInputQueue ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Session inputs ${sessionQueueCount}. Clear all pending session inputs`}
              disabled={!canClearSessionInputQueue || isMutatingSessionInputQueue}
              onPress={confirmClearSessionInputQueue}
            >
              <Text className="pt-2 text-xs text-foreground-muted">
                Session inputs · {sessionQueueCount} · Clear all
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}

        {/* Queue count */}
        {props.localOutboxCount > 0 ? (
          <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(120)}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Manage ${props.localOutboxCount} pending send${props.localOutboxCount === 1 ? "" : "s"}`}
              onPress={props.onManagePendingSends}
            >
              <Text className="pt-2 text-xs text-foreground-muted">
                {props.localOutboxCount} pending send{props.localOutboxCount === 1 ? "" : "s"} on
                this device · Manage
              </Text>
            </Pressable>
          </Animated.View>
        ) : null}
      </Animated.View>
      <QuickQuestionModal
        key={quickQuestionScopeKey}
        scopeKey={quickQuestionScopeKey}
        visible={quickQuestionOpenScopeKey === quickQuestionScopeKey && quickQuestionAvailable}
        onAsk={props.onAskSessionSideQuestion}
        onCancel={props.onCancelSessionSideQuestion}
        onDismiss={() => setQuickQuestionOpenScopeKey(null)}
      />
      {isSessionResourcesOpen &&
      sessionResourceInventory !== null &&
      props.sessionResources !== null ? (
        <SessionResourcesModal
          inventory={sessionResourceInventory}
          snapshot={props.sessionResources}
          showReload={showSessionResourceReload}
          reloadDisabled={sessionResourceReloadDisabled}
          isReloading={isReloadingSessionResources}
          onReload={reloadSessionResources}
          onClose={() => setIsSessionResourcesOpen(false)}
        />
      ) : null}
      {liveActivityOpen && selectedLiveActivityAgent !== null ? (
        <SessionAgentLiveActivityModal
          key={sessionAgentScopeKey}
          environmentId={props.environmentId}
          threadId={props.selectedThread.id}
          agentId={selectedLiveActivityAgent.id}
          agent={selectedLiveActivityAgent}
          onClose={() => setLiveActivitySelection(null)}
        />
      ) : null}
      <Modal
        visible={messageAgent !== null}
        transparent
        animationType="fade"
        onRequestClose={closeAgentMessage}
      >
        <KeyboardAvoidingView
          behavior={Platform.OS === "ios" ? "padding" : undefined}
          className="flex-1 justify-end"
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close agent message"
            className="absolute inset-0 bg-black/50"
            disabled={agentMessagePending}
            onPress={closeAgentMessage}
          />
          <View className="rounded-t-[28px] border-t border-border bg-sheet px-5 pb-8 pt-5">
            <View className="mb-4 flex-row items-start justify-between gap-4">
              <View className="min-w-0 flex-1">
                <Text className="text-lg font-t3-bold text-foreground">
                  Message {messageAgent?.title ?? "agent"}
                </Text>
                <Text className="mt-1 text-sm text-foreground-muted">
                  Send a direct instruction to this active agent.
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel agent message"
                disabled={agentMessagePending}
                onPress={closeAgentMessage}
                className="h-11 items-center justify-center px-2"
              >
                <Text className="font-t3-bold text-foreground-muted">Cancel</Text>
              </Pressable>
            </View>
            <TextInput
              autoFocus
              multiline
              textAlignVertical="top"
              maxLength={PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS}
              value={agentMessageDraft}
              editable={!agentMessagePending}
              onChangeText={(value) => {
                setAgentMessageDraft(value);
                if (agentMessageError && agentMessageError !== AGENT_MESSAGE_UNAVAILABLE_ERROR) {
                  setAgentMessageError(null);
                }
              }}
              placeholder="What should this agent know or do?"
              className="h-36 rounded-[20px] px-4 py-3.5"
            />
            <View className="mt-2 flex-row items-start justify-between gap-3">
              <Text
                accessibilityRole={agentMessageError ? "alert" : undefined}
                className="min-w-0 flex-1 text-xs text-danger"
              >
                {agentMessageError}
              </Text>
              <Text className="text-xs tabular-nums text-foreground-muted">
                {agentMessageDraft.length.toLocaleString()} /{" "}
                {PROVIDER_SESSION_AGENT_MESSAGE_MAX_CHARS.toLocaleString()}
              </Text>
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={agentMessagePending ? "Sending message" : "Send message"}
              accessibilityState={{
                disabled:
                  agentMessagePending ||
                  !messageAgentCanSend ||
                  agentMessageDraft.trim().length === 0,
                busy: agentMessagePending,
              }}
              disabled={
                agentMessagePending || !messageAgentCanSend || agentMessageDraft.trim().length === 0
              }
              onPress={() => void sendAgentMessage()}
              className="mt-4 h-12 flex-row items-center justify-center rounded-full bg-primary disabled:bg-subtle-strong"
            >
              {agentMessagePending ? (
                <ActivityIndicator />
              ) : (
                <Text className="font-t3-bold text-primary-foreground">Send message</Text>
              )}
            </Pressable>
          </View>
        </KeyboardAvoidingView>
      </Modal>
      <VideoPreviewModal source={previewVideo} onRequestClose={closePreview} />
      <FilePreviewModal source={previewFile} onRequestClose={closePreview} />
    </Animated.View>
  );
});
