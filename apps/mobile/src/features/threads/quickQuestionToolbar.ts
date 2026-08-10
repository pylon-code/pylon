import { canAskSessionSideQuestion } from "@t3tools/client-runtime/state/session-side-question";
import type { OrchestrationSession, ServerProvider } from "@t3tools/contracts";

import type { RemoteClientConnectionState } from "../../lib/connection";

export const QUICK_QUESTION_LABEL = "Quick question" as const;
export const QUICK_QUESTION_TEST_ID = "quick-question-trigger" as const;

export function quickQuestionSessionScopeKey(input: {
  readonly environmentId: string;
  readonly threadId: string;
  readonly providerInstanceId: string | null | undefined;
  readonly sessionStartedAt: string | null | undefined;
}): string {
  return JSON.stringify([
    input.environmentId,
    input.threadId,
    input.providerInstanceId ?? null,
    input.sessionStartedAt ?? null,
  ]);
}

/** Maps the mobile presentation phase into the provider-neutral live-session gate. */
export function canOpenQuickQuestion(input: {
  readonly connectionState: RemoteClientConnectionState;
  readonly session: OrchestrationSession | null | undefined;
  readonly provider: Pick<ServerProvider, "featureCapabilities"> | null | undefined;
}): boolean {
  return canAskSessionSideQuestion(
    input.provider,
    input.connectionState === "connected" ? "connected" : "offline",
    input.session,
  );
}

/** Availability loss is a dismissal, not a pause that can reopen on reconnect. */
export function quickQuestionOpenScopeAfterAvailability(
  openScopeKey: string | null,
  available: boolean,
): string | null {
  return available ? openScopeKey : null;
}
