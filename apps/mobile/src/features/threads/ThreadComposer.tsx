import { isLiquidGlassSupported, LiquidGlassView } from "@callstack/liquid-glass";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import {
  canAbortSessionCompaction,
  canConfigureSessionAutoCompaction,
  canStartSessionCompaction,
  isSessionCompactionInProgress,
  type SessionCompactionControlSnapshot,
} from "@t3tools/client-runtime/state/context-compaction";
import {
  isActiveSubagentStatus,
  supportsSessionAgentCancel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import {
  hasSessionInputQueueModes,
  sessionInputQueueCount,
  supportsSessionInputQueue,
  supportsSessionInputQueueClear,
  supportsSessionInputQueueFollowUp,
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
  resolveSessionSlashCommands,
  supportsSessionResourceReload,
  type SessionResourcesSnapshot,
} from "@t3tools/client-runtime/state/session-resources";
import type {
  EnvironmentId,
  MessageId,
  ModelSelection,
  OrchestrationThreadShell,
  ProviderInteractionMode,
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
  Platform,
  Pressable,
  StyleSheet,
  useColorScheme,
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
import { armAgentAwarenessLiveActivityForLocalWork } from "../agent-awareness/remoteRegistration";
import { scopedThreadKey } from "../../lib/scopedEntities";

import { AppText as Text } from "../../components/AppText";
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
import { ControlPill } from "../../components/ControlPill";
import { ProviderIcon } from "../../components/ProviderIcon";
import type { DraftComposerImageAttachment } from "../../lib/composerImages";
import {
  buildModelOptions,
  getModelSelectionSupportedRuntimeModes,
  groupByProvider,
  resolveModelSelectionRuntimeMode,
  showModelSelectionInteractionModeToggle,
} from "../../lib/modelOptions";
import { useScaledTextRole } from "../settings/appearance/useScaledTextRole";
import type { RemoteClientConnectionState } from "../../lib/connection";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import { ComposerCommandPopover, type ComposerCommandItem } from "./ComposerCommandPopover";
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
} from "./sessionInputQueueMenu";
import {
  buildSessionCompactionMenuActions,
  parseSessionCompactionMenuAction,
  type SessionCompactionMenuAction,
} from "./sessionCompactionMenu";

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
  readonly onSetSessionAgentDepth: (maxDepth: number) => Promise<void>;
  readonly onSendMessage: () => Promise<MessageId | null>;
  readonly onQueueFollowUp: () => Promise<MessageId | null>;
  readonly onClearSessionInputQueue: () => Promise<boolean>;
  readonly onSetSessionInputQueueMode: (
    queue: "steering" | "follow-up",
    mode: "all-at-once" | "one-at-a-time",
  ) => Promise<boolean>;
  readonly onRunSessionCompactionAction: (action: SessionCompactionMenuAction) => Promise<boolean>;
  readonly onCancelSessionAgent: (agentId: string) => Promise<boolean>;
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
  // Drop shadow lives on a wrapper: `overflow: "hidden"` on the surface itself
  // (needed to clip content to the pill shape) would clip the shadow on iOS.
  const shadowStyle: ViewStyle = {
    borderRadius: props.style.borderRadius,
    shadowColor: "#000000",
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
          backgroundColor: props.isDarkMode ? "rgba(44,44,46,0.96)" : "rgba(255,255,255,0.96)",
          borderWidth: 1,
          borderColor: props.isDarkMode ? "rgba(255,255,255,0.08)" : "rgba(0,0,0,0.06)",
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
        className="max-w-full flex-row items-center gap-2 rounded-full bg-white/90 px-3 py-2 shadow-sm active:opacity-70 dark:bg-neutral-900/90"
      >
        {isReconnecting ? (
          <ActivityIndicator size="small" color="#8e8e93" />
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
  const isDarkMode = useColorScheme() === "dark";
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
  const supportedRuntimeModes = getModelSelectionSupportedRuntimeModes(
    props.serverConfig,
    currentModelSelection,
  );
  const showInteractionModeToggle = showModelSelectionInteractionModeToggle(
    props.serverConfig,
    currentModelSelection,
  );
  const currentInteractionMode = showInteractionModeToggle
    ? (props.selectedThread.interactionMode ?? "default")
    : "default";
  const connectionStatus = composerConnectionStatus({
    connectionError: props.connectionError,
    connectionState: props.connectionState,
    environmentLabel: props.environmentLabel,
    threadSyncPhase: props.threadSyncPhase,
  });
  const toolbarFadeOpaque = isDarkMode ? "rgba(0,0,0,0.95)" : "rgba(255,255,255,0.95)";
  const toolbarFadeTransparent = isDarkMode ? "rgba(0,0,0,0)" : "rgba(255,255,255,0)";
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
  const sendLabel = canQueueFollowUp
    ? "Queue follow-up"
    : props.connectionState !== "connected" || props.activeThreadBusy || props.localOutboxCount > 0
      ? "Save pending send"
      : "Send";

  const showSessionResourceReload =
    props.selectedThread.session?.runtimeMode === "full-access" &&
    supportsSessionResourceReload(activeSessionProviderStatus);
  const sessionResourceReloadDisabled =
    props.connectionState !== "connected" ||
    props.activeThreadBusy ||
    props.selectedThread.session?.status !== "ready";
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
  const canCancelSessionAgents =
    props.connectionState === "connected" &&
    props.selectedThread.session?.runtimeMode === "full-access" &&
    (props.selectedThread.session.status === "ready" ||
      props.selectedThread.session.status === "running") &&
    supportsSessionAgentCancel(activeSessionProviderStatus);
  const [cancellingAgentIds, setCancellingAgentIds] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => {
    const activeIds = new Set(activeSessionAgents.map((agent) => agent.id));
    setCancellingAgentIds((current) => {
      const next = new Set([...current].filter((agentId) => activeIds.has(agentId)));
      return next.size === current.size ? current : next;
    });
  }, [activeSessionAgents]);
  useEffect(() => {
    setCancellingAgentIds(new Set());
  }, [props.environmentId, props.selectedThread.id]);
  const sessionAgentScopeKey = `${props.environmentId}:${props.selectedThread.id}`;
  const sessionAgentControlRef = useRef({
    scopeKey: sessionAgentScopeKey,
    agents: props.sessionAgents,
    canCancel: canCancelSessionAgents,
    cancellingAgentIds,
    onCancel: props.onCancelSessionAgent,
  });
  sessionAgentControlRef.current = {
    scopeKey: sessionAgentScopeKey,
    agents: props.sessionAgents,
    canCancel: canCancelSessionAgents,
    cancellingAgentIds,
    onCancel: props.onCancelSessionAgent,
  };
  const sessionAgentActions = useMemo(
    () =>
      activeSessionAgents.map((agent) => {
        const stopping = cancellingAgentIds.has(agent.id);
        return {
          id: `cancel-session-agent:${agent.id}`,
          title: stopping ? `Stopping ${agent.title}` : `Stop ${agent.title}`,
          subtitle: stopping
            ? "Waiting for provider confirmation"
            : "End this agent's current work",
          image: "stop.fill",
          attributes:
            stopping || !canCancelSessionAgents
              ? ({ destructive: true, disabled: true } as const)
              : ({ destructive: true } as const),
        };
      }),
    [activeSessionAgents, canCancelSessionAgents, cancellingAgentIds],
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
  const handleSessionAgentAction = useCallback(
    (eventId: string) => {
      if (!eventId.startsWith("cancel-session-agent:")) return;
      const agentId = eventId.slice("cancel-session-agent:".length);
      const control = sessionAgentControlRef.current;
      const agent = control.agents.find((candidate) => candidate.id === agentId);
      if (
        !agent ||
        !control.canCancel ||
        !isActiveSubagentStatus(agent.status) ||
        control.cancellingAgentIds.has(agent.id)
      ) {
        return;
      }
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
    [cancelSessionAgent],
  );

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
        selectedProviderStatus?.featureCapabilities?.resources?.operations.includes("commands")
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

      return [...builtIn, ...providerCommands];
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
      await onSendMessage();
      // Sending a prompt starts agent work: arm the lock-screen card while the
      // app is foregrounded and the activity token can be registered. Armed
      // after the send so its preference read and native Activity start don't
      // contend with the queued-message feedback on the tap frame.
      armAgentAwarenessLiveActivityForLocalWork({
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
            mutating: isMutatingSessionInputQueue,
          })
        : [],
    [
      canClearSessionInputQueue,
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
      canSetSessionInputQueueModes,
      confirmClearSessionInputQueue,
      isMutatingSessionInputQueue,
      props.onSetSessionInputQueueMode,
      props.sessionInputQueue?.followUpMode,
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
    }),
    [
      currentModelSelection,
      currentRuntimeMode,
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
            experimental_backgroundImage: isDarkMode
              ? "linear-gradient(to bottom, rgba(0,0,0,0) 0%, rgba(0,0,0,0.6) 55%, rgba(0,0,0,0.9) 100%)"
              : "linear-gradient(to bottom, rgba(255,255,255,0) 0%, rgba(255,255,255,0.6) 55%, rgba(255,255,255,0.9) 100%)",
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
                      <ComposerToolbarTrigger
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
                ) : null}
                {activeSessionAgents.length > 0 &&
                supportsSessionAgentCancel(activeSessionProviderStatus) ? (
                  <ControlPillMenu
                    title="Active agents"
                    actions={sessionAgentActions}
                    onPressAction={({ nativeEvent }) => handleSessionAgentAction(nativeEvent.event)}
                  >
                    <ComposerToolbarTrigger
                      accessibilityLabel={`${activeSessionAgents.length} active ${activeSessionAgents.length === 1 ? "agent" : "agents"}`}
                      icon="person.2"
                      label={`${activeSessionAgents.length} ${activeSessionAgents.length === 1 ? "agent" : "agents"}`}
                      disabled={!canCancelSessionAgents}
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
                    <ComposerToolbarTrigger
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
                    <ComposerToolbarTrigger
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
                {showSessionResourceReload ? (
                  <ComposerToolbarButton
                    accessibilityLabel={
                      isReloadingSessionResources
                        ? "Reloading session resources"
                        : "Reload session resources"
                    }
                    icon="arrow.clockwise"
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
