import {
  dedupeProviderSkillsByName,
  getProviderSkillsForSlashMenu,
  getProviderSlashCommandsForSlashMenu,
} from "@t3tools/client-runtime/providerSkills";
import type { ComposerPathSearchEntry } from "@t3tools/client-runtime/state/threads";
import {
  formatProviderSlashCommandDescription,
  resolveSessionSlashCommands,
  type SessionResourcesSnapshot,
} from "@t3tools/client-runtime/state/session-resources";
import type {
  EnvironmentId,
  ProviderInteractionMode,
  ServerProvider,
  ServerProviderSlashCommand,
} from "@t3tools/contracts";
import {
  detectComposerTrigger,
  replaceTextRange,
  serializeComposerFileLink,
  type ComposerTrigger,
} from "@t3tools/shared/composerTrigger";
import {
  insertRankedSearchResult,
  normalizeSearchQuery,
  scoreQueryMatch,
} from "@t3tools/shared/searchRanking";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import type { ComposerEditorSelection } from "../../components/ComposerEditor";
import { useComposerPathSearch } from "../../state/use-composer-path-search";
import type { ComposerCommandItem } from "./ComposerCommandPopover";
import { matchesSlashSkillQuery } from "./composerSlashSkillSearch";

/**
 * The slice of a provider snapshot the menu reads. Narrower than `ServerProvider`
 * so the pure builder can be exercised without a full status fixture.
 */
export type ComposerCommandMenuProvider = Pick<
  ServerProvider,
  "instanceId" | "driver" | "skills" | "slashCommands"
>;

/** Skill results are capped so the popover stays a glance, not a list to scroll. */
const MAX_SKILL_RESULTS = 20;

/**
 * Provider commands come from the live session when the provider reports one,
 * and fall back to the catalog snapshot otherwise. Callers that have no session
 * yet — the New task screen — pass `sessionResources: null`.
 */
export function resolveComposerProviderSlashCommands(
  selectedProviderStatus: ServerProvider | null,
  sessionResources: SessionResourcesSnapshot | null,
): ReadonlyArray<ServerProviderSlashCommand> {
  return resolveSessionSlashCommands(
    selectedProviderStatus?.featureCapabilities?.resources?.operations.includes("commands") &&
      sessionResources?.providerInstanceId === selectedProviderStatus.instanceId
      ? sessionResources
      : null,
    selectedProviderStatus?.slashCommands ?? [],
  );
}

/**
 * The pure half of the composer command menu: everything the popover renders for
 * a detected trigger. Kept separate from the hook so both composers share one
 * ranking and filtering implementation and it stays unit-testable.
 */
