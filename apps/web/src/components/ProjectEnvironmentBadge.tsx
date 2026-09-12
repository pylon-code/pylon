import type { EnvironmentId, EnvironmentMachineKind } from "@t3tools/contracts";

import type { SidebarProjectSnapshot } from "~/sidebarProjectGrouping";
import { EnvironmentMachineIcon } from "./EnvironmentMachineIcon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * Machine icon for a project picker row whose group has a member on another
 * environment, with the environment names in a tooltip. Projects that only
 * live on this device render nothing, the rule thread rows use for their
 * machine icon. Callers
 * render it only while the catalog spans environments (see
 * projectGroupsSpanEnvironments), so single-machine users see no change.
 */
export function getProjectEnvironmentPresentation(
  members: ReadonlyArray<{ environmentId: EnvironmentId; environmentLabel: string | null }>,
  primaryEnvironmentId: EnvironmentId | null,
) {
  // Member order follows registration order and can differ between sessions,
  // so sort by label to keep the icon and tooltip stable.
  const remoteMembers = members
    .filter((member) => member.environmentId !== primaryEnvironmentId)
    .map((member) => ({ ...member, environmentLabel: member.environmentLabel ?? "Remote" }))
    .sort((a, b) => a.environmentLabel.localeCompare(b.environmentLabel));
  const first = remoteMembers[0];
  if (!first) return null;
  const labels = remoteMembers
    .map((member) => member.environmentLabel)
    .filter((label, index, all) => all.indexOf(label) === index)
    .join(", ");
  const alsoHere = remoteMembers.length < members.length;
  const description = `${alsoHere ? "Also on" : "On"} ${labels}`;
  return { environmentId: first.environmentId, description };
}

export function ProjectEnvironmentBadge(props: {
  readonly group: Pick<SidebarProjectSnapshot, "memberProjects">;
  readonly primaryEnvironmentId: EnvironmentId | null;
  readonly machineByEnvironmentId: ReadonlyMap<EnvironmentId, EnvironmentMachineKind>;
}) {
  const presentation = getProjectEnvironmentPresentation(
    props.group.memberProjects,
    props.primaryEnvironmentId,
  );
  if (!presentation) return null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={presentation.description}
            className="ml-auto inline-flex shrink-0 items-center text-muted-foreground"
          />
        }
      >
        <EnvironmentMachineIcon
          aria-hidden
          kind={props.machineByEnvironmentId.get(presentation.environmentId) ?? "server"}
          className="size-3.5"
        />
      </TooltipTrigger>
      <TooltipPopup side="top">{presentation.description}</TooltipPopup>
    </Tooltip>
  );
}
