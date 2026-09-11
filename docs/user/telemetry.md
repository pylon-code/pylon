# Product usage data

Pylon does not send product usage data by default. The server only sends events
when whoever runs it configures a PostHog project key with
`T3CODE_POSTHOG_KEY`.

When a key is configured, events go to that PostHog project, associated with a
hashed account or installation identifier. They include the provider, model,
reasoning effort, permission mode, turn result, duration, and main-agent token
totals when the provider reports them. Token totals can be complete, partial, or
unavailable, and child-agent token use is excluded.

Events do not include prompts, responses, file contents, authentication tokens,
conversation IDs, raw provider events, or child-agent output.

To turn collection off on a server that has a key, set
`T3CODE_TELEMETRY_ENABLED=false` in the server's environment before starting
it. This stops product events from being recorded or sent.
