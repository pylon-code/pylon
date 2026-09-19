export interface AntigravityTaskNotification {
  readonly command: string;
  readonly taskId: string;
  readonly exitCode?: number;
  readonly status?: "completed" | "failed" | "cancelled";
  readonly output: string;
}

const LEGACY_OPEN = "<task_notification>";
const SYSTEM_MESSAGE_PREAMBLE =
  "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.";
const SYSTEM_MESSAGE_OPEN = "<SYSTEM_MESSAGE>";
const MAX_BUFFER_LENGTH = 1024 * 1024;

const HEADER_LINE_REGEX =
  /^\[Message\][^\S\r\n]+timestamp=\S+[^\S\r\n]+sender=(\S+)[^\S\r\n]+priority=\S+[^\S\r\n]+content=Task id "([^"]+)" finished with result:[^\S\r\n]*(?:\r?\n|$)/;

/**
 * Known terminal trailer patterns for Antigravity system message task notices:
 * 1. XML task log attachment:
 *    }\n<attachment>\nAttachment processed: ...\nDescription: Task Description: <command>\n</attachment>\n</SYSTEM_MESSAGE>
 * 2. Plain attachment processed transcription:
 *    } Attachment processed: ...\nDescription: Task Description: <command>
 * 3. Task log path trailer with terminal tag:
 *    Log: file://<path>\n</SYSTEM_MESSAGE>
 * 4. Standalone terminal tag:
 *    </SYSTEM_MESSAGE>
 */
const TERMINAL_TRAILER_PATTERN =
  /(?:\r?\n)?(?:\}?\s*<attachment>[\s\S]*?<\/attachment>(?:\s*<\/SYSTEM_MESSAGE>)?|\}?\s*Attachment processed:[^\r\n]*(?:\r?\n\s*Original path:[^\r\n]*)?(?:\r?\n\s*Description:[^\r\n]*)?(?:\s*<\/SYSTEM_MESSAGE>)?|[^\S\r\n]*Log:[^\S\r\n]*file:\/\/\S+[^\r\n]*(?:\s*<\/SYSTEM_MESSAGE>)?|[^\S\r\n]*<\/SYSTEM_MESSAGE>)\s*\}?\s*$/;

