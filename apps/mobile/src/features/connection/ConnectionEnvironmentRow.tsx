import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { SymbolView } from "../../components/AppSymbol";
import { connectionStatusText } from "@t3tools/client-runtime/connection";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useAtomValue } from "@effect/atom-react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerPrimeManagedMaintenance,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useMemo, useState } from "react";
import { Alert, Pressable, View } from "react-native";
import Animated, { FadeIn, FadeOut, LinearTransition } from "react-native-reanimated";

import { AppText as Text, AppTextInput as TextInput } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";
import type { ConnectedEnvironmentSummary } from "../../state/remote-runtime-types";
import { serverEnvironment } from "../../state/server";
import { ConnectionStatusDot } from "./ConnectionStatusDot";

function connectionStatusLabel(environment: ConnectedEnvironmentSummary): string | null {
  return connectionStatusText({
    phase: environment.connectionState,
    error: environment.connectionError,
    traceId: environment.connectionErrorTraceId,
  });
}

type PrimeMaintenanceInstance = {
  readonly instanceId: ProviderInstanceId;
  readonly label: string;
  readonly distributionMessage: string | null;
  readonly result: AsyncResult.AsyncResult<ServerPrimeManagedMaintenance, unknown>;
};

/** Render the entire maintenance group only when at least one instance has status to show. */
export function PrimeHostMaintenanceSnapshot(props: {
  readonly configKnown: boolean;
  readonly instances: ReadonlyArray<PrimeMaintenanceInstance>;
}) {
  const instances = props.instances.flatMap((instance) => {
    const data = Option.getOrNull(AsyncResult.value(instance.result));
    const error = instance.result._tag === "Failure" ? Cause.squash(instance.result.cause) : null;
    const operation = data?.scheduled ?? data?.operation ?? null;
    if (
      data?.controlsAvailable === false &&
      data.availableBuilds.length === 0 &&
      !instance.result.waiting &&
      instance.result._tag !== "Failure" &&
      (operation === null || operation.status === "succeeded")
    ) {
      return [];
    }
    return [{ ...instance, data, error, operation }];
  });
  if (props.instances.length > 0 && instances.length === 0) return null;
  return (
    <View className="gap-2 border-t border-border pt-3">
      <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
        Prime host maintenance
      </Text>
      {instances.length > 0 ? (
        instances.map(
          ({ instanceId, label, distributionMessage, result, data, error, operation }) => (
            <View
              key={instanceId}
              className="gap-1 rounded-[14px] border border-input-border bg-input px-3.5 py-3"
            >
              <Text className="text-xs font-t3-bold text-foreground">{label}</Text>
              <Text className="text-xs leading-normal text-foreground-muted">
                {error !== null
                  ? error instanceof Error
                    ? error.message
                    : "The environment request failed."
                  : result.waiting
                    ? "Reading host maintenance status."
                    : (data?.message ?? "Status unavailable.")}
              </Text>
              {distributionMessage ? (
                <Text className="text-xs leading-normal text-foreground-muted">
                  {distributionMessage}
                </Text>
              ) : null}
              {operation ? (
                <Text
                  className={cn(
                    "text-xs leading-normal",
                    operation.status === "failed"
                      ? "text-adaptive-rose-500-400"
                      : "text-foreground-muted",
                  )}
                >
                  {operation.status.replaceAll("-", " ")} · {operation.message}
                </Text>
              ) : null}
              {data?.guidance ? (
                <Text className="text-xs leading-normal text-adaptive-amber-600-400">
                  {data.guidance}
                </Text>
              ) : null}
            </View>
          ),
        )
      ) : (
        <Text className="text-xs leading-normal text-foreground-muted">
          {!props.configKnown
            ? "Connect to read Prime maintenance status."
            : "This environment reports no configured Prime Agent instance."}
        </Text>
      )}
      <Text className="text-xs leading-normal text-foreground-muted">
        Install, update, rollback, switch back, and cleanup are host operations. Open Provider
        Settings in Pylon web or desktop for this environment. Active work is never interrupted.
      </Text>
    </View>
  );
}

function PrimeHostMaintenanceStatus(props: { readonly environmentId: EnvironmentId }) {
  const statusAtom = useMemo(
    () =>
      Atom.make((get) => {
        const config = get(serverEnvironment.configValueAtom(props.environmentId));
        return {
          configKnown: config !== null,
          instances: (config?.providers ?? [])
            .filter((provider) => provider.driver === "primeAgent")
            .map((provider) => ({
              instanceId: provider.instanceId,
              label: provider.displayName ?? "Prime Agent",
              distributionMessage: provider.distribution?.message ?? null,
              result: get(
                serverEnvironment.primeManagedMaintenance({
                  environmentId: props.environmentId,
                  input: { instanceId: provider.instanceId },
                }),
              ),
            })),
        };
      }),
    [props.environmentId],
  );
  const status = useAtomValue(statusAtom);
  return <PrimeHostMaintenanceSnapshot {...status} />;
}

