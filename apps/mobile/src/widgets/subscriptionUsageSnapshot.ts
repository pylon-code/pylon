import {
  collectLimitAccounts,
  collectLimitPools,
  type LimitAccount,
} from "@t3tools/shared/usageLimits";
import type { EnvironmentPresentation } from "@t3tools/client-runtime/connection";
import type { EnvironmentId } from "@t3tools/contracts";

export interface SubscriptionUsageSnapshot {
  url?: string;
  checkedAt: number;
  providers: Array<{
    name: string;
    detail: string;
    windows: Array<{ kind?: string; label: string; remaining: number; reset: string }>;
    expiresAt: number;
    totalWindows: number;
  }>;
}

// Expire from the provider's read timestamp. Re-publishing an old config must
// never extend a quota's apparent freshness while the app is backgrounded.
const SNAPSHOT_MAX_AGE = 15 * 60_000;

function subscriptionUsageProps(
  accounts: readonly LimitAccount[],
  now: number,
): SubscriptionUsageSnapshot {
  const pools = collectLimitPools(accounts, now);
  const checked = accounts
    .filter((account) => account.driver === "codex" || account.driver === "claudeAgent")
    .map((account) => Date.parse(account.limits.checkedAt));
  return {
    checkedAt:
      checked.length > 0 && checked.every((value) => Number.isFinite(value) && value <= now)
        ? Math.min(...checked)
        : 0,
    providers: (["codex", "claudeAgent"] as const).map((driver) => {
      const pool = pools.find((candidate) => candidate.driver === driver);
      const name = driver === "codex" ? "Codex" : "Claude";
      if (!pool)
        return { name, detail: "No limits available", windows: [], expiresAt: 0, totalWindows: 0 };
      const checkedAt = Math.min(...pool.accounts.map((a) => Date.parse(a.limits.checkedAt)));
      const expiresAt = Math.min(
        checkedAt + SNAPSHOT_MAX_AGE,
        ...pool.windows.flatMap((window) => window.resets.map((reset) => reset.at)),
      );
      const fresh = Number.isFinite(checkedAt) && checkedAt <= now && expiresAt > now;
      const sortedWindows = [...pool.windows]
        .filter(
          (window) =>
            window.kind === "session" || window.kind === "weekly" || window.kind === "monthly",
        )
        .sort((a, b) => a.remainingPercent - b.remainingPercent);
      // Scope-specific window labels can contain model names. The widget only
      // stores canonical kinds and the tightest reading in each kind.
      const selectedWindows = ["session", "weekly", "monthly"].flatMap((kind) => {
        const window = sortedWindows.find((candidate) => candidate.kind === kind);
        return window ? [window] : [];
      });
      return {
        name,
        detail: !fresh
          ? "Open Pylon to refresh"
          : pool.accounts.length > 1
            ? `${pool.accounts.length} accounts · pooled`
            : "Subscription remaining",
        expiresAt: fresh ? expiresAt : 0,
        totalWindows: fresh ? selectedWindows.length : 0,
        windows: fresh
          ? selectedWindows.map((window) => ({
              kind: window.kind,
              label:
                window.kind === "monthly"
                  ? "Monthly"
                  : window.kind === "weekly"
                    ? "Weekly"
                    : "Session",
              remaining: Math.round(window.remainingPercent),
              reset: window.resets[0]
                ? `Next reset ${new Date(window.resets[0].at).toLocaleString(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  })}`
                : "Reset time unavailable",
            }))
          : [],
      };
    }),
  };
}

/** Deduplicate accounts before pooling, and only publish display data to the OS. */
export function buildSubscriptionUsageSnapshot(
  presentations: ReadonlyMap<EnvironmentId, EnvironmentPresentation>,
  url: string,
  now = Date.now(),
): SubscriptionUsageSnapshot {
  // A cached config is useful in the app, but cannot keep a disconnected or
  // signed-out account's quota visible on the system home/lock screen.
  const connected: Parameters<typeof collectLimitAccounts>[0] = new Map(
    [...presentations].flatMap(([environmentId, presentation]) => {
      if (presentation.connection.phase !== "connected" || presentation.serverConfig === null) {
        return [];
      }
      const providers = presentation.serverConfig.providers.filter(
        (provider) =>
          provider.auth.status === "authenticated" &&
          Boolean(provider.auth.accountId || provider.auth.email),
      );
      return [
        [
          environmentId,
          {
            ...presentation,
            serverConfig: { ...presentation.serverConfig, providers },
          },
        ],
      ];
    }),
  );
  return { ...subscriptionUsageProps(collectLimitAccounts(connected), now), url };
}

export function subscriptionUsageTimeline(snapshot: SubscriptionUsageSnapshot, now: number) {
  const deadlines = [...new Set(snapshot.providers.map((p) => p.expiresAt))]
    .filter((deadline) => deadline > now)
    .sort((a, b) => a - b);
  return [now, ...deadlines].map((date) => ({
    date: new Date(date),
    props: {
      ...snapshot,
      providers: snapshot.providers.map((provider) =>
        provider.windows.length > 0 && provider.expiresAt <= date
          ? { ...provider, detail: "Open Pylon to refresh", windows: [], totalWindows: 0 }
          : provider,
      ),
    },
  }));
}
