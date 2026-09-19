# Mobile notifications

Sign in to Pylon Connect, link your environments, and enable **Device Notifications** in Settings to
receive alerts when an agent finishes, fails, needs approval, or asks for input. Tap a notification
to open its thread. Your environment must have agent activity publishing enabled.

Enable **Live Activity Updates** on iOS, or **Ongoing Agent Activity** on Android, to follow work
without opening the app. Finished results remain visible for up to 15 minutes.

A switch reads on only when this device can actually receive notifications. If Pylon Connect
registered the device but it could not get a push token from the system, the switch stays off and
Pylon tells you why when you try to turn it on.

Ordinary alerts stay quiet while the mobile app is in the foreground. Activity updates continue.
Viewing a thread on another device does not silence your phone's alerts.

Background delivery requires Pylon Connect; a direct or Tailscale connection alone does not enable
push notifications. The mobile app does not need to maintain a connection to your environment.
Notification permission is controlled in system Settings.

## Android

Android notifications work only in Pylon Mobile builds that include push support. In other builds,
both switches stay off with **This app build can't receive notifications**. If Settings says to
install a newer app build instead, update Pylon Mobile.

Where push is supported, Android notifications require Android 7.0 or newer and Google Play
services. You can dismiss an activity card without disabling alerts; turn off **Ongoing Agent
Activity** in Settings to stop future cards. Android 16 and newer can promote ongoing activity to a
Live Update, subject to system settings and device support; other devices show a regular ongoing
notification. Android 7's battery-saving modes can delay removal of expired cards.

Android notification channels are controlled in system Settings. Force-stopping the app in system
Settings prevents push delivery until you open it again.
