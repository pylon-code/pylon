# Notifications

Pylon can alert you when an agent needs approval, asks for input, finishes a turn,
or fails. Click an alert to open its thread. Completion refers to the foreground
turn; separately running background work may continue.

Delegated child threads do not send notifications. Follow their progress in the parent thread’s
subagent panel; the parent thread can still notify you.

## Desktop

Open **Settings → General → Notifications**. Native desktop notifications and
all four event categories are on by default. Turn off the master switch or
individual categories to reduce interruptions. Notification sounds are opt-in.
Select **Send test notification** to check system delivery even while Pylon is
focused. Your operating system may hide banners when notifications are denied
or Focus / Do Not Disturb is enabled. On Linux, a notification daemon is required.

## Browser and in-app alerts

In a browser, choose **Settings → General → Behavior → Thread notifications**
to enable system notifications, sounds, or both. Browser notifications need a
supported secure context and permission. Sound requires interaction with the
page after enabling it. These options are off by default.

Enable **In-app notifications** to show a notice when another thread needs your
attention while you are using Pylon. System popups are suppressed while Pylon is
focused; enabled sounds can still play. Background system notifications also
add a badge, which clears when you return to the app.

## Delivery behavior

Preferences belong to this device. The app or browser tab must remain open to
observe new events; this feature does not add mobile push notifications.
Opening or reconnecting Pylon does not replay old alerts. Events suppressed by
focus or preferences are consumed rather than saved for later. Archived threads
are silent. Clicking a previously delivered desktop notification can reopen its
thread even if you closed the main window.
