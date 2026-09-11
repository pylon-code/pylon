# Model manifest

The [bundled manifest](../../apps/server/src/provider/model-manifest.json) allows
offline startup; fetching `model-catalog.json` from Pylon's public releases repository
lets model metadata change between releases. Failed fetches or invalid data preserve
the last usable manifest. Remote data must pass both catalog-reference validation and
the owning provider's adapter validation before replacing the cache.

The on-disk copy of the last successful fetch outranks the bundle even when it is
stale; the bundle is used only when no valid remote cache exists. Editing the bundled
file therefore does not correct model data for an environment that already holds a
cached catalog. Publish the change through the
[publishing runbook](../operations/model-manifest.md), which also produces a
`model-manifest.json` compatibility feed with only `version` and `currentModels` for
older releases whose strict schemas reject provider catalogs.

Generic catalog data describes presentation and capabilities. Each provider owns
its adapter schema and dispatch mappings. Claude uses the manifest for its entire
built-in catalog. Adding a model with an existing capability profile is a JSON
edit; a new profile is needed only for a new capability combination. Codex still
gets its model list from its app server.

`currentModels.claudeAgent` is frozen for releases that predate catalog discovery.
Do not extend it when adding Claude models. Codex uses `currentModels.codex` as a
legacy-classification overlay for discovered models.

Model data is schema-validated configuration. Tests should cover resolver, cache,
and adapter semantics with synthetic model names, so adding a model never requires
tests that repeat the configuration.
