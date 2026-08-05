import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { FollowUpList } from "~/components/followups/FollowUpList";
import { SidebarInset } from "~/components/ui/sidebar";
import { useEnvironments } from "~/state/environments";
import { resolveFollowUpAvailability } from "~/state/followups";
import { resolveFollowUpsRoutePresentation } from "./followUpsRoute.logic";

const FOLLOW_UP_ROUTE_CLASS =
  "h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh";

function FollowUpsRouteView() {
  const navigate = useNavigate();
  const { environments, isReady } = useEnvironments();
  const availability = resolveFollowUpAvailability(isReady, environments);
  const presentation = resolveFollowUpsRoutePresentation(availability);

  useEffect(() => {
    if (presentation.kind === "redirect") {
      void navigate({ to: "/", replace: true });
    }
  }, [navigate, presentation.kind]);

  if (presentation.kind === "redirect") return null;
  if (presentation.kind === "status") {
    return (
      <SidebarInset className={FOLLOW_UP_ROUTE_CLASS}>
        <div className="flex min-h-0 flex-1 items-center justify-center" role="status">
          <p className="max-w-sm text-center text-xs font-medium text-muted-foreground">
            {presentation.message}
          </p>
        </div>
      </SidebarInset>
    );
  }

  return (
    <SidebarInset className={FOLLOW_UP_ROUTE_CLASS}>
      <FollowUpList />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/followups")({
  component: FollowUpsRouteView,
});
