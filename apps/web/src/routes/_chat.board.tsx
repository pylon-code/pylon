import { createFileRoute } from "@tanstack/react-router";

import { KanbanBoard } from "../components/kanban/KanbanBoard";
import { SidebarInset } from "../components/ui/sidebar";
import { useProjects, useThreadShells } from "../state/entities";
import { useEnvironments, usePrimaryEnvironmentId } from "../state/environments";
import { COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS } from "../workspaceTitlebar";

function KanbanBoardRoute() {
  const { environments } = useEnvironments();
  const primaryEnvironmentId = usePrimaryEnvironmentId();
  const projects = useProjects();
  const threads = useThreadShells();

  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground">
      <KanbanBoard
        environments={environments}
        primaryEnvironmentId={primaryEnvironmentId}
        projects={projects}
        threads={threads}
        titlebarInsetClassName={COLLAPSED_SIDEBAR_TITLEBAR_INSET_CLASS}
      />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/board")({
  component: KanbanBoardRoute,
});
