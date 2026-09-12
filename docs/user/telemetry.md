# Product usage data

Pylon does not send product usage data by default. The server only sends events when whoever runs it
configures a PostHog project key with `T3CODE_POSTHOG_KEY`.

With a key configured, the server sends product usage events to that PostHog project, associated with
a hashed account or installation identifier. Events include the provider, model, reasoning effort,
permission mode, turn result, duration, and main-agent token totals when available.

Events do not include prompts, responses, file contents, authentication tokens, conversation IDs, raw
provider events, or child-agent output. Child-agent token use is excluded from the totals.

To turn collection off on a server that has a key, set `T3CODE_TELEMETRY_ENABLED=false` in the
server's environment before starting it. This stops product events from being recorded or sent.
