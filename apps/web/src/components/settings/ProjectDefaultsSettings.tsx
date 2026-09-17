import {
  DEFAULT_SERVER_SETTINGS,
  type DelegationChildRuntimeMode,
  EnvironmentId,
  type ModelSelection,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";

import { useT3ProjectFileState } from "../../hooks/useT3ProjectFileScripts";
import { getCustomModelOptionsByInstance } from "../../modelSelection";
import {
  applyProviderInstanceSettings,
  deriveProviderInstanceEntries,
  resolveDefaultProviderModelSelection,
  sortProviderInstanceEntries,
} from "../../providerInstances";
import { useEnvironments } from "../../state/environments";
import { EMPTY_SERVER_PROVIDERS } from "../../state/server";
import { resolveEnvModeLabel } from "../BranchToolbar.logic";
import { ProviderModelPicker } from "../chat/ProviderModelPicker";
import { runtimeModeConfig, runtimeModeOptions } from "../chat/runtimeModeConfig";
import { PULL_REQUEST_MERGE_METHOD_LABELS } from "../pullRequest/pullRequestDetail.logic";
import { TraitsPicker } from "../chat/TraitsPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { toastManager } from "../ui/toast";
import { Switch } from "../ui/switch";
import type { ProjectSettingsCategory } from "./ProjectSettingsPanel";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  SETTINGS_PICKER_TRIGGER_CLASSNAME,
  SettingResetButton,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useScopedSettingSource,
  useUpdateScopedSettings,
} from "./useScopedSettings";

/**
 * Rows for the settings a project may override. The same rows edit
 * environment defaults at an environment scope and project overrides at a
 * project or checkout scope; the scoped hooks route the write.
 */
const CHILD_PERMISSION_LABELS = {
  inherit: "Same as parent",
  "approval-required": "Supervised",
} as const satisfies Record<DelegationChildRuntimeMode, string>;

const CHILD_PERMISSION_DESCRIPTIONS = {
  inherit: "Children use the permission mode of the agent that started them.",
  "approval-required": "Children ask before running commands or editing files.",
} as const satisfies Record<DelegationChildRuntimeMode, string>;

