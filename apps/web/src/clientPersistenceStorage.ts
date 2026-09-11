import {
  decodeStoredClientSettings,
  encodeStoredClientSettings,
  retainUnreadClientSettings,
  type ClientSettings,
  type StoredClientSettings,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import {
  getLocalStorageItem,
  LocalStorageOperationError,
  setLocalStorageItem,
} from "./hooks/useLocalStorage";

const CLIENT_SETTINGS_STORAGE_KEY = "t3code:client-settings:v1";
const isLocalStorageOperationError = Schema.is(LocalStorageOperationError);

// Pylon and T3 Code share this key when they are served from the same origin,
// so the document can hold values in shapes this build cannot read.
let storedClientSettings: StoredClientSettings | null = null;

function hasWindow(): boolean {
  return typeof window !== "undefined";
}

/**
 * Reads saved client settings. Storage access failures throw so hydration can
 * retry without replacing preferences it never saw. A document that parses but
 * holds values this build cannot decode keeps every readable setting and falls
 * back to defaults for the rest; a document that is not settings JSON at all
 * falls back to defaults entirely.
 */
export function readBrowserClientSettings(): ClientSettings | null {
  if (!hasWindow()) {
    return null;
  }

  let document: unknown;
  try {
    document = getLocalStorageItem(CLIENT_SETTINGS_STORAGE_KEY, Schema.Unknown);
  } catch (error) {
    if (!isLocalStorageOperationError(error) || error.operation !== "decode") {
      throw error;
    }
    console.error("Could not read persisted client settings.", error);
    storedClientSettings = null;
    return null;
  }
  if (document === null) {
    storedClientSettings = null;
    return null;
  }

  storedClientSettings = decodeStoredClientSettings(document);
  if (storedClientSettings === null) {
    console.error("Could not read persisted client settings.");
    return null;
  }
  const unreadKeys = Object.keys(storedClientSettings.unreadValues);
  if (unreadKeys.length > 0) {
    console.error("Some persisted client settings could not be read; using defaults for them.", {
      settings: unreadKeys,
    });
  }
  return storedClientSettings.settings;
}

/** Writes settings, leaving unread stored values in place until their setting changes. */
export function writeBrowserClientSettings(settings: ClientSettings): void {
  if (!hasWindow()) {
    return;
  }

  const next = retainUnreadClientSettings(settings, storedClientSettings);
  setLocalStorageItem(
    CLIENT_SETTINGS_STORAGE_KEY,
    encodeStoredClientSettings(next),
    Schema.Unknown,
  );
  storedClientSettings = next;
}
