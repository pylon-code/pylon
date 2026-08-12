import {
  PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS,
  ProviderSessionSideQuestionRequestId,
  type ProviderAskSessionSideQuestionResult,
} from "@t3tools/contracts";
import * as Clipboard from "expo-clipboard";
import { useCallback, useEffect, useRef, useState } from "react";
import { KeyboardAvoidingView, Modal, Platform, Pressable, ScrollView, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { ComposerToolbarButton } from "../../components/ComposerToolbar";
import { uuidv4 } from "../../lib/uuid";
import {
  beginQuickQuestion,
  initialQuickQuestionState,
  resetQuickQuestion,
  settleQuickQuestion,
  updateQuickQuestionDraft,
} from "./quickQuestionState";
import { QUICK_QUESTION_LABEL, QUICK_QUESTION_TEST_ID } from "./quickQuestionToolbar";

export function QuickQuestionTrigger({ onPress }: { readonly onPress: () => void }) {
  return (
    <ComposerToolbarButton
      accessibilityLabel={QUICK_QUESTION_LABEL}
      icon="questionmark.circle"
      label={QUICK_QUESTION_LABEL}
      onPress={onPress}
      showChevron={false}
      testID={QUICK_QUESTION_TEST_ID}
    />
  );
}

type PendingQuestion = {
  readonly requestId: ProviderSessionSideQuestionRequestId;
  readonly cancel: (requestId: ProviderSessionSideQuestionRequestId) => Promise<void>;
  cancelRequested: boolean;
};

export interface QuickQuestionModalProps {
  readonly scopeKey: string;
  readonly visible: boolean;
  readonly onAsk: (
    requestId: ProviderSessionSideQuestionRequestId,
    question: string,
  ) => Promise<ProviderAskSessionSideQuestionResult | null>;
  readonly onCancel: (requestId: ProviderSessionSideQuestionRequestId) => Promise<void>;
  readonly onDismiss: () => void;
}

export function QuickQuestionModal(props: QuickQuestionModalProps) {
  const [state, setState] = useState(() => initialQuickQuestionState(props.scopeKey));
  const pendingRef = useRef<PendingQuestion | null>(null);

  const cancelPendingOnce = useCallback(() => {
    const pending = pendingRef.current;
    if (pending === null || pending.cancelRequested) return;
    pending.cancelRequested = true;
    pendingRef.current = null;
    void pending.cancel(pending.requestId).catch(() => {
      // Closing is local and final. Never surface transport payloads or retry on reconnect.
    });
  }, []);

  useEffect(() => {
    if (props.visible) return;
    cancelPendingOnce();
    setState((current) => resetQuickQuestion(current, props.scopeKey).state);
  }, [cancelPendingOnce, props.scopeKey, props.visible]);

  useEffect(
    () => () => {
      cancelPendingOnce();
    },
    [cancelPendingOnce],
  );

  const dismiss = useCallback(() => {
    cancelPendingOnce();
    props.onDismiss();
  }, [cancelPendingOnce, props.onDismiss]);

  const submit = useCallback(async () => {
    const question = state.draft.trim();
    if (state.phase !== "draft" || pendingRef.current !== null) return;
    if (question.length === 0) {
      setState((current) => ({ ...current, statusText: "Enter a question." }));
      return;
    }

    const requestId = ProviderSessionSideQuestionRequestId.make(uuidv4());
    const pending: PendingQuestion = {
      requestId,
      cancel: props.onCancel,
      cancelRequested: false,
    };
    pendingRef.current = pending;
    setState((current) => beginQuickQuestion(current, requestId));

    let result: ProviderAskSessionSideQuestionResult | null = null;
    try {
      result = await props.onAsk(requestId, question);
    } catch {
      result = null;
    }

    if (pendingRef.current !== pending || pending.cancelRequested) return;
    pendingRef.current = null;
    setState((current) => settleQuickQuestion(current, requestId, result));
  }, [props.onAsk, props.onCancel, state.draft, state.phase]);

  const copyAnswer = useCallback(async () => {
    try {
      await Clipboard.setStringAsync(state.answer);
      setState((current) => ({ ...current, statusText: "Answer copied." }));
    } catch {
      setState((current) => ({ ...current, statusText: "The answer could not be copied." }));
    }
  }, [state.answer]);

  const submitDisabled = state.phase !== "draft" || state.draft.trim().length === 0;

  return (
    <Modal visible={props.visible} transparent animationType="fade" onRequestClose={dismiss}>
      <KeyboardAvoidingView
        behavior={Platform.OS === "ios" ? "padding" : undefined}
        className="flex-1 justify-end"
      >
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Dismiss Quick question"
          className="absolute inset-0 bg-black/50"
          onPress={dismiss}
        />
        <View className="max-h-[85%] rounded-t-[28px] border-t border-border bg-sheet px-5 pb-8 pt-5">
          <View className="mb-4 flex-row items-start justify-between gap-4">
            <View className="min-w-0 flex-1">
              <Text className="text-lg font-t3-bold text-foreground">{QUICK_QUESTION_LABEL}</Text>
              <Text className="mt-1 text-sm leading-5 text-foreground-muted">
                The answer is temporary and won’t be added to this thread. It may incur provider
                usage. Available only in approval-required sessions.
              </Text>
            </View>
            {state.phase === "pending" ? null : (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Dismiss Quick question"
                onPress={dismiss}
                className="h-11 items-center justify-center px-2"
              >
                <Text className="font-t3-bold text-foreground-muted">Dismiss</Text>
              </Pressable>
            )}
          </View>

          {state.phase === "answer" ? (
            <>
              <Text className="mb-2 text-xs font-t3-bold uppercase tracking-wide text-foreground-muted">
                Temporary answer
              </Text>
              <ScrollView
                accessibilityLabel="Quick question answer"
                accessibilityLiveRegion="polite"
                className="max-h-72 rounded-[20px] bg-subtle px-4 py-3.5"
                testID="quick-question-answer"
              >
                <Text selectable className="text-sm leading-6 text-foreground">
                  {state.answer}
                </Text>
              </ScrollView>
              <Text
                accessibilityLiveRegion="polite"
                className="mt-2 min-h-5 text-xs text-foreground-muted"
              >
                {state.statusText}
              </Text>
              <View className="mt-3 flex-row gap-3">
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Copy Quick question answer"
                  onPress={() => void copyAnswer()}
                  className="h-12 flex-1 items-center justify-center rounded-full bg-subtle-strong"
                >
                  <Text className="font-t3-bold text-foreground">Copy</Text>
                </Pressable>
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Dismiss Quick question answer"
                  onPress={dismiss}
                  className="h-12 flex-1 items-center justify-center rounded-full bg-primary"
                >
                  <Text className="font-t3-bold text-primary-foreground">Dismiss</Text>
                </Pressable>
              </View>
            </>
          ) : state.phase === "pending" ? (
            <View accessibilityLiveRegion="polite" className="items-center py-6">
              <Text className="text-sm text-foreground">Waiting for a temporary answer…</Text>
              <Text className="mt-1 text-xs text-foreground-muted">
                This is not added to the thread.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel Quick question"
                onPress={dismiss}
                className="mt-5 h-12 min-w-40 items-center justify-center rounded-full bg-subtle-strong px-5"
                testID="quick-question-cancel"
              >
                <Text className="font-t3-bold text-foreground">Cancel</Text>
              </Pressable>
            </View>
          ) : (
            <>
              <TextInput
                accessibilityLabel="Quick question input"
                autoFocus
                multiline
                textAlignVertical="top"
                maxLength={PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS}
                value={state.draft}
                onChangeText={(value) => {
                  setState((current) => updateQuickQuestionDraft(current, value));
                }}
                placeholder="Ask something without adding it to the thread"
                className="h-36 rounded-[20px] px-4 py-3.5"
                testID="quick-question-input"
              />
              <View className="mt-2 flex-row items-start justify-between gap-3">
                <Text
                  accessibilityRole={state.statusText ? "alert" : undefined}
                  className="min-w-0 flex-1 text-xs text-danger"
                >
                  {state.statusText}
                </Text>
                <Text className="text-xs tabular-nums text-foreground-muted">
                  {state.draft.length.toLocaleString()} /{" "}
                  {PROVIDER_SESSION_SIDE_QUESTION_MAX_CHARS.toLocaleString()}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Submit Quick question"
                accessibilityState={{ disabled: submitDisabled }}
                disabled={submitDisabled}
                onPress={() => void submit()}
                className="mt-4 h-12 items-center justify-center rounded-full bg-primary disabled:bg-subtle-strong"
                testID="quick-question-submit"
              >
                <Text className="font-t3-bold text-primary-foreground">Ask</Text>
              </Pressable>
            </>
          )}
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}
