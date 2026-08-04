import { useAtomValue } from "@effect/atom-react";
import { useNavigate } from "@tanstack/react-router";
import { ArrowRightLeftIcon, HourglassIcon } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";

import { usePrimarySettings } from "../../hooks/useSettings";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
} from "../../providerInstances";
import { primaryServerProvidersAtom } from "../../state/server";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  getAccountDrainPillView,
  type AccountDrainPillAccount,
} from "./SidebarAccountDrainPill.logic";

/**
 * Coarse enough that the label never lies by more than a minute, slow enough
 * that the sidebar is not repainting. It runs only while the pill is showing.
 */
const DRAIN_PILL_TICK_MS = 60_000;

/** Accounts are told apart by their configured accent color, never by the thread-status palette. */
function AccountDot({ account }: { account: AccountDrainPillAccount }) {
  if (!account.accentColor) return null;
  return (
    <span
      aria-hidden="true"
      className="size-1.5 shrink-0 rounded-full"
      style={{ backgroundColor: account.accentColor }}
    />
  );
}

/**
 * Conditional pill announcing that an account drained and which one picked up
 * the work. Renders nothing while every configured account can serve a turn.
 */
export function SidebarAccountDrainPill() {
  const navigate = useNavigate();
  const providers = useAtomValue(primaryServerProvidersAtom);
  const settings = usePrimarySettings();
  const entries = useMemo(
    () => applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
    [providers, settings],
  );

  // `tick` exists only to re-render the reset label. The view is derived from
  // a fresh clock read each render so it can never show an expired drain.
  const [, setTick] = useState(0);
  const view = getAccountDrainPillView(entries, Date.now());
  const isShowing = view !== null;

  useEffect(() => {
    if (!isShowing) return;
    const intervalId = window.setInterval(() => setTick((value) => value + 1), DRAIN_PILL_TICK_MS);
    return () => window.clearInterval(intervalId);
  }, [isShowing]);

  const openProviderSettings = useCallback(() => {
    void navigate({ to: "/settings/providers" });
  }, [navigate]);

  if (!view) return null;

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            aria-label={view.description}
            className="flex h-7 w-full items-center gap-2 rounded-lg bg-muted/60 px-2 text-left text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
            onClick={openProviderSettings}
          >
            {view.takeover ? (
              <ArrowRightLeftIcon className="size-3.5 shrink-0" />
            ) : (
              <HourglassIcon className="size-3.5 shrink-0" />
            )}
            <AccountDot account={view.takeover ?? view.spent} />
            <span className="truncate">{view.title}</span>
          </button>
        }
      />
      <TooltipPopup side="top">{view.description}</TooltipPopup>
    </Tooltip>
  );
}
