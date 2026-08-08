import {
  SESSION_INTERACTION_CONTENT_MAX_CHARS,
  type SessionInteractionRequest,
  type SessionInteractionResponse,
} from "@t3tools/contracts";

export type SessionInteractionCardModel =
  | {
      readonly kind: "select";
      readonly title: string;
      readonly options: ReadonlyArray<string>;
    }
  | {
      readonly kind: "confirm";
      readonly title: string;
      readonly message: string | null;
    }
  | {
      readonly kind: "input";
      readonly title: string;
      readonly initialValue: "";
      readonly placeholder: string | null;
      readonly multiline: false;
    }
  | {
      readonly kind: "editor";
      readonly title: string;
      readonly initialValue: string;
      readonly placeholder: null;
      readonly multiline: true;
    };

export function sessionInteractionCardModel(
  request: SessionInteractionRequest,
): SessionInteractionCardModel {
  switch (request.kind) {
    case "select":
      return { kind: "select", title: request.title, options: request.options };
    case "confirm":
      return { kind: "confirm", title: request.title, message: request.message ?? null };
    case "input":
      return {
        kind: "input",
        title: request.title,
        initialValue: "",
        placeholder: request.placeholder ?? null,
        multiline: false,
      };
    case "editor":
      return {
        kind: "editor",
        title: request.title,
        initialValue: request.prefill ?? "",
        placeholder: null,
        multiline: true,
      };
  }
}

export const selectedInteractionResponse = (value: string): SessionInteractionResponse => ({
  kind: "selected",
  value,
});

export const confirmedInteractionResponse = (confirmed: boolean): SessionInteractionResponse => ({
  kind: "confirmed",
  confirmed,
});

export const submittedInteractionResponse = (value: string): SessionInteractionResponse => ({
  kind: "submitted",
  value,
});

export const cancelledInteractionResponse = (): SessionInteractionResponse => ({
  kind: "cancelled",
});

export function selectInteractionOptionKey(options: ReadonlyArray<string>, index: number): string {
  const value = options[index] ?? "";
  let priorOccurrences = 0;
  for (let candidate = 0; candidate < index; candidate += 1) {
    if (options[candidate] === value) {
      priorOccurrences += 1;
    }
  }
  return JSON.stringify([value, priorOccurrences]);
}

export function clampSessionInteractionDraft(value: string): string {
  return value.slice(0, SESSION_INTERACTION_CONTENT_MAX_CHARS);
}
