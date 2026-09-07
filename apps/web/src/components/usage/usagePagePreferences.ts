import * as Schema from "effect/Schema";

const STORAGE_KEY = "t3code:usage-page-preferences:v1";
const UsagePagePreferencesSchema = Schema.Struct({
  metric: Schema.Literals(["cost", "tokens", "limits"]),
  windowDays: Schema.Literals([1, 7, 30, 90]),
});
export type UsagePagePreferences = typeof UsagePagePreferencesSchema.Type;
const preferencesCodec = Schema.fromJsonString(UsagePagePreferencesSchema);
const decodePreferences = Schema.decodeSync(preferencesCodec);
const encodePreferences = Schema.encodeSync(preferencesCodec);

export function readUsagePagePreferences(): UsagePagePreferences {
  try {
    const stored = typeof window === "undefined" ? null : window.localStorage.getItem(STORAGE_KEY);
    return stored === null ? { metric: "cost", windowDays: 30 } : decodePreferences(stored);
  } catch (error) {
    console.error("Could not read Usage page preferences.", error);
    return { metric: "cost", windowDays: 30 };
  }
}

export function saveUsagePagePreferences(preferences: UsagePagePreferences): void {
  try {
    if (typeof window === "undefined") return;
    window.localStorage.setItem(STORAGE_KEY, encodePreferences(preferences));
  } catch (error) {
    console.error("Could not save Usage page preferences.", error);
  }
}
