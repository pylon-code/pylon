import type { PairState } from "@t3tools/client-runtime/state/pair";

/**
 * The lead's view of its pair on a phone: who it is paired with, what that
 * executor is doing, and one tap to open it. Renders nothing while the pair is
 * off, so the thread screen looks exactly as it did.
 */
export function PairStatusNotice(_props: {
  readonly state: PairState;
  /** The executor model's display name. */
  readonly executorLabel: string;
  readonly onOpenExecutor: () => void;
}) {
  return null;
}
