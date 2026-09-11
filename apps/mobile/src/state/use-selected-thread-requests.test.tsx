import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  drafts: {} as Record<string, unknown>,
  uploads: {} as Record<string, unknown>,
  preparations: {} as Record<string, number>,
  preparationAtom: Symbol("preparation"),
  threadStatus: "live",
  questionPending: true,
  effects: [] as Array<() => void>,
}));
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  // Server rendering skips effects; collect them and run them after the render.
  useEffect: (effect: () => void) => {
    fixture.effects.push(effect);
  },
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() } }));
vi.mock("./atom-registry", () => ({
  appAtomRegistry: {
    get: (atom: unknown) => (atom === fixture.preparationAtom ? fixture.preparations : {}),
    set: vi.fn(),
  },
}));
vi.mock("@effect/atom-react", () => ({
  useAtomValue: (atom: unknown) =>
    atom === "drafts"
      ? fixture.drafts
      : atom === "uploads"
        ? fixture.uploads
        : atom === fixture.preparationAtom
          ? fixture.preparations
          : {},
}));
vi.mock("./use-composer-drafts", () => ({
  composerDraftsAtom: "drafts",
  clearComposerDraft: vi.fn(),
}));
vi.mock("./composer-attachment-uploads", async () => ({
  ...(await import("../lib/composerAttachmentUploadQueue")),
  composerAttachmentUploadsAtom: "uploads",
}));
vi.mock("./question-attachments", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./question-attachments")>()),
  questionAttachmentPreparationAtom: fixture.preparationAtom,
}));
vi.mock("./entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        {
          environment: {
            capabilities: {
              questionAttachments: true,
              attachmentUploads: true,
              fileAttachments: { maxUploadBytes: 20_000_000 },
            },
          },
        },
      ],
    ]),
}));
vi.mock("./threads", () => ({ threadEnvironment: {} }));
vi.mock("./use-atom-command", () => ({ useAtomCommand: () => vi.fn() }));
vi.mock("./use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
  }),
}));
vi.mock("./use-thread-detail", async () => {
  const Option = await import("effect/Option");
  return {
    useSelectedThreadDetailState: () => ({
      status: fixture.threadStatus,
      data: Option.some({
        activities: fixture.questionPending
          ? [
              {
                id: "request-activity",
                kind: "user-input.requested",
                createdAt: "2026-09-08T00:00:00Z",
                payload: {
                  requestId: "request-1",
                  questions: ["first", "second"].map((id) => ({
                    id,
                    header: id,
                    question: `Attach ${id} file`,
                    options: [],
                    allowCustomAnswer: true,
                  })),
                },
              },
            ]
          : [],
      }),
    }),
  };
});

import { ApprovalRequestId, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { questionAttachmentDraftKey } from "./question-attachments";
import { clearComposerDraft } from "./use-composer-drafts";
import { useSelectedThreadRequests } from "./use-selected-thread-requests";

const environmentId = EnvironmentId.make("environment-1");
const key = (question: string) =>
  questionAttachmentDraftKey(
    environmentId,
    ThreadId.make("thread-1"),
    ApprovalRequestId.make("request-1"),
    question,
  );
function submitButtonMarkup() {
  function Probe() {
    const { activePendingUserInputAnswers } = useSelectedThreadRequests();
    return <button disabled={activePendingUserInputAnswers === null}>Submit answers</button>;
  }
  const markup = renderToStaticMarkup(<Probe />);
  for (const effect of fixture.effects.splice(0)) effect();
  return markup;
}
beforeEach(() => {
  vi.mocked(clearComposerDraft).mockClear();
  fixture.threadStatus = "live";
  fixture.questionPending = true;
  fixture.preparations = {};
  fixture.drafts = Object.fromEntries(
    ["first", "second"].map((id) => [
      key(id),
      {
        attachments: [
          {
            id,
            type: "file",
            name: `${id}.txt`,
            mimeType: "text/plain",
            sizeBytes: 4,
            fileUri: `file:///${id}.txt`,
          },
        ],
      },
    ]),
  );
  fixture.uploads = { "environment-1:first": { status: "ready" } };
});
describe("question attachment submission readiness", () => {
  it.each([
    undefined,
    { status: "uploading", progress: 0.5 },
    { status: "failed", reason: "Offline" },
  ])("keeps Submit disabled until all question uploads finish: %j", (state) => {
    if (state) fixture.uploads["environment-1:second"] = state;
    expect(submitButtonMarkup()).toContain("disabled");
    fixture.uploads["environment-1:second"] = { status: "ready" };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("ignores an upload in another environment", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.uploads["environment-2:second"] = { status: "uploading", progress: 0.5 };
    expect(submitButtonMarkup()).not.toContain("disabled");
  });
  it("waits for attachment preparation even when uploads are ready", () => {
    fixture.uploads["environment-1:second"] = { status: "ready" };
    fixture.preparations[key("first")] = 1;
    expect(submitButtonMarkup()).toContain("disabled");
  });
});
describe("question attachment draft cleanup", () => {
  it.each(["cached", "synchronizing"])(
    "keeps drafts while a %s snapshot does not show the question yet",
    (status) => {
      fixture.threadStatus = status;
      fixture.questionPending = false;
      submitButtonMarkup();
      expect(clearComposerDraft).not.toHaveBeenCalled();
    },
  );
  it("keeps drafts for a question that is still pending", () => {
    submitButtonMarkup();
    expect(clearComposerDraft).not.toHaveBeenCalled();
  });
  it("discards drafts once live data shows the question resolved", () => {
    fixture.questionPending = false;
    submitButtonMarkup();
    expect(vi.mocked(clearComposerDraft).mock.calls).toEqual([[key("first")], [key("second")]]);
  });
});