export function parseAntigravityTaskNotification(
  text: string,
  fallbackTaskId?: string,
): AntigravityTaskNotification | undefined {
  const plain =
    /^An async task completed with status: (success|failed|cancelled)\r?\nTask Summary: ([^\r\n]+)\r?\nExecution output:(?:[^\S\r\n]*\r?\n|[^\S\r\n])?([\s\S]*)$/.exec(
      text.trimStart(),
    );
  if (plain && fallbackTaskId && plain[2]?.trim()) {
    return {
      command: plain[2].trim(),
      taskId: fallbackTaskId,
      status: plain[1] === "success" ? "completed" : plain[1] === "failed" ? "failed" : "cancelled",
      output: plain[3] ?? "",
    };
  }

  // 1. Legacy XML format
  const legacyMatch =
    /^\s*<task_notification>\r?\nTask completed: ([^\r\n]+) \(task ID: ([^\s()]+)\)\r?\nExit code: (-?\d+)\r?\nOutput:\r?\n([\s\S]*?)\r?\n<\/task_notification>\s*$/.exec(
      text,
    );
  if (legacyMatch) {
    const [, command, taskId, code, output] = legacyMatch;
    const exitCode = Number(code);
    if (command && taskId && output !== undefined && Number.isSafeInteger(exitCode)) {
      return { command, taskId, exitCode, output };
    }
  }

  // 2. <SYSTEM_MESSAGE> format
  let candidate = text.trimStart();
  if (candidate.startsWith(SYSTEM_MESSAGE_PREAMBLE)) {
    candidate = candidate.slice(SYSTEM_MESSAGE_PREAMBLE.length).trimStart();
  }
  if (!candidate.startsWith(SYSTEM_MESSAGE_OPEN)) {
    return undefined;
  }
  const body = candidate.slice(SYSTEM_MESSAGE_OPEN.length).trimStart();

  const headerMatch = HEADER_LINE_REGEX.exec(body);
  if (!headerMatch) {
    return undefined;
  }
  const sender = headerMatch[1];
  const taskId = headerMatch[2];
  if (!sender || !taskId || sender !== taskId) {
    return undefined;
  }

  // Must not have trailing prose after the closing tag
  const closeTag = "</SYSTEM_MESSAGE>";
  const closeIdx = text.lastIndexOf(closeTag);
  if (closeIdx !== -1) {
    const afterClose = text.slice(closeIdx + closeTag.length).trim();
    if (afterClose !== "" && afterClose !== "}") {
      return undefined;
    }
  }

  const bodyAfterHeader = body.slice(headerMatch[0].length).trimStart();
  const exitMatch = /^The command exited with code (-?\d+)\.?(?:[^\S\r\n]*\r?\n)?([\s\S]*)$/.exec(
    bodyAfterHeader,
  );
  if (!exitMatch || !exitMatch[1]) {
    return undefined;
  }
  const exitCode = Number(exitMatch[1]);
  if (!Number.isSafeInteger(exitCode)) {
    return undefined;
  }

  let rest = exitMatch[2] ?? "";
  const outputLabelMatch =
    /^(?:[^\S\r\n]*\r?\n)?\s*(?:Output:|Stdout:)(?:[^\S\r\n]*\r?\n|[^\S\r\n])?/.exec(rest);
  if (outputLabelMatch) {
    rest = rest.slice(outputLabelMatch[0].length);
  }

  // A complete recognized terminal envelope/trailer is strictly required for all system notices
  const trailerMatch = TERMINAL_TRAILER_PATTERN.exec(rest);
  if (!trailerMatch) {
    return undefined;
  }

  const trailer = rest.slice(trailerMatch.index);
  const outputRaw = rest.slice(0, trailerMatch.index);

  // If there was an attachment or description trailer without </SYSTEM_MESSAGE>, verify no prose after
  if (closeIdx === -1) {
    const attachClose = "</attachment>";
    const attachIdx = trailer.lastIndexOf(attachClose);
    if (attachIdx !== -1) {
      const after = trailer.slice(attachIdx + attachClose.length).trim();
      if (after !== "" && after !== "}") {
        return undefined;
      }
    } else {
      const descMatch = /Description:\s*Task Description:[^\r\n]*/.exec(trailer);
      if (descMatch) {
        const after = trailer.slice(descMatch.index + descMatch[0].length).trim();
        if (after !== "" && after !== "}") {
          return undefined;
        }
      }
    }
  }

  let command = "";
  const descMatch = /Description:\s*Task Description:\s*([^\r\n]+)/.exec(trailer);
  if (descMatch?.[1]) {
    command = descMatch[1].trim();
  }
  if (!command) {
    const promptMatch = /^\s*(?:>[^\r\n]*\r?\n\s*)?[$>]\s*([^\r\n]+)/.exec(outputRaw);
    if (promptMatch?.[1]) {
      command = promptMatch[1].trim();
    } else {
      command = taskId;
    }
  }

  return { command, taskId, exitCode, output: outputRaw };
}

