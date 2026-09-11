import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const fixture = vi.hoisted(() => ({
  questionAttachments: true,
  onPaste: undefined as ((payload: { type: "images"; uris: Array<string> }) => void) | undefined,
}));
vi.mock("react-native", () => ({ Alert: { alert: vi.fn() }, View: "div" }));
vi.mock("expo-paste-input", () => ({
  TextInputWrapper: (props: { onPaste: typeof fixture.onPaste; children: ReactNode }) => {
    fixture.onPaste = props.onPaste;
    return props.children;
  },
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => ({}) }));
vi.mock("../../components/AppText", () => ({ AppTextInput: "input" }));
vi.mock("../../components/ComposerAttachmentButton", () => ({
  ComposerAttachmentButton: () => null,
}));
vi.mock("../../components/ComposerAttachmentStrip", () => ({
  ComposerAttachmentStrip: () => null,
}));
vi.mock("../../lib/composerImages", () => ({
  convertPastedImagesToAttachments: vi.fn(async () => []),
  pickComposerFiles: vi.fn(),
  pickComposerMedia: vi.fn(),
}));
vi.mock("../../state/atom-registry", () => ({
  appAtomRegistry: { get: () => ({}), set: vi.fn() },
}));
vi.mock("../../state/use-composer-drafts", () => ({
  appendComposerDraftAttachments: vi.fn(),
  composerDraftsAtom: "drafts",
  removeComposerDraftAttachment: vi.fn(),
  releaseUnusedComposerAttachmentFiles: vi.fn(),
}));
vi.mock("../../state/use-thread-selection", () => ({
  useThreadSelection: () => ({
    selectedThread: { environmentId: "environment-1", id: "thread-1" },
  }),
}));
vi.mock("../../state/entities", () => ({
  useServerConfigs: () =>
    new Map([
      [
        "environment-1",
        { environment: { capabilities: { questionAttachments: fixture.questionAttachments } } },
      ],
    ]),
}));

import { ApprovalRequestId } from "@t3tools/contracts";
import { Alert } from "react-native";
import { convertPastedImagesToAttachments } from "../../lib/composerImages";
import { QuestionAttachments } from "./QuestionAttachments";

function pasteImage() {
  const question = {
    id: "question-1",
    header: "Screenshot",
    question: "Show the error",
    options: [],
    allowCustomAnswer: true,
  };
  renderToStaticMarkup(
    <QuestionAttachments
      requestId={ApprovalRequestId.make("request-1")}
      question={question}
      questions={[question]}
      disabled={false}
      value=""
      onChangeText={() => {}}
    />,
  );
  fixture.onPaste?.({ type: "images", uris: ["file:///pasted.png"] });
}

beforeEach(() => {
  vi.mocked(Alert.alert).mockClear();
  vi.mocked(convertPastedImagesToAttachments).mockClear();
  fixture.onPaste = undefined;
});

describe("QuestionAttachments paste", () => {
  it("tells the user to update a server without question attachments", () => {
    fixture.questionAttachments = false;
    pasteImage();
    expect(Alert.alert).toHaveBeenCalledWith(
      "Could not paste image",
      "Update this server to send files with question answers.",
    );
    expect(convertPastedImagesToAttachments).not.toHaveBeenCalled();
  });

  it("stages the image when the server supports question attachments", () => {
    fixture.questionAttachments = true;
    pasteImage();
    expect(Alert.alert).not.toHaveBeenCalled();
    expect(convertPastedImagesToAttachments).toHaveBeenCalledOnce();
  });
});
