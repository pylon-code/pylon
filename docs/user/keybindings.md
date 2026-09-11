# Keybindings

Customize shortcuts in **Settings → Keybindings** on web and desktop. That page lists the command IDs
and defaults available in your version and warns about conflicts. In the desktop app it also warns
when a shortcut matches your SnapShot shortcut, which is claimed system-wide and never reaches Pylon
while SnapShots are on.

## Edit the configuration file

Keybindings live on the environment's machine, in `~/.pylon-code/userdata/keybindings.json` by
default. You can edit this file directly. It is a JSON array of rules:

```json
[
  { "key": "mod+g", "command": "terminal.toggle" },
  { "key": "mod+shift+g", "command": "terminal.new", "when": "terminalFocus" }
]
```

Pylon creates the file with its defaults and adds new defaults on later startups unless one of your
rules already claims that command or shortcut. Invalid rules are ignored; if the file cannot be
parsed, Pylon uses defaults and the server logs a warning.

## Rule shape

Each rule requires a `key` shortcut and a `command` ID. An optional `when` expression restricts when
it runs.

Project scripts use `script.{id}.run`, such as `script.test.run`. Script IDs with a shortcut use 1–24
lowercase letters, digits, or hyphens and start with a letter or digit. Older scripts with other IDs
can still run, but cannot have a shortcut.

## Key syntax

Join modifiers and a key with `+`, such as `mod+shift+d` or `ctrl+l`. `mod` means Command on macOS
and Control elsewhere. Other modifiers are `cmd` / `meta`, `ctrl` / `control`, `alt` / `option`, and
`shift`.

## When conditions

Available context keys are `terminalFocus`, `terminalOpen`, `previewFocus`, `previewOpen`, and
`modelPickerOpen`. Unknown keys evaluate to `false`.

Combine keys with `!` for not, `&&` for and, `||` for or, and parentheses:

```json
{ "key": "mod+j", "command": "terminal.toggle", "when": "terminalOpen && !terminalFocus" }
```

## Precedence

The last rule whose key and condition both match wins, even if it belongs to a different command.
Put a more specific rule after a general one when they share a shortcut.

## Commands with special behavior

`chat.new` may ask you to choose a project when there is more than one. `chat.newLocal` skips that
chooser. Both use your [new-thread defaults](./thread-sidebar.md#start-a-thread).

`filePicker.toggle` (`mod+p`) opens file search for the active project, and `projectSearch.toggle`
(`mod+shift+f`) searches inside its files. Repeating either shortcut closes that search.

`thread.copyReference` (`mod+shift+c`) copies the open pull request panel URL, then the thread's pull
request link, or its thread ID when no pull request is available. `thread.settle` (`mod+shift+s`)
settles the active thread or restores it, and `thread.pin` (`mod+shift+p`) pins or unpins it.

`thread.stop` stops the running turn in the focused thread, including a turn still waiting to
start. `rightPanel.toggleMaximized` maximizes or restores the right panel. Neither has a default
shortcut; assign one here. When nothing is running, `thread.stop` leaves the key free for other
commands.

`themeEditor.toggle` (`mod+alt+shift+t`) opens or closes the floating theme editor. See
[Appearance and themes](./appearance.md#custom-themes).

## Reserved shortcuts

`mod+w` closes the active right-panel tab, or the terminal when it has focus. In the desktop app,
when nothing remains to close, it closes the window. In a browser, `mod+w` closes the browser tab;
rebind `rightPanel.close` and `terminal.close` to an available shortcut such as `alt+w`.

Many defaults include `!terminalFocus` so they do not intercept terminal input. Keep that condition
when remapping them if you want the same behavior.

## Desktop quit shortcut

Use `Cmd+Q` on macOS or `Ctrl+Q` on Windows and Linux. **Settings → General → Confirmations →
Quit shortcut** chooses how it confirms:

- **Hold** (the default): hold the shortcut for 1.2 seconds, or press it twice within 500
  milliseconds. A single quick press shows a hint instead of quitting.
- **Double press**: press the shortcut twice within 500 milliseconds. The first press shows a hint
  until that window ends.
- **Direct**: the first press quits.

In Hold and Double press, the second press quits immediately, and an unrelated shortcut cancels the
first press. Holding needs keyboard repeat; if holding does not quit, use two quick presses or the
application menu. Choosing **Quit** from the application menu always quits immediately. If you had
**Hold to quit** turned off before this setting existed, Pylon starts in **Direct**.
