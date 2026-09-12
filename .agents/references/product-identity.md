# Product identity

Read for branding, packaging, launch identity, or upstream desktop adoption.

## Compatibility names

Pylon still retains upstream compatibility identifiers such as `.t3`, `T3CODE_HOME`, `t3.json`, `npx t3`, `@t3tools/*`, `com.t3tools.*`, and some T3-named source files. Treat those as implementation details, not product copy. Do not rename compatibility identifiers during branding or UI work unless the developer explicitly expands the scope and the migration is handled across every client and connection mode.

The desktop product identity is deliberately independent from T3 Code so both apps can be installed and run at the same time. Preserve these Pylon-owned boundaries when adopting upstream desktop work:

- macOS/Windows application ID: `com.pylon.code` (`com.pylon.code.dev.*` for local development);
- renderer protocols: `pylon-code://` and `pylon-code-dev://`;
- runtime home: `~/.pylon-code` unless explicitly overridden;
- Electron profiles: `pylon-code` and `pylon-code-dev`;
- Linux executable/registration: `pylon`, the per-channel desktop entries `com.pylon.code.desktop`, `com.pylon.code.nightly.desktop` and `com.pylon.code.dev.desktop`, and the matching `com.pylon.code[.nightly|.dev]` WM class and Wayland app ID (Electron derives both from the desktop entry, and XDG portals require a dotted ID);
- packaged app and artifacts: `Pylon (Alpha)` / `Pylon (Nightly)` and `Pylon-*`.

T3-named environment variables may still be passed to the bundled compatibility server. They are not permission to point Pylon at T3's default runtime or Electron data directories.
