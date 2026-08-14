import * as Schema from "effect/Schema";

import { RuntimeRequestId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const SESSION_INTERACTION_REQUEST_ID_MAX_CHARS = 128;
export const SESSION_INTERACTION_KEY_MAX_CHARS = 128;
export const SESSION_INTERACTION_TITLE_MAX_CHARS = 4_000;
export const SESSION_INTERACTION_OPTION_MAX_CHARS = 4_000;
export const SESSION_INTERACTION_OPTIONS_MAX_ITEMS = 100;
export const SESSION_INTERACTION_CONTENT_MAX_CHARS = 100_000;
export const SESSION_INTERACTION_WIDGET_LINES_MAX_ITEMS = 100;
export const SESSION_INTERACTION_TIMEOUT_MAX_MS = 24 * 60 * 60 * 1_000;

/**
 * Opaque request id shared by canonical runtime events and response commands.
 * It aliases RuntimeRequestId so request routing does not require a cast.
 */
export const SessionInteractionRequestId = RuntimeRequestId.check(
  Schema.isMaxLength(SESSION_INTERACTION_REQUEST_ID_MAX_CHARS),
);
export type SessionInteractionRequestId = typeof SessionInteractionRequestId.Type;

const InteractionTitle = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SESSION_INTERACTION_TITLE_MAX_CHARS),
);
const InteractionKey = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SESSION_INTERACTION_KEY_MAX_CHARS),
);
const InteractionOption = TrimmedNonEmptyString.check(
  Schema.isMaxLength(SESSION_INTERACTION_OPTION_MAX_CHARS),
);
const InteractionOptions = Schema.Array(InteractionOption).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(SESSION_INTERACTION_OPTIONS_MAX_ITEMS),
);
const InteractionContent = Schema.String.check(
  Schema.isMaxLength(SESSION_INTERACTION_CONTENT_MAX_CHARS),
);
const InteractionTimeout = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: SESSION_INTERACTION_TIMEOUT_MAX_MS }),
);

const SelectInteractionRequest = Schema.Struct({
  kind: Schema.Literal("select"),
  title: InteractionTitle,
  options: InteractionOptions,
  timeout: Schema.optionalKey(InteractionTimeout),
});

const ConfirmInteractionRequest = Schema.Struct({
  kind: Schema.Literal("confirm"),
  title: InteractionTitle,
  message: Schema.optionalKey(InteractionContent),
  timeout: Schema.optionalKey(InteractionTimeout),
});

const InputInteractionRequest = Schema.Struct({
  kind: Schema.Literal("input"),
  title: InteractionTitle,
  placeholder: Schema.optionalKey(InteractionContent),
  timeout: Schema.optionalKey(InteractionTimeout),
});

const EditorInteractionRequest = Schema.Struct({
  kind: Schema.Literal("editor"),
  title: InteractionTitle,
  prefill: Schema.optionalKey(InteractionContent),
  timeout: Schema.optionalKey(InteractionTimeout),
});

/** Blocking, provider-neutral session dialog request. */
export const SessionInteractionRequest = Schema.Union([
  SelectInteractionRequest,
  ConfirmInteractionRequest,
  InputInteractionRequest,
  EditorInteractionRequest,
]);
export type SessionInteractionRequest = typeof SessionInteractionRequest.Type;

const SelectedInteractionResponse = Schema.Struct({
  kind: Schema.Literal("selected"),
  value: InteractionOption,
});

const ConfirmedInteractionResponse = Schema.Struct({
  kind: Schema.Literal("confirmed"),
  confirmed: Schema.Boolean,
});

const SubmittedInteractionResponse = Schema.Struct({
  kind: Schema.Literal("submitted"),
  value: InteractionContent,
});

const CancelledInteractionResponse = Schema.Struct({
  kind: Schema.Literal("cancelled"),
});

/**
 * Dialog response vocabulary. `selected` resolves select, `confirmed` resolves
 * confirm, `submitted` resolves input/editor, and `cancelled` resolves any
 * blocking request.
 */
export const SessionInteractionResponse = Schema.Union([
  SelectedInteractionResponse,
  ConfirmedInteractionResponse,
  SubmittedInteractionResponse,
  CancelledInteractionResponse,
]);
export type SessionInteractionResponse = typeof SessionInteractionResponse.Type;

export const SessionNotificationLevel = Schema.Literals(["info", "warning", "error"]);
export type SessionNotificationLevel = typeof SessionNotificationLevel.Type;

export const SessionWidgetPlacement = Schema.Literals(["aboveEditor", "belowEditor"]);
export type SessionWidgetPlacement = typeof SessionWidgetPlacement.Type;

const SessionNotification = Schema.Struct({
  kind: Schema.Literal("notification"),
  message: TrimmedNonEmptyString.check(Schema.isMaxLength(SESSION_INTERACTION_CONTENT_MAX_CHARS)),
  level: SessionNotificationLevel,
});

const SessionStatus = Schema.Struct({
  kind: Schema.Literal("status"),
  key: InteractionKey,
  text: Schema.optionalKey(InteractionContent),
});

const SessionWidget = Schema.Struct({
  kind: Schema.Literal("widget"),
  key: InteractionKey,
  lines: Schema.optionalKey(
    Schema.Array(
      Schema.String.check(Schema.isMaxLength(SESSION_INTERACTION_OPTION_MAX_CHARS)),
    ).check(Schema.isMaxLength(SESSION_INTERACTION_WIDGET_LINES_MAX_ITEMS)),
  ),
  placement: Schema.optionalKey(SessionWidgetPlacement),
});

/** Nonblocking, provider-neutral presentation update. */
export const SessionPresentation = Schema.Union([
  SessionNotification,
  SessionStatus,
  SessionWidget,
]);
export type SessionPresentation = typeof SessionPresentation.Type;
