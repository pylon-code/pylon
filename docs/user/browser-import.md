# Import browser logins

In the desktop app, open **Settings → Integrations → Browser profiles → Add profile**
and choose a browser under **Import from**. The import copies cookies into a Pylon browser
profile so you can use existing logins in the preview browser. Changes made afterward stay
separate from the source browser.

Linux discovery includes Helium and both native and Snap installations of Firefox. Windows
discovery includes Firefox and Helium builds that still use Windows' standard profile
encryption. Other Chromium-based browsers on Windows use app-bound cookie encryption and cannot
be imported. A browser appears once it has a profile with a cookie database. Close the source
browser before importing; the import wizard will prompt you if it is still running.

On Linux, Chromium-based browsers use your desktop keyring to protect their cookies. Pylon
includes the keyring reader; no separate command-line tool is needed. Allow the desktop unlock
prompt if one appears. If the keyring cannot be accessed, Pylon reports that failure when no
cookies can be imported. Partitioned cookies are skipped.

On macOS, Safari protects its cookies with Full Disk Access. The import wizard’s **Open System
Settings** button takes you to that permission pane. macOS may require you to quit and reopen Pylon
after granting access. You can revoke Full Disk Access after importing. Choose the Safari profile whose cookies you want to import, including named profiles.

Browser profiles keep separate logins for each connected environment on this desktop. Default
uses the existing browser data; Incognito keeps data only until the app closes. Choose a default
profile in Settings or pick a profile when opening a browser tab. Existing tabs keep their profile.

Custom profiles and Incognito require an updated Pylon server for the connected environment.
If its server is older, Pylon asks you to update it before opening those profiles. Default remains
available.
