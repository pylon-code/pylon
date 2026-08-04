import type { ServerProviderUsageLimits } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import type { TimestampFormat } from "@t3tools/contracts/settings";
import { ProviderUsageRows } from "./ProviderUsageRows";

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

function AccountHeader(props: { readonly account: ProviderUsageAccount }) {
  return (
    <div className="flex items-center gap-1.5">
      <span
        aria-hidden
        className="size-1.5 shrink-0 rounded-full"
        style={{ background: props.account.accentColor ?? "var(--muted-foreground)" }}
      />
      <span className="min-w-0 truncate font-medium text-foreground text-xs">
        {props.account.displayName}
      </span>
      {props.account.isActive ? (
        <span className="shrink-0 text-[11px] text-muted-foreground/70">this thread</span>
      ) : null}
    </div>
  );
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

  return (
    <div className="grid gap-3">
      {props.accounts.map((account) => (
        <div
          key={account.instanceId}
          className={cn("grid gap-1.5", account.isActive ? null : "opacity-70")}
        >
          <AccountHeader account={account} />
          <ProviderUsageRows
            usageLimits={account.usageLimits}
            timestampFormat={props.timestampFormat}
            compact
          />
        </div>
      ))}
    </div>
  );
}
