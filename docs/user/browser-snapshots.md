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
