import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ServerProvider,
} from "@t3tools/contracts";
import { AtomRegistry } from "effect/unstable/reactivity";

import {
  decodeQueuedThreadMessage,
  encodeQueuedThreadMessage,
  groupQueuedThreadMessages,
  isQueuedThreadCreationSendable,
  modelSelectionsEqual,
  preserveQueuedThreadDeliveryHold,
  queuedCreationWorkspaceHold,
  resolveConfirmedThreadOutboxPlan,
  resolveThreadOutboxDeliveryAction,
  resolveThreadOutboxFailureAction,
  resolveQueuedThreadAdmission,
  retryQueuedThreadMessage,
  resolveQueuedThreadSettings,
  shouldRetryThreadOutboxDelivery,
  threadOutboxRetryDelayMs,
  type QueuedThreadMessage,
} from "./thread-outbox-model";
import { createThreadOutboxManager, ThreadOutboxManagerError } from "./thread-outbox-manager";
import type { ThreadOutboxStorage } from "./thread-outbox-storage";

function queuedMessage(input: {
  readonly environmentId?: string;
  readonly threadId?: string;
  readonly messageId: string;
  readonly createdAt: string;
}): QueuedThreadMessage {
  return {
    environmentId: EnvironmentId.make(input.environmentId ?? "environment-1"),
    threadId: ThreadId.make(input.threadId ?? "thread-1"),
    messageId: MessageId.make(input.messageId),
    commandId: CommandId.make(`command-${input.messageId}`),
    text: input.messageId,
    attachments: [],
    createdAt: input.createdAt,
  };
}

function provider(input: {
  readonly instanceId: string;
  readonly availability?: "available" | "unavailable";
  readonly unavailableReason?: string;
  readonly status?: ServerProvider["status"];
  readonly driver?: string;
  readonly continuationGroupKey?: string;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver ?? "primeAgent"),
    enabled: input.availability !== "unavailable",
    installed: true,
    version: null,
    status: input.status ?? (input.availability === "unavailable" ? "disabled" : "ready"),
    ...(input.availability ? { availability: input.availability } : {}),
    ...(input.unavailableReason ? { unavailableReason: input.unavailableReason } : {}),
    ...(input.continuationGroupKey
      ? { continuation: { groupKey: input.continuationGroupKey } }
      : {}),
    auth: { status: "authenticated" },
    checkedAt: "2026-08-06T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
  };
}

