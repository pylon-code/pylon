# Status indicators

Pylon uses compact Dot Matrix patterns to distinguish active work, queued work,
waiting, orchestration, connection phases, terminal activity, and settled
outcomes. Motion represents a known active state rather than a generic
“Working” label. Active work uses the theme's active color (blue in the
standard theme). Info uses purple. Operational Waiting and active terminal
identity use the normal foreground color. A thread that needs your input uses
an orange exclamation indicator. Collapsed task progress uses a
compact solid segment bar; expanded task rows use the same Dot Matrix language.

## Choose the motion style

1. Open **Settings**.
2. Select **Appearance**.
3. Find **Status language**.
4. Set **Status motion** to one of these options:
   - **Smooth** uses fluid fades and is the default.
   - **Efficient** uses stepped frames to reduce continuous rendering on the
     current device.

Your operating system’s Reduce Motion preference pauses status animation in
either mode.

## Preview the status language

Under **Status catalog**, select **View catalog** to inspect every pattern and
its meaning. The catalog begins with compact, inline, and prominent size
previews, then shows the streaming terminal-row treatment. Select **Hide
catalog** when you are done; its live previews are removed rather than
continuing to animate in the background.