export function ConnectionEnvironmentRow(props: {
  readonly environment: ConnectedEnvironmentSummary;
  readonly expanded: boolean;
  readonly onToggle: () => void;
  readonly onReconnect: (environmentId: EnvironmentId) => void;
  readonly onRemove: (environmentId: EnvironmentId) => void;
  readonly onUpdate: (
    environmentId: EnvironmentId,
    updates: { readonly label: string; readonly displayUrl: string },
  ) => Promise<AtomCommandResult<unknown, unknown>>;
}) {
  const [label, setLabel] = useState(props.environment.environmentLabel);
  const [url, setUrl] = useState(props.environment.displayUrl);
  const serverConfig = useAtomValue(
    serverEnvironment.configValueAtom(props.environment.environmentId),
  );
  const statusLabel = connectionStatusLabel(props.environment);
  const statusTraceId = props.environment.connectionErrorTraceId;
  const hasConnectionFailure = props.environment.connectionError !== null;
  const isRetrying =
    props.environment.connectionState === "connecting" ||
    props.environment.connectionState === "reconnecting";
  const handleSave = useCallback(async () => {
    const result = await props.onUpdate(props.environment.environmentId, {
      label: label.trim(),
      displayUrl: url.trim(),
    });
    if (AsyncResult.isSuccess(result)) {
      props.onToggle();
      return;
    }
    const error = Cause.squash(result.cause);
    Alert.alert(
      "Could not update environment",
      error instanceof Error ? error.message : "The environment could not be updated.",
    );
  }, [label, url, props]);

  return (
    <Animated.View layout={LinearTransition.duration(250)} className="bg-card">
      <Pressable
        className="flex-row items-center gap-3 px-4 py-3.5 active:opacity-70"
        onPress={props.onToggle}
      >
        <ConnectionStatusDot
          state={props.environment.connectionState}
          pulse={isRetrying}
          size={8}
        />

        <View className="flex-1 gap-0.5">
          <View className="flex-row items-center gap-1.5">
            <EnvironmentMachineSymbol
              kind={resolveEnvironmentMachineKind(serverConfig)}
              size={14}
              tintColorClassName="accent-foreground-muted"
            />
            <Text
              className="min-w-0 flex-shrink text-base font-t3-bold leading-snug text-foreground"
              numberOfLines={1}
            >
              {props.environment.environmentLabel}
            </Text>
          </View>
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {props.environment.displayUrl}
          </Text>
          {statusLabel ? (
            <Text
              className={cn(
                "text-xs",
                hasConnectionFailure ? "text-danger-foreground" : "text-foreground-muted",
              )}
              numberOfLines={props.expanded ? undefined : 1}
              selectable={props.expanded}
            >
              {statusLabel}
              {statusTraceId ? (
                <>
                  {" Trace ID: "}
                  <Text
                    accessibilityHint="Copies the trace ID"
                    accessibilityRole="button"
                    className="underline decoration-dotted"
                    onLongPress={(event) => {
                      event.stopPropagation();
                      copyTextWithHaptic(statusTraceId, { target: "connection-trace-id" });
                    }}
                    onPress={(event) => {
                      event.stopPropagation();
                    }}
                  >
                    {statusTraceId}
                  </Text>
                </>
              ) : null}
            </Text>
          ) : null}
        </View>

        <SymbolView
          name="chevron.down"
          size={12}
          tintColorClassName={"accent-icon-subtle"}
          type="monochrome"
          style={{
            transform: [{ rotate: props.expanded ? "180deg" : "0deg" }],
          }}
        />
      </Pressable>

      {props.expanded ? (
        <Animated.View
          entering={FadeIn.duration(200)}
          exiting={FadeOut.duration(150)}
          className="gap-3 px-4 pb-4"
        >
          {props.environment.isRelayManaged ? (
            <Text className="text-sm text-foreground-muted">
              Managed by Pylon Connect. Tunnel details update automatically.
            </Text>
          ) : (
            <>
              <View className="gap-1.5">
                <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
                  Label
                </Text>
                <TextInput
                  autoCapitalize="words"
                  autoCorrect={false}
                  placeholder="My MacBook"
                  value={label}
                  onChangeText={setLabel}
                  className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
                />
              </View>

              <View className="gap-1.5">
                <Text className="text-2xs font-t3-bold tracking-[0.8px] uppercase text-foreground-muted">
                  URL
                </Text>
                <TextInput
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  placeholder="192.168.1.100:8080"
                  value={url}
                  onChangeText={setUrl}
                  className="rounded-[14px] border border-input-border bg-input px-4 py-3 text-base text-foreground"
                />
              </View>
            </>
          )}

          <PrimeHostMaintenanceStatus environmentId={props.environment.environmentId} />

          <View className="flex-row justify-end gap-2">
            {props.environment.isRelayManaged ? null : (
              <Pressable
                className="min-h-[42px] flex-1 flex-row items-center justify-center gap-1.5 rounded-[14px] bg-primary px-3.5 py-2.5 active:opacity-70"
                onPress={handleSave}
              >
                <SymbolView
                  name="checkmark"
                  size={13}
                  tintColorClassName={"accent-primary-foreground"}
                  type="monochrome"
                />
                <Text className="text-xs font-t3-bold tracking-[0.8px] uppercase text-primary-foreground">
                  Save
                </Text>
              </Pressable>
            )}

            <Pressable
              className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-input-border bg-input active:opacity-70"
              onPress={() => props.onReconnect(props.environment.environmentId)}
            >
              <SymbolView
                name="arrow.clockwise"
                size={14}
                tintColorClassName={"accent-icon-subtle"}
                type="monochrome"
              />
            </Pressable>

            <Pressable
              className="h-[42px] w-[42px] items-center justify-center rounded-[14px] border border-danger-border bg-danger active:opacity-70"
              onPress={() => props.onRemove(props.environment.environmentId)}
            >
              <SymbolView
                name="trash"
                size={14}
                tintColorClassName={"accent-danger-foreground"}
                type="monochrome"
              />
            </Pressable>
          </View>
        </Animated.View>
      ) : null}
    </Animated.View>
  );
}