describe("thread outbox", () => {
  it("groups messages by scoped thread and preserves creation order", () => {
    const later = queuedMessage({
      messageId: "message-2",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    const earlier = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(groupQueuedThreadMessages([later, earlier])).toEqual({
      "environment-1:thread-1": [earlier, later],
    });
  });

  it("decodes the persisted schema and rejects incomplete messages", () => {
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    expect(
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        ...message,
      }),
    ).toEqual(message);
    expect(() =>
      decodeQueuedThreadMessage({
        schemaVersion: 1,
        environmentId: "environment-1",
      }),
    ).toThrow();
  });

  it("persists the exact selector snapshot while remaining compatible with v1 messages", () => {
    const legacyMessage = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const selectedMessage = {
      ...legacyMessage,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
      runtimeMode: "approval-required",
      interactionMode: "plan",
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(selectedMessage))).toEqual(
      selectedMessage,
    );
    expect(
      resolveQueuedThreadSettings(legacyMessage, {
        modelSelection: selectedMessage.modelSelection,
        runtimeMode: selectedMessage.runtimeMode,
        interactionMode: selectedMessage.interactionMode,
      }),
    ).toEqual({
      modelSelection: selectedMessage.modelSelection,
      runtimeMode: selectedMessage.runtimeMode,
      interactionMode: selectedMessage.interactionMode,
    });
  });

  it("durably holds a queued turn whose snapshot conflicts with the live binding", () => {
    const message = {
      ...queuedMessage({
        messageId: "message-binding",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      },
    } satisfies QueuedThreadMessage;
    const admission = resolveQueuedThreadAdmission({
      message,
      thread: {
        modelSelection: {
          instanceId: ProviderInstanceId.make("primeAgent"),
          model: "kimi-k2.5",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        session: { providerInstanceId: ProviderInstanceId.make("primeAgent") },
      },
      providers: [provider({ instanceId: "primeAgent" })],
    });

    expect(admission.action).toBe("hold");
    if (admission.action !== "hold") return;
    expect(admission.hold.kind).toBe("provider-binding-mismatch");
    expect(
      decodeQueuedThreadMessage(
        encodeQueuedThreadMessage({ ...message, deliveryHold: admission.hold }),
      ).deliveryHold,
    ).toEqual(admission.hold);
  });

  it("dispatches a compatible account with the target-owned model and options intact", () => {
    const targetSelection = {
      instanceId: ProviderInstanceId.make("codex_personal"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "xhigh" }],
    } as const;
    const thread = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.3-codex",
      },
      runtimeMode: "approval-required" as const,
      interactionMode: "default" as const,
      session: { providerInstanceId: ProviderInstanceId.make("codex") },
    };
    const admission = resolveQueuedThreadAdmission({
      message: {
        ...queuedMessage({
          messageId: "message-compatible-account",
          createdAt: "2026-06-08T10:00:01.000Z",
        }),
        modelSelection: targetSelection,
        runtimeMode: "full-access",
        interactionMode: "plan",
      },
      thread,
      providers: [
        provider({
          instanceId: "codex",
          driver: "codex",
          continuationGroupKey: "codex:home:shared",
        }),
        provider({
          instanceId: "codex_personal",
          driver: "codex",
          continuationGroupKey: "codex:home:shared",
        }),
      ],
    });

    expect(admission).toEqual({
      action: "send",
      settings: {
        modelSelection: targetSelection,
        runtimeMode: "full-access",
        interactionMode: "plan",
        session: thread.session,
      },
    });
  });

  it("holds exact unavailable bindings with remediation and resumes the same instance", () => {
    const selection = {
      instanceId: ProviderInstanceId.make("primeAgent"),
      model: "kimi-k2.5",
      options: [{ id: "thinking", value: true }],
    } as const;
    const message = {
      ...queuedMessage({
        messageId: "message-unavailable",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      modelSelection: selection,
    } satisfies QueuedThreadMessage;
    const thread = {
      modelSelection: selection,
      runtimeMode: "approval-required" as const,
      interactionMode: "plan" as const,
      session: { providerInstanceId: selection.instanceId },
    };
    const reason = "Restore Prime Agent inside WSL2.";

    expect(
      resolveQueuedThreadAdmission({
        message,
        thread,
        providers: [
          provider({
            instanceId: "primeAgent",
            availability: "unavailable",
            unavailableReason: reason,
          }),
        ],
      }),
    ).toMatchObject({
      action: "hold",
      hold: { kind: "provider-unavailable", reason },
    });
    expect(
      resolveQueuedThreadAdmission({
        message,
        thread,
        providers: [provider({ instanceId: "primeAgent", availability: "available" })],
      }),
    ).toEqual({ action: "send", settings: thread });
  });

  it("waits on unknown provider snapshots, admits warnings, and holds hard errors", () => {
    const message = queuedMessage({
      messageId: "message-provider-tri-state",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const thread = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
    };

    expect(resolveQueuedThreadAdmission({ message, thread, providers: undefined })).toEqual({
      action: "wait",
    });
    expect(
      resolveQueuedThreadAdmission({
        message,
        thread,
        providers: [provider({ instanceId: "codex", status: "warning" })],
      }).action,
    ).toBe("send");
    expect(
      resolveQueuedThreadAdmission({
        message,
        thread,
        providers: [provider({ instanceId: "codex", status: "error" })],
      }).action,
    ).toBe("hold");
  });

  it("keeps persisted holds inert for existing turns and task creation", () => {
    for (const isCreation of [false, true]) {
      expect(
        resolveThreadOutboxDeliveryAction({
          isCreation,
          threadExists: !isCreation,
          shellStatus: "live",
          environmentConnected: true,
          threadStatus: "ready",
          hasDeliveryHold: true,
        }),
      ).toBe("wait");
    }
  });

  it("preserves a held creation only while an edit keeps every durable identifier", () => {
    const held = {
      ...queuedMessage({
        messageId: "message-held-edit",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      deliveryHold: {
        kind: "project-workspace-unavailable" as const,
        reason: "Retarget this task.",
      },
    };
    const identity = {
      threadId: held.threadId,
      commandId: held.commandId,
      messageId: held.messageId,
      createdAt: held.createdAt,
    };

    expect(preserveQueuedThreadDeliveryHold(held, identity)).toBe(held.deliveryHold);
    expect(
      preserveQueuedThreadDeliveryHold(held, {
        ...identity,
        commandId: CommandId.make("command-explicit-retry"),
      }),
    ).toBeUndefined();
    expect(preserveQueuedThreadDeliveryHold(null, identity)).toBeUndefined();
  });

  it("mints a fresh admission request when a held send is retried", () => {
    const original = {
      ...queuedMessage({
        messageId: "message-held-retry",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      text: "preserve me",
      deliveryHold: {
        kind: "admission-rejected" as const,
        reason: "PreviouslyRejected",
      },
    };
    const retried = retryQueuedThreadMessage(original, {
      commandId: CommandId.make("command-held-retry-fresh"),
      createdAt: "2026-06-08T10:00:02.000Z",
    });

    expect(retried).toMatchObject({
      messageId: original.messageId,
      commandId: CommandId.make("command-held-retry-fresh"),
      text: "preserve me",
      createdAt: "2026-06-08T10:00:02.000Z",
    });
    expect(retried.commandId).not.toBe(original.commandId);
    expect(retried.deliveryHold).toBeUndefined();
  });

  it("compares model options as part of the queued settings change", () => {
    const base = {
      instanceId: ProviderInstanceId.make("codex"),
      model: "gpt-5.4",
      options: [{ id: "reasoningEffort", value: "medium" }],
    } as const;

    expect(modelSelectionsEqual(base, base)).toBe(true);
    expect(
      modelSelectionsEqual(base, {
        ...base,
        options: [{ id: "reasoningEffort", value: "xhigh" }],
      }),
    ).toBe(false);
  });

  it("backs off queued delivery retries and caps them at sixteen seconds", () => {
    expect([1, 2, 3, 4, 5, 6].map(threadOutboxRetryDelayMs)).toEqual([
      1_000, 2_000, 4_000, 8_000, 16_000, 16_000,
    ]);
  });

  it("serializes mutations even when an earlier mutation is slower", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = manager.serialize(async () => {
      order.push("first:start");
      await firstBlocked;
      order.push("first:end");
    });
    const second = manager.serialize(async () => {
      order.push("second");
    });

    await Promise.resolve();
    expect(order).toEqual(["first:start"]);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(["first:start", "first:end", "second"]);
    registry.dispose();
  });

  it("holds the mutation queue while persisted messages are loading", async () => {
    const registry = AtomRegistry.make();
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const stored = new Map([[message.messageId, message]]);
    let loadCalls = 0;
    let removeCalls = 0;
    let releaseInitialLoad!: () => void;
    const initialLoadBlocked = new Promise<void>((resolve) => {
      releaseInitialLoad = resolve;
    });
    const storage: ThreadOutboxStorage = {
      load: async () => {
        loadCalls += 1;
        if (loadCalls === 1) {
          await initialLoadBlocked;
        }
        return [...stored.values()];
      },
      write: async () => undefined,
      remove: async (candidate) => {
        removeCalls += 1;
        stored.delete(candidate.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });

    const loading = manager.load();
    await Promise.resolve();
    const clearing = manager.clearEnvironment(message.environmentId);
    await Promise.resolve();
    await Promise.resolve();

    expect(loadCalls).toBe(1);
    expect(removeCalls).toBe(0);

    releaseInitialLoad();
    await Promise.all([loading, clearing]);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("reports structured load failures and permits a retry", async () => {
    const registry = AtomRegistry.make();
    const loadCause = new Error("storage unavailable");
    const warnings: Array<{ message: string; error: unknown }> = [];
    let loadCalls = 0;
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => {
          loadCalls += 1;
          if (loadCalls === 1) throw loadCause;
          return [];
        },
        write: async () => undefined,
        remove: async () => undefined,
      },
      warn: (message, error) => warnings.push({ message, error }),
    });

    await manager.load();
    expect(warnings).toEqual([
      {
        message: "[thread-outbox] failed to load persisted messages",
        error: new ThreadOutboxManagerError({
          operation: "load",
          environmentId: null,
          threadId: null,
          messageId: null,
          cause: loadCause,
        }),
      },
    ]);

    await manager.load();
    expect(loadCalls).toBe(2);
    registry.dispose();
  });

  it("keeps atom state aligned with durable writes and removals", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const removalCause = new Error("remove failed");
    let failRemoval = true;
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        if (failRemoval) {
          throw removalCause;
        }
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    await expect(manager.remove(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "remove",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: removalCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    failRemoval = false;
    await manager.remove(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("publishes an enqueued message before the durable write resolves", async () => {
    const registry = AtomRegistry.make();
    let releaseWrite!: () => void;
    const writeBlocked = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => writeBlocked,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    const enqueueing = manager.enqueue(message);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });

    releaseWrite();
    await enqueueing;
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [message],
    });
    registry.dispose();
  });

  it("rolls an enqueued message back out when the durable write fails", async () => {
    const registry = AtomRegistry.make();
    const writeCause = new Error("disk full");
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          throw writeCause;
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await expect(manager.enqueue(message)).rejects.toEqual(
      new ThreadOutboxManagerError({
        operation: "enqueue",
        environmentId: message.environmentId,
        threadId: message.threadId,
        messageId: message.messageId,
        cause: writeCause,
      }),
    );
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    registry.dispose();
  });

  it("keeps a same-id retry queued when the first attempt's write fails", async () => {
    const registry = AtomRegistry.make();
    let failNextWrite = true;
    let releaseFirstWrite!: () => void;
    const firstWriteBlocked = new Promise<void>((resolve) => {
      releaseFirstWrite = resolve;
    });
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => {
          if (failNextWrite) {
            failNextWrite = false;
            await firstWriteBlocked;
            throw new Error("disk full");
          }
        },
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    const first = manager.enqueue(message);
    const second = manager.enqueue(retried);
    releaseFirstWrite();
    await expect(first).rejects.toBeInstanceOf(ThreadOutboxManagerError);
    await second;

    // The failed first attempt must not roll back the retry that replaced it.
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    await expect(manager.confirmQueued(retried)).resolves.toBe(true);
    await expect(manager.confirmQueued(message)).resolves.toBe(false);
    registry.dispose();
  });

  it("replaces an existing message when an enqueue retry uses the same id", async () => {
    const registry = AtomRegistry.make();
    const manager = createThreadOutboxManager({
      registry,
      storage: {
        load: async () => [],
        write: async () => undefined,
        remove: async () => undefined,
      },
    });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const retried = { ...message, text: "retried" };

    await manager.enqueue(message);
    await manager.enqueue(retried);

    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [retried],
    });
    registry.dispose();
  });

  it("updates a queued message in place but never resurrects a removed one", async () => {
    const registry = AtomRegistry.make();
    const stored = new Map<MessageId, QueuedThreadMessage>();
    const storage: ThreadOutboxStorage = {
      load: async () => [...stored.values()],
      write: async (message) => {
        stored.set(message.messageId, message);
      },
      remove: async (message) => {
        stored.delete(message.messageId);
      },
    };
    const manager = createThreadOutboxManager({ registry, storage });
    const message = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });

    await manager.enqueue(message);
    const edited = { ...message, text: "edited" };
    await expect(manager.update(edited)).resolves.toBe(true);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({
      "environment-1:thread-1": [edited],
    });
    expect(stored.get(message.messageId)).toEqual(edited);

    await manager.remove(edited);
    await expect(manager.update({ ...message, text: "stale flush" })).resolves.toBe(false);
    expect(registry.get(manager.queuedMessagesByThreadKeyAtom)).toEqual({});
    expect(stored.size).toBe(0);
    registry.dispose();
  });

  it("only confirms a missing-thread message after shell synchronization is live", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadStatus: null,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus: null,
      }),
    ).toBe("confirm");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus: null,
      }),
    ).toBe("send");
  });

  it("waits for starting admission but lets running sessions steer", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus: "starting",
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus: "running",
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: false,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: false,
        threadStatus: "running",
      }),
    ).toBe("wait");
  });

  it("recomputes every live authority after durable confirmation", () => {
    const message = queuedMessage({
      messageId: "message-post-confirm-existing",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const thread = {
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      runtimeMode: "full-access" as const,
      interactionMode: "default" as const,
      session: { status: "ready" as const },
    };
    const destination = {
      projectId: ProjectId.make("project-post-confirm"),
      projectTitle: "Project",
      projectCwd: "/workspace/current",
      workspaceMode: "local" as const,
      branch: null,
      worktreePath: null,
    };
    const base = {
      message: { ...message, destination },
      thread,
      shellStatus: "live" as const,
      environmentConnected: true,
      providers: [provider({ instanceId: "codex", status: "warning" })],
      project: null,
    };

    expect(resolveConfirmedThreadOutboxPlan(base).action).toBe("send-existing");
    expect(resolveConfirmedThreadOutboxPlan({ ...base, environmentConnected: false }).action).toBe(
      "wait",
    );
    expect(
      resolveConfirmedThreadOutboxPlan({
        ...base,
        thread: { ...thread, session: { status: "starting" } },
      }).action,
    ).toBe("wait");
    expect(resolveConfirmedThreadOutboxPlan({ ...base, thread: undefined })).toMatchObject({
      action: "hold",
      hold: { kind: "thread-missing" },
      creation: destination,
    });
    expect(resolveConfirmedThreadOutboxPlan({ ...base, providers: undefined }).action).toBe("wait");

    const creationMessage = {
      ...message,
      modelSelection: thread.modelSelection,
      creation: {
        projectId: ProjectId.make("project-post-confirm"),
        workspaceMode: "local" as const,
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
      },
    };
    const creationBase = {
      ...base,
      message: creationMessage,
      thread: undefined,
      project: { workspaceRoot: "/workspace/current" },
    };
    expect(resolveConfirmedThreadOutboxPlan(creationBase)).toMatchObject({
      action: "send-creation",
      projectCwd: "/workspace/current",
    });
    expect(resolveConfirmedThreadOutboxPlan({ ...creationBase, project: undefined })).toMatchObject(
      { action: "hold", hold: { kind: "project-workspace-unavailable" } },
    );
    expect(resolveConfirmedThreadOutboxPlan({ ...creationBase, providers: undefined }).action).toBe(
      "wait",
    );
  });

  it("quiesces after a cross-device delete is converted to a durable hold", () => {
    const destination = {
      projectId: ProjectId.make("project-cross-device-delete"),
      projectTitle: "Cross-device project",
      projectCwd: "/workspace/cross-device",
      workspaceMode: "local" as const,
      branch: null,
      worktreePath: null,
    };
    const message = {
      ...queuedMessage({
        messageId: "message-cross-device-delete",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      destination,
    };
    const confirmed = resolveConfirmedThreadOutboxPlan({
      message,
      thread: undefined,
      shellStatus: "live",
      environmentConnected: true,
      providers: [provider({ instanceId: "codex", status: "ready" })],
      project: null,
    });
    expect(confirmed).toMatchObject({
      action: "hold",
      hold: { kind: "thread-missing" },
      creation: destination,
    });
    if (confirmed.action !== "hold" || confirmed.creation === undefined) {
      throw new Error("Expected retargetable missing-thread hold");
    }
    const held = {
      ...message,
      deliveryHold: confirmed.hold,
      creation: confirmed.creation,
    };

    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus: null,
        hasDeliveryHold: true,
      }),
    ).toBe("wait");
    expect(
      resolveConfirmedThreadOutboxPlan({
        message: held,
        thread: undefined,
        shellStatus: "live",
        environmentConnected: true,
        providers: [provider({ instanceId: "codex", status: "ready" })],
        project: { workspaceRoot: "/workspace/cross-device" },
      }),
    ).toEqual({ action: "wait" });
  });

  it("turns a live missing project workspace into a durable creation hold", () => {
    const message = {
      ...queuedMessage({
        messageId: "message-missing-project",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      creation: {
        projectId: ProjectId.make("project-missing"),
        workspaceMode: "local" as const,
        branch: null,
        worktreePath: null,
        startFromOrigin: false,
      },
    };

    expect(
      queuedCreationWorkspaceHold({ message, project: undefined, shellStatus: "cached" }),
    ).toBe(null);
    expect(
      queuedCreationWorkspaceHold({ message, project: undefined, shellStatus: "live" }),
    ).toMatchObject({ kind: "project-workspace-unavailable" });
    expect(
      queuedCreationWorkspaceHold({
        message,
        project: { workspaceRoot: "/workspace/retargeted" },
        shellStatus: "live",
      }),
    ).toBe(null);
  });

  it("sends queued creations once connected and live, removing already-created ones", () => {
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "cached",
        environmentConnected: false,
        threadStatus: null,
      }),
    ).toBe("wait");
    // Connected but not yet synchronized: a previously delivered creation may
    // simply not be visible yet — sending now could duplicate the thread.
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "synchronizing",
        environmentConnected: true,
        threadStatus: null,
      }),
    ).toBe("wait");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: false,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus: null,
      }),
    ).toBe("send");
    expect(
      resolveThreadOutboxDeliveryAction({
        isCreation: true,
        threadExists: true,
        shellStatus: "live",
        environmentConnected: true,
        threadStatus: "running",
      }),
    ).toBe("remove");
  });

  it("round-trips queued creations and gates incomplete ones from sending", () => {
    const base = queuedMessage({
      messageId: "message-1",
      createdAt: "2026-06-08T10:00:01.000Z",
    });
    const creationMessage = {
      ...base,
      modelSelection: {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-5.4",
      },
      creation: {
        projectId: ProjectId.make("project-1"),
        workspaceMode: "worktree",
        branch: "main",
        worktreePath: null,
        startFromOrigin: true,
      },
    } satisfies QueuedThreadMessage;

    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(creationMessage))).toEqual(
      creationMessage,
    );
    expect(isQueuedThreadCreationSendable(creationMessage)).toBe(true);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: null },
      }),
    ).toBe(false);
    expect(
      isQueuedThreadCreationSendable({
        ...creationMessage,
        creation: { ...creationMessage.creation, branch: "" },
      }),
    ).toBe(false);
    expect(isQueuedThreadCreationSendable({ ...creationMessage, modelSelection: undefined })).toBe(
      false,
    );
    expect(isQueuedThreadCreationSendable(base)).toBe(false);
  });

  it("retries transport failures but drops deterministic command failures", () => {
    expect(shouldRetryThreadOutboxDelivery(new Error("Socket is not connected"))).toBe(true);
    expect(
      shouldRetryThreadOutboxDelivery({
        _tag: "ConnectionTransientError",
        message: "temporarily unavailable",
      }),
    ).toBe(true);
    expect(shouldRetryThreadOutboxDelivery(new Error("Thread no longer exists"))).toBe(false);
  });

  it("holds every domain failure before acceptance without losing content", () => {
    const deterministicFailure = new Error("Thread already has pending turn admission");

    expect(
      resolveThreadOutboxFailureAction({
        stage: "settings-sync",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("hold");
    expect(
      resolveThreadOutboxFailureAction({
        stage: "start-turn",
        error: deterministicFailure,
        interrupted: false,
      }),
    ).toBe("hold");

    const message = {
      ...queuedMessage({
        messageId: "message-admission-rejected",
        createdAt: "2026-06-08T10:00:01.000Z",
      }),
      text: "keep this pending prose",
      attachments: [
        {
          id: "image-1",
          previewUri: "file:///preview.png",
          type: "image" as const,
          name: "preview.png",
          mimeType: "image/png",
          sizeBytes: 4,
          dataUrl: "data:image/png;base64,AAAA",
        },
      ],
      deliveryHold: {
        kind: "admission-rejected" as const,
        reason: deterministicFailure.message,
      },
    };
    expect(decodeQueuedThreadMessage(encodeQueuedThreadMessage(message))).toEqual(message);
  });
});