export function ProjectDefaultsSettings({ category }: { category: ProjectSettingsCategory }) {
  const { scope, target, targets, connectedEnvironments } = useSettingsScope();
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const navigate = useNavigate();
  const { environments } = useEnvironments();
  const representative = target
    ? environments.find((environment) => environment.environmentId === target.environmentId)
    : undefined;
  const providers = representative?.serverConfig?.providers ?? EMPTY_SERVER_PROVIDERS;
  const selection = resolveDefaultProviderModelSelection(providers, settings.defaultModelSelection);
  const entries = sortProviderInstanceEntries(
    applyProviderInstanceSettings(deriveProviderInstanceEntries(providers), settings),
  );
  const modelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    selection?.instanceId,
    selection?.model,
  );
  const activeEntry = entries.find((entry) => entry.instanceId === selection?.instanceId);
  const mixedModel = useScopedSettingsMixed(["defaultModelSelection"]);
  const mixedPermissions = useScopedSettingsMixed(["defaultRuntimeMode"]);
  const PermissionIcon = runtimeModeConfig[settings.defaultRuntimeMode].icon;
  const mixedWorkspace = useScopedSettingsMixed(["defaultThreadEnvMode"]);
  const mixedBrowser = useScopedSettingsMixed(["enableAgentBrowserAccess"]);
  const mixedDevice = useScopedSettingsMixed(["enableAgentDeviceAccess"]);
  const mixedDelegation = useScopedSettingsMixed(["enableAgentDelegation"]);
  const mixedDelegationModel = useScopedSettingsMixed(["delegationDefaultModelSelection"]);
  const mixedChildPermissions = useScopedSettingsMixed(["delegationChildRuntimeMode"]);
  // A saved default is shown exactly as stored, even when unavailable, because
  // delegation never substitutes another provider. With none saved the picker
  // shows a suggestion; nothing is stored until a pick.
  const delegationSelection =
    settings.delegationDefaultModelSelection ??
    resolveDefaultProviderModelSelection(providers, null);
  const delegationModelOptions = getCustomModelOptionsByInstance(
    settings,
    providers,
    delegationSelection?.instanceId,
    delegationSelection?.model,
  );
  const delegationEntry = entries.find(
    (entry) => entry.instanceId === delegationSelection?.instanceId,
  );
  const mixedAutoPull = useScopedSettingsMixed(["defaultAutoPull"]);
  const mixedMergeMethod = useScopedSettingsMixed(["pullRequestMergeMethod"]);
  const modelSource = useScopedSettingSource(["defaultModelSelection"]);
  const workspaceSource = useScopedSettingSource(["defaultThreadEnvMode"]);
  const isProjectScope = scope.kind === "project" || scope.kind === "checkout";
  const unavailable = connectedEnvironments.length === 0;

  // A checkout's t3.json wins over the environment default when the project
  // has no override of its own; show which one "inherit" resolves to.
  const checkout = scope.kind === "checkout" ? scope.checkout : null;
  // The query is disabled without a checkout, so any id satisfies the hook.
  const t3File = useT3ProjectFileState(
    checkout?.environmentId ?? EnvironmentId.make("none"),
    category === "general" && checkout ? checkout.workspaceRoot : null,
  );
  const repositoryEnvMode = t3File.file?.defaultThreadEnvMode ?? null;
  const inheritedEnvModeLabel =
    workspaceSource === "project"
      ? null
      : repositoryEnvMode
        ? `${resolveEnvModeLabel(repositoryEnvMode)} (t3.json)`
        : null;

  function modelDisabledReason(instanceId: ProviderInstanceId, model: string): string | null {
    const sourceEntry = entries.find((entry) => entry.instanceId === instanceId);
    for (const candidate of targets) {
      const environment = environments.find(
        (entry) => entry.environmentId === candidate.environmentId,
      );
      const config = environment?.serverConfig;
      if (!config) continue;
      const entry = applyProviderInstanceSettings(
        deriveProviderInstanceEntries(config.providers),
        candidate.settings,
      ).find((option) => option.instanceId === instanceId);
      const options = getCustomModelOptionsByInstance(
        { ...settings, ...candidate.settings },
        config.providers,
      ).get(instanceId);
      if (
        !entry?.enabled ||
        !entry.isAvailable ||
        entry.driverKind !== sourceEntry?.driverKind ||
        !options?.some((option) => option.slug === model && !option.isUnavailable)
      ) {
        return `This model is unavailable on ${environment?.label ?? "a selected environment"}. Select that environment to choose its model separately.`;
      }
    }
    return null;
  }

  const setModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({ type: "error", title: "Default model not saved", description: reason });
      return;
    }
    updateSettings({ defaultModelSelection: value });
  };

  const setDelegationModel = (value: ModelSelection | null) => {
    const reason = value ? modelDisabledReason(value.instanceId, value.model) : null;
    if (reason) {
      toastManager.add({
        type: "error",
        title: "Default delegation model not saved",
        description: reason,
      });
      return;
    }
    updateSettings({ delegationDefaultModelSelection: value });
  };

  return (
    <SettingsSection
      id={
        category === "general"
          ? "project-defaults"
          : category === "integrations"
            ? "browser-access"
            : "source-control-defaults"
      }
      title={
        category === "general"
          ? "New threads"
          : category === "integrations"
            ? "Agent access"
            : "Repositories"
      }
    >
      {category === "general" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultModelSelection"]}
            mixed={mixedModel}
            id="default-model"
            title="Model"
            description={
              isProjectScope
                ? "Model for new threads in this project."
                : "Default model for new threads. Projects can override it."
            }
            status={
              unavailable || mixedModel || modelSource === "project"
                ? undefined
                : settings.defaultModelSelection === null
                  ? "Automatic"
                  : undefined
            }
            resetAction={
              settings.defaultModelSelection !== null ? (
                <SettingResetButton label="default model" onClick={() => setModel(null)} />
              ) : null
            }
            control={
              selection && activeEntry ? (
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={selection.instanceId}
                    model={selection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={modelOptions}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    {...(mixedModel ? { triggerLabel: "Mixed" } : {})}
                    getModelDisabledReason={modelDisabledReason}
                    onOpenProviderSetup={(instanceId) => {
                      if (representative)
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: representative.environmentId, instanceId },
                        });
                    }}
                    onInstanceModelChange={(instanceId, model) =>
                      setModel(createModelSelection(instanceId, model))
                    }
                  />
                  {!mixedModel ? (
                    <TraitsPicker
                      provider={activeEntry.driverKind}
                      models={activeEntry.models}
                      model={selection.model}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={selection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={settings.planModeEnabled}
                      triggerVariant="outline"
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        setModel(
                          createModelSelection(selection.instanceId, selection.model, options),
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["defaultRuntimeMode"]}
            mixed={mixedPermissions}
            {...searchableSetting("default-permissions")}
            description={
              isProjectScope
                ? "Permissions for new threads in this project."
                : "Default permissions for new threads. Projects can override them."
            }
            resetAction={
              settings.defaultRuntimeMode !== DEFAULT_SERVER_SETTINGS.defaultRuntimeMode ? (
                <SettingResetButton
                  label="default permissions"
                  onClick={() =>
                    updateSettings({
                      defaultRuntimeMode: DEFAULT_SERVER_SETTINGS.defaultRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedPermissions ? null : settings.defaultRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ defaultRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default permissions">
                  {!mixedPermissions && (
                    <PermissionIcon className="size-3.5 shrink-0 text-muted-foreground" />
                  )}
                  <SelectValue>
                    {mixedPermissions
                      ? "Mixed"
                      : runtimeModeConfig[settings.defaultRuntimeMode].label}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {runtimeModeOptions.map((mode) => {
                    const option = runtimeModeConfig[mode];
                    const Icon = option.icon;
                    return (
                      <SelectItem key={mode} value={mode} className="min-w-64 py-2">
                        <div className="grid gap-0.5">
                          <span className="inline-flex items-center gap-1.5 font-medium">
                            <Icon className="size-3.5 shrink-0 text-muted-foreground" />
                            {option.label}
                          </span>
                          <span className="text-xs leading-4 text-muted-foreground">
                            {option.description}
                          </span>
                        </div>
                      </SelectItem>
                    );
                  })}
                </SelectPopup>
              </Select>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["defaultThreadEnvMode"]}
            mixed={mixedWorkspace}
            id={searchableSetting("new-threads").id}
            title="Workspace"
            description={
              isProjectScope
                ? "Where new threads in this project start. A t3.json preference applies when the project has no override."
                : "Where new threads start, unless overridden by the project or t3.json."
            }
            status={
              inheritedEnvModeLabel ? `Repository default: ${inheritedEnvModeLabel}` : undefined
            }
            resetAction={
              settings.defaultThreadEnvMode !== DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode ? (
                <SettingResetButton
                  label="default workspace"
                  onClick={() =>
                    updateSettings({
                      defaultThreadEnvMode: DEFAULT_SERVER_SETTINGS.defaultThreadEnvMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedWorkspace ? null : settings.defaultThreadEnvMode}
                onValueChange={(value) => {
                  if (value === "local" || value === "worktree")
                    updateSettings({ defaultThreadEnvMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default workspace">
                  <SelectValue>
                    {(value: string | null) =>
                      value === "local" || value === "worktree"
                        ? resolveEnvModeLabel(value)
                        : unavailable
                          ? "Unavailable"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="local">{resolveEnvModeLabel("local")}</SelectItem>
                  <SelectItem value="worktree">{resolveEnvModeLabel("worktree")}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : category === "source-control" ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["defaultAutoPull"]}
            mixed={mixedAutoPull}
            id="automatic-pull"
            title="Automatically pull"
            description={
              isProjectScope
                ? "Keeps this project's default branch current when the checkout has no local changes or commits."
                : "Keeps the default branch current when the checkout has no local changes or commits. Projects can override it."
            }
            resetAction={
              settings.defaultAutoPull ? (
                <SettingResetButton
                  label="default automatic pull"
                  tooltip="Reset automatic pull to off"
                  onClick={() => updateSettings({ defaultAutoPull: false })}
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Default automatic pull"
                mixed={mixedAutoPull}
                checked={mixedAutoPull ? false : settings.defaultAutoPull}
                onCheckedChange={(enabled) => updateSettings({ defaultAutoPull: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["pullRequestMergeMethod"]}
            mixed={mixedMergeMethod}
            {...searchableSetting("pull-request-merge-method")}
            description={
              isProjectScope
                ? "Pull requests in this project start with this method."
                : "Pull requests start with this method. Last selected reuses whatever you chose most recently on this device."
            }
            resetAction={
              settings.pullRequestMergeMethod !== null ? (
                <SettingResetButton
                  label="default merge method"
                  tooltip="Reset to last selected"
                  onClick={() => updateSettings({ pullRequestMergeMethod: null })}
                />
              ) : null
            }
            control={
              <Select
                value={mixedMergeMethod ? null : (settings.pullRequestMergeMethod ?? "last")}
                onValueChange={(value) => {
                  if (value === "last") updateSettings({ pullRequestMergeMethod: null });
                  else if (value === "merge" || value === "squash" || value === "rebase")
                    updateSettings({ pullRequestMergeMethod: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Default pull request merge method">
                  <SelectValue>
                    {(value: string | null) =>
                      value === "merge" || value === "squash" || value === "rebase"
                        ? PULL_REQUEST_MERGE_METHOD_LABELS[value]
                        : value === "last"
                          ? "Last selected"
                          : "Mixed"
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  <SelectItem value="last">Last selected</SelectItem>
                  <SelectItem value="merge">{PULL_REQUEST_MERGE_METHOD_LABELS.merge}</SelectItem>
                  <SelectItem value="squash">{PULL_REQUEST_MERGE_METHOD_LABELS.squash}</SelectItem>
                  <SelectItem value="rebase">{PULL_REQUEST_MERGE_METHOD_LABELS.rebase}</SelectItem>
                </SelectPopup>
              </Select>
            }
          />
        </>
      ) : (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["enableAgentBrowserAccess"]}
            mixed={mixedBrowser}
            id={searchableSetting("agent-browser-access").id}
            title="Agent browser access"
            description={
              isProjectScope
                ? "Allow agents in this project to use the shared browser. Applies when the agent session next starts."
                : "Allow agents to use the shared browser. Projects can override it."
            }
            resetAction={
              settings.enableAgentBrowserAccess !==
              DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess ? (
                <SettingResetButton
                  label="default browser access"
                  onClick={() =>
                    updateSettings({
                      enableAgentBrowserAccess: DEFAULT_SERVER_SETTINGS.enableAgentBrowserAccess,
                    })
                  }
                />
              ) : null
            }
            control={
              <Switch
                aria-label="Agent browser access"
                mixed={mixedBrowser}
                checked={mixedBrowser ? false : settings.enableAgentBrowserAccess}
                onCheckedChange={(enabled) => updateSettings({ enableAgentBrowserAccess: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["enableAgentDelegation"]}
            mixed={mixedDelegation}
            {...searchableSetting("agent-delegation")}
            description={
              isProjectScope
                ? "Built-in subagents stay the default. Allow separate Pylon threads in this project when you explicitly request them. Changes apply to new agent sessions; existing sessions and children keep running."
                : "Built-in subagents stay the default. Allow separate Pylon threads when you explicitly request them. Changes apply to new agent sessions; existing sessions and children keep running. Projects can override it."
            }
            control={
              <Switch
                aria-label="Pylon delegation"
                mixed={mixedDelegation}
                checked={mixedDelegation ? false : settings.enableAgentDelegation}
                onCheckedChange={(enabled) => updateSettings({ enableAgentDelegation: enabled })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["delegationDefaultModelSelection"]}
            mixed={mixedDelegationModel}
            {...searchableSetting("delegation-default-model")}
            description={
              isProjectScope
                ? "Saved provider and model for Pylon child threads in this project, including while delegation is off. Does not change built-in subagents. A provider or model named in your request takes priority."
                : "Saved provider and model for Pylon child threads, including while delegation is off. Does not change built-in subagents. A provider or model named in your request takes priority. Projects can override it."
            }
            status={
              unavailable || mixedDelegationModel
                ? undefined
                : settings.delegationDefaultModelSelection === null
                  ? "Not set"
                  : delegationEntry && (!delegationEntry.enabled || !delegationEntry.isAvailable)
                    ? "Provider unavailable"
                    : undefined
            }
            resetAction={
              settings.delegationDefaultModelSelection !== null ? (
                <SettingResetButton
                  label="default delegation model"
                  onClick={() => setDelegationModel(null)}
                />
              ) : null
            }
            control={
              delegationSelection && delegationEntry ? (
                <div className="flex min-w-0 flex-wrap items-center justify-end gap-1.5">
                  <ProviderModelPicker
                    activeInstanceId={delegationSelection.instanceId}
                    model={delegationSelection.model}
                    lockedProvider={null}
                    instanceEntries={entries}
                    modelOptionsByInstance={delegationModelOptions}
                    triggerVariant="outline"
                    triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                    {...(mixedDelegationModel
                      ? { triggerLabel: "Mixed" }
                      : settings.delegationDefaultModelSelection === null
                        ? { triggerLabel: "Choose a model" }
                        : {})}
                    getModelDisabledReason={modelDisabledReason}
                    onOpenProviderSetup={(instanceId) => {
                      if (representative)
                        void navigate({
                          to: "/settings/providers",
                          search: { environmentId: representative.environmentId, instanceId },
                        });
                    }}
                    onInstanceModelChange={(instanceId, model) =>
                      setDelegationModel(createModelSelection(instanceId, model))
                    }
                  />
                  {!mixedDelegationModel && settings.delegationDefaultModelSelection !== null ? (
                    <TraitsPicker
                      provider={delegationEntry.driverKind}
                      models={delegationEntry.models}
                      model={delegationSelection.model}
                      prompt=""
                      onPromptChange={() => {}}
                      modelOptions={delegationSelection.options ?? []}
                      allowPromptInjectedEffort={false}
                      planModeEnabled={settings.planModeEnabled}
                      triggerVariant="outline"
                      triggerClassName={SETTINGS_PICKER_TRIGGER_CLASSNAME}
                      onModelOptionsChange={(options) =>
                        setDelegationModel(
                          createModelSelection(
                            delegationSelection.instanceId,
                            delegationSelection.model,
                            options,
                          ),
                        )
                      }
                    />
                  ) : null}
                </div>
              ) : settings.delegationDefaultModelSelection !== null ? (
                <span className="text-sm text-muted-foreground">
                  Unavailable provider: {settings.delegationDefaultModelSelection.instanceId} ·{" "}
                  {settings.delegationDefaultModelSelection.model}
                </span>
              ) : (
                <span className="text-sm text-muted-foreground">No providers available</span>
              )
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["delegationChildRuntimeMode"]}
            mixed={mixedChildPermissions}
            {...searchableSetting("delegation-child-permissions")}
            description="Saved permissions for Pylon child threads. A child never gets broader permissions than its parent. Turning Pylon delegation off does not disable built-in subagents; stop a running child from its thread."
            resetAction={
              settings.delegationChildRuntimeMode !==
              DEFAULT_SERVER_SETTINGS.delegationChildRuntimeMode ? (
                <SettingResetButton
                  label="child permissions"
                  onClick={() =>
                    updateSettings({
                      delegationChildRuntimeMode:
                        DEFAULT_SERVER_SETTINGS.delegationChildRuntimeMode,
                    })
                  }
                />
              ) : null
            }
            control={
              <Select
                value={mixedChildPermissions ? null : settings.delegationChildRuntimeMode}
                onValueChange={(value) => {
                  if (value) updateSettings({ delegationChildRuntimeMode: value });
                }}
              >
                <SelectTrigger size="sm" aria-label="Child permissions">
                  <SelectValue>
                    {mixedChildPermissions
                      ? "Mixed"
                      : CHILD_PERMISSION_LABELS[settings.delegationChildRuntimeMode]}
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {(["inherit", "approval-required"] as const).map((mode) => (
                    <SelectItem key={mode} value={mode} className="min-w-64 py-2">
                      <div className="grid gap-0.5">
                        <span className="font-medium">{CHILD_PERMISSION_LABELS[mode]}</span>
                        <span className="text-xs leading-4 text-muted-foreground">
                          {CHILD_PERMISSION_DESCRIPTIONS[mode]}
                        </span>
                      </div>
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            }
          />
          {isProjectScope ? (
            <SettingsRow
              serverScoped
              settingKeys={["enableAgentDeviceAccess"]}
              mixed={mixedDevice}
              {...searchableSetting("agent-device-access")}
              description="Allow agents in this project to control simulators and emulators. Device support must also be enabled on each environment. Applies when the agent session next starts."
              control={
                <Switch
                  aria-label="Agent device access"
                  mixed={mixedDevice}
                  checked={mixedDevice ? false : settings.enableAgentDeviceAccess}
                  onCheckedChange={(enabled) =>
                    updateSettings({ enableAgentDeviceAccess: enabled })
                  }
                />
              }
            />
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}