function isPotentialSystemNoticeBody(after: string): boolean {
  if (after === "") return true;
  const MSG = "[Message]";
  if (MSG.startsWith(after)) return true;
  if (!after.startsWith(MSG)) return false;

  const afterMsg = after.slice(MSG.length);
  if (afterMsg === "") return true;
  // Must be followed by horizontal whitespace on the header line, not a newline
  if (afterMsg.startsWith("\r") || afterMsg.startsWith("\n") || !/^\s/.test(afterMsg)) {
    return false;
  }

  const firstLineEnd = afterMsg.search(/\r?\n/);
  const firstLine = firstLineEnd === -1 ? afterMsg : afterMsg.slice(0, firstLineEnd);

  const contentIdx = firstLine.indexOf("content=");
  if (contentIdx !== -1) {
    const contentVal = firstLine.slice(contentIdx + "content=".length).trimStart();
    const TASK_ID_PREFIX = 'Task id "';
    if (contentVal === "") return true;
    if (TASK_ID_PREFIX.startsWith(contentVal)) return true;
    if (!contentVal.startsWith(TASK_ID_PREFIX)) {
      return false;
    }
  }

  const senderMatch = /sender=(\S+)/.exec(firstLine);
  if (senderMatch?.[1] && contentIdx !== -1) {
    const sender = senderMatch[1];
    const taskIdMatch = /content=Task id "([^"]*)"?/.exec(firstLine);
    if (taskIdMatch?.[1]) {
      const partialTaskId = taskIdMatch[1];
      if (!sender.startsWith(partialTaskId) && !partialTaskId.startsWith(sender)) {
        return false;
      }
    }
  }

  return true;
}

function isPotentialNoticePrefix(candidate: string): boolean {
  if (candidate === "") return true;
  const plainPrefix = "An async task completed with status: ";
  if (plainPrefix.startsWith(candidate)) return true;
  if (candidate.startsWith(plainPrefix)) {
    const rest = candidate.slice(plainPrefix.length);
    return ["success", "failed", "cancelled"].some(
      (status) =>
        status.startsWith(rest) ||
        rest === status + "\r" ||
        rest.startsWith(status + "\n") ||
        rest.startsWith(status + "\r\n"),
    );
  }

  // 1. Legacy format
  if (LEGACY_OPEN.startsWith(candidate) || candidate.startsWith(LEGACY_OPEN)) {
    return true;
  }

  // 2. Direct <SYSTEM_MESSAGE>
  if (SYSTEM_MESSAGE_OPEN.startsWith(candidate)) {
    return true;
  }
  if (candidate.startsWith(SYSTEM_MESSAGE_OPEN)) {
    const after = candidate.slice(SYSTEM_MESSAGE_OPEN.length).trimStart();
    return isPotentialSystemNoticeBody(after);
  }

  // 3. Preamble format
  if (SYSTEM_MESSAGE_PREAMBLE.startsWith(candidate)) {
    return true;
  }
  if (candidate.startsWith(SYSTEM_MESSAGE_PREAMBLE)) {
    const afterPreamble = candidate.slice(SYSTEM_MESSAGE_PREAMBLE.length).trimStart();
    if (afterPreamble === "") return true;
    if (SYSTEM_MESSAGE_OPEN.startsWith(afterPreamble)) return true;
    if (afterPreamble.startsWith(SYSTEM_MESSAGE_OPEN)) {
      const after = afterPreamble.slice(SYSTEM_MESSAGE_OPEN.length).trimStart();
      return isPotentialSystemNoticeBody(after);
    }
    return false;
  }

  return false;
}

export type AntigravityMessagePart =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "notification"; readonly notification: AntigravityTaskNotification };

// Mixed messages need an unambiguous provider trailer. A literal closing tag
// can occur in command output (including tests of this very protocol).
const CLOSED_SYSTEM_TRAILER =
  /(?:^|\r?\n)(?:[^\S\r\n]*Log:[^\S\r\n]*file:\/\/[^\r\n]+\r?\n[^\S\r\n]*|[^\S\r\n]*<\/attachment>\s*)<\/SYSTEM_MESSAGE>/g;

function leadingSystemNotice(text: string) {
  for (const trailer of text.matchAll(CLOSED_SYSTEM_TRAILER)) {
    const end = trailer.index + trailer[0].length;
    const notification = parseAntigravityTaskNotification(text.slice(0, end));
    if (notification) return { notification, remainder: text.slice(end) };
  }
  return undefined;
}

/** Extract provider notices from narration while keeping ordinary prose streaming. */
export class AntigravityTaskNotificationBuffer {
  private readonly fallbackTaskId: string | undefined;
  constructor(fallbackTaskId?: string) {
    this.fallbackTaskId = fallbackTaskId;
  }
  private pending = "";
  private passthrough = false;
  private proseTail = "";
  private proseLine = "";
  private lineBreaks = 0;
  private fence: string | undefined;

