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
        expect(buffer.finish()).toEqual([
          { type: "notification", notification: parseAntigravityTaskNotification(text) },
        ]);
      }
    });

    it("streams ordinary prose immediately and preserves quoted examples", () => {
      const buffer = new AntigravityTaskNotificationBuffer();
      expect(buffer.push("Here is an example:\n")).toBe("Here is an example:\n");
      expect(buffer.push(legacyNotice())).toBe(legacyNotice());
      expect(buffer.finish()).toEqual([]);
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
      expect(emitted + result.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
        text,
      );
      expect(result.every((part) => part.type === "text")).toBe(true);
    });

    it("bounds buffering and falls back to lossless text for oversized notices", () => {
      const buffer = new AntigravityTaskNotificationBuffer();
      const text = "<task_notification>\n" + "x".repeat(1024 * 1024);
      expect(buffer.push(text)).toBe(text);
      expect(buffer.push("tail")).toBe("tail");
      expect(buffer.finish()).toEqual([]);
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
        expect(buffer.finish()).toEqual([
          { type: "notification", notification: parseAntigravityTaskNotification(text) },
        ]);
      }
    });

    it("preserves exact output whitespace without trimming meaningful indentation or line trailing spaces", () => {
      const notice = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-ws priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-ws" finished with result:\n\nThe command exited with code 0.\nOutput:\n  function calculate() {\n    const x = 42;   \n    return x;\n  }\n\nLog: file:///path/task-ws.log\n</SYSTEM_MESSAGE>`;
      const parsed = parseAntigravityTaskNotification(notice);
      expect(parsed).toBeDefined();
      expect(parsed?.output).toBe(
        "  function calculate() {\n    const x = 42;   \n    return x;\n  }\n",
      );
    });

    it("parses valid complete empty-output notices with and without Output: label", () => {
      const withOutputLabel = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-empty priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-empty" finished with result:\n\nThe command exited with code 0.\nOutput:\nLog: file:///path/task-empty.log\n</SYSTEM_MESSAGE>`;
      expect(parseAntigravityTaskNotification(withOutputLabel)).toEqual({
        command: "session/task-empty",
        taskId: "session/task-empty",
        exitCode: 0,
        output: "",
      });

      const withoutOutputLabel = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-empty priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-empty" finished with result:\n\nThe command exited with code 0.\nLog: file:///path/task-empty.log\n</SYSTEM_MESSAGE>`;
      expect(parseAntigravityTaskNotification(withoutOutputLabel)).toEqual({
        command: "session/task-empty",
        taskId: "session/task-empty",
        exitCode: 0,
        output: "",
      });

      const withAttachment = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-empty priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-empty" finished with result:\n\nThe command exited with code 0.\n}\n<attachment>\nAttachment processed: empty.log\nDescription: Task Description: true\n</attachment>\n</SYSTEM_MESSAGE>`;
      expect(parseAntigravityTaskNotification(withAttachment)).toEqual({
        command: "true",
        taskId: "session/task-empty",
        exitCode: 0,
        output: "",
      });
    });

    it.each([
      // Truncation immediately after exit code
      `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-trunc priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-trunc" finished with result:\n\nThe command exited with code 0.`,
      // Truncation after Output:
      `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-trunc priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-trunc" finished with result:\n\nThe command exited with code 0.\nOutput:`,
      // Truncation after inline Output:
      `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-trunc priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-trunc" finished with result:\n\nThe command exited with code 0. Output:`,
      // Truncation after Output newline
      `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-trunc priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-trunc" finished with result:\n\nThe command exited with code 0.\nOutput:\n`,
      // Truncation during output without terminal trailer
      `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=session/task-trunc priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-trunc" finished with result:\n\nThe command exited with code 0.\nOutput:\n$ pnpm test\nrunning tests...`,
    ])(
      "rejects notices truncated before a terminal trailer and flushes text losslessly",
      (text) => {
        expect(parseAntigravityTaskNotification(text)).toBeUndefined();
        const buffer = new AntigravityTaskNotificationBuffer();
        const emitted = buffer.push(text);
        const result = buffer.finish();
        expect(
          emitted + result.map((part) => (part.type === "text" ? part.text : "")).join(""),
        ).toBe(text);
        expect(result.every((part) => part.type === "text")).toBe(true);
      },
    );

    it("rejects system messages with mismatched sender and task identity", () => {
      const mismatchedNotice = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z sender=user priority=MESSAGE_PRIORITY_HIGH content=Task id "session/task-1" finished with result:\n\nThe command exited with code 0.\nLog: file:///path/task-1.log\n</SYSTEM_MESSAGE>`;
      expect(parseAntigravityTaskNotification(mismatchedNotice)).toBeUndefined();

      // Buffer immediately passes through when sender does not match taskId
      const buffer = new AntigravityTaskNotificationBuffer();
      expect(buffer.push(mismatchedNotice)).toBe(mismatchedNotice);
      expect(buffer.finish()).toEqual([]);
    });

    it("rejects arbitrary prose containing task-looking phrases", () => {
      const proseWithNewlines = `<SYSTEM_MESSAGE>\n[Message]\nI noticed that content=Task id "session/task-1" finished with result:\nThe command exited with code 0.\n</SYSTEM_MESSAGE>`;
      expect(parseAntigravityTaskNotification(proseWithNewlines)).toBeUndefined();

      const proseConversation = `The following is a <SYSTEM_MESSAGE> not actually sent by the user.\n\nTask id "session/task-1" finished with result: The command exited with code 0.`;
      expect(parseAntigravityTaskNotification(proseConversation)).toBeUndefined();
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
      expect(buffer.finish()).toEqual([]);
    });

    it("streams unrelated <SYSTEM_MESSAGE> prose immediately without treating as task notice", () => {
      const buffer = new AntigravityTaskNotificationBuffer();
      const peerReview = `<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-14T23:22:20Z sender=reviewer priority=NORMAL content=### Adversarial Review: PR`;
      // Buffer diverges when content does not start with Task id "
      expect(buffer.push(peerReview)).toBe(peerReview);
      expect(buffer.finish()).toEqual([]);
      expect(parseAntigravityTaskNotification(peerReview)).toBeUndefined();
    });

    it("recognizes a system notice between narration across every chunk boundary", () => {
      const before = "I will wait for the tests.\n\nThe system will notify us.\n\n";
      const after = "I will check the results.";
      const notice = systemNotice(0, "log");
      const text = before + notice + after;
      for (let split = 0; split <= text.length; split++) {
        const buffer = new AntigravityTaskNotificationBuffer();
        const emitted = buffer.push(text.slice(0, split)) + buffer.push(text.slice(split));
        const result = buffer.finish();
        expect(emitted).toBe(before);
        expect(result).toEqual([
          { type: "notification", notification: parseAntigravityTaskNotification(notice) },
          { type: "text", text: after },
        ]);
      }
    });

    it.each(["\n", "\r\n"])(
      "keeps multiple notices and narration ordered with %j framing",
      (newline) => {
        const first = systemNotice(0, "log").replaceAll("\n", newline);
        const second = systemNotice(8, "log")
          .replaceAll("task-444", "task-445")
          .replaceAll("\n", newline);
        const middle = `I will inspect the other task.${newline}${newline}`;
        const after = "Both tasks have finished.";
        const text = first + middle + second + after;
        for (let split = 0; split <= text.length; split++) {
          const buffer = new AntigravityTaskNotificationBuffer();
          expect(buffer.push(text.slice(0, split)) + buffer.push(text.slice(split))).toBe("");
          expect(buffer.finish()).toEqual([
            { type: "notification", notification: parseAntigravityTaskNotification(first) },
            { type: "text", text: middle },
            { type: "notification", notification: parseAntigravityTaskNotification(second) },
            { type: "text", text: after },
          ]);
        }
      },
    );

    it.each(["expected </SYSTEM_MESSAGE> in fixture", "</SYSTEM_MESSAGE>"])(
      "preserves literal closing tags in output: %s",
      (output) => {
        const notice = systemNotice(0, "log").replace("✔ passed", `${output}\nAll tests passed`);
        const narration = "I will check the results.";
        const text = notice + narration;
        for (let split = 0; split <= text.length; split++) {
          const buffer = new AntigravityTaskNotificationBuffer();
          expect(buffer.push(text.slice(0, split)) + buffer.push(text.slice(split))).toBe("");
          expect(buffer.finish()).toEqual([
            { type: "notification", notification: parseAntigravityTaskNotification(notice) },
            { type: "text", text: narration },
          ]);
        }
      },
    );

    it.each(["\n", "\n}\n"])(
      "consumes terminal envelope trivia %j without a message shell",
      (suffix) => {
        const notice = systemNotice(0, "log");
        const buffer = new AntigravityTaskNotificationBuffer();
        expect(buffer.push(notice + suffix)).toBe("");
        expect(buffer.finish()).toEqual([
          { type: "notification", notification: parseAntigravityTaskNotification(notice) },
        ]);
      },
    );

    it("keeps ambiguous bare closing tags with trailing narration losslessly", () => {
      const text =
        systemNotice(0, "log").replace("Log: file:///path/to/tasks/task-444.log\n", "") +
        "Next steps.";
      const buffer = new AntigravityTaskNotificationBuffer();
      expect(buffer.push(text)).toBe("");
      expect(buffer.finish()).toEqual([{ type: "text", text }]);
    });

    it("preserves fenced system notice examples even with character-sized chunks", () => {
      const text = "Here is an example:\n\n```text\n\n" + systemNotice(0, "log") + "\n```";
      const buffer = new AntigravityTaskNotificationBuffer();
      let emitted = "";
      for (const char of text) emitted += buffer.push(char);
      const result = buffer.finish();
      expect(emitted + result.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
        text,
      );
      expect(result.every((part) => part.type === "text")).toBe(true);
    });

    it("separates a closed system notice from narration across every chunk boundary", () => {
      const notice = systemNotice(0, "log");
      const narration = "I will check the progress of the local task.";
      const text = notice + narration;
      for (let split = 0; split <= text.length; split++) {
        const buffer = new AntigravityTaskNotificationBuffer();
        expect(buffer.push(text.slice(0, split))).toBe("");
        expect(buffer.push(text.slice(split))).toBe("");
        expect(buffer.finish()).toEqual([
          { type: "notification", notification: parseAntigravityTaskNotification(notice) },
          { type: "text", text: narration },
        ]);
      }
      expect(parseAntigravityTaskNotification(text)).toBeUndefined();
    });

    it.each([
      "<SYSTEM_MESSAGE>",
      "<SYSTEM_MESSAGE>\n[Message] timestamp=2026-09-17T17:21:40Z",
      systemNotice().replace("code 0", "code unknown"),
      systemNotice().replace("code 0", "code 99999999999999999"),
    ])("returns incomplete or unrecognized system messages without losing text", (text) => {
      const buffer = new AntigravityTaskNotificationBuffer();
      const emitted = buffer.push(text);
      const result = buffer.finish();
      expect(emitted + result.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
        text,
      );
      expect(result.every((part) => part.type === "text")).toBe(true);
    });
  });
});

