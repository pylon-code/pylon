import { describe, expect, it } from "vite-plus/test";
import {
  AntigravityTaskNotificationBuffer,
  parseAntigravityTaskNotification,
} from "./AntigravityTaskNotification.ts";

const legacyNotice = (code = 0) =>
  `<task_notification>\nTask completed: pnpm test (task ID: session/task-33)\nExit code: ${code}\nOutput:\n> test\n✔ passed\n\n</task_notification>`;

const systemNotice = (
  code = 0,
  trailerType: "attachment" | "log" | "attachment_transcription" = "attachment",
) => {
  const trailer =
    trailerType === "attachment"
      ? `}\n<attachment>\nAttachment processed: No MIME type detected.\nOriginal path: /path/to/tasks/task-444.log\nDescription: Task Description: pnpm --filter t3 test src/provider/RuntimeInstructions.test.ts\n</attachment>`
      : trailerType === "attachment_transcription"
        ? `} Attachment processed: No MIME type detected. Original path: /path/to/tasks/task-444.log\nDescription: Task Description: pnpm --filter t3 test src/provider/RuntimeInstructions.test.ts`
        : `Log: file:///path/to/tasks/task-444.log\n</SYSTEM_MESSAGE>`;
  return `The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.\n\n<SYSTEM_MESSAGE> [Message] timestamp=2026-09-17T17:21:40Z sender=e35e0b4a-7683-46b5-aa6b-eb1e59fcd22f/task-444 priority=MESSAGE_PRIORITY_HIGH content=Task id "e35e0b4a-7683-46b5-aa6b-eb1e59fcd22f/task-444" finished with result:\n\nThe command exited with code ${code}. Output: $ vp test run src/provider/RuntimeInstructions.test.ts\n✔ passed\n\n${trailer}`;
};