  private streamProse(text: string): string {
    const combined = this.proseTail + text;
    this.proseTail = "";
    for (let index = 0; index < combined.length; index++) {
      // Only a full provider preamble at a paragraph boundary can interrupt
      // narration. Bare tags and fenced examples remain ordinary text.
      if (this.lineBreaks >= 2 && !this.fence && combined[index] === "T") {
        const candidate = combined.slice(index);
        if (
          candidate.length <= MAX_BUFFER_LENGTH &&
          candidate.startsWith(SYSTEM_MESSAGE_PREAMBLE)
        ) {
          this.passthrough = false;
          this.lineBreaks = 0;
          this.pending = candidate;
          return combined.slice(0, index);
        }
        if (SYSTEM_MESSAGE_PREAMBLE.startsWith(candidate)) {
          this.proseTail = candidate;
          return combined.slice(0, index);
        }
      }
      const char = combined[index];
      if (char === "\n") {
        const delimiter = /^ {0,3}(`{3,}|~{3,})/.exec(this.proseLine)?.[1];
        if (delimiter) {
          if (!this.fence) this.fence = delimiter;
          else if (
            delimiter[0] === this.fence[0] &&
            delimiter.length >= this.fence.length &&
            this.proseLine.trim() === delimiter
          ) {
            this.fence = undefined;
          }
        }
        this.proseLine = "";
        this.lineBreaks++;
      } else if (char !== "\r") {
        this.lineBreaks = 0;
        // Only the beginning of the line is needed to track Markdown fences.
        if (this.proseLine.length < 256) this.proseLine += char;
      }
    }
    return combined;
  }

  push(text: string): string {
    if (this.passthrough) return this.streamProse(text);
    this.pending += text;
    const candidate = this.pending.trimStart();
    if (this.pending.length <= MAX_BUFFER_LENGTH && isPotentialNoticePrefix(candidate)) {
      return "";
    }
    this.passthrough = true;
    const result = this.pending;
    this.pending = "";
    return this.streamProse(result);
  }

  canFlushOnIdle(): boolean {
    return this.finishedParts().every(
      (part) => part.type === "notification" || !isPotentialNoticePrefix(part.text.trimStart()),
    );
  }

  finish(): ReadonlyArray<AntigravityMessagePart> {
    const parts = this.finishedParts();
    this.pending = "";
    this.proseTail = "";
    return parts;
  }

  private finishedParts(): ReadonlyArray<AntigravityMessagePart> {
    const parts: AntigravityMessagePart[] = [];
    let text = this.pending + this.proseTail;
    let passthrough = this.passthrough;
    let fallbackTaskId = this.fallbackTaskId;
    while (true) {
      if (passthrough) {
        if (text) parts.push({ type: "text", text });
        break;
      }

      // Split before parsing the whole buffer: multiple notices otherwise look
      // like a single notice whose output contains the intervening narration.
      const leading = leadingSystemNotice(text);
      const notification =
        leading?.notification ?? parseAntigravityTaskNotification(text, fallbackTaskId);
      if (!notification) {
        if (text) parts.push({ type: "text", text });
        break;
      }
      parts.push({ type: "notification", notification });
      // Whitespace and the provider's optional terminal brace belong to the
      // envelope; neither should create a new assistant-message shell.
      if (!leading?.remainder.trim() || leading.remainder.trim() === "}") break;

      const buffer = new AntigravityTaskNotificationBuffer(
        this.fallbackTaskId ? `${this.fallbackTaskId}:notice:${parts.length}` : undefined,
      );
      const prose = buffer.push(leading.remainder);
      if (prose) parts.push({ type: "text", text: prose });
      text = buffer.pending + buffer.proseTail;
      passthrough = buffer.passthrough;
      fallbackTaskId = buffer.fallbackTaskId;
    }
    return parts;
  }
}
