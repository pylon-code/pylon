# Browser snapshots for agents

An agent can inspect a page in Pylon’s browser with a snapshot. By default, the response includes
page text, interactive elements, diagnostics, and a screenshot.

For tasks that only need page text or controls, ask the agent to use text-only snapshots. The
`preview_snapshot` tool accepts `includeImage: false`, which keeps the page metadata and leaves
the image out of that response. Each call reads fresh page state. Omitting the option or setting
it to `true` includes the screenshot again.

Text-only snapshots can help avoid accumulating images in a conversation. They do not remove
screenshots already sent to a provider. The browser still captures a complete snapshot.
