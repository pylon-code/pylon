import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
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
  formatProviderSlashCommandDescription,
  presentSessionResourceInventory,
  resolveSessionSlashCommands,
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
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import { StackActions, useFocusEffect, useNavigation } from "@react-navigation/native";
import type { ReactNode } from "react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import {
  ActivityIndicator,
  Alert,
  Image,
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  StyleSheet,
  View,
  type ViewStyle,
} from "react-native";
import ImageViewing from "react-native-image-viewing";
import Animated, {
  FadeIn,
  FadeInDown,
  FadeOut,
  FadeOutDown,
  LinearTransition,
} from "react-native-reanimated";
import { useThemeColor } from "../../lib/useThemeColor";
import { presentMobileContextWindow } from "../../lib/contextWindow";
import { themeColorWithAlpha } from "../../lib/mobileTheme";
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerAttachmentStrip } from "../../components/ComposerAttachmentStrip";
import { GlassSurface } from "../../components/GlassSurface";
import {
  ComposerEditor,
  type ComposerEditorHandle,
  type ComposerEditorSelection,
} from "../../components/ComposerEditor";
import {
  ComposerInlineControl,
  ComposerToolbarButton,
  ComposerToolbarRow,
  ComposerToolbarScroller,
} from "../../components/ComposerToolbar";
import { ControlPill, ControlPillMenu } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import {
  buildModelOptions,
  type ModelOption,
  groupByProvider,
  resolveModelSelectionRuntimeMode,
  showModelSelectionInteractionModeToggle,
} from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import { useAppearancePreferences } from "../settings/appearance/AppearancePreferencesProvider";
import type { RemoteClientConnectionState } from "../../lib/connection";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";
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
  readonly draftAttachments: ReadonlyArray<DraftComposerImageAttachment>;
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
  readonly onPickDraftImages: () => Promise<void>;
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
const COMPOSER_LAYOUT_TRANSITION =
  Platform.OS === "android" ? undefined : LinearTransition.duration(220);

