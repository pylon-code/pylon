export interface AntigravityTaskNotification {
  readonly command: string;
  readonly taskId: string;
  readonly exitCode: number;
  readonly output: string;
}

const LEGACY_OPEN = "<task_notification>";
const SYSTEM_MESSAGE_PREAMBLE =
  "The following is a <SYSTEM_MESSAGE> not actually sent by the user. It is provided by the system as important information to pay attention to.";
const SYSTEM_MESSAGE_OPEN = "<SYSTEM_MESSAGE>";
const MAX_BUFFER_LENGTH = 1024 * 1024;

export function parseAntigravityTaskNotification(
  text: string,
): AntigravityTaskNotification | undefined {
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
  if (!body.startsWith("[Message]")) {
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

  const bodyMatch =
    /^\[Message\][\s\S]*?content=Task id "([^"]+)" finished with result:\s*The command exited with code (-?\d+)\.?(?:\s*(?:Output:|Stdout:)\s*\r?\n?([\s\S]*))?$/.exec(
      body,
    );
  if (!bodyMatch) {
    return undefined;
  }

  const taskId = bodyMatch[1];
  const exitCode = Number(bodyMatch[2]);
  if (!taskId || !Number.isSafeInteger(exitCode)) {
    return undefined;
  }

  const rawRest = bodyMatch[3] ?? "";
  const trailerMatch =
    /(?:\r?\n\}?\s*<attachment>[\s\S]*?<\/attachment>(?:\s*<\/SYSTEM_MESSAGE>)?|\r?\n\}?\s*Attachment processed:[^\r\n]*(?:\r?\n\s*Original path:[^\r\n]*)?(?:\r?\n\s*Description:[^\r\n]*)?(?:\s*<\/SYSTEM_MESSAGE>)?|\r?\n\s*Log:\s*file:\/\/\S+[^\r\n]*(?:\s*<\/SYSTEM_MESSAGE>)?|\r?\n\s*<\/SYSTEM_MESSAGE>|<\/SYSTEM_MESSAGE>)\s*\}?\s*$/.exec(
      rawRest,
    );

  if (!trailerMatch) {
    if (rawRest.trim() !== "" && !rawRest.trim().endsWith("</SYSTEM_MESSAGE>")) {
      return undefined;
    }
  }

  const trailer = trailerMatch ? rawRest.slice(trailerMatch.index) : "";
  const outputRaw = trailerMatch ? rawRest.slice(0, trailerMatch.index) : rawRest;

  // If there was an attachment or description trailer without </SYSTEM_MESSAGE>, verify no prose after
  if (closeIdx === -1 && trailerMatch) {
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

  const isCrlf = outputRaw.includes("\r\n") || text.includes("\r\n");
  const eol = isCrlf ? "\r\n" : "\n";
  const output = outputRaw.trimEnd() ? outputRaw.trimEnd() + eol : "";
  return { command, taskId, exitCode, output };
}

function isPotentialSystemNoticeBody(after: string): boolean {
  if (after === "") return true;
  const MSG = "[Message]";
  if (MSG.startsWith(after)) return true;
  if (!after.startsWith(MSG)) return false;

  const afterMsg = after.slice(MSG.length);
  const contentIdx = afterMsg.indexOf("content=");
  if (contentIdx === -1) {
    return true;
  }

  const contentVal = afterMsg.slice(contentIdx + "content=".length).trimStart();
  const TASK_ID_PREFIX = 'Task id "';
  if (contentVal === "") return true;
  if (TASK_ID_PREFIX.startsWith(contentVal)) return true;
  if (!contentVal.startsWith(TASK_ID_PREFIX)) {
    return false;
  }

  return true;
}

function isPotentialNoticePrefix(candidate: string): boolean {
  if (candidate === "") return true;

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

/** Buffer only a possible standalone notice; normal prose keeps streaming. */
export class AntigravityTaskNotificationBuffer {
  private pending = "";
  private passthrough = false;

  push(text: string): string {
    if (this.passthrough) return text;
    this.pending += text;
    const candidate = this.pending.trimStart();
    if (this.pending.length <= MAX_BUFFER_LENGTH && isPotentialNoticePrefix(candidate)) {
      return "";
    }
    this.passthrough = true;
    const result = this.pending;
    this.pending = "";
    return result;
  }

  finish(): { text: string; notification: AntigravityTaskNotification | undefined } {
    const text = this.pending;
    this.pending = "";
    const notification = this.passthrough ? undefined : parseAntigravityTaskNotification(text);
    return { text: notification ? "" : text, notification };
  }
}
