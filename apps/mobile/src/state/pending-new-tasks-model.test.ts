import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  type ServerConfig,
  ThreadId,
} from "@t3tools/contracts";
import { Atom, AtomRegistry } from "effect/unstable/reactivity";

import type { QueuedThreadMessage } from "./thread-outbox-model";
import type { ComposerDraft } from "./use-composer-drafts";
import {
  buildPendingNewTasks,
  makeListedNewTaskDraftsAtom,
  resolvePendingTaskDelivery,
  selectListedNewTaskDrafts,
} from "./pending-new-tasks-model";

const environmentId = EnvironmentId.make("env-1");
const projectId = ProjectId.make("project-1");

function queuedCreation(id: string, createdAt: string): QueuedThreadMessage {
  return {
    environmentId,
    threadId: ThreadId.make(`thread-${id}`),
    messageId: MessageId.make(id),
    commandId: CommandId.make(`command-${id}`),
    text: `queued ${id}`,
    attachments: [],
    createdAt,
    creation: {
      projectId,
      workspaceMode: "local",
      branch: "main",
      worktreePath: null,
    },
  };
}

function draft(
  text: string,
  createdAt: string,
  overrides: Partial<ComposerDraft> = {},
): ComposerDraft {
  return {
    text,
    attachments: [],
    project: { environmentId, projectId, createdAt },
    ...overrides,
  };
}

describe("buildPendingNewTasks", () => {
  it("surfaces every new-task draft with content alongside queued creations", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [queuedCreation("a", "2026-09-05T10:00:00.000Z")],
      drafts: {
        "new-task:draft-old": draft("first idea", "2026-09-05T09:00:00.000Z", {
          workspaceSelection: { mode: "worktree", branch: "main", worktreePath: null },
        }),
        "new-task:draft-new": draft("second idea", "2026-09-05T11:00:00.000Z"),
      },
    });

    expect(tasks.map((task) => [task.kind, task.title, task.branch])).toEqual([
      ["draft", "second idea", null],
      ["draft", "first idea", "main"],
      ["pending", "queued a", "main"],
    ]);
    expect(tasks[1]).toMatchObject({
      key: "draft-task:new-task:draft-old",
      environmentId,
      projectId,
      draftKey: "new-task:draft-old",
      createdAt: "2026-09-05T09:00:00.000Z",
    });
  });

  it("hides settings-only drafts, unstamped drafts, and drafts for other surfaces", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [],
      drafts: {
        "new-task:settings-only": draft("", "2026-09-05T09:00:00.000Z", {
          modelSelection: { instanceId: "codex" as never, model: "gpt" },
        }),
        "new-task:blank": draft("   ", "2026-09-05T09:00:00.000Z"),
        "new-task:unstamped": { text: "no project", attachments: [] },
        [`${environmentId}:thread-1`]: { text: "thread composer text", attachments: [] },
        "pending-task:message-1": { text: "editor copy of a queued task", attachments: [] },
      },
    });

    expect(tasks).toEqual([]);
  });

  it("titles an attachment-only draft by its attachment count", () => {
    const attachment = {
      type: "image",
      id: "image-1",
      uri: "file:///image-1.png",
      mimeType: "image/png",
      name: "image-1.png",
      width: 1,
      height: 1,
      sizeBytes: 1,
    } as unknown as ComposerDraft["attachments"][number];
    const tasks = buildPendingNewTasks({
      queuedMessages: [],
      drafts: {
        "new-task:with-image": draft("", "2026-09-05T09:00:00.000Z", {
          attachments: [attachment],
        }),
      },
    });

    expect(tasks.map((task) => task.title)).toEqual(["1 attachment"]);
  });

  it("orders queued creations newest first and skips existing-thread messages", () => {
    const tasks = buildPendingNewTasks({
      queuedMessages: [
        queuedCreation("old", "2026-09-05T08:00:00.000Z"),
        { ...queuedCreation("follow-up", "2026-09-05T11:00:00.000Z"), creation: undefined },
        queuedCreation("new", "2026-09-05T10:00:00.000Z"),
      ],
      drafts: {},
    });

    expect(tasks.map((task) => task.title)).toEqual(["queued new", "queued old"]);
  });
});

