# Dot Matrix status language

Pylon uses one 5×5 Dot Matrix primitive for compact lifecycle status on the web
and desktop surfaces. The component is adapted from assistant-ui's standalone
Dot Matrix and adds Pylon-specific orchestration, queue, and terminal states
for product concepts that the reference palette does not represent.

## Truth contract

A pattern represents a known lifecycle fact. Motion alone does not mean
"Working," and a label must not upgrade queued or waiting work into active work.

| Product fact                                     | Dot Matrix state                | Motion                              |
| ------------------------------------------------ | ------------------------------- | ----------------------------------- |
| Root turn is running                             | `loading`                       | deterministic twinkle               |
| Provider exposes active thinking                 | `thinking`                      | diagonal wave                       |
| Subagent or workflow is actively running         | `orchestrating`                 | circular fading-tail orbit          |
| Work is queued but has not started               | `queued`                        | static ellipsis                     |
| Work is waiting or blocked without user approval | `waiting`                       | animated ellipsis                   |
| Watch loop is active                             | `listening`                     | column activity                     |
| Environment is connecting                        | `connecting`                    | outward ripple                      |
| Connection is healthy                            | `success`                       | static check                        |
| Server update is downloading or restarting       | `downloading` / `syncing`       | directional / rotational wave       |
| Terminal identity is inactive or complete        | `terminal`                      | static prompt and three-dot cursor  |
| Terminal indicator is active outside a live row  | `terminal-active`               | synchronized prompt breath          |
| Terminal work is streaming in the transcript     | `terminal` inside the live row  | one foreground sweep with its label |
| Successful, failed, or warning outcome           | `success` / `error` / `warning` | semantic glyph                      |
| Paused, stopped, or offline                      | matching state                  | static                              |

The full assistant-ui palette remains available for facts such as streaming,
searching, uploading, downloading, listening, speaking, and recording. Callers
must not select a more specific state unless Pylon has that fact.

The circular `orchestrating` state is a Pylon extension. It is reserved for
subagent and workflow coordination. Generic root work must not use it. The
static `queued` state distinguishes pending work from animated waiting. The
The `terminal` and `terminal-active` states are Pylon extensions. Active thread
and sidebar terminal indicators use the synchronized breathing variant. A streaming
transcript row keeps the terminal glyph itself static and sweeps one foreground
highlight across both the glyph and its label, avoiding competing animation.

## Color

Neutral activity uses `currentColor` through the semantic `text-foreground`
token. It appears near-white on dark themes and near-black on light themes.
Callers do not force blue for generic activity.

Color is reserved for meaning:

- healthy or successful: `text-success`;
- failure and recording: `text-destructive`;
- warning or approval: `text-warning`;
- informational state: `text-primary`;
- resting and disconnected state: `text-muted-foreground`.

## Motion and accessibility

Only live or attention states receive CSS animation timelines. Static outcomes
and resting states do not animate. Dot timing is deterministic so server and
client markup agree. Smooth opacity timing is the client-local default. Users
can select Efficient stepped timing in Settings → Appearance → Status language
for lower continuous rendering cost on their device. `prefers-reduced-motion`
overrides either choice and disables every Dot Matrix animation while keeping
the state pattern and tone visible.

A meaningful standalone matrix with a label has `role="img"`. Without a label,
the primitive is decorative by default. Adjacent status text owns live-region
semantics so screen readers do not announce the same state twice.

## Settings catalog

Settings → Appearance → Status language exposes the full state vocabulary on
demand through View catalog. The catalog mounts its live animations only while
open, and also shows the composed streaming terminal row, which is not a
separate Dot Matrix state. Keep this catalog complete whenever a state is added
or removed.

## Surfaces

The web primitive is shared by the browser and Electron desktop client. Mobile
uses a separate React Native indicator and must map the same lifecycle facts,
but it does not share this SVG or CSS implementation.
