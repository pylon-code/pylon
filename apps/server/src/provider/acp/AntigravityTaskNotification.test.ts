import { describe, expect, it } from "vite-plus/test";
import {
  AntigravityTaskNotificationBuffer,
  parseAntigravityTaskNotification,
} from "./AntigravityTaskNotification.ts";

const notice = (code = 0) =>
  `<task_notification>\nTask completed: pnpm test (task ID: session/task-33)\nExit code: ${code}\nOutput:\n> test\n✔ passed\n\n</task_notification>`;

describe("Antigravity task notifications", () => {
  it("preserves command, native task identity, exit code and multiline output", () => {
    expect(parseAntigravityTaskNotification(notice(1))).toEqual({
      command: "pnpm test",
      taskId: "session/task-33",
      exitCode: 1,
      output: "> test\n✔ passed\n",
    });
  });

  it("accepts CRLF framing without leaking the envelope separator into output", () => {
    expect(parseAntigravityTaskNotification(notice().replaceAll("\n", "\r\n"))?.output).toBe(
      "> test\r\n✔ passed\r\n",
    );
  });

  it("buffers a notice across every possible chunk boundary", () => {
    const text = notice();
    for (let split = 0; split <= text.length; split++) {
      const buffer = new AntigravityTaskNotificationBuffer();
      expect(buffer.push(text.slice(0, split))).toBe("");
      expect(buffer.push(text.slice(split))).toBe("");
      expect(buffer.finish()).toEqual({
        text: "",
        notification: parseAntigravityTaskNotification(text),
      });
    }
  });

  it("streams ordinary prose immediately and preserves quoted examples", () => {
    const buffer = new AntigravityTaskNotificationBuffer();
    expect(buffer.push("Here is an example:\n")).toBe("Here is an example:\n");
    expect(buffer.push(notice())).toBe(notice());
    expect(buffer.finish()).toEqual({ text: "", notification: undefined });
    expect(parseAntigravityTaskNotification("```xml\n" + notice() + "\n```")).toBeUndefined();
  });

  it.each([
    "<task_",
    notice().replace("Exit code: 0", "Exit code: unknown"),
    notice().replace("Exit code: 0", "Exit code: 99999999999999999"),
    notice() + "\nAdditional explanation.",
  ])("returns incomplete or unrecognized messages without losing text", (text) => {
    const buffer = new AntigravityTaskNotificationBuffer();
    const emitted = buffer.push(text);
    const result = buffer.finish();
    expect(emitted + result.text).toBe(text);
    expect(result.notification).toBeUndefined();
  });

  it("bounds buffering and falls back to lossless text for oversized notices", () => {
    const buffer = new AntigravityTaskNotificationBuffer();
    const text = "<task_notification>\n" + "x".repeat(1024 * 1024);
    expect(buffer.push(text)).toBe(text);
    expect(buffer.push("tail")).toBe("tail");
    expect(buffer.finish()).toEqual({ text: "", notification: undefined });
  });
});
