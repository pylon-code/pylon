import { useAtomValue } from "@effect/atom-react";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect } from "react";

import { FollowUpList } from "~/components/followups/FollowUpList";
import { SidebarInset } from "~/components/ui/sidebar";
import { usePrimarySettings } from "~/hooks/useSettings";
import { isFollowUpBetaEnabled } from "~/state/followups";
import { primaryServerConfigAtom } from "~/state/server";

function FollowUpsRouteView() {
  const navigate = useNavigate();
  const primaryServerConfig = useAtomValue(primaryServerConfigAtom);
  const enabled = usePrimarySettings(isFollowUpBetaEnabled);

  useEffect(() => {
    if (primaryServerConfig !== null && !enabled) {
      void navigate({ to: "/", replace: true });
    }
  }, [enabled, navigate, primaryServerConfig]);

  if (primaryServerConfig === null || !enabled) return null;

  return (
    <SidebarInset className="h-svh min-h-0 overflow-hidden overscroll-y-none bg-background text-foreground md:h-dvh">
      <FollowUpList />
    </SidebarInset>
  );
}

export const Route = createFileRoute("/_chat/followups")({
  component: FollowUpsRouteView,
});