describe("plain async task completion notices", () => {
  const notice =
    "An async task completed with status: success\nTask Summary: node scripts/verify.mjs --pr 329\nExecution output: Tests passed\nRun is still in progress; current conclusion: in_progress.";
  it("preserves output without inventing a native exit code", () => {
    const parsed = parseAntigravityTaskNotification(notice, "message-123");
    expect(parsed).toEqual({
      taskId: "message-123",
      command: "node scripts/verify.mjs --pr 329",
      status: "completed",
      output: "Tests passed\nRun is still in progress; current conclusion: in_progress.",
    });
  });
  it("buffers the new envelope across arbitrary chunk boundaries", () => {
    for (let split = 0; split <= notice.length; split++) {
      const buffer = new AntigravityTaskNotificationBuffer("message-123");
      expect(buffer.push(notice.slice(0, split))).toBe("");
      expect(buffer.push(notice.slice(split))).toBe("");
      expect(buffer.finish()).toEqual([
        {
          type: "notification",
          notification: parseAntigravityTaskNotification(notice, "message-123"),
        },
      ]);
    }
  });
  it.each(["failed", "cancelled"] as const)(
    "keeps %s status without guessing an exit code",
    (status) => {
      const parsed = parseAntigravityTaskNotification(
        notice.replace("status: success", `status: ${status}`),
        "message-456",
      );
      expect(parsed?.status).toBe(status);
      expect(parsed?.exitCode).toBeUndefined();
    },
  );
  it.each([
    "An async task completed with status: success",
    "An async task completed with status: unknown\nTask Summary: test\nExecution output: done",
    "Here is the notice:\n" + notice,
    "```text\n" + notice + "\n```",
  ])("preserves ordinary, quoted, or incomplete text", (text) => {
    const buffer = new AntigravityTaskNotificationBuffer("message-123");
    const emitted = buffer.push(text);
    const result = buffer.finish();
    expect(emitted + result.map((part) => (part.type === "text" ? part.text : "")).join("")).toBe(
      text,
    );
    expect(result.every((part) => part.type === "text")).toBe(true);
  });
});
