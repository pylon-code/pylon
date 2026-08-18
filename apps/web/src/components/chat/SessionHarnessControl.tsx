import type { SessionAgentDepthSnapshot } from "@t3tools/client-runtime/state/session-agent-depth";
import type { SessionResourceInventory } from "@t3tools/client-runtime/state/session-resources";
import { BotIcon, LibraryIcon, RefreshCwIcon } from "lucide-react";

import { ComposerControl, ComposerControlChevron, ComposerControlIcon } from "./ComposerControl";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";

export function SessionHarnessControl(props: {
  readonly agentDepth: SessionAgentDepthSnapshot | null;
  readonly agentDepthDisabled: boolean;
  readonly agentDepthAccessibleLabel: string | null;
  readonly resourceInventory: SessionResourceInventory | null;
  readonly showResourceReload: boolean;
  readonly resourceReloadDisabled: boolean;
  readonly isReloadingResources: boolean;
  readonly onSetAgentDepth: (maxDepth: number) => void;
  readonly onOpenResources: () => void;
  readonly onReloadResources: () => void;
}) {
  const resourceCount = props.resourceInventory
    ? props.resourceInventory.skills.length + props.resourceInventory.prompts.length
    : null;

  return (
    <Menu>
      <MenuTrigger
        render={
          <ComposerControl
            type="button"
            className="shrink-0 font-medium"
            aria-label={
              props.agentDepthAccessibleLabel
                ? `Session harness controls. ${props.agentDepthAccessibleLabel}.`
                : "Session harness controls"
            }
          />
        }
      >
        <ComposerControlIcon icon={BotIcon} opticalSize="large" />
        <span>Harness</span>
        <ComposerControlChevron />
      </MenuTrigger>
      <MenuPopup side="top" align="start" className="w-72 max-w-[calc(100vw-2rem)]">
        {props.agentDepth ? (
          <MenuGroup>
            <MenuGroupLabel>Subagent depth</MenuGroupLabel>
            <MenuRadioGroup
              value={String(props.agentDepth.maxDepth)}
              onValueChange={(value) => {
                if (value === null || props.agentDepthDisabled) return;
                const maxDepth = Number(value);
                if (Number.isInteger(maxDepth)) props.onSetAgentDepth(maxDepth);
              }}
            >
              {props.agentDepth.maxDepth > props.agentDepth.maxSettableDepth ? (
                <MenuRadioItem value={String(props.agentDepth.maxDepth)} disabled className="py-2">
                  <div className="grid gap-0.5">
                    <span className="font-medium">Depth {props.agentDepth.maxDepth}</span>
                    <span className="text-muted-foreground text-xs leading-4">
                      Current provider setting · choose a bounded value below
                    </span>
                  </div>
                </MenuRadioItem>
              ) : null}
              {Array.from({ length: props.agentDepth.maxSettableDepth + 1 }, (_, maxDepth) => (
                <MenuRadioItem
                  key={maxDepth}
                  value={String(maxDepth)}
                  disabled={props.agentDepthDisabled}
                  className="py-2"
                >
                  <div className="grid gap-0.5">
                    <span className="font-medium">Depth {maxDepth}</span>
                    <span className="text-muted-foreground text-xs leading-4">
                      {maxDepth === 0
                        ? "Do not spawn recursive agents"
                        : maxDepth === 1
                          ? "Allow direct child agents"
                          : `Allow up to ${maxDepth} recursive levels`}
                    </span>
                  </div>
                </MenuRadioItem>
              ))}
            </MenuRadioGroup>
          </MenuGroup>
        ) : null}

        {props.agentDepth && (props.resourceInventory || props.showResourceReload) ? (
          <MenuSeparator />
        ) : null}

        {props.resourceInventory || props.showResourceReload ? (
          <MenuGroup>
            <MenuGroupLabel>Commands and resources</MenuGroupLabel>
            {props.resourceInventory ? (
              <MenuItem onClick={props.onOpenResources}>
                <LibraryIcon />
                <span>Browse skills and prompts</span>
                <span className="ms-auto text-muted-foreground text-xs tabular-nums">
                  {resourceCount}
                </span>
              </MenuItem>
            ) : null}
            {props.showResourceReload ? (
              <MenuItem
                disabled={props.resourceReloadDisabled || props.isReloadingResources}
                onClick={props.onReloadResources}
              >
                <RefreshCwIcon />
                <span>
                  {props.isReloadingResources ? "Reloading…" : "Reload commands and resources"}
                </span>
              </MenuItem>
            ) : null}
            {props.showResourceReload ? (
              <p className="px-2 py-1 text-pretty text-muted-foreground text-xs leading-4">
                Use reload after adding or changing session commands, skills, or prompts.
              </p>
            ) : null}
          </MenuGroup>
        ) : null}
      </MenuPopup>
    </Menu>
  );
}
