# Status indicators

Pylon uses small dots, icons, labels, and progress marks to show what needs your
attention. Color has a consistent meaning:

- **Sky** means a thread is working, connecting, or running delegated work.
- **Amber** means an approval is required.
- **Indigo** means Pylon is waiting for your input.
- **Violet** means a plan is ready to review.
- **Emerald** means work completed successfully.
- **Red** means work failed.
- **Muted** indicators are idle, offline, or waiting without requiring action.

Monitoring states remain still. Active progress can pulse, but Pylon stops that
motion when your device has Reduce Motion enabled.

Connection indicators use green for connected, amber for connecting or
reconnecting, red for an error, and muted grey while offline. Connecting or
reconnecting environments use an amber halo. Connected client sessions use a
green liveness halo. Reduce Motion hides both halos.

Task lists use `✓` for completed steps, `●` for the current step, and `○` for
pending or passive waiting steps. A step that is specifically waiting for you
uses an amber `●`.
