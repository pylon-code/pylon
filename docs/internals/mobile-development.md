# Mobile development lifecycle

Ordinary component changes use Metro Fast Refresh. The connection runtime uses
a stable development-only atom runtime whose writable layer atom receives the
newly evaluated Effect layer. Its module accepts the update only after installing
that layer. Existing subscribers observe the new context, and Effect releases the
previous runtime scope without restarting React Navigation. Production uses an
ordinary `Atom.runtime` without this hot-update boundary.

Replacing the atom registry itself disposes its old nodes; replacing the managed
runtime starts its asynchronous disposal. These modules use normal Metro update
propagation. The app does not call `DevSettings.reload` during their replacement.
React can still reset state when its normal Fast Refresh rules require it.

Do not reset the shared registry to clean up a connection-runtime edit: registry
reset removes listeners from unedited mounted consumers. Do not self-accept a
runtime module while leaving importers attached to its old implementation. A
hot-update boundary must install fresh behavior through the existing reactive
dependencies. These boundaries do not make every module-level atom family in the
app hot-swappable; new runtime singletons still need explicit ownership. Editing
the registry or managed runtime can still rebuild a much larger dependency graph
than an ordinary component or connection-runtime edit.

Environment supervisor scopes are children of the connection registry scope.
The registry's per-environment map supports targeted shutdown, but it cannot be
the sole owner: a supervisor created after that map's finalizer has run must
still inherit the closed parent scope. Otherwise interrupted startup or runtime
replacement can leave a session and WebSocket alive outside the current registry.

The Uniwind dependency patch still recompiles CSS on Metro updates so newly used
classes are discovered. It fingerprints the generated native stylesheet and
theme list, then skips development-only global invalidation when that output is
unchanged. A changed stylesheet or theme list still resets the style caches and
notifies subscribers. The digest is committed only after initialization succeeds.
Web and production retain their existing initialization behavior.

After installing or changing the Uniwind patch, restart Metro once with
`vp run dev:client:reset` from `apps/mobile`. pnpm gives patched packages new
filesystem paths, and cached transforms can otherwise retain references to the
previous package. Ordinary development starts should retain the transform cache.

All Pylon variants retain the fingerprint runtime policy and their Pylon schemes. A dependency patch can change the native fingerprint even when its implementation only changes JavaScript. Build a compatible binary before publishing an OTA for a changed fingerprint.
