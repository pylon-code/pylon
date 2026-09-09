# Desktop notifications

Pylon can show a system notification when an agent needs approval, asks for input,
finishes its work, or fails. Notifications appear while a Pylon window is open and
no Pylon window is focused. Click a notification to bring Pylon forward and open
the thread that raised it.

Closing the Pylon window stops new notifications, even if the server keeps
running. Desktop notifications are unavailable in a plain web browser.

## Preferences

Open **Settings → General → Notifications**. Desktop notifications and all four
event types are on by default. Use the master switch to turn them all off, or
choose which events notify you. Preferences are stored per device, so each
machine has its own settings.

Events that happen while Pylon is focused or a notification preference is off
are not saved for later delivery. Opening Pylon also does not notify you about
threads that were already finished or waiting for attention.

## Check delivery

Select **Send test notification** to check delivery, including while Pylon is
focused. This test works independently of the notification switches.

If no banner appears:

- On macOS, open **System Settings → Notifications** and allow notifications for
  the app. With unsigned builds, notifications may be attributed to **Electron**;
  check its notification settings as well.
- Check whether your operating system's Focus or Do Not Disturb mode is hiding
  banners.
- On Linux, make sure a notification daemon is running.

The test button reports when the system says notifications are unsupported.
It cannot reliably detect whether notification permission has been denied.
