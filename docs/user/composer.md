# Messages and context

Give the agent a task in the composer. Add files, quote a previous response, or include a skill when
the task needs more context.

Messages can contain up to 120,000 characters. Longer drafts stay in the composer with a count of
the characters to remove, so you can shorten them or split them into several messages.

## Attach files

Attach up to eight files per message. Images can be up to 10 MB. On servers that support file
uploads, you can also attach videos, text files, PDFs, archives, and other files up to the limit the
server advertises, capped at 50 MB. Files upload to the environment, where the agent can read, copy,
or edit them by their file path.

Uploads begin when you add an attachment. On web and desktop, all uploads must finish before the
message can send, and reloading before an upload finishes leaves the file marked **Attach again**.
In the mobile app you can send while an upload is still running: the message waits on your device
and sends once its files reach the server. A Prime Agent follow-up still waits for its uploads.
Retry or remove a failed upload.

You can drag or paste images into the web or desktop composer. HEIC and HEIF photos are converted to
JPEG there and when selected from the mobile photo library; photos over the image limit are also resized
to fit. On mobile, tap **+** for **Photo Library** or **Choose Files**, or send photos, videos, and files to
Pylon through another app's share sheet. Select a received file on mobile to preview it, save it,
or open it in another app.

See [images and videos](#images-and-videos-in-messages) for previewing and saving media.

## Send while the agent is working

On web and desktop, choose **Settings → General → Follow-up behavior** to queue
new messages for a later turn or steer the running turn immediately. The setting
applies to this client; already queued messages keep their place. Queued messages
are saved on the server and can be edited, reordered, or removed above the composer.
`Cmd+Enter` on macOS or `Ctrl+Enter` on Windows and Linux uses the opposite action:
it steers when your default is Queue and queues when your default is Steer.

Use `Cmd+Shift+Enter` on macOS or `Ctrl+Shift+Enter` on Windows and Linux to send
the oldest queued message as a steer. This leaves the current draft intact and
requires an active turn that supports steering. Change
`thread.steerQueuedMessage` in **Settings → Keybindings** to use another shortcut.

Press `Option+Up` on macOS or `Alt+Up` on Windows and Linux with the cursor at the
start of the composer to edit the most recently queued message. Change
`thread.editQueuedMessage` to use another shortcut.

Mobile has the same choice under **Settings → Follow-ups**. While a turn is
running the send button shows which action it will take. Long-press it to use the
other action for a single message, or hold `Cmd` while sending from a hardware
keyboard. The button only offers Steer when the running agent supports it.

## Queue messages offline on mobile

Mobile keeps local copies of draft attachments, so you can preview them and queue messages while
disconnected. Uploads resume when you reconnect. Drafts and queued messages survive app restarts.
Signing out of Pylon Connect keeps that work on your device until you sign back into the same
account.

## Models

New threads start with the first model that is set, in this order:

1. The project's default model, from its page in **Settings → Projects**.
2. The default model for the machine the thread runs on, from **All projects** on the same page.
3. The last provider, model, and model options you selected, which Pylon remembers.

Resetting a project's model returns that project to the machine default. Resetting the machine
default returns new threads to your remembered selection. Leaving reasoning level or service tier
unset uses the provider's own configuration; Pylon sends only the options you choose.

On web and desktop, use **Settings → Providers → Models** to add an unlisted model with a custom
name and options. Only options supported by the provider integration affect turns. Antigravity uses
its account catalog and does not support custom models.

## Subscription capacity

On web and desktop, the bar above the composer shows how much of the selected account's
subscription is spent: the rolling session window and the weekly total, each with the time until it
resets. It follows the account the composer will send to, so picking another account in the model
picker changes the readout. Click it to compare every configured account for that provider.

Readings update as a running turn reports its limits and keep the last good value through a failed
check. Provider usage endpoints are rate limited, so Pylon reads each account at most every few
minutes and every Pylon server on the machine shares that reading. The readout dims and shows its
age once a reading falls behind, and only then offers **Refresh**.

Prime Agent signs in to its backends on its own, so a Prime thread shows the capacity of the account
Prime is actually using for the selected model: Prime's own recent reading for Anthropic or ChatGPT,
or the configured Codex account whose identity matches Prime's sign-in. When neither can be read,
Pylon shows your configured accounts for that backend and says the match is assumed. If Prime is
signed in to a Codex account that Pylon does not have configured, the readout says capacity is
unavailable rather than showing another account's numbers. Prime's own default model, and backends
Pylon has no provider for, show nothing.

Turn the readout off with **Subscription capacity in the composer** in **Settings → General**.

## Quote an assistant response

On web and desktop, select text within one assistant response and choose **Cite in composer**. You
can add a comment about the quote and write instructions around it. A quote can be up to 8,000
characters, and the quote and comment count toward the message limit.

Select the quote in a draft or sent message to return to its source, including in older history.
If the source is unavailable or has changed, the saved quote remains readable and Pylon shows a
warning.

The quote chip shows your comment when it has one. Use its pencil button to change the comment,
or delete the chip beside the caret to remove the citation. Copying, reloading, and stashing a
prompt keep the comment with its quote.

Mobile displays saved quotes and comments, but does not create citations or navigate to their
sources.

## Recall a sent prompt

Press `ArrowUp` in an empty composer to bring back the last prompt you sent in this thread, and
again to go further back; `ArrowDown` comes forward and clears the composer past the newest prompt.
Only the text you typed returns, not attachments or other context. While the composer holds text,
arrow keys move the caret unless the text is an unedited recalled prompt and the caret is on its
first or last line.

## Edit an earlier prompt

On web and desktop, choose **Edit from here** beneath a sent message to rewind
the conversation to before that message. Choose **Revert and keep changes** to
leave workspace files as they are, or **Revert files too** to restore them as well.
File restore is only offered for threads running in a worktree, and it is
refused when another thread or agent session also uses that directory, a folder
inside it, or a folder that contains it, since
restoring would erase their changes. A thread that works in the project directory
rewinds the conversation only. The selected prompt and
its attachments and inline context return to the composer for editing and resending. Any unsent
draft stays above the restored prompt. Mobile offers the same file choice in its
existing rollback action; restoring the prompt to the composer is available on
web and desktop.

This removes the selected message and later conversation from the active thread
and provider history. It does not undo external actions or separate provider
memory. Pylon enables the action only when the active provider and saved checkpoint support rollback.
Prime conversation rollback is unavailable in the initial v2 bridge. See
[conversation rollback](./conversation-rollback.md) for availability and failure behavior.

## Prompt stash

On web and desktop, press `Cmd+S` on macOS or `Ctrl+S` on Windows and Linux to save the current
prompt and its attachments for later. Wait for uploads to finish first. With an empty composer, the
same shortcut restores a single stash or opens the stash menu when there are several.

Stashes containing uploaded files must be restored in their original environment. Those files are
retained for 24 hours. After an upload expires, restore the prompt and use **Attach again** or
remove the missing file before sending.

## Browser preview annotations

On desktop, pick an element in the browser preview to attach an annotation or send it to the
composer. If its screenshot cannot be captured, Pylon keeps the annotation without it and shows a
warning. Annotations in an unsent draft survive a reload, including when you move the draft into a
new thread to resolve a provider conflict.

## Voice input on iPhone

On supported iPhones with iOS 26 or later, use the composer's microphone to record, then confirm to
transcribe. Text is inserted where your selection was when recording started, ready for you to
review and edit before sending.

The first use may download Apple's speech model and needs a network connection. Later transcription
works offline for that language. Recordings can be up to five minutes long. Canceling, leaving the
screen, or an audio interruption discards the recording and preserves your existing draft. While
recording, the screen stays awake; it can sleep normally once recording stops.

Transcription runs on your device. Pylon deletes the temporary audio after transcription or
cancellation; only the message text is sent when you submit.

## Queued messages

On web and desktop, the composer shows **Interrupt** while the agent is working and the draft is
empty. Adding text or attachments replaces it with a steer arrow. Click it to send a message into
the active turn, or press `Enter` on desktop. Hold `Cmd` on macOS or `Ctrl` on Windows and Linux to
switch the button to a queue icon. Click while holding that key, or press `Cmd+Enter` or
`Ctrl+Enter` on desktop, to queue the message for after the active turn.

Queued messages appear above the composer. Rows show a thumbnail of any attached image alongside
the text. Drag a row by its handle to reorder it, use the handle's arrow keys, promote the message
to a steer, or remove it.

If the server restarts, saved queued messages keep their order and are held. Press
**Resume** in an empty composer on web or desktop, or **Resume queue** in the queue
sheet on mobile, to continue. You can edit, reorder, or remove held messages without starting them.

The pencil on a queued row opens that message in the composer for editing. The original message
stays in the queue until you save, and its row is highlighted while you edit. The message's
attachments appear above the text with a remove control, and new images can be added the usual way.
The checkmark saves the queued message in place; **Cancel** on its row leaves it unchanged. Whatever
you had typed in the composer before starting the edit is restored afterwards. If the queued
message starts or is removed while you are editing, the edit ends: changed content moves into the
composer when it is empty, and is discarded otherwise.

## Commands and skills

Type `/` for commands or `$` to add a skill from the selected environment and provider. On mobile,
both are also available before starting a thread on **New task**. For Codex, Claude, Cursor, Grok,
and OpenCode, the skill list includes skills from the current project or worktree on that
environment, so remote projects use their remote skills.

The slash menu also includes skills unless you turn off **Settings → General → Show skills in slash
menu**. Only skills enabled for the provider are listed. A skill token runs the skill wherever it
sits in your message.

After you add or change skills, plugins, or MCP servers, use **Restart agent session** in the
command palette on web and desktop. The conversation continues, and your next message starts the
agent again with the new setup.

Provider commands must start the message to run. Pylon commands such as `/model` and `/plan`, and
skill mentions, work on any line.

Send `/compact` in an existing conversation to reduce context usage when the provider supports it.
Web and desktop also offer compaction from the context meter.

## Context in your message

Attached context appears as a chip at the caret: a terminal excerpt, review comment, preview
annotation, file, or image. Write around a chip, move it with cut and paste, or delete it like a
character. Select a chip to inspect its captured content. File references open the current file;
attached files open the copy included with the message.

On web and desktop, type `#` to find pull requests in the project's repository. Digits filter the
recent list and resolve a complete number directly; a word searches by text. Choose a result to
attach its title, branches, and status. The chip's status reflects the moment it was attached.

Another thread can be context too. Type `@` followed by part of its title to pick one from
the same server, or on web and desktop drag a thread out of the sidebar and drop it on the
composer; a multi-selection drops together. The chip shows the thread's current title and
opens it when selected. Your prompt only carries a reference: the agent reads the thread's
history on demand, so attaching a long thread costs nothing until the agent looks. Attaching a
thread does not change it, and the agent cannot send messages to it unless you ask.

Images keep their thumbnail shelf above the text and also get a chip at your cursor, so you can
say exactly which image you mean. Deleting an image chip leaves the image on the shelf; removing
the thumbnail asks first when the image is still mentioned in your text, then removes both. Files
exist only as chips: deleting a file's last chip removes the file from the message.
Images remain in the thumbnail shelf when you delete their chips. Removing a thumbnail asks for
confirmation if the image is still referenced, then removes both. Files live only in chips:
deleting the last reference removes that file from the message.

Copying text with chips into another draft preserves their context. Images and files are fetched
again from their source environment. If that environment is unreachable or the attachment is
gone, Pylon keeps an unresolved chip for you to remove or replace. Copying into another app gives
readable Markdown. Older messages remain readable, and stashing a prompt keeps its context.

## Attached files

Select a file chip in a draft or sent message to preview it. Code and JSON have syntax highlighting;
Markdown, HTML, CSV, and TSV offer rendered and raw views. Audio has playback controls. Large text
files show a limited preview; save the file to read it in full.

On web and desktop, attached files open beside the conversation with the workspace file viewer's
copy, save, and view controls. On mobile, the file screen offers copy, save or share, and the
native file viewer. Pictures, videos, and PDFs retain their viewers. Other document formats open
in a compatible installed viewer; otherwise save or share the file to open it elsewhere.

## Images and videos in messages

Select an image or video attachment or link to preview it inside Pylon. Workspace media opens in
the file viewer. Playback support depends on your browser or device; save an unsupported video to
open it in another app.

On web and desktop, right-click media to save it or copy its path or URL. On mobile, touch and hold
an image or video thumbnail to copy its source or choose **Save or share**.

Agents can embed media with Markdown image syntax, and links open the same preview:

```markdown
![Screenshot](/tmp/screenshot.png)
![Recording](/tmp/recording.mp4)
[Open recording](/tmp/recording.mp4)
```

Relative paths resolve from the thread's workspace. Absolute paths and `file://` links refer to the
environment's machine, including when you connect remotely, and can point outside the workspace.
Previews use the original file, so moving or deleting it can break the preview; save a copy if you
need to keep it. Bare paths in prose, paths in code blocks, and raw HTML `<video>` tags stay text.

On desktop, when a remote thread embeds media the remote environment cannot find, Pylon tries the
same absolute path on the desktop app's own environment. A file on the remote environment always
wins, and network share paths never fall back.

Public web links can show a site icon. Links to localhost, private networks, Tailscale hosts, and
reserved hostnames use a local icon, so those hostnames are not sent to the public icon service.

## Files outside the workspace

Follow an agent's file link to read a report or other file outside the workspace. These files open
read-only. An HTML file outside the workspace cannot load scripts, styles, or images from
neighboring files. POSIX paths are case-sensitive when Pylon decides whether a file belongs to the
workspace, so `/work/Project` and `/work/project` differ; Windows drive and UNC paths are not.

## HTML and PDF files in the file viewer

On web and desktop, HTML and PDF files open as rendered pages. Switch an HTML file to source view to
read its markup; a link to a specific line opens source automatically. HTML previews cannot access
your Pylon session.

The file viewer recognizes images, HTML, and PDF files by their filename extension, including
filenames or folders containing `#` or `?`.

On mobile, select a PDF attachment or link to open it. iOS uses the native viewer; Android opens a
compatible installed file viewer.

## Collapse the composer while reading

On web and desktop, scrolling an existing conversation can collapse the composer to a single line.
Focus it or start typing to expand it again. Turn off **Settings → General → Collapse composer on
scroll** to keep it expanded.
