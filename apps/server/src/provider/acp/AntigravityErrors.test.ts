import { describe, expect, it } from "vite-plus/test";

import {
  ANTIGRAVITY_CHECKPOINT_ERROR_MESSAGE,
  extractAntigravityModelName,
  formatAntigravityErrorMessage,
  isAntigravityCorruptedSessionError,
} from "./AntigravityErrors.ts";

describe("AntigravityErrors", () => {
  describe("extractAntigravityModelName", () => {
    it("extracts model name from server capacity error string", () => {
      expect(
        extractAntigravityModelName(
          "No capacity available for model gemini-3.8-flash-high on the server",
        ),
      ).toBe("gemini-3.8-flash-high");
    });

    it("extracts model name from metadata map", () => {
      expect(
        extractAntigravityModelName(
          "metadata:map[OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST:true error_number:2010 model:gemini-3.8-flash-high] reason:MODEL_CAPACITY_EXHAUSTED",
        ),
      ).toBe("gemini-3.8-flash-high");
    });

    it("returns undefined if no model is found", () => {
      expect(extractAntigravityModelName("Some random failure occurred")).toBeUndefined();
    });
  });

  describe("isAntigravityCorruptedSessionError", () => {
    it("detects doneCh for checkpoint error", () => {
      expect(
        isAntigravityCorruptedSessionError(
          'Agent execution terminated due to error. ("agent executor error: could not find doneCh for checkpoint")',
        ),
      ).toBe(true);
      expect(
        isAntigravityCorruptedSessionError(
          "Agent execution error: could not find doneCh for checkpoint",
        ),
      ).toBe(true);
    });

    it("detects terminal step type exit", () => {
      expect(isAntigravityCorruptedSessionError("reached terminal step type. Exiting.")).toBe(true);
    });

    it("detects actionable and legacy formatted checkpoint error messages", () => {
      expect(
        isAntigravityCorruptedSessionError(
          "Antigravity agent executor encountered an irreparable internal checkpoint error. This session cannot be resumed; please start a new thread or branch to continue.",
        ),
      ).toBe(true);
      expect(
        isAntigravityCorruptedSessionError(
          "Antigravity agent executor encountered an internal checkpoint error. Please retry your message.",
        ),
      ).toBe(true);
    });

    it("returns false for regular errors and prose", () => {
      expect(isAntigravityCorruptedSessionError(undefined)).toBe(false);
      expect(isAntigravityCorruptedSessionError("")).toBe(false);
      expect(isAntigravityCorruptedSessionError("No capacity available for model")).toBe(false);
      expect(isAntigravityCorruptedSessionError("Here is the plan for your changes.")).toBe(false);
    });
  });

  describe("formatAntigravityErrorMessage", () => {
    it("formats 503 MODEL_CAPACITY_EXHAUSTED with model name", () => {
      const raw =
        "Agent execution error: model unreachable: Error 503, Message: No capacity available for model gemini-3.8-flash-high on the server, Status: UNAVAILABLE, Details: [map[@type:type.googleapis.com/google.rpc.ErrorInfo domain:cloudcode-pa.googleapis.com metadata:map[OVERLOADED_TOO_MANY_RETRIES_PER_REQUEST:true error_number:2010 model:gemini-3.8-flash-high] reason:MODEL_CAPACITY_EXHAUSTED]] request failed (code 503): No capacity available for model gemini-3.8-flash-high on the server";

      expect(formatAntigravityErrorMessage(raw)).toBe(
        "Google Antigravity model capacity exhausted for gemini-3.8-flash-high (503 UNAVAILABLE). The Gemini server is temporarily overloaded; please try again in a moment or switch models.",
      );
    });

    it("formats retryable error tool output with 503", () => {
      const raw =
        'Encountered retryable error from model provider: Agent execution terminated due to error. ("request failed (code 503): No capacity available for model gemini-3.8-flash-high on the server")';

      expect(formatAntigravityErrorMessage(raw)).toBe(
        "Google Antigravity model capacity exhausted for gemini-3.8-flash-high (503 UNAVAILABLE). The Gemini server is temporarily overloaded; please try again in a moment or switch models.",
      );
    });

    it("formats 429 quota / resource exhausted errors", () => {
      const raw =
        "request failed (code 429): Resource has been exhausted (e.g. check quota for model gemini-2.5-pro).";

      expect(formatAntigravityErrorMessage(raw)).toBe(
        "Google Antigravity rate limit exceeded for gemini-2.5-pro (429 RESOURCE_EXHAUSTED). Please wait a moment before retrying.",
      );
    });

    it("formats doneCh internal checkpoint crash as actionable unrecoverable message", () => {
      expect(
        formatAntigravityErrorMessage("agent executor error: could not find doneCh for checkpoint"),
      ).toBe(ANTIGRAVITY_CHECKPOINT_ERROR_MESSAGE);
    });

    it("formats general model unreachable", () => {
      expect(
        formatAntigravityErrorMessage("model unreachable: could not connect to endpoint"),
      ).toBe(
        "Google Antigravity model unreachable. The server is currently unreachable; please check your network connection or try again shortly.",
      );
    });

    it("passes normal prose through untouched", () => {
      const text = "Here is the implementation of the requested feature.";
      expect(formatAntigravityErrorMessage(text)).toBe(text);
    });
  });
});
