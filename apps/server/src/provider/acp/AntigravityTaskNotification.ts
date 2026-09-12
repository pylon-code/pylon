/** Antigravity 1.1.1 sends command completion notices as whole assistant messages. */
const OPEN = "<task_notification>";
const MAX_BUFFER_LENGTH = 1024 * 1024;

export function parseAntigravityTaskNotification(text: string) {
  const match =
    /^\s*<task_notification>\r?\nTask completed: ([^\r\n]+) \(task ID: ([^\s()]+)\)\r?\nExit code: (-?\d+)\r?\nOutput:\r?\n([\s\S]*?)\r?\n<\/task_notification>\s*$/.exec(
      text,
    );
  if (!match) return undefined;
  const [, command, taskId, code, output] = match;
  const exitCode = Number(code);
  if (!command || !taskId || output === undefined || !Number.isSafeInteger(exitCode)) {
    return undefined;
  }
  return { command, taskId, exitCode, output };
}

/** Buffer only a possible standalone notice; normal prose keeps streaming. */
export class AntigravityTaskNotificationBuffer {
  private pending = "";
  private passthrough = false;

  push(text: string): string {
    if (this.passthrough) return text;
    this.pending += text;
    const candidate = this.pending.trimStart();
    if (
      this.pending.length <= MAX_BUFFER_LENGTH &&
      (OPEN.startsWith(candidate) || candidate.startsWith(OPEN))
    ) {
      return "";
    }
    this.passthrough = true;
    const result = this.pending;
    this.pending = "";
    return result;
  }

  finish() {
    const text = this.pending;
    this.pending = "";
    const notification = this.passthrough ? undefined : parseAntigravityTaskNotification(text);
    return { text: notification ? "" : text, notification };
  }
}
