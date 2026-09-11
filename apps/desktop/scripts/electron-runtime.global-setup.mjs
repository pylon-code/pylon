import { ensureElectronRuntime } from "./ensure-electron-runtime.mjs";

/**
 * Vitest global setup for desktop tests. Electron 42+ downloads its runtime on
 * the first `require("electron")`, so parallel test workers would race that
 * download into one `dist`. Installing it here runs once, before any worker.
 */
export function setup() {
  ensureElectronRuntime();
}