export function buildComposerCommandItems({
  trigger,
  selectedProviderStatus,
  providerSlashCommands,
  showInteractionModeToggle,
  hasThread,
  pathEntries,
}: {
  readonly trigger: ComposerTrigger | null;
  readonly selectedProviderStatus: ComposerCommandMenuProvider | null;
  readonly providerSlashCommands: ReadonlyArray<ServerProviderSlashCommand>;
  readonly showInteractionModeToggle: boolean;
  readonly hasThread: boolean;
  readonly pathEntries: ReadonlyArray<ComposerPathSearchEntry>;
}): ComposerCommandItem[] {
  if (!trigger) return [];

  if (trigger.kind === "slash-command") {
    const q = trigger.query.toLowerCase();
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

    // Shared with web so both clients agree on what the `/` menu contains.
    // `showSkillsInSlashMenu` is passed as its contract default because the
    // synced settings blob is web-only today; the enabled filter and the
    // native-command dedupe do not depend on it.
    const slashMenuSkills = getProviderSkillsForSlashMenu(
      selectedProviderStatus?.skills ?? [],
      true,
    );

    const providerCommands: ComposerCommandItem[] = [];
    for (const cmd of getProviderSlashCommandsForSlashMenu(
      providerSlashCommands,
      slashMenuSkills,
    )) {
      if (!cmd.name.toLowerCase().includes(q)) continue;
      // Codex `/feedback` uploads an existing thread's session and logs, so it
      // has nothing to send before the thread exists.
      if (!hasThread && selectedProviderStatus?.driver === "codex" && cmd.name === "feedback") {
        continue;
      }
      providerCommands.push({
        id: `pcmd:${cmd.name}`,
        type: "provider-slash-command" as const,
        command: cmd,
        label: `/${cmd.name}`,
        description: formatProviderSlashCommandDescription(cmd),
      });
    }

    const skillItems = slashMenuSkills
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

  if (trigger.kind === "skill") {
    const enabledSkills = dedupeProviderSkillsByName(
      (selectedProviderStatus?.skills ?? []).filter((s) => s.enabled),
    );
    const normalizedQuery = normalizeSearchQuery(trigger.query, {
      trimLeadingPattern: /^\$+/,
    });

    if (!normalizedQuery) {
      return enabledSkills.slice(0, MAX_SKILL_RESULTS).map((skill) => ({
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
          MAX_SKILL_RESULTS,
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

  if (trigger.kind === "path") {
    return pathEntries.map((entry) => {
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
}

/** The text a selected item writes over its trigger range, or `null` for mode switches. */
export function composerCommandReplacement(item: ComposerCommandItem): string | null {
  switch (item.type) {
    case "path":
      return `${serializeComposerFileLink(item.path)} `;
    case "skill":
      return `$${item.skill.name} `;
    case "slash-command":
      return item.command === "plan" || item.command === "default" ? null : `/${item.command} `;
    case "provider-slash-command":
      return `/${item.command.name} `;
  }
}

export function composerSelectionAtEnd(draftMessage: string): ComposerEditorSelection {
  return { start: draftMessage.length, end: draftMessage.length };
}

/**
 * Composer autocomplete shared by the thread composer and the unsent New task
 * draft. Owns the caret selection it needs for trigger detection, so callers
 * pass `selection` and `onSelectionChange` straight through to `ComposerEditor`.
 */
export function useComposerCommandMenu({
  draftMessage,
  ownerKey,
  environmentId,
  projectCwd,
  selectedProviderStatus,
  sessionResources,
  showInteractionModeToggle,
  hasThread,
  enabled = true,
  onChangeDraftMessage,
  onUpdateInteractionMode,
}: {
  readonly draftMessage: string;
  readonly ownerKey: string | null;
  readonly environmentId: EnvironmentId | null;
  readonly projectCwd: string | null;
  readonly selectedProviderStatus: ServerProvider | null;
  readonly sessionResources: SessionResourcesSnapshot | null;
  readonly showInteractionModeToggle: boolean;
  readonly hasThread: boolean;
  readonly enabled?: boolean;
  readonly onChangeDraftMessage: (value: string) => void;
  readonly onUpdateInteractionMode?: (mode: ProviderInteractionMode) => void;
}) {
  const [selection, setSelection] = useState(() => composerSelectionAtEnd(draftMessage));
  const previousOwnerKeyRef = useRef(ownerKey);

  const onSelectionChange = useCallback((nextSelection: ComposerEditorSelection) => {
    setSelection(nextSelection);
  }, []);
  useEffect(() => {
    const end = draftMessage.length;
    setSelection((current) => {
      const start = Math.min(current.start, end);
      const selectionEnd = Math.min(current.end, end);
      if (start === current.start && selectionEnd === current.end) {
        return current;
      }
      return { start, end: selectionEnd };
    });
  }, [draftMessage.length]);
  useEffect(() => {
    if (previousOwnerKeyRef.current === ownerKey) return;
    previousOwnerKeyRef.current = ownerKey;
    setSelection(composerSelectionAtEnd(draftMessage));
  }, [draftMessage, ownerKey]);

  const trigger = useMemo<ComposerTrigger | null>(() => {
    if (!enabled || selection.start !== selection.end) {
      return null;
    }
    return detectComposerTrigger(draftMessage, selection.end);
  }, [draftMessage, enabled, selection]);

  const pathSearch = useComposerPathSearch({
    environmentId,
    cwd: trigger?.kind === "path" ? projectCwd : null,
    query: trigger?.kind === "path" ? trigger.query : null,
  });

  const providerSlashCommands = useMemo(
    () => resolveComposerProviderSlashCommands(selectedProviderStatus, sessionResources),
    [selectedProviderStatus, sessionResources],
  );

  const items = useMemo(
    () =>
      buildComposerCommandItems({
        trigger,
        selectedProviderStatus,
        providerSlashCommands,
        showInteractionModeToggle:
          showInteractionModeToggle && onUpdateInteractionMode !== undefined,
        hasThread,
        pathEntries: pathSearch.entries,
      }),
    [
      hasThread,
      onUpdateInteractionMode,
      pathSearch.entries,
      providerSlashCommands,
      selectedProviderStatus,
      showInteractionModeToggle,
      trigger,
    ],
  );

  const onSelect = useCallback(
    (item: ComposerCommandItem) => {
      if (!trigger) return;

      const replacement = composerCommandReplacement(item);
      const result = replaceTextRange(
        draftMessage,
        trigger.rangeStart,
        trigger.rangeEnd,
        replacement ?? "",
      );
      setSelection({ start: result.cursor, end: result.cursor });
      onChangeDraftMessage(result.text);
      if (replacement === null && item.type === "slash-command") {
        onUpdateInteractionMode?.(item.command === "plan" ? "plan" : "default");
      }
    },
    [draftMessage, onChangeDraftMessage, onUpdateInteractionMode, trigger],
  );

  return {
    selection,
    onSelectionChange,
    trigger,
    items,
    isLoading: pathSearch.isPending,
    onSelect,
  };
}
