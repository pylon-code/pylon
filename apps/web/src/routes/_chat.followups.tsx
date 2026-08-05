import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { FollowUpList } from "~/components/followups/FollowUpList";
import { SidebarInset } from "~/components/ui/sidebar";
import { useEnvironments } from "~/state/environments";
import { resolveFollowUpAvailability } from "~/state/followups";

const FOLLOW_UP_ROUTE_CLASS =
  "h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh";

function FollowUpsRouteView() {
  const navigate = useNavigate();
  const { environments, isReady } = useEnvironments();
  const availability = resolveFollowUpAvailability(isReady, environments);

  useEffect(() => {
    if (availability === "unavailable") {
      void navigate({ to: "/", replace: true });
    }
  }, [availability, navigate]);

  if (availability === "unavailable") return null;
  if (availability === "pending") {
    return (
      <SidebarInset className={FOLLOW_UP_ROUTE_CLASS}>
        <div className="flex min-h-0 flex-1 items-center justify-center" role="status">
          <p className="text-xs font-medium text-muted-foreground">Loading Follow-ups…</p>
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
