# Browser snapshots for agents

An agent can inspect a page in Pylon’s browser with a snapshot. By default, the response includes
page text, interactive elements, diagnostics, and a screenshot.

For tasks that only need page text or controls, ask the agent to use text-only snapshots. The
`preview_snapshot` tool accepts `includeImage: false`, which keeps the page metadata and leaves
the image out of that response. Each call reads fresh page state. Omitting the option or setting
it to `true` includes the screenshot again.

Text-only snapshots can help avoid accumulating images in a conversation. They do not remove
screenshots already sent to a provider. The browser still captures a complete snapshot.

## Long pages

Agent tools limit how much text one result can carry, so the snapshot text an agent reads stays
compact. It leaves out the accessibility tree, shortens long page text and element names, and keeps
the newest console, network, and action entries. When anything is shortened or left out, the
snapshot says what, and the agent can read more of the page with `preview_evaluate`.

## Saving screenshots

A snapshot’s screenshot is not saved anywhere unless the agent asks. With `save: true`, Pylon writes
the PNG to the environment the agent runs in and returns its path, so the agent can embed the
screenshot in its reply for you to see.

## Recordings

When an agent stops a browser recording, the desktop app saves the video and then transfers the
finished file once to the environment the agent runs in. The agent receives a path it can read even
when that environment is remote. Transfers are limited to 50 MiB, and saving and transferring share a
two-minute limit. If a recording is too large, the transfer fails or runs out of time, or the desktop
app is too old to transfer recordings, the agent receives an error and the saved copy stays on the
desktop.
