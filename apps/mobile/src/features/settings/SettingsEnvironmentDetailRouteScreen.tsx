import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import type { StaticScreenProps } from "@react-navigation/native";
import type { EnvironmentId, ServerProvider } from "@t3tools/contracts";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult } from "effect/unstable/reactivity";
import { useRef, useState } from "react";
import { Platform, ScrollView, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { AppText as Text } from "../../components/AppText";
import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { ProviderIcon } from "../../components/ProviderIcon";
import { NativeStackScreenOptions } from "../../native/StackHeader";
import { serverEnvironment } from "../../state/server";
import { environmentSession } from "../../state/session";
import { useAtomCommand } from "../../state/use-atom-command";
import { useRemoteConnections } from "../../state/use-remote-environment-registry";
import { SettingsRow } from "./components/SettingsRow";
import { SettingsSection } from "./components/SettingsSection";
import {
  canMaintainEnvironment,
  canUpdateEnvironmentProvider,
  providerUpdateOutcome,
} from "./environment-maintenance";

export function SettingsEnvironmentDetailRouteScreen({
  route,
}: StaticScreenProps<{ readonly environmentId: EnvironmentId }>) {
  // Navigation can reuse a mounted screen for another environment.
  return (
    <EnvironmentDetail
      key={route.params.environmentId}
      environmentId={route.params.environmentId}
    />
  );
}

function EnvironmentDetail({ environmentId }: { readonly environmentId: EnvironmentId }) {
  const navigation = useNavigation();
  const insets = useSafeAreaInsets();
  const connections = useRemoteConnections();
  const environment = connections.connectedEnvironments.find(
    (entry) => entry.environmentId === environmentId,
  );
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const session = useAtomValue(environmentSession.sessionStateValueAtom(environmentId));
  const sessionResult = useAtomValue(environmentSession.sessionStateAtom(environmentId));
  const updateState = useAtomValue(serverEnvironment.updateStateAtom(environmentId));
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const updateProvider = useAtomCommand(serverEnvironment.updateProvider, { reportFailure: false });
  const [pending, setPending] = useState<string | null>(null);
  const pendingRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const connected = environment?.isEnabled === true && environment.connectionState === "connected";
  const allowed =
    !AsyncResult.isFailure(sessionResult) && canMaintainEnvironment(session, connected);
  const providerBusy =
    config?.providers.some(
      (provider) =>
        provider.updateState?.status === "running" || provider.updateState?.status === "queued",
    ) ?? false;
  const busy = pending !== null || updateState.status === "running" || providerBusy;

  async function run(label: string, action: () => Promise<void>) {
    if (!allowed || pendingRef.current || busy) return;
    pendingRef.current = true;
    setPending(label);
    setError(null);
    setNotice(null);
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The action could not be completed.");
    } finally {
      pendingRef.current = false;
      setPending(null);
    }
  }

  function requestProviderUpdate(provider: ServerProvider) {
    if (!canUpdateEnvironmentProvider(provider)) return;
    void run(provider.instanceId, async () => {
      const result = await updateProvider({
        environmentId,
        input: { provider: provider.driver, instanceId: provider.instanceId },
      });
      if (isAtomCommandInterrupted(result)) return;
      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
      const outcome = providerUpdateOutcome(result.value.providers, provider.instanceId);
      if (outcome?.kind === "error") setError(outcome.message);
      else if (outcome) setNotice(outcome.message);
    });
  }

  return (
    <View collapsable={false} className="flex-1 bg-sheet">
      {Platform.OS === "android" ? (
        <>
          <NativeStackScreenOptions options={{ headerShown: false }} />
          <AndroidScreenHeader
            title={environment?.environmentLabel ?? "Environment"}
            onBack={() => navigation.goBack()}
          />
        </>
      ) : null}
      <ScrollView
        alwaysBounceVertical
        contentInsetAdjustmentBehavior="automatic"
        className="flex-1 bg-sheet"
        contentContainerClassName="gap-6 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {!environment ? (
          <Text className="text-base text-foreground-muted">
            This environment is no longer saved on this device.
          </Text>
        ) : (
          <>
            <SettingsSection title={environment.environmentLabel}>
              <View className="gap-1 p-4">
                <Text className="text-base text-foreground">
                  {connected ? "Connected" : "Disconnected"}
                </Text>
                {config ? (
                  <Text className="text-sm text-foreground-muted">
                    Pylon server {config.environment.serverVersion}
                  </Text>
                ) : null}
                {updateState.status === "running" ? (
                  <Text className="text-sm text-foreground-muted">
                    Server update in progress. Reconnect when it finishes.
                  </Text>
                ) : updateState.status === "failed" ? (
                  <Text selectable className="text-sm text-danger-foreground">
                    {updateState.message}
                  </Text>
                ) : null}
                <Text className="text-sm text-foreground-muted">
                  Server updates are available from Pylon web or desktop when this environment
                  supports them.
                </Text>
              </View>
            </SettingsSection>
            {!connected ? (
              <Text className="px-2 text-sm text-foreground-muted">
                Connect this environment to manage it.
              </Text>
            ) : !allowed ? (
              <Text className="px-2 text-sm text-foreground-muted">
                {AsyncResult.isFailure(sessionResult)
                  ? "Could not verify your permissions. Reconnect to try again."
                  : session === null
                    ? "Checking permissions…"
                    : "This connection does not have permission to manage the environment."}
              </Text>
            ) : null}
            {error ? (
              <Text selectable className="px-2 text-sm text-danger-foreground">
                {error}
              </Text>
            ) : null}
            {notice ? <Text className="px-2 text-sm text-foreground-muted">{notice}</Text> : null}
            {config ? (
              <SettingsSection title="Providers">
                <SettingsRow
                  icon="arrow.clockwise"
                  label={pending === "refresh" ? "Refreshing…" : "Refresh provider status"}
                  disabled={!allowed || busy}
                  onPress={() =>
                    void run("refresh", async () => {
                      const result = await refreshProviders({ environmentId, input: {} });
                      if (isAtomCommandInterrupted(result)) return;
                      if (AsyncResult.isFailure(result)) throw squashAtomCommandFailure(result);
                      setNotice("Provider status refreshed.");
                    })
                  }
                />
                {config.providers
                  .filter((provider) => provider.enabled)
                  .map((provider) => (
                    <View key={provider.instanceId} className="border-t border-border">
                      <View className="flex-row items-center gap-3 p-4">
                        <ProviderIcon provider={provider.driver} size={18} />
                        <View className="min-w-0 flex-1 gap-1">
                          <Text className="text-base text-foreground">
                            {provider.displayName ?? provider.driver}
                          </Text>
                          <Text className="text-sm text-foreground-muted">
                            {provider.installed
                              ? (provider.version ?? "Version unknown")
                              : "Not installed"}
                            {provider.versionAdvisory?.latestVersion
                              ? ` · Latest ${provider.versionAdvisory.latestVersion}`
                              : ""}
                          </Text>
                          {provider.updateState?.status !== "idle" &&
                          provider.updateState?.message ? (
                            <Text
                              selectable
                              className={
                                provider.updateState.status === "failed"
                                  ? "text-sm text-danger-foreground"
                                  : "text-sm text-foreground-muted"
                              }
                            >
                              {provider.updateState.message}
                            </Text>
                          ) : null}
                        </View>
                      </View>
                      {canUpdateEnvironmentProvider(provider) ? (
                        <SettingsRow
                          icon="arrow.up.circle"
                          label={
                            pending === provider.instanceId
                              ? "Updating…"
                              : `Update ${provider.displayName ?? provider.driver}`
                          }
                          disabled={!allowed || busy}
                          onPress={() => requestProviderUpdate(provider)}
                        />
                      ) : null}
                    </View>
                  ))}
              </SettingsSection>
            ) : null}
          </>
        )}
      </ScrollView>
    </View>
  );
}
