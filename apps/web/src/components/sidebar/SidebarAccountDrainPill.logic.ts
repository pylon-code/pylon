/**
 * Pure view derivation for the sidebar account-drain pill.
 *
 * The pill is conditional: it exists only while a configured account is out of
 * subscription capacity, and it says which account took over and when the
 * spent one comes back. Keeping the derivation here leaves the component with
 * nothing but rendering and a one-minute tick.
 *
 * @module components/sidebar/SidebarAccountDrainPill.logic
 */
import {
  isProviderInstanceDrained,
  sortProviderInstancesForRouting,
  type ProviderInstanceEntry,
} from "../../providerInstances";

export interface AccountDrainPillAccount {
  readonly displayName: string;
  readonly accentColor?: string | undefined;
}

export interface AccountDrainPillView {
  /**
   * Identity of the situation being described, not of the moment. It omits the
   * reset time on purpose so a minute tick re-renders the label without
   * remounting the pill.
   */
  readonly key: string;
  readonly title: string;
  readonly description: string;
  readonly spent: AccountDrainPillAccount;
  /** Absent when no other account of the same driver can take the work. */
  readonly takeover?: AccountDrainPillAccount | undefined;
}

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

/**
 * Coarse "time until reset", suitable for a one-minute tick.
 *
 * Deliberately never renders seconds: at a one-minute cadence a seconds value
 * is wrong the moment it paints, and a per-second countdown is exactly the
 * continuously repainting element the sidebar must not have.
 */
export function formatDrainResetLabel(resetsAt: string, nowMs: number): string {
  const resetsAtMs = Date.parse(resetsAt);
  if (!Number.isFinite(resetsAtMs)) return "";
  const remainingMs = resetsAtMs - nowMs;
  if (remainingMs <= MINUTE_MS) return "in under a minute";
  if (remainingMs < HOUR_MS) return `in ${Math.floor(remainingMs / MINUTE_MS)}m`;
  if (remainingMs < DAY_MS) return `in ${Math.floor(remainingMs / HOUR_MS)}h`;
  return `in ${Math.floor(remainingMs / DAY_MS)}d`;
}

const toAccount = (entry: ProviderInstanceEntry): AccountDrainPillAccount => ({
  displayName: entry.displayName,
  ...(entry.accentColor ? { accentColor: entry.accentColor } : {}),
});

/**
 * Describe the drain a user most needs to know about, or `null` when every
 * configured account can still serve a turn.
 *
 * When several accounts are spent it reports the highest-priority one, since
 * that is the account new threads would otherwise have opened on.
 */
export function getAccountDrainPillView(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  nowMs: number,
): AccountDrainPillView | null {
  const configured = entries.filter((entry) => entry.enabled && entry.isAvailable);
  const drained = configured.filter((entry) => isProviderInstanceDrained(entry, nowMs));
  const spent = sortProviderInstancesForRouting(drained, nowMs)[0];
  if (!spent) return null;

  const takeover = sortProviderInstancesForRouting(
    configured.filter(
      (entry) =>
        entry.driverKind === spent.driverKind &&
        entry.instanceId !== spent.instanceId &&
        !isProviderInstanceDrained(entry, nowMs),
    ),
    nowMs,
  )[0];

  const resetsAt = spent.snapshot.rateLimit?.resetsAt;
  const resetLabel = resetsAt ? formatDrainResetLabel(resetsAt, nowMs) : "";
  const spentSentence = resetLabel
    ? `${spent.displayName} is out of capacity and resets ${resetLabel}.`
    : `${spent.displayName} is out of capacity.`;

  return {
    key: `${spent.instanceId}:${takeover?.instanceId ?? "none"}`,
    title: takeover ? `On ${takeover.displayName}` : `${spent.displayName} is spent`,
    description: takeover
      ? `${spentSentence} New threads are opening on ${takeover.displayName}.`
      : `${spentSentence} No other account is configured for it, so new threads still use it.`,
    spent: toAccount(spent),
    ...(takeover ? { takeover: toAccount(takeover) } : {}),
  };
}
