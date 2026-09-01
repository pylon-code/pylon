# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Pylon keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

You can attach images up to 10 MB. On servers that support file uploads, you can also attach text
files, PDFs, ZIP archives, and other files. Each file can be up to the limit advertised by the
server, capped at 50 MB. Each message can carry up to eight attachments in total. Files upload
directly to the environment, where your agent can read, copy, or edit them by their file path.

In the web and desktop apps, attachments upload as soon as you add them. The send button becomes
available after every upload finishes. Failed uploads can be retried or removed. In the mobile app,
the **+** control offers Photos, and adds Files when the connected server supports file uploads. You
can share a file into Pylon from any app through the system share sheet. Mobile uploads happen when
the message sends, so queued messages keep their files until they deliver. Select a received file on
mobile to save it or open it in another app through the system share sheet.

On web and desktop, select a video attachment before or after sending to play it with the browser's
built-in controls. Playback depends on the video formats and codecs that the browser supports.

On web and desktop, if you reload before a file finishes uploading, the draft keeps the file's name
and shows **Attach again** next to it. Attach the file again or remove it, then send.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

On mobile, the model picker shows each OpenCode model's upstream provider, such as Anthropic,
GitHub Copilot, or OpenCode Zen, beneath its name. Search by that provider name to narrow the list
when starting a thread or changing an existing thread's model.

## Notices above the composer

On web and desktop, loading and syncing statuses fill the available banner width beside the
stash tab. Task progress appears above the composer, while the timeline's working timer shows
only elapsed time.

On web and desktop, additional notices peek out above the attached banner. Hover over the peek
to reveal them, or focus **Show other notices** with `Tab` and press `Enter` or `Space`. Press
`Escape` to close the stack and return focus to that control. On a touchscreen, tap the peek to
open the stack. Interacting with the attached banner or composer does not open the stack.

## Prompt stash

Use the default shortcut, `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux, to stash the current
prompt and its attachments after all file uploads finish. Restore the entry later from the stash
menu. Stashes that contain files must be restored in the environment where those files were
uploaded. Stashed files stay uploaded on the server for 24 hours. If you restore an entry after
that, the file comes back with **Attach again** next to it. Attach the file again or remove it, then
send.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

On mobile, these menus are also available on the **New task** screen before you start a thread.
They use the skills and commands from the selected environment and provider.

By default, the `/` menu includes skills. To keep this menu command-only, turn off **Show skills in
slash menu** in **Settings → General** in the web or desktop app. Skill results use the
`/skill:Skill Name` label and add the same `$name` skill token to your message. The original skill
name remains searchable. If the provider also reports that skill as a native slash command, Pylon
hides the duplicate native entry and keeps the `/skill:Skill Name` label.

On desktop, press `Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux from a new thread to
start it in the background. Pylon opens another new thread and shows an **Open** action for the
thread that started. The new thread keeps the selected workspace mode and base branch. If **New
worktree** is selected, each background thread creates its own worktree.

## Subscription capacity

On web and desktop, the bar above the composer shows how much of the selected account's
subscription is spent: the rolling session window and the weekly total, each with the time until it
resets. The account is the one the composer will send to — pick a different account in the model
picker and the readout follows.

Click it to compare every configured account for that provider and see when each window resets.
Pylon polls capacity on the provider-health interval, updates it as a running turn reports its
limits, and keeps the last good reading through a failed check. The providers' usage endpoints are
rate limited, so Pylon reads each account at most every few minutes — and every Pylon server on the
machine shares that one reading, so running several does not multiply the requests. The readout
dims and says how old it is once a reading has fallen behind, and only then offers **Refresh**.

Prime Agent signs in to its backends on its own, so a Prime thread shows the capacity of the
account Prime is actually using for the selected model: Prime's own reading for Anthropic and for
ChatGPT whenever Prime has used that backend recently, refreshed again each time a Prime turn
finishes. For an OpenAI Codex model without a recent reading it is the configured Codex account whose
identity matches Prime's sign-in. When neither can be read, Pylon shows your configured accounts for
that backend and the popover says the match is assumed. If Prime is signed in
to a Codex account that is not configured in Pylon, the readout says the capacity is unavailable
rather than showing another account's numbers. Prime's own default model, and backends Pylon has no
provider for, show nothing.

Turn the readout off with **Subscription capacity in the composer** in **Settings → General**.
