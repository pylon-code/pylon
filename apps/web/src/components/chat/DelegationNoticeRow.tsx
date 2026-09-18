import type { DelegationNotice } from "@t3tools/client-runtime/state/delegation-notice";
import type { EnvironmentId } from "@t3tools/contracts";

/**
 * Replaces the raw automatic wake message in the timeline: who finished or
 * needs the user, and a link to that thread.
 *
 * STUB: written by the lead so the test compiles. The executor implements it;
 * the export name and props must not change.
 */
export function DelegationNoticeRow(_props: {
  readonly notice: DelegationNotice;
  readonly environmentId: EnvironmentId;
}) {
  return null;
}
