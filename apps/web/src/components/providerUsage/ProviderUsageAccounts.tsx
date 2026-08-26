import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ProviderUsageRows } from "./ProviderUsageRows";
import { ProviderUsageMatrix } from "./ProviderUsageMatrix";

/**
 * One configured provider instance's usage, as the popover renders it.
 *
 * `isActive` marks the instance the current thread is bound to. With a single
 * configured account there is nothing to disambiguate, so the account header is
 * dropped entirely and the section renders exactly as a single-instance list.
 */
export interface ProviderUsageAccount {
  readonly instanceId: string;
  readonly displayName: string;
  readonly accentColor?: string | undefined;
  readonly usageLimits: ServerProviderUsageLimits;
  readonly isActive: boolean;
}

/**
 * Renders subscription usage for every configured instance of one driver.
 *
 * Pylon-specific: upstream shows only the active thread's instance, which is
 * enough when a driver has one account. Pylon routes threads across several
 * accounts of the same driver, so "how much is left" is a question about all of
 * them, not just the one in front of you.
 */
export function ProviderUsageAccounts(props: {
  readonly accounts: readonly ProviderUsageAccount[];
  readonly timestampFormat: TimestampFormat;
  readonly nowMs: number;
  readonly staleAfterMs?: number | undefined;
}) {
  if (props.accounts.length === 0) return null;

  const firstAccount = props.accounts[0];
  if (props.accounts.length === 1 && firstAccount) {
    return (
      <ProviderUsageRows
        usageLimits={firstAccount.usageLimits}
        timestampFormat={props.timestampFormat}
        compact
      />
    );
  }

  // Two or more accounts is a comparison, not two lists. Dimming the inactive
  // one is dropped with it: knowing where the work goes next is exactly why
  // both are shown.
  return (
    <ProviderUsageMatrix
      accounts={props.accounts}
      timestampFormat={props.timestampFormat}
      nowMs={props.nowMs}
      staleAfterMs={props.staleAfterMs}
    />
  );
}
