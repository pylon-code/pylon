import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { FollowUpList } from "~/components/followups/FollowUpList";
import { SidebarInset } from "~/components/ui/sidebar";
import { useEnvironments } from "~/state/environments";
import { hasAvailableFollowUpEnvironment } from "~/state/followups";

function FollowUpsRouteView() {
  const navigate = useNavigate();
  const { environments, isReady } = useEnvironments();
  const available = hasAvailableFollowUpEnvironment(environments);

  useEffect(() => {
    if (isReady && !available) {
      void navigate({ to: "/", replace: true });
    }
  }, [available, isReady, navigate]);

  if (!isReady || !available) return null;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <FollowUpList />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/followups")({
  component: FollowUpsRouteView,
});
