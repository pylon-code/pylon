import { ComputerSetupSection } from "./ComputerSetupSection";
import type { ServerSettingsPatch } from "@t3tools/contracts";
import { useState } from "react";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useSettingsScope } from "./SettingsScopeContext";

export function ComputerIntegrationSettings() {
  const { environment, scope } = useSettingsScope();
  const update = useAtomCommand(serverEnvironment.updateSettings);
  const [busy, setBusy] = useState(false);
  const settings = environment?.serverConfig?.settings;
  const disabled = busy || environment?.connection.phase !== "connected" || !settings;
  const save = async (patch: ServerSettingsPatch) => {
    if (!environment || disabled) return;
    setBusy(true);
    try {
      await update({ environmentId: environment.environmentId, input: { patch } });
    } finally {
      setBusy(false);
    }
  };
  // These controls affect an entire desktop, never an individual checkout.
  if (scope.kind === "project" || scope.kind === "checkout") return null;
  return (
    <SettingsSection
      id="computer"
      title={environment ? `Computer · ${environment.label}` : "Computer"}
    >
      {environment && (
        <ComputerSetupSection
          key={environment.environmentId}
          environmentId={environment.environmentId}
          environmentLabel={environment.label}
          binaryPath={settings?.computerUseBinaryPath ?? "cua-driver"}
          connected={environment.connection.phase === "connected"}
        />
      )}
      <SettingsRow
        {...searchableSetting("agent-computer-access")}
        description="Allow agents from every provider to inspect and control the desktop on this environment’s server computer using Cua Driver. Start a new agent session after enabling. Turning this off closes Pylon’s Cua connections."
        control={
          <Switch
            aria-label="Agent computer access"
            disabled={disabled}
            checked={settings?.enableAgentComputerAccess ?? false}
            onCheckedChange={(checked) =>
              void save({ enableAgentComputerAccess: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("computer-foreground")}
        description="Allow actions that can bring apps forward, move the pointer, or interrupt typing. Off by default: agents use reviewed background window actions and report unsupported operations. Apps can still open dialogs in response to background actions."
        control={
          <Switch
            aria-label="Allow foreground control"
            disabled={disabled || !settings?.enableAgentComputerAccess}
            checked={settings?.allowAgentComputerForeground ?? false}
            onCheckedChange={(checked) =>
              void save({ allowAgentComputerForeground: Boolean(checked) })
            }
          />
        }
      />
      <SettingsRow
        {...searchableSetting("computer-use-binary")}
        description="Use cua-driver for Pylon’s managed setup, or enter a custom executable on this environment. Pylon preserves custom installations; updates and repairs apply only to the default driver."
        control={
          <DraftInput
            key={environment?.environmentId ?? "none"}
            nativeInput
            size="sm"
            className="w-full sm:w-64"
            aria-label="Cua Driver executable"
            disabled={disabled}
            value={settings?.computerUseBinaryPath ?? "cua-driver"}
            onCommit={(value) => void save({ computerUseBinaryPath: value.trim() || "cua-driver" })}
          />
        }
      />
    </SettingsSection>
  );
}
