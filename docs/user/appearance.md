# Appearance and themes

Open **Settings → Appearance** to choose a theme and follow the system appearance or stay in light
or dark mode. To use different themes for light and dark mode, select the corresponding preview
within each theme. Appearance preferences are saved separately on each device or browser.

## Mobile

Mobile has its own themes and text, code, and terminal preferences, stored on the device. It does
not follow environment themes or defaults. In **Settings → Appearance**, tap a theme card to use it
for both light and dark appearance, or tap a card's light or dark preview to change only that
appearance. **System** follows the device appearance.

On Android 12 or newer, choose the **Material You** theme to use colors from your wallpaper. Like
other themes, it can be selected separately for light and dark appearances, and it picks up a new
wallpaper when you return to Pylon. **Material You Layout** changes shapes and surfaces to match
Android's style. It is off by default and works with any theme.

## Custom themes

On web and desktop, choose **Create theme** to adjust a palette, or import a Pylon or VS Code
theme. Use **Inspect** in the theme editor to pick an area of the app and find the color that
styles it. Download your theme as JSON to share it.

## Environment themes

Some desktops publish the palette they are currently using so apps can match it. Environment themes
and defaults come from the environment your client is anchored to: the server serving your web app,
or the desktop app's own local environment. Additional connections do not publish themes to that
client.

Select a published theme in **Settings → Appearance** to follow its palette as the machine updates
it, without a restart. **Duplicate** makes an independent copy you can edit. A saved custom theme
with the same ID takes precedence. If the machine stops publishing the selected theme, Pylon falls
back to its standard theme.

Run this on the server to set a default and switch connected web and desktop clients to it:

```bash
t3 theme set nightfall
```

Clients that are offline apply it when they reconnect. Each client applies the setting once;
choosing another theme afterward sticks until the next `t3 theme set`. Run the command again to
reapply it, even if the name is unchanged.

`t3 theme clear` removes the default without changing anyone's current theme. `t3 theme show` lists
the default and published themes, and names the themes directory the server uses.

### Publish a theme

Save a theme exported from Pylon into `~/.pylon-code/userdata/themes/` on the server. A server
started with `--base-dir` or `T3CODE_HOME` uses the `userdata/themes` directory inside that base
directory instead. The filename supplies the theme ID: `nightfall.json` can be selected with
`t3 theme set nightfall`, and an `id` inside the file is ignored. Keep the filename stable when
updating its colors. Do not use `system`, `light`, `dark`, or a built-in theme's ID.

For an integration that generates a palette, this shorter format also works:

```json
{
  "name": "Nightfall",
  "appearance": "dark",
  "canvas": "#1a1b26",
  "accent": "#7aa2f7",
  "colors": {
    "terminalSelection": "#292e42",
    "error": "#f7768e"
  }
}
```

Set `appearance` to `light` or `dark` and supply hex colors for `canvas` and `accent`. Pylon
generates the rest. The optional `colors` overrides use the names in the theme editor's advanced
view; a name this version of Pylon does not recognize is ignored.

Write updates to a temporary file and rename it into place so clients never read a partial theme.
Invalid files are not published, and a theme with no usable colors is not listed.

## Motion

The main sidebar, right panel, and terminal drawer open and close immediately by default. Under
**Settings → Appearance → Motion**, move the **Panel animations** slider above 0 ms to add motion,
up to 400 ms. Navigating between threads, projects, settings, or pull requests always restores
panels immediately, and reduced-motion mode keeps panel changes immediate too.

## Environment artwork

Dev and Nightly environments can identify themselves with artwork at the top of the sidebar and in
the send button. Under environment identification in **Settings → Appearance**, choose **Artwork**,
**Version pill**, or **None**. Artwork is recolored to match each built-in theme; custom themes use
the version pill instead.
