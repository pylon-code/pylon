import type { DotMatrixState } from "../ui/dot-matrix";

export const DOT_MATRIX_STATUS_DESCRIPTIONS: Readonly<Record<DotMatrixState, string>> = {
  idle: "Available, but no work is active.",
  loading: "Generic root work when no narrower fact is known.",
  orchestrating: "Active subagent or workflow coordination.",
  queued: "Accepted but not started.",
  thinking: "Provider reasoning or planning is active.",
  streaming: "Response or tool output is arriving.",
  searching: "A known search operation is active.",
  syncing: "State is reconciling or a service is restarting.",
  connecting: "A connection handshake or reconnect is active.",
  waiting: "Operational work is blocked or waiting without claiming active work.",
  uploading: "A known outbound transfer is active.",
  downloading: "A known inbound transfer is active.",
  listening: "An active watch or monitor loop.",
  speaking: "Fast output or voice playback activity.",
  recording: "Capture is active.",
  success: "Healthy or completed successfully.",
  error: "Failed and needs attention.",
  warning: "User input, approval, or another warning needs attention.",
  info: "Actionable information, such as a plan ready for review.",
  paused: "Paused and resumable.",
  stopped: "Stopped or cancelled.",
  offline: "Unavailable or disconnected.",
  terminal: "Completed or inactive terminal identity.",
  "terminal-active": "Active terminal identity with a synchronized breath.",
};

export const DOT_MATRIX_STATUS_GROUPS: ReadonlyArray<{
  title: string;
  states: ReadonlyArray<DotMatrixState>;
}> = [
  {
    title: "Active work",
    states: [
      "loading",
      "thinking",
      "streaming",
      "searching",
      "syncing",
      "uploading",
      "downloading",
    ],
  },
  {
    title: "Coordination, presence, and media",
    states: [
      "orchestrating",
      "queued",
      "connecting",
      "waiting",
      "listening",
      "speaking",
      "recording",
    ],
  },
  {
    title: "Outcomes and resting states",
    states: ["success", "error", "warning", "info", "paused", "stopped", "offline", "idle"],
  },
  { title: "Terminal", states: ["terminal", "terminal-active"] },
];

export const dotMatrixSettingsStates = DOT_MATRIX_STATUS_GROUPS.flatMap((group) => group.states);
