import {
  FollowUp,
  FollowUpFileInput,
  FollowUpKind,
  FollowUpOperationError,
  FollowUpRecordValidationInput,
  FollowUpResolution,
  FollowUpStatus,
  NonNegativeInt,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/unstable/ai";

import { FollowUpService } from "../../../followups/FollowUpService.ts";
import { ServerSettingsService } from "../../../serverSettings.ts";
import { McpInvocationContext } from "../../McpInvocationContext.ts";

const dependencies = [Crypto.Crypto, FollowUpService, McpInvocationContext, ServerSettingsService];

const {
  commandId: _commandId,
  itemId: _itemId,
  projectId: _projectId,
  ...followUpFileFields
} = FollowUpFileInput.fields;

export const FollowUpFileTool = Tool.make("followup_file", {
  description:
    'File a follow-up for work you are NOT doing now. Before filing, ask yourself: was I asked to do this, and can I do it now? If yes, filing is forbidden — do the work instead. Only file when the work genuinely falls outside what you were asked to do. You must supply a deferReason from the closed set (out-of-scope, needs-decision, blocked-externally, idea) — "ran out of time", "seemed hard", and "probably fine" are not valid reasons to defer. You must also supply verifyCheck: a concrete, falsifiable check a different agent can run weeks from now to decide whether this still matters. Use kind "blocker" only when a competent reviewer would refuse to merge the current work because of it, and then you must name the branch it gates.',
  parameters: Schema.Struct(followUpFileFields),
  success: FollowUp,
  failure: FollowUpOperationError,
  dependencies,
}).annotate(Tool.Destructive, false);

export const FollowUpListTool = Tool.make("followup_list", {
  description:
    "List follow-ups for the current thread's project. Call this when you start work and again before you report work complete, so you do not claim done while a blocker is open.",
  parameters: Schema.Struct({
    status: Schema.optional(FollowUpStatus),
    kind: Schema.optional(FollowUpKind),
  }),
  success: Schema.Array(FollowUp),
  failure: FollowUpOperationError,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const FollowUpResolveTool = Tool.make("followup_resolve", {
  description:
    "Close a follow-up you have actually addressed. You cannot waive it or mark it moot here: use followup_record_validation for a checked moot result, and only a person can waive work.",
  parameters: Schema.Struct({
    itemId: FollowUp.fields.id,
    expectedRevision: NonNegativeInt,
    resolution: Schema.Struct({
      note: FollowUpResolution.fields.note,
      commitSha: FollowUpResolution.fields.commitSha,
    }),
  }),
  success: FollowUp,
  failure: FollowUpOperationError,
  dependencies,
}).annotate(Tool.Destructive, false);

export const FollowUpCheckGateTool = Tool.make("followup_check_gate", {
  description:
    "Report whether unresolved blockers are attached to a branch in the current project. Call this before reporting work complete or opening a change request. If blocked is true, resolve the listed blockers or ask the developer to waive them — do not report the work as finished.",
  parameters: Schema.Struct({ branchRef: Schema.String }),
  success: Schema.Struct({
    blocked: Schema.Boolean,
    blockers: Schema.Array(FollowUp),
  }),
  failure: FollowUpOperationError,
  dependencies,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Idempotent, true);

export const FollowUpRecordValidationTool = Tool.make("followup_record_validation", {
  description:
    'Record the result of the current visible thread checking a follow-up\'s verifyCheck and evidence. Choose exactly "still-needed", "moot", or "uncertain". Still-needed and uncertain remain open. Moot requires concrete evidence and is the only validation outcome that closes the item. This records work already performed; it does not launch another agent and can never waive an item.',
  parameters: FollowUpRecordValidationInput,
  success: FollowUp,
  failure: FollowUpOperationError,
  dependencies,
}).annotate(Tool.Destructive, false);

export const FollowUpToolkit = Toolkit.make(
  FollowUpFileTool,
  FollowUpListTool,
  FollowUpResolveTool,
  FollowUpCheckGateTool,
  FollowUpRecordValidationTool,
);
