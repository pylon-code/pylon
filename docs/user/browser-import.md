# Import browser sessions

The desktop app can import cookies from another browser so you can reuse its signed-in sessions
in the preview browser.

Open **Settings → Integrations → Browser profiles → Add profile**, then choose a browser under
**Import from**. A browser appears once it has a profile with a cookie database. Close the source
browser before importing, and allow an operating-system keyring unlock prompt if one appears.

This is a one-time copy. Later login changes stay separate between the two browsers, and some
sites may still require you to sign in again. Partitioned cookies are skipped on all platforms.

## Platform notes

On Linux, import finds Helium and both native and Snap installations of Firefox. Chromium-based
browsers protect their cookies with your desktop keyring; Pylon reports a keyring failure when no
cookies can be imported.

On macOS, Safari protects its cookies with Full Disk Access. The import wizard's
**Open System Settings** button opens that permission pane, and macOS may ask you to quit and
reopen Pylon before the grant applies. Choose the Safari profile to import, including named
profiles. You can revoke Full Disk Access afterward.

On Windows, import supports Firefox and Helium profiles that use standard profile encryption.
Other Chromium-based browsers use app-bound encryption and cannot be imported.

## Browser profiles

Browser profiles keep separate logins for each connected environment on this desktop. **Default**
uses the existing browser data; **Incognito** keeps data only until the app closes. Choose a default
profile in Settings or pick one when opening a browser tab. Existing tabs keep their profile.

Custom profiles and Incognito require an updated Pylon server for the connected environment. If its
server is older, Pylon asks you to update it before opening those profiles.
