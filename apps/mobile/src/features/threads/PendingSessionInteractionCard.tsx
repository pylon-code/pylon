import {
  SESSION_INTERACTION_CONTENT_MAX_CHARS,
  type SessionInteractionRequestId,
  type SessionInteractionResponse,
} from "@t3tools/contracts";
import { useEffect, useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, useWindowDimensions, View } from "react-native";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import type { PendingSessionInteraction } from "../../lib/sessionInteractions";
import {
  cancelledInteractionResponse,
  clampSessionInteractionDraft,
  confirmedInteractionResponse,
  selectedInteractionResponse,
  selectInteractionOptionKey,
  sessionInteractionCardModel,
  submittedInteractionResponse,
} from "./sessionInteractionCard.logic";

export interface PendingSessionInteractionCardProps {
  readonly interaction: PendingSessionInteraction;
  readonly submitting: boolean;
  readonly error: string | null;
  readonly canRetry: boolean;
  readonly onRespond: (
    requestId: SessionInteractionRequestId,
    response: SessionInteractionResponse,
  ) => Promise<unknown>;
  readonly onRetry: () => Promise<unknown>;
}

function ActionButton(props: {
  readonly accessibilityLabel: string;
  readonly disabled: boolean;
  readonly label: string;
  readonly tone?: "primary" | "neutral" | "danger";
  readonly onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityLabel={props.accessibilityLabel}
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className={cn(
        "min-h-11 items-center justify-center rounded-[14px] px-3.5 py-2.5",
        props.tone === "primary"
          ? "bg-blue-500"
          : props.tone === "danger"
            ? "bg-rose-100 dark:bg-rose-500/18"
            : "bg-neutral-200 dark:bg-neutral-800",
        props.disabled ? "opacity-50" : "active:opacity-70",
      )}
      disabled={props.disabled}
      onPress={props.onPress}
    >
      <Text
        className={cn(
          "font-t3-bold text-sm",
          props.tone === "primary"
            ? "text-white"
            : props.tone === "danger"
              ? "text-rose-700 dark:text-rose-300"
              : "text-neutral-950 dark:text-neutral-50",
        )}
      >
        {props.label}
      </Text>
    </Pressable>
  );
}

export function PendingSessionInteractionCard(props: PendingSessionInteractionCardProps) {
  const model = useMemo(
    () => sessionInteractionCardModel(props.interaction.request),
    [props.interaction.request],
  );
  const [draft, setDraft] = useState(() =>
    model.kind === "input" || model.kind === "editor" ? model.initialValue : "",
  );
  const { height: windowHeight } = useWindowDimensions();
  const requestId = props.interaction.requestId;

  useEffect(() => {
    setDraft(model.kind === "input" || model.kind === "editor" ? model.initialValue : "");
  }, [model, requestId]);

  const respond = (response: SessionInteractionResponse) => {
    void props.onRespond(requestId, response);
  };
  const submitDraft = () => respond(submittedInteractionResponse(draft));

  return (
    <View className="gap-2.5 rounded-[20px] border border-neutral-200 bg-neutral-100 p-4 dark:border-white/6 dark:bg-neutral-900">
      <View className="flex-row items-center justify-between gap-3">
        <Text className="font-t3-bold text-2xs uppercase tracking-[1.1px] text-sky-700 dark:text-sky-300">
          Input needed
        </Text>
        {props.submitting ? (
          <ActivityIndicator accessibilityLabel="Sending response" size="small" />
        ) : null}
      </View>
      <Text className="font-t3-bold text-lg text-neutral-950 dark:text-neutral-50">
        {model.title}
      </Text>

      <ScrollView
        bounces={false}
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
        nestedScrollEnabled
        showsVerticalScrollIndicator
        style={{ maxHeight: Math.max(160, Math.min(360, windowHeight * 0.45)) }}
      >
        <View className="gap-2.5 pr-1">
          {model.kind === "select" ? (
            model.options.map((option, index) => (
              <ActionButton
                key={selectInteractionOptionKey(model.options, index)}
                accessibilityLabel={`Select ${option}`}
                disabled={props.submitting}
                label={option}
                onPress={() => respond(selectedInteractionResponse(option))}
              />
            ))
          ) : model.kind === "confirm" ? (
            <>
              {model.message ? (
                <Text className="font-sans text-sm leading-normal text-neutral-600 dark:text-neutral-300">
                  {model.message}
                </Text>
              ) : null}
              <View className="flex-row gap-2.5">
                <View className="flex-1">
                  <ActionButton
                    accessibilityLabel="Yes"
                    disabled={props.submitting}
                    label="Yes"
                    tone="primary"
                    onPress={() => respond(confirmedInteractionResponse(true))}
                  />
                </View>
                <View className="flex-1">
                  <ActionButton
                    accessibilityLabel="No"
                    disabled={props.submitting}
                    label="No"
                    onPress={() => respond(confirmedInteractionResponse(false))}
                  />
                </View>
              </View>
            </>
          ) : (
            <>
              <TextInput
                accessibilityLabel={model.kind === "editor" ? "Editor response" : "Input response"}
                autoCapitalize="sentences"
                blurOnSubmit={!model.multiline}
                className={cn(
                  "rounded-2xl border border-neutral-200 bg-white px-3.5 py-3 font-sans text-base text-neutral-950 dark:border-white/8 dark:bg-neutral-950/70 dark:text-neutral-50",
                  model.multiline ? "min-h-[132px]" : "min-h-[52px]",
                )}
                editable={!props.submitting}
                maxLength={SESSION_INTERACTION_CONTENT_MAX_CHARS}
                multiline={model.multiline}
                onChangeText={(value) => setDraft(clampSessionInteractionDraft(value))}
                onSubmitEditing={model.multiline ? undefined : submitDraft}
                placeholder={model.placeholder ?? undefined}
                returnKeyType={model.multiline ? "default" : "done"}
                scrollEnabled={model.multiline}
                textAlignVertical={model.multiline ? "top" : "center"}
                value={draft}
              />
              <ActionButton
                accessibilityLabel="Submit response"
                disabled={props.submitting}
                label="Submit"
                tone="primary"
                onPress={submitDraft}
              />
            </>
          )}
        </View>
      </ScrollView>

      {props.error ? (
        <View
          accessibilityRole="alert"
          className="gap-2 rounded-xl bg-rose-100 p-3 dark:bg-rose-500/18"
        >
          <Text className="font-sans text-sm text-rose-800 dark:text-rose-200">{props.error}</Text>
          {props.canRetry ? (
            <ActionButton
              accessibilityLabel="Retry response"
              disabled={props.submitting}
              label="Retry"
              tone="danger"
              onPress={() => void props.onRetry()}
            />
          ) : null}
        </View>
      ) : null}

      <ActionButton
        accessibilityLabel="Cancel interaction"
        disabled={props.submitting}
        label="Cancel"
        onPress={() => respond(cancelledInteractionResponse())}
      />
    </View>
  );
}
