import { DEFAULT_DOT_MATRIX_MOTION, type DotMatrixMotion } from "@t3tools/contracts/settings";
import { useState } from "react";
import { useClientSettings, useUpdateClientSettings } from "~/hooks/useSettings";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { DotMatrix, dotMatrixAnimatedStates, type DotMatrixState } from "../ui/dot-matrix";
import { Button } from "../ui/button";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  DOT_MATRIX_STATUS_DESCRIPTIONS,
  DOT_MATRIX_STATUS_GROUPS,
} from "./DotMatrixSettings.logic";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

const MOTION_LABELS: Readonly<Record<DotMatrixMotion, string>> = {
  smooth: "Smooth",
  efficient: "Efficient",
};

function TerminalRowContent({ highlighted = false }: { highlighted?: boolean }) {
  return (
    <div
      className={
        highlighted
          ? "flex min-h-7 items-center gap-2 px-1 py-0.5 text-foreground"
          : "flex min-h-7 items-center gap-2 px-1 py-0.5 text-secondary-label"
      }
    >
      <DotMatrix aria-hidden state="terminal" className="size-[22px] text-inherit" />
      <span className="text-sm font-medium">IPython</span>
    </div>
  );
}

function StreamingTerminalRowPreview() {
  return (
    <div
      role="img"
      aria-label="Streaming terminal row"
      className="relative w-fit max-w-full overflow-hidden rounded-md"
    >
      <TerminalRowContent />
      <div
        aria-hidden
        className="live-activity-focus pointer-events-none absolute inset-y-0 select-none"
      >
        <div className="live-activity-focus-counter">
          <div className="live-activity-focus-aligned">
            <TerminalRowContent highlighted />
          </div>
        </div>
      </div>
    </div>
  );
}

function StatusCard({ state, motionPaused }: { state: DotMatrixState; motionPaused: boolean }) {
  const animated = dotMatrixAnimatedStates.includes(state);
  const motionLabel = animated ? (motionPaused ? "Paused" : "Animated") : "Static";
  return (
    <div className="grid min-h-20 grid-cols-[2rem_minmax(0,1fr)] items-center gap-3 rounded-xl border border-border/70 bg-card/55 p-3">
      <DotMatrix aria-hidden state={state} className="size-6" />
      <div className="min-w-0">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
          <code className="text-xs font-semibold text-foreground">{state}</code>
          <span className="text-[9px] font-medium tracking-[0.08em] text-muted-foreground uppercase">
            {motionLabel}
          </span>
        </div>
        <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
          {DOT_MATRIX_STATUS_DESCRIPTIONS[state]}
        </p>
      </div>
    </div>
  );
}

export function DotMatrixSettings() {
  const motion = useClientSettings((settings) => settings.dotMatrixMotion);
  const updateSettings = useUpdateClientSettings();
  const prefersReducedMotion = useMediaQuery("(prefers-reduced-motion: reduce)");
  const [catalogOpen, setCatalogOpen] = useState(false);

  return (
    <SettingsSection title="Status language">
      <SettingsRow
        {...searchableSetting("dot-matrix-motion")}
        description={
          prefersReducedMotion
            ? "Your system Reduce Motion preference pauses status animation. This choice is saved for when motion is enabled."
            : "Smooth uses fluid fades. Efficient uses stepped frames to reduce continuous rendering on this device."
        }
        resetAction={
          motion !== DEFAULT_DOT_MATRIX_MOTION ? (
            <SettingResetButton
              label="status motion"
              onClick={() => updateSettings({ dotMatrixMotion: DEFAULT_DOT_MATRIX_MOTION })}
            />
          ) : null
        }
        control={
          <Select
            value={motion}
            onValueChange={(value) => {
              if (value === "smooth" || value === "efficient") {
                updateSettings({ dotMatrixMotion: value });
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-40" aria-label="Status motion">
              <SelectValue>{MOTION_LABELS[motion]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.entries(MOTION_LABELS) as ReadonlyArray<[DotMatrixMotion, string]>).map(
                ([value, label]) => (
                  <SelectItem hideIndicator key={value} value={value}>
                    {label}
                  </SelectItem>
                ),
              )}
            </SelectPopup>
          </Select>
        }
      />

      <SettingsRow
        {...searchableSetting("dot-matrix-catalog")}
        description="Preview every status pattern, its meaning, and the composed streaming terminal row."
        control={
          <Button
            aria-controls="dot-matrix-status-catalog"
            aria-expanded={catalogOpen}
            size="xs"
            variant="outline"
            onClick={() => setCatalogOpen((open) => !open)}
          >
            {catalogOpen ? "Hide catalog" : "View catalog"}
          </Button>
        }
      />

      {catalogOpen ? (
        <div
          id="dot-matrix-status-catalog"
          className="space-y-5 border-t border-border/70 px-4 py-5"
        >
          <div>
            <h3 className="text-sm font-semibold text-foreground">Live catalog</h3>
            <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">
              These patterns are the status language used across threads, agents, tools,
              connections, and updates. Motion represents a known active state; settled states stay
              still.
            </p>
          </div>

          {DOT_MATRIX_STATUS_GROUPS.map((group) => (
            <div key={group.title}>
              <h4 className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
                {group.title}
              </h4>
              <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                {group.states.map((state) => (
                  <StatusCard key={state} state={state} motionPaused={prefersReducedMotion} />
                ))}
              </div>
            </div>
          ))}

          <div>
            <h4 className="mb-2 text-[10px] font-semibold tracking-[0.1em] text-muted-foreground uppercase">
              Composed activity
            </h4>
            <div className="grid min-h-24 gap-3 rounded-xl border border-border/70 bg-card/55 p-4 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
              <div>
                <p className="text-sm font-medium text-foreground">Streaming terminal row</p>
                <p className="mt-1 max-w-xl text-xs leading-relaxed text-muted-foreground">
                  Live command output uses one foreground sweep across the terminal identity and its
                  label. It does not add a second Dot Matrix animation.
                </p>
              </div>
              <StreamingTerminalRowPreview />
            </div>
          </div>
        </div>
      ) : null}
    </SettingsSection>
  );
}