export function ComposerSurface(props: {
  readonly children: ReactNode;
  readonly style: ViewStyle;
  readonly isDarkMode: boolean;
  /** Existing thread composers morph between pill and card layouts. */
  readonly animateLayout?: boolean;
}) {
  const cardColor = useThemeColor("--color-card-translucent");
  const borderColor = useThemeColor("--color-border");
  const shadowColor = useThemeColor("--color-primary-shadow");
  // Drop shadow lives on a wrapper: `overflow: "hidden"` on the surface itself
  // (needed to clip content to the pill shape) would clip the shadow on iOS.
  const shadowStyle: ViewStyle = {
    borderRadius: props.style.borderRadius,
    shadowColor,
    shadowOpacity: props.isDarkMode ? 0.35 : 0.12,
    shadowRadius: 14,
    shadowOffset: { width: 0, height: 6 },
    elevation: 10,
  };

  return (
    <Animated.View
      layout={props.animateLayout === false ? undefined : COMPOSER_LAYOUT_TRANSITION}
      style={shadowStyle}
    >
      <GlassSurface
        chrome="none"
        fallbackStyle={{
          backgroundColor: cardColor,
          borderWidth: 1,
          borderColor,
        }}
        glassEffectStyle="regular"
        // The composer is a passive material containing interactive controls.
        // Expo GlassView defaults to non-interactive and both layouts share it.
        tintColor="transparent"
        style={props.style}
      >
        {props.children}
      </GlassSurface>
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
  const indicatorColor = useThemeColor("--color-icon-muted");

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
          <ActivityIndicator size="small" color={indicatorColor} />
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
  const { themeAppearance } = useAppearancePreferences();
  const isDarkMode = themeAppearance === "dark";
  const foregroundColor = useThemeColor("--color-foreground");
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

  const [previewImageUri, setPreviewImageUri] = useState<string | null>(null);
  const hasContent = props.draftMessage.trim().length > 0 || props.draftAttachments.length > 0;
  // Opening and presentation count as active so the composer stays expanded
  // while focus moves between its native editor and the settings picker.
  const isExpanded = isFocused || settingsSheetPresentation.isActive;
  const canSend = hasContent;

  // Notify the parent from the derived value, not focus events: the parent
  // sizes the feed inset from this, and blur-during-sheet would otherwise
  // report collapsed while the composer still renders expanded.
  useEffect(() => {
    onExpandedChange?.(isExpanded);
  }, [isExpanded, onExpandedChange]);

  const onPressImage = useCallback(
    (uri: string) => {
      wasExpandedBeforePreviewRef.current = isFocused;
      setPreviewImageUri(uri);
    },
    [isFocused],
  );

  const closePreview = useCallback(() => {
    setPreviewImageUri(null);
    if (wasExpandedBeforePreviewRef.current) {
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [inputRef]);

  const onEditorFocusChange = props.onEditorFocusChange;
  const handleFocus = useCallback(() => {
    setIsFocused(true);
    onEditorFocusChange?.(true);
  }, [onEditorFocusChange]);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    onEditorFocusChange?.(false);
  }, [onEditorFocusChange]);
  const showStopAction =
    props.selectedThread.session?.status === "running" ||
    props.selectedThread.session?.status === "starting";

  const currentModelSelection = props.selectedThread.modelSelection;
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
  const toolbarSurface = String(useThemeColor("--color-card"));
  const backdropSurface = String(useThemeColor("--color-screen"));
  const toolbarFadeOpaque = themeColorWithAlpha(toolbarSurface, 0.95);
  const toolbarFadeTransparent = themeColorWithAlpha(toolbarSurface, 0);
  const backdropGradient = `linear-gradient(to bottom, ${themeColorWithAlpha(backdropSurface, 0)} 0%, ${themeColorWithAlpha(backdropSurface, 0.6)} 55%, ${themeColorWithAlpha(backdropSurface, 0.9)} 100%)`;
  const selectedProviderStatus = useMemo(() => {
    if (!props.serverConfig) return null;
    return (
      props.serverConfig.providers.find(
        (p) => p.instanceId === props.selectedThread.modelSelection.instanceId,
      ) ?? null
    );
  }, [props.serverConfig, props.selectedThread.modelSelection.instanceId]);
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
    [currentModelSelection, modelChangesLocked, props.selectedThread.session],
  );
  const quickQuestionAvailable = canOpenQuickQuestion({
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
    props.selectedThread.session?.status === "running" &&
    !props.sessionInputBlocked &&
    props.localOutboxCount === 0 &&
    supportsSessionInputQueueFollowUp(activeSessionProviderStatus);
  const canClearSessionInputQueue =
    props.connectionState === "connected" &&
    props.selectedThread.session?.status === "running" &&
    props.selectedThread.session.activeTurnId != null &&
    sessionQueueCount > 0 &&
    supportsSessionInputQueueClear(activeSessionProviderStatus);
  const canRemoveOnlySessionInputQueueItem =
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
    props.connectionState === "connected" &&
    (props.selectedThread.session?.status === "ready" ||
      props.selectedThread.session?.status === "running") &&
    !isMutatingSessionInputQueue;
  // A busy thread is no longer a reason to hold a message back: the outbox now
  // delivers while a turn runs so the message steers it. Only a lost connection
  // or an already-queued message still means "saved rather than sent".
  const sendLabel = canQueueFollowUp
    ? "Queue follow-up"
    : props.connectionState !== "connected" || props.localOutboxCount > 0
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
    props.sessionCompactionPendingAction === null &&
    canStartSessionCompaction(activeSessionProviderStatus, props.sessionCompaction);
  const canAbortSessionContext =
    sessionCompactionConnected &&
    props.sessionCompactionPendingAction === null &&
    canAbortSessionCompaction(activeSessionProviderStatus, props.sessionCompaction);
  const canSetSessionAutoCompaction =
    sessionCompactionConnected &&
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
      const expectedScopeKey = current.scopeKey;
      if (action === "compact") {
        Alert.alert(
          "Compact context now?",
          "This reduces the current provider session's context. The agent may briefly pause.",
          [
            { text: "Not now", style: "cancel" },
            {
              text: "Compact",
              onPress: () => runSessionCompactionAction(action, expectedScopeKey),
            },
          ],
        );
        return;
      }
      runSessionCompactionAction(action, expectedScopeKey);
    },
    [runSessionCompactionAction],
  );

  const providerSlashCommands = useMemo(
    () =>
      resolveSessionSlashCommands(
        selectedProviderStatus?.featureCapabilities?.resources?.operations.includes("commands") &&
          props.sessionResources?.providerInstanceId === selectedProviderStatus.instanceId
          ? props.sessionResources
          : null,
        selectedProviderStatus?.slashCommands ?? [],
      ),
    [
      selectedProviderStatus?.featureCapabilities?.resources?.operations,
      selectedProviderStatus?.slashCommands,
      props.sessionResources,
    ],
  );

  // ── Trigger detection ────────────────────────────────────
  const [composerSelection, setComposerSelection] = useState(() => ({
    start: props.draftMessage.length,
    end: props.draftMessage.length,
  }));

  const handleSelectionChange = useCallback((selection: ComposerEditorSelection) => {
    setComposerSelection(selection);
  }, []);
  useEffect(() => {
    const end = props.draftMessage.length;
    setComposerSelection((selection) => {
      const start = Math.min(selection.start, end);
      const selectionEnd = Math.min(selection.end, end);
      if (start === selection.start && selectionEnd === selection.end) {
        return selection;
      }
      return { start, end: selectionEnd };
    });
  }, [props.draftMessage.length]);

  const composerTrigger = useMemo<ComposerTrigger | null>(() => {
    if (composerSelection.start !== composerSelection.end) {
      return null;
    }
    return detectComposerTrigger(props.draftMessage, composerSelection.end);
  }, [composerSelection, props.draftMessage]);
  const pathSearch = useComposerPathSearch({
    environmentId: props.environmentId,
    cwd: composerTrigger?.kind === "path" ? props.projectCwd : null,
    query: composerTrigger?.kind === "path" ? composerTrigger.query : null,
  });

  const composerMenuItems: ComposerCommandItem[] = useMemo(() => {
    if (!composerTrigger) return [];

    if (composerTrigger.kind === "slash-command") {
      const q = composerTrigger.query.toLowerCase();
      const allBuiltIn = [
        {
          id: "cmd:model",
          type: "slash-command" as const,
          command: "model",
          label: "/model",
          description: "Switch model",
        },
        ...(showInteractionModeToggle
          ? [
              {
                id: "cmd:plan",
                type: "slash-command" as const,
                command: "plan" as const,
                label: "/plan",
                description: "Switch to plan mode",
              },
              {
                id: "cmd:default",
                type: "slash-command" as const,
                command: "default" as const,
                label: "/default",
                description: "Switch to default mode",
              },
            ]
          : []),
      ];
      const builtIn = allBuiltIn.filter((item) => item.command.includes(q));

      const providerCommands: ComposerCommandItem[] = [];
      for (const cmd of providerSlashCommands) {
        if (!cmd.name.toLowerCase().includes(q)) continue;
        providerCommands.push({
          id: `pcmd:${cmd.name}`,
          type: "provider-slash-command" as const,
          command: cmd,
          label: `/${cmd.name}`,
          description: formatProviderSlashCommandDescription(cmd),
        });
      }

      const skillItems = (selectedProviderStatus?.skills ?? [])
        .filter((skill) => matchesSlashSkillQuery(skill, q))
        .map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: `skill:${skill.name}`,
          description: skill.shortDescription ?? skill.description ?? "",
        }));

      return [...builtIn, ...providerCommands, ...skillItems];
    }

    if (composerTrigger.kind === "skill") {
      const enabledSkills = (selectedProviderStatus?.skills ?? []).filter((s) => s.enabled);
      const normalizedQuery = normalizeSearchQuery(composerTrigger.query, {
        trimLeadingPattern: /^\$+/,
      });

      if (!normalizedQuery) {
        return enabledSkills.slice(0, 20).map((skill) => ({
          id: `skill:${skill.name}`,
          type: "skill" as const,
          skill,
          label: skill.displayName ?? skill.name,
          description: skill.shortDescription ?? skill.description ?? "",
        }));
      }

      const ranked: Array<{
        item: (typeof enabledSkills)[number];
        score: number;
        tieBreaker: string;
      }> = [];
      for (const skill of enabledSkills) {
        const displayLabel = (skill.displayName ?? skill.name).toLowerCase();
        const scores = [
          scoreQueryMatch({
            value: skill.name.toLowerCase(),
            query: normalizedQuery,
            exactBase: 0,
            prefixBase: 2,
            boundaryBase: 4,
            includesBase: 6,
            fuzzyBase: 100,
            boundaryMarkers: ["-", "_", "/"],
          }),
          scoreQueryMatch({
            value: displayLabel,
            query: normalizedQuery,
            exactBase: 1,
            prefixBase: 3,
            boundaryBase: 5,
            includesBase: 7,
            fuzzyBase: 110,
          }),
          scoreQueryMatch({
            value: skill.shortDescription?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 20,
            prefixBase: 22,
            boundaryBase: 24,
            includesBase: 26,
          }),
          scoreQueryMatch({
            value: skill.description?.toLowerCase() ?? "",
            query: normalizedQuery,
            exactBase: 30,
            prefixBase: 32,
            boundaryBase: 34,
            includesBase: 36,
          }),
        ].filter((s): s is number => s !== null);

        if (scores.length > 0) {
          insertRankedSearchResult(
            ranked,
            {
              item: skill,
              score: Math.min(...scores),
              tieBreaker: `${displayLabel}\u0000${skill.name}`,
            },
            20,
          );
        }
      }

      return ranked.map(({ item: skill }) => ({
        id: `skill:${skill.name}`,
        type: "skill" as const,
        skill,
        label: skill.displayName ?? skill.name,
        description: skill.shortDescription ?? skill.description ?? "",
      }));
    }

    if (composerTrigger.kind === "path") {
      return pathSearch.entries.map((entry) => {
        const parts = entry.path.split("/");
        return {
          id: `path:${entry.path}`,
          type: "path" as const,
          path: entry.path,
          kind: entry.kind,
          label: parts[parts.length - 1] ?? entry.path,
          description: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
        };
      });
    }

    return [];
  }, [
    composerTrigger,
    pathSearch.entries,
    providerSlashCommands,
    selectedProviderStatus,
    showInteractionModeToggle,
  ]);

  // ── Handle command selection ──────────────────────────────
  const { onChangeDraftMessage, onUpdateInteractionMode, draftMessage, onSendMessage } = props;

  const handleSend = useCallback(async () => {
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
    onSendMessage,
    props.environmentId,
    props.environmentLabel,
    props.selectedThread.id,
    props.selectedThread.title,
  ]);
  const handleQueueFollowUp = useCallback(async () => {
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

  const handleCommandSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!composerTrigger) return;

      if (
        item.type === "slash-command" &&
        (item.command === "plan" || item.command === "default")
      ) {
        const result = replaceTextRange(
          draftMessage,
          composerTrigger.rangeStart,
          composerTrigger.rangeEnd,
          "",
        );
        setComposerSelection({ start: result.cursor, end: result.cursor });
        onChangeDraftMessage(result.text);
        onUpdateInteractionMode(item.command);
        return;
      }

      let replacement = "";
      if (item.type === "path") {
        replacement = `${serializeComposerFileLink(item.path)} `;
      } else if (item.type === "skill") {
        replacement = `$${item.skill.name} `;
      } else if (item.type === "slash-command") {
        replacement = `/${item.command} `;
      } else if (item.type === "provider-slash-command") {
        replacement = `/${item.command.name} `;
      }

      const result = replaceTextRange(
        draftMessage,
        composerTrigger.rangeStart,
        composerTrigger.rangeEnd,
        replacement,
      );
      setComposerSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
    },
    [composerTrigger, draftMessage, onChangeDraftMessage, onUpdateInteractionMode],
  );

  // ── Model menu ───────────────────────────────────────────
  const modelOptions = useMemo(
    () => buildModelOptions(props.serverConfig, currentModelSelection),
    [props.serverConfig, currentModelSelection],
  );
  const providerGroups = useMemo(() => groupByProvider(modelOptions), [modelOptions]);
  // An existing thread is bound to its harness: sessions can't move between
  // provider instances, so the picker only offers the thread's own group.
  const threadProviderGroups = useMemo(
    () => providerGroups.filter((group) => group.providerKey === currentModelSelection.instanceId),
    [providerGroups, currentModelSelection.instanceId],
  );
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
  const settingsOwnerId = scopedThreadKey(props.environmentId, props.selectedThread.id);
  const settingsRouteSession = useMemo<ExistingThreadSettingsRouteSession>(
    () => ({
      ownerId: settingsOwnerId,
      providerGroups: threadProviderGroups,
      selectedModel: currentModelSelection,
      onSelectModel: (option) => props.onUpdateModelSelection(option.selection),
      optionDescriptors: providerOptionDescriptors,
      onUpdateOptionSelections: (options) =>
        props.onUpdateModelSelection({ ...currentModelSelection, options }),
      runtimeMode: currentRuntimeMode,
      onUpdateRuntimeMode: props.onUpdateRuntimeMode,
      getModelDisabledReason: getModelChangeDisabledReason,
    }),
    [
      confirmSessionHarnessRefinement,
      currentModelSelection,
      currentRuntimeMode,
      getModelChangeDisabledReason,
      props.onUpdateModelSelection,
      props.onUpdateRuntimeMode,
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
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          {
            experimental_backgroundImage: backdropGradient,
          },
        ]}
      />
      <Animated.View
        className="relative w-full self-center"
        layout={COMPOSER_LAYOUT_TRANSITION}
        style={{ maxWidth: props.contentMaxWidth }}
      >
        {composerTrigger && composerMenuItems.length > 0 ? (
          <View className="absolute inset-x-0 bottom-full z-10 mb-2">
            <ComposerCommandPopover
              items={composerMenuItems}
              triggerKind={composerTrigger.kind}
              isLoading={pathSearch.isPending}
              onSelect={handleCommandSelect}
            />
          </View>
        ) : null}

        {connectionStatus ? (
          <ComposerConnectionStatusPill
            status={connectionStatus}
            onPress={props.onReconnectEnvironment}
          />
        ) : null}

        <ComposerSurface
          isDarkMode={isDarkMode}
          style={
            isExpanded
              ? {
                  borderRadius: 26,
                  minHeight: 140,
                  overflow: "hidden" as const,
                  paddingBottom: 6,
                  paddingHorizontal: 14,
                  paddingTop: 14,
                }
              : {
                  borderRadius: 999,
                  overflow: "hidden" as const,
                  flexDirection: "row" as const,
                  alignItems: "center" as const,
                  paddingLeft: 18,
                  paddingRight: 5,
                  paddingVertical: 5,
                }
          }
        >
          {/* Attachment strip — inside the card, above the text input */}
          {isExpanded ? (
            <Animated.View
              className={props.draftAttachments.length > 0 ? "pb-2.5" : undefined}
              entering={FadeIn.duration(160)}
              exiting={FadeOut.duration(120)}
            >
              <ComposerAttachmentStrip
                attachments={props.draftAttachments}
                onRemove={props.onRemoveDraftImage}
                onPressImage={onPressImage}
              />
            </Animated.View>
          ) : null}

          <View className={isExpanded ? undefined : "min-w-0 flex-1"}>
            <ComposerEditor
              ref={inputRef}
              multiline
              value={props.draftMessage}
              skills={selectedProviderStatus?.skills ?? []}
              selection={composerSelection}
              onChangeText={props.onChangeDraftMessage}
              onSelectionChange={handleSelectionChange}
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
                      paddingHorizontal: 4,
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
              {props.draftAttachments.slice(0, 3).map((image) => (
                <Pressable key={image.id} onPress={() => onPressImage(image.previewUri)}>
                  <Image
                    source={{ uri: image.previewUri }}
                    className="size-[30px] rounded-lg bg-subtle"
                    resizeMode="cover"
                  />
                </Pressable>
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
          {!isExpanded ? (
            <Animated.View entering={FadeIn.duration(180)} exiting={FadeOut.duration(100)}>
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
                      accessibilityLabel="Queue follow-up"
                      icon="arrow.up"
                      variant="primary"
                      disabled={!canSend || isMutatingSessionInputQueue}
                      onPress={handleQueueFollowUp}
                    />
                  ) : null}
                </View>
              ) : (
                <ControlPill
                  accessibilityLabel={sendLabel}
                  icon="arrow.up"
                  variant="primary"
                  disabled={!canSend}
                  onPress={handleSend}
                />
              )}
            </Animated.View>
          ) : null}
          {isExpanded ? (
            <ComposerToolbarRow paddingBottom={0} paddingHorizontal={0} paddingTop={4}>
              <ComposerToolbarScroller
                fadeOpaque={toolbarFadeOpaque}
                fadeTransparent={toolbarFadeTransparent}
                contentPaddingRight={8}
              >
                <ComposerToolbarButton
                  accessibilityLabel="Add attachment"
                  icon="plus"
                  onPress={() => void props.onPickDraftImages()}
                  showChevron={false}
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
                    onPressAction={({ nativeEvent }) => handleSessionAgentAction(nativeEvent.event)}
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
                {showStopAction ? (
                  <ComposerToolbarButton
                    accessibilityLabel="Stop"
                    icon="stop.fill"
                    variant="danger"
                    onPress={props.onStopThread}
                    showChevron={false}
                  />
                ) : null}
              </ComposerToolbarScroller>
              <ComposerToolbarButton
                accessibilityLabel={sendLabel}
                icon="arrow.up"
                variant="primary"
                disabled={!canSend || (canQueueFollowUp && isMutatingSessionInputQueue)}
                onPress={canQueueFollowUp ? handleQueueFollowUp : handleSend}
                showChevron={false}
              />
            </ComposerToolbarRow>
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
            <Text className="pt-2 text-xs text-foreground-muted">
              {props.localOutboxCount} pending send{props.localOutboxCount === 1 ? "" : "s"} on this
              device.
            </Text>
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
      <ImageViewing
        images={previewImageUri ? [{ uri: previewImageUri }] : []}
        imageIndex={0}
        visible={previewImageUri !== null}
        onRequestClose={closePreview}
        swipeToCloseEnabled
        doubleTapToZoomEnabled
      />
    </Animated.View>
  );
});
