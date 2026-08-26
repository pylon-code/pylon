# Message composer

Messages can contain up to 120,000 characters. If a draft is longer, Pylon keeps it in the
composer and shows how many characters need to be removed. Shorten the draft or split it into
multiple messages, then send again in the same thread.

In the web and desktop apps, on servers that support direct uploads, images upload as soon as you
add them. The send button becomes available after every upload finishes. Failed uploads can be
retried or removed. The mobile app sends images with the message instead.

On web and desktop, HEIC and HEIF photos are automatically converted to JPEG when you drag them into
the composer or paste them into a message.

## Commands and skills

Type `/` to open the command menu. Type `$` to find and add a skill. Skill rows show their source,
such as System, Personal, Project, or App.

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

Click it to compare every configured account for that provider, see when each window resets, and
refresh the reading. Pylon polls capacity on the provider-health interval, updates it as a running
turn reports its limits, and keeps the last good reading through a failed check; the readout dims
and says how old it is when it has fallen behind.

Prime Agent has no capacity of its own. A Prime thread shows the capacity of the backend the selected
model runs on: your Claude accounts for an Anthropic model, your Codex account for an OpenAI Codex
model. Pylon assumes Prime Agent is signed in to the same subscription. Prime's own default model,
and backends Pylon has no provider for, show nothing.

Turn the readout off with **Subscription capacity in the composer** in **Settings → General**.
