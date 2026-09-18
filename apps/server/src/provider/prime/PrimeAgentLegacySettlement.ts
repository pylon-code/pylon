import * as Schema from "effect/Schema";

import type { PrimeAgentDaemonBridge } from "./PrimeAgentDaemonBridge.ts";
import {
  PrimeAgentOwnershipReceiptStore,
  primeAgentOwnershipReceiptIsSafeLive,
} from "./PrimeAgentOwnershipReceipt.ts";

const isSettled = Schema.is(
  Schema.Struct({
    feature: Schema.Literal("owned_session_settlement_observation_v1"),
    status: Schema.Literal("settled"),
  }),
);

/** Runs only from managed maintenance with a freshly receipt-verified target SDK. */
export async function recoverPrimeAgentLegacySettlement(input: {
  readonly instanceId: string;
  readonly store: PrimeAgentOwnershipReceiptStore;
  readonly loadBridge: () => Promise<
    Pick<PrimeAgentDaemonBridge, "sdkFeatures" | "observeOwnedSessionSettlement">
  >;
}): Promise<boolean> {
  const scan = await input.store.scan();
  if (scan.corrupt)
    throw new Error("Prime ownership recovery is blocked by an unreadable ownership record.");
  const receipts = scan.receipts.filter(
    (receipt) =>
      receipt.instanceId === input.instanceId && !primeAgentOwnershipReceiptIsSafeLive(receipt),
  );
  if (receipts.length === 0) return false;
  if (receipts.some((receipt) => receipt.state !== "acquired" || receipt.recovery !== undefined)) {
    throw new Error("Prime ownership recovery requires the original session's recovery authority.");
  }
  const bridge = await input.loadBridge();
  const observe = bridge.observeOwnedSessionSettlement;
  if (!bridge.sdkFeatures?.includes("owned_session_settlement_observation_v1") || !observe) {
    throw new Error(
      "Prime ownership recovery needs a managed build with settlement observation support.",
    );
  }
  let changed = false;
  for (const receipt of receipts) {
    if (receipt.state !== "acquired") continue;
    const { appVersion, buildId, ...daemon } = receipt.attachProof.daemon;
    const contractProof = {
      ...receipt.attachProof,
      daemon: {
        ...daemon,
        ...(appVersion === undefined ? {} : { appVersion }),
        ...(buildId === undefined ? {} : { buildId }),
      },
    };
    const cleared = await input.store.clearLegacyAfterSettlement(receipt, async () =>
      isSettled(
        await observe({
          agentDir: receipt.effectiveHome,
          activeSessionId: receipt.activeSessionId,
          contractProof,
        }),
      ),
    );
    if (!cleared) {
      throw new Error(
        "Prime ownership remains quarantined: prior session settlement could not be proved.",
      );
    }
    changed = true;
  }
  return changed;
}
