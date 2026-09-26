import {
  EnvironmentId,
  MessageId,
  OrchestrationDispatchCommandError,
  ThreadId,
} from "@t3tools/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  reportOutboxDeliveryFailure,
  reportOutboxEditedAfterDelivery,
  reportOutboxUploadFailure,
} from "./thread-outbox-failure-log";

const message = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
  messageId: MessageId.make("message-1"),
};

const debugFlag = globalThis as { __PYLON_OUTBOX_DEBUG__?: boolean };
let warn: ReturnType<typeof vi.spyOn>;
let log: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  delete debugFlag.__PYLON_OUTBOX_DEBUG__;
});

afterEach(() => {
  delete debugFlag.__PYLON_OUTBOX_DEBUG__;
  vi.restoreAllMocks();
});

describe("thread outbox failure logging", () => {
  it("keeps an ordinary offline retry out of warnings while retaining opt-in diagnostics", () => {
    const input = {
      stage: "start-turn" as const,
      error: new Error("Socket is not connected"),
      interrupted: false,
      context: message,
    };
    expect(reportOutboxDeliveryFailure(input)).toBe("retry");
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();

    expect(
      reportOutboxDeliveryFailure({
        ...input,
        error: { _tag: "RpcClientError", reason: { _tag: "SocketReadError" } },
      }),
    ).toBe("retry");
    expect(warn).not.toHaveBeenCalled();

    debugFlag.__PYLON_OUTBOX_DEBUG__ = true;
    expect(reportOutboxDeliveryFailure(input)).toBe("retry");
    expect(log).toHaveBeenCalledWith(
      "[pylon-thread-outbox] queued message delivery failed; retrying",
      expect.objectContaining({ stage: "start-turn", action: "retry" }),
    );
    expect(warn).not.toHaveBeenCalled();
  });

  it("keeps server decisions and non-socket RPC failures visible as warnings", () => {
    expect(
      reportOutboxDeliveryFailure({
        stage: "start-turn",
        error: new OrchestrationDispatchCommandError({ message: "Rejected" }),
        interrupted: false,
        context: message,
      }),
    ).toBe("hold");
    expect(warn).toHaveBeenCalledTimes(1);

    const decodeDefect = { _tag: "RpcClientError", reason: { _tag: "RpcClientDefect" } };
    expect(
      reportOutboxDeliveryFailure({
        stage: "settings-sync",
        error: decodeDefect,
        interrupted: false,
        context: message,
      }),
    ).toBe("retry");
    expect(warn).toHaveBeenCalledTimes(2);

    for (const reasonTag of ["StatusCodeError", "DecodeError", "WorkerError"]) {
      expect(
        reportOutboxDeliveryFailure({
          stage: "start-turn",
          error: { _tag: "RpcClientError", reason: { _tag: reasonTag } },
          interrupted: false,
          context: message,
        }),
      ).toBe("retry");
    }
    expect(warn).toHaveBeenCalledTimes(5);

    expect(
      reportOutboxDeliveryFailure({
        stage: "start-turn",
        error: new Error("RpcClientError: StatusCodeError"),
        interrupted: false,
        context: message,
      }),
    ).toBe("retry");
    expect(warn).toHaveBeenCalledTimes(6);

    expect(
      reportOutboxDeliveryFailure({
        stage: "start-turn",
        error: new Error("Unexpected failure"),
        interrupted: false,
        context: message,
      }),
    ).toBe("hold");
    expect(warn).toHaveBeenCalledTimes(7);
  });

  it("treats interrupted requests and retryable uploads as ordinary", () => {
    expect(
      reportOutboxDeliveryFailure({
        stage: "start-turn",
        error: new Error("Interrupted"),
        interrupted: true,
        context: message,
      }),
    ).toBe("retry");
    reportOutboxUploadFailure(message, new Error("Socket is not connected"));
    expect(warn).not.toHaveBeenCalled();

    reportOutboxUploadFailure(message, new Error("Invalid attachment"));
    expect(warn).toHaveBeenCalledOnce();

    reportOutboxUploadFailure(message, {
      _tag: "RpcClientError",
      reason: { _tag: "StatusCodeError" },
    });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it("does not warn when a user edit wins the delivery cleanup race", () => {
    reportOutboxEditedAfterDelivery(message);
    expect(warn).not.toHaveBeenCalled();
    expect(log).not.toHaveBeenCalled();
  });
});
