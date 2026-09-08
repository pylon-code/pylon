import {
  parseUsagePriceForm,
  usagePriceForm,
  USAGE_PRICE_FIELDS,
  type UsagePriceForm,
} from "./usagePriceForm";
import type { UsagePriceChange, UsagePriceTarget } from "./usagePriceTargets";

export type UsagePriceField = (typeof USAGE_PRICE_FIELDS)[number]["key"];

export interface UsagePriceDraft {
  readonly id: string;
  readonly model: string;
  readonly isNew: boolean;
  readonly values: Partial<Pick<UsagePriceForm, UsagePriceField>>;
  readonly removed?: boolean;
}

export function isEmptyUsagePriceDraft(draft: UsagePriceDraft) {
  return (
    draft.isNew &&
    draft.model.trim() === "" &&
    Object.values(draft.values).every((value) => value.trim() === "")
  );
}

function modelPrice(target: UsagePriceTarget, model: string) {
  return target.prices && Object.hasOwn(target.prices, model) ? target.prices[model] : undefined;
}

export function usagePriceCell(
  targets: readonly UsagePriceTarget[],
  model: string,
  field: UsagePriceField,
) {
  const optional = USAGE_PRICE_FIELDS.find((entry) => entry.key === field)!.optional;
  const values = targets.map((target) =>
    modelPrice(target, model) ? usagePriceForm(model, modelPrice(target, model))[field] : null,
  );
  if (targets.some((target) => target.prices === null))
    return { value: "", placeholder: "Unavailable" };
  if (values.some((value) => value !== values[0])) return { value: "", placeholder: "Mixed" };
  return {
    value: values[0] ?? "",
    placeholder: values[0] === null ? "Automatic" : optional ? "Input rate" : "0.00",
  };
}

/** Only edited cells replace rates; untouched cells retain each environment's own values. */
export function usagePriceTableChanges(
  target: UsagePriceTarget,
  drafts: readonly UsagePriceDraft[],
) {
  const changes: UsagePriceChange[] = [];
  const errors = new Map<string, string>();
  for (const draft of drafts) {
    if (isEmptyUsagePriceDraft(draft)) continue;
    const model = draft.model.trim();
    if (draft.removed) {
      if (modelPrice(target, model)) changes.push({ model, price: null });
      continue;
    }
    const original = usagePriceForm(model, modelPrice(target, model));
    const form = { ...original, ...draft.values };
    const parsed = parseUsagePriceForm(form);
    if (parsed === null) {
      const missing = USAGE_PRICE_FIELDS.find(
        (field) => !field.optional && form[field.key].trim() === "",
      );
      errors.set(
        draft.id,
        model === ""
          ? "Enter a model ID."
          : missing
            ? `${missing.label} is required on ${target.label}.`
            : "Use non-negative numbers for prices.",
      );
      continue;
    }
    const next = usagePriceForm(model, parsed.price);
    if (USAGE_PRICE_FIELDS.some((field) => original[field.key] !== next[field.key]))
      changes.push(parsed);
  }
  return { changes, errors };
}

/**
 * The rows to render for the environments' current prices plus the staged drafts.
 *
 * Rows for existing models come from settings, which another client can change
 * while an edit is staged here. A draft whose model has since left settings keeps
 * its row so the edit stays visible, correctable, and resettable; dropping the row
 * would leave an edit that still saves and a validation message with nowhere to
 * render. `saving` holds new rows in place while environments publish their
 * updated settings.
 */
export function usagePriceRows(
  customModels: readonly string[],
  drafts: readonly UsagePriceDraft[],
  options: { readonly saving: boolean },
): readonly UsagePriceDraft[] {
  const newModels = new Set(
    drafts.filter((draft) => draft.isNew).map((draft) => draft.model.trim()),
  );
  const inSettings = new Set(customModels);
  return [
    ...customModels
      .filter((model) => !options.saving || !newModels.has(model))
      .map(
        (model) =>
          drafts.find((draft) => draft.id === `model:${model}`) ?? {
            id: `model:${model}`,
            model,
            isNew: false,
            values: {},
          },
      ),
    ...drafts.filter((draft) => !draft.isNew && !inSettings.has(draft.model)),
    ...drafts.filter((draft) => draft.isNew),
  ];
}

/** Unavailable destinations report a save failure without blocking writable environments. */
export function usagePriceTableErrors(
  targets: readonly UsagePriceTarget[],
  drafts: readonly UsagePriceDraft[],
) {
  return new Map(
    targets
      .filter((target) => target.unavailable === null && target.prices !== null)
      .flatMap((target) => [...usagePriceTableChanges(target, drafts).errors]),
  );
}