describe("Antigravity task notifications", () => {
  describe("legacy <task_notification> format", () => {
    it("preserves command, native task identity, exit code and multiline output", () => {
      expect(parseAntigravityTaskNotification(legacyNotice(1))).toEqual({
        command: "pnpm test",
        taskId: "session/task-33",
        exitCode: 1,
        output: "> test\n✔ passed\n",
      });
    });

    it("accepts CRLF framing without leaking the envelope separator into output", () => {
      expect(
        parseAntigravityTaskNotification(legacyNotice().replaceAll("\n", "\r\n"))?.output,
      ).toBe("> test\r\n✔ passed\r\n");
    });

    it("buffers a notice across every possible chunk boundary", () => {
      const text = legacyNotice();
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
      expect(buffer.push(legacyNotice())).toBe(legacyNotice());
      expect(buffer.finish()).toEqual({ text: "", notification: undefined });
      expect(
        parseAntigravityTaskNotification("```xml\n" + legacyNotice() + "\n```"),
      ).toBeUndefined();
    });

    it.each([
      "<task_",
      legacyNotice().replace("Exit code: 0", "Exit code: unknown"),
      legacyNotice().replace("Exit code: 0", "Exit code: 99999999999999999"),
      legacyNotice() + "\nAdditional explanation.",
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

  describe("<SYSTEM_MESSAGE> task notification format", () => {
    it("parses system message notice with attachment trailer (success and failure)", () => {
      expect(parseAntigravityTaskNotification(systemNotice(0, "attachment"))).toEqual({
        command: "pnpm --filter t3 test src/provider/RuntimeInstructions.test.ts",
        taskId: "e35e0b4a-7683-46b5-aa6b-eb1e59fcd22f/task-444",
        exitCode: 0,
        output: "$ vp test run src/provider/RuntimeInstructions.test.ts\n✔ passed\n",
      });

      expect(parseAntigravityTaskNotification(systemNotice(8, "attachment"))).toEqual({
        command: "pnpm --filter t3 test src/provider/RuntimeInstructions.test.ts",
        taskId: "e35e0b4a-7683-46b5-aa6b-eb1e59fcd22f/task-444",
        exitCode: 8,
        output: "$ vp test run src/provider/RuntimeInstructions.test.ts\n✔ passed\n",
      });
    });

    it("parses system message notice with transcription attachment trailer", () => {
      expect(parseAntigravityTaskNotification(systemNotice(0, "attachment_transcription"))).toEqual(
        {
          command: "pnpm --filter t3 test src/provider/RuntimeInstructions.test.ts",
          taskId: "e35e0b4a-7683-46b5-aa6b-eb1e59fcd22f/task-444",
          exitCode: 0,
          output: "$ vp test run src/provider/RuntimeInstructions.test.ts\n✔ passed\n",
        },
      );
    });

    it("parses system message notice with log trailer and derives command from shell prompt", () => {
      expect(parseAntigravityTaskNotification(systemNotice(0, "log"))).toEqual({
        command: "vp test run src/provider/RuntimeInstructions.test.ts",
        taskId: "e35e0b4a-7683-46b5-aa6b-eb1e59fcd22f/task-444",
        exitCode: 0,
        output: "$ vp test run src/provider/RuntimeInstructions.test.ts\n✔ passed\n",
      });
    });

    it("parses direct <SYSTEM_MESSAGE> notice without preamble", () => {
      const noticeWithoutPreamble = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-1 priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-1" finished with result:\n\nThe command exited with code 0.\nOutput:\n$ pnpm test\ndone\n\nLog: file:///path/task-1.log\n</SYSTEM_MESSAGE>`;
      expect(parseAntigravityTaskNotification(noticeWithoutPreamble)).toEqual({
        command: "pnpm test",
        taskId: "session/task-1",
        exitCode: 0,
        output: "$ pnpm test\ndone\n",
      });
    });

    it("accepts CRLF framing on system message notices", () => {
      const crlf = systemNotice(0, "attachment").replaceAll("\n", "\r\n");
      expect(parseAntigravityTaskNotification(crlf)?.output).toBe(
        "$ vp test run src/provider/RuntimeInstructions.test.ts\r\n✔ passed\r\n",
      );
    });

    it("buffers a system message notice across every possible chunk boundary", () => {
      const text = systemNotice();
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

    it("streams ordinary prose immediately even when starting with preamble prefix", () => {
      const buffer = new AntigravityTaskNotificationBuffer();
      // First chunk matches the beginning of "The following is a ..."
      expect(buffer.push("The following is a ")).toBe("");
      // Second chunk diverges from the preamble
      expect(buffer.push("summary of our changes:\n")).toBe(
        "The following is a summary of our changes:\n",
      );
      // Subsequent chunks stream immediately
      expect(buffer.push("1. First fix\n")).toBe("1. First fix\n");
      expect(buffer.finish()).toEqual({ text: "", notification: undefined });
    });

    it("streams unrelated <SYSTEM_MESSAGE> prose immediately without treating as task notice", () => {
      const buffer = new AntigravityTaskNotificationBuffer();
      const peerReview = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-14T23:22:20Z sender=reviewer priority=NORMAL content=### Adversarial Review: PR`;
      // Buffer diverges when content does not start with Task id "
      expect(buffer.push(peerReview)).toBe(peerReview);
      expect(buffer.finish()).toEqual({ text: "", notification: undefined });
      expect(parseAntigravityTaskNotification(peerReview)).toBeUndefined();
    });

    it.each([
      "<SYSTEM_MESSAGE>",
      "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z",
      systemNotice().replace("code 0", "code unknown"),
      systemNotice().replace("code 0", "code 99999999999999999"),
      systemNotice() + "\nAdditional explanation from assistant.",
    ])("returns incomplete or unrecognized system messages without losing text", (text) => {
      const buffer = new AntigravityTaskNotificationBuffer();
      const emitted = buffer.push(text);
      const result = buffer.finish();
      expect(emitted + result.text).toBe(text);
      expect(result.notification).toBeUndefined();
    });
  });
});