describe("listed new-task drafts", () => {
  const listed = draft("an idea", "2026-09-05T09:00:00.000Z");

  it("keeps its identity while unrelated drafts change", () => {
    const first = selectListedNewTaskDrafts(
      { "new-task:idea": listed, "env-1:thread-1": { text: "typ", attachments: [] } },
      undefined,
    );
    expect(first).toEqual({ "new-task:idea": listed });

    const afterThreadKeystroke = selectListedNewTaskDrafts(
      { "new-task:idea": listed, "env-1:thread-1": { text: "typing", attachments: [] } },
      first,
    );
    expect(afterThreadKeystroke).toBe(first);

    // A model pick on an empty new-task draft is not listed either.
    const afterEmptyDraftSettings = selectListedNewTaskDrafts(
      {
        "new-task:idea": listed,
        "new-task:empty": draft("", "2026-09-05T10:00:00.000Z", { runtimeMode: "full-access" }),
      },
      first,
    );
    expect(afterEmptyDraftSettings).toBe(first);
  });

  it("changes when a listed draft is edited, added, or removed", () => {
    const first = selectListedNewTaskDrafts({ "new-task:idea": listed }, undefined);
    const edited = { ...listed, text: "an idea, refined" };
    const afterEdit = selectListedNewTaskDrafts({ "new-task:idea": edited }, first);
    expect(afterEdit).not.toBe(first);
    expect(afterEdit).toEqual({ "new-task:idea": edited });
    const added = selectListedNewTaskDrafts(
      { "new-task:idea": listed, "new-task:other": draft("other", "2026-09-05T10:00:00.000Z") },
      first,
    );
    expect(added).not.toBe(first);
    expect(selectListedNewTaskDrafts({}, first)).toEqual({});
  });

  it("does not notify list subscribers when a thread composer changes", () => {
    const registry = AtomRegistry.make();
    const source = Atom.make<Readonly<Record<string, ComposerDraft>>>({
      "new-task:idea": listed,
    });
    const derived = makeListedNewTaskDraftsAtom(source);
    const initial = registry.get(derived);
    let notifications = 0;
    const unsubscribe = registry.subscribe(derived, () => {
      notifications += 1;
    });

    registry.set(source, {
      ...registry.get(source),
      "env-1:thread-1": { text: "typing a follow-up", attachments: [] },
    });
    expect(registry.get(derived)).toBe(initial);
    expect(notifications).toBe(0);

    registry.set(source, {
      ...registry.get(source),
      "new-task:idea": { ...listed, text: "an idea, refined" },
    });
    expect(registry.get(derived)).not.toBe(initial);
    expect(notifications).toBe(1);
    unsubscribe();
  });
});

describe("resolvePendingTaskDelivery", () => {
  const uploadConfig = {
    environment: {
      capabilities: { attachmentUploads: true, fileAttachments: { maxUploadBytes: 1_000_000 } },
    },
  } as unknown as ServerConfig;
  const image = {
    id: "image-1",
    type: "image",
    name: "screen.png",
    mimeType: "image/png",
    sizeBytes: 10,
    previewUri: "data:image/png;base64,AAAA",
  } as const;

  it("says Held for a held task whatever the connection", () => {
    const held: QueuedThreadMessage = {
      ...queuedCreation("held", "2026-09-05T10:00:00.000Z"),
      deliveryHold: { kind: "admission-rejected", reason: "Provider refused the turn" },
    };
    expect(
      resolvePendingTaskDelivery({ message: held, connected: true, serverConfig: uploadConfig }),
    ).toBe("held");
    expect(
      resolvePendingTaskDelivery({ message: held, connected: false, serverConfig: uploadConfig }),
    ).toBe("held");
  });

  it("only says it sends on reconnect while disconnected", () => {
    const queued = { ...queuedCreation("q", "2026-09-05T10:00:00.000Z"), attachments: [image] };
    expect(
      resolvePendingTaskDelivery({ message: queued, connected: false, serverConfig: uploadConfig }),
    ).toBe("offline");
    expect(
      resolvePendingTaskDelivery({ message: queued, connected: true, serverConfig: uploadConfig }),
    ).toBe("uploading");
    expect(
      resolvePendingTaskDelivery({
        message: {
          ...queued,
          attachments: [
            { ...image, uploadedAttachmentId: "upload-1", uploadEnvironmentId: environmentId },
          ],
        },
        connected: true,
        serverConfig: uploadConfig,
      }),
    ).toBe("sending");
    expect(
      resolvePendingTaskDelivery({
        message: queuedCreation("plain", "2026-09-05T10:00:00.000Z"),
        connected: true,
        serverConfig: uploadConfig,
      }),
    ).toBe("sending");
  });
});
