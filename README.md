# dsh-computer-use-native

Windows desktop control for DeepSeek Harness, built for a vision model.

The agent takes a screenshot, reads the interface from the pixels, and clicks
what it sees. Input tools accept coordinates measured on that screenshot and
convert them to screen coordinates themselves, so the model never does the
scaling arithmetic that makes vision-driven clicking unreliable.

## Why this exists

Accessibility-tree automation fails on modern Windows applications. Chromium,
WebView2, and Electron windows expose almost no accessible controls — a UI
Automation tree over the new Outlook or a Vivaldi window returns a handful of
nodes and no content. A tool built on that tree reports an empty window and the
agent cannot read the interface at all.

Screenshots do not have that problem. Whatever draws the pixels, the pixels are
there. A model that can see them can operate the application.

This provider therefore does the opposite of a tree-based tool: it captures the
real rendered surface with `PrintWindow` and `PW_RENDERFULLCONTENT`, which is the
only route that returns actual pixels for a DirectComposition surface, falls back
to a screen-region capture when that yields a blank frame, and hands the image to
the model with the coordinate mapping attached.

It also aims at a window without taking the desktop over. An agent that must raise
every window it touches makes the machine unusable for whoever is sitting at it,
so input posts messages to the target's own queue by default: nothing is raised,
the real cursor does not move, and the person at the keyboard keeps working. See
[Input routes](#input-routes-background-and-foreground) for the measured
behaviour and the two limits that come with it.

## Requirements

- Windows 10 or later, x64.
- Node.js 22 or later.
- A model route that accepts image input.
- DSH with the `computerUse`, `tools`, `systemPrompt`, and `attachments` services.

## Install

```sh
dsh plugin add dsh-computer-use-native
```

Or install straight from the repository, pinned to a commit so a later push
cannot change what you are running:

```sh
dsh plugin --profile web add github:dao-awa/dsh-computer-use-native#1354d1d1481619c2cc0a5ecccfa8180f1a34452a
```

The bundle's patch layer mounts two rows: `@deepseek-ai/dsh-computer-use`, which
owns the provider registration and is not part of the base bundle, and this
provider. Restart DSH and start a new session; bundles are mounted before a
session is created or resumed.

### Coexistence with an MCP desktop server

`computer-use-win` and similar packages are MCP servers bridged through
`@deepseek-ai/dsh-mcp-client`. They are not computer-use providers, so they do
not conflict with this one at registration. They do offer the model a second,
overlapping set of desktop tools, which is confusing in practice. Mount one or
the other.

## Tools

| Tool | Purpose |
|---|---|
| `computer_screenshot` | Capture the desktop or one window; returns the image and a viewport id. |
| `computer_window` | List windows, read one window's geometry, or raise a window. |
| `computer_click` | Click, double-click, or right-click at a point on the last screenshot. |
| `computer_move` | Move the pointer without clicking, for hover menus and tooltips. |
| `computer_type` | Type Unicode text — any character, regardless of keyboard layout. |
| `computer_key` | Send a key or chord such as `enter`, `f5`, `ctrl+shift+t`. |
| `computer_scroll` | Scroll the wheel at a point on the last screenshot. |
| `computer_drag` | Drag between two points, for sliders, selection, and drag-and-drop. |

The five input tools all take the same `dispatch` parameter, described under
[Input routes](#input-routes-background-and-foreground).

## How coordinates work

This is the part that decides whether the agent hits what it aims at.

A screenshot is downscaled before it reaches the model, so the image is smaller
than the screen region it came from. On a 2560×1600 display at 150% scaling,
capturing a 2582×1550 window and downscaling to fit 1568 pixels gives a scale
factor of about 1.65. A model that assumes image pixels are screen pixels misses
its target by 65% of the distance from the origin — hundreds of pixels on a wide
window.

So the plugin absorbs the conversion:

1. `computer_screenshot` records a **viewport**: the image size, the screen
   rectangle it came from, the scale factors, and the window it belongs to.
2. The model reads a target's position off the image and passes those numbers to
   an input tool.
3. The tool converts image pixels to screen coordinates through that viewport,
   exactly and reversibly, and reports where the action actually landed.

Two guards make this safe rather than merely convenient:

- **Staleness.** The viewport fingerprints the source window's frame. If the
  window moved or resized after the capture, input is refused instead of landing
  where the model never looked.
- **Bounds.** A point outside the image is refused rather than clamped. Clamping
  would act on an unrelated part of the desktop.

## Input routes: background and foreground

Every input tool takes a `dispatch` parameter, and the two routes trade opposite
costs.

**`background`** is the default. It posts window messages — `WM_LBUTTONDOWN`,
`WM_CHAR`, `WM_MOUSEWHEEL` — straight to the window the screenshot came from. That
window is never raised, the real cursor never moves, and whoever is using the
machine keeps their focus and their typing. Mouse messages carry *client-area*
coordinates, so the tool converts the screenshot point back through
`ScreenToClient` before posting; `WM_MOUSEWHEEL` is the one exception, whose
`lParam` holds screen coordinates.

**`foreground`** raises the target and moves the real cursor through `SendInput`.
Every window receives it, at the cost of taking the desktop over.

Background is the default because a silent no-op the model can see and retry is a
smaller failure than commandeering the machine. The route is chosen per call, so a
model that finds one step did nothing retries that step with
`dispatch="foreground"` and leaves the rest of the run silent.

Measured behaviour — Windows 11, 150% DPI, a Chromium page backgrounded behind a
real application, driven through the shipped tools:

| Case | Result |
|---|---|
| Click a backgrounded Chromium page | Delivered; the page's own click counter incremented. |
| Type into the focused field of a backgrounded Chromium page | Delivered; all 15 characters arrived. |
| Foreground after a click into body text | Unchanged. |
| Foreground after a click into a text field | Chromium activates its own window, because the field needs keyboard focus. The result note reports it. |

Two limits follow from that table. Posted characters reach whatever already holds
focus *inside* the target window, so a field has to be clicked before text lands
in it. And a control that needs keyboard focus — a text field, not body text —
makes its own window activate; the tool reports that rather than hiding it.

If a window will not come forward on the foreground route, the foreground lock is
the usual cause. The tool raises through `AttachThreadInput` to share the target's
input queue, which is the documented way around it. When even that fails it
reports the refusal instead of sending input to the wrong place.

## Capture routes

`captureWindowAuto` tries `PrintWindow` with `PW_RENDERFULLCONTENT` first, counts
the distinct colours in the result, and falls back to a screen-region capture
when the frame is near-uniform. No single route covers every window class: an IME
host window returns one colour through `PrintWindow` while a Chromium window
returns a blank frame through a naive `BitBlt`. A capture that stays blank
through every route is reported to the model as unreliable rather than presented
as a valid image.

## Configuration

Set these under the plugin's `config` in `cordis.yml`:

| Field | Default | Meaning |
|---|---|---|
| `maxEdge` | `1568` | Longest edge of a returned screenshot, in pixels. Lower spends fewer tokens per capture; higher makes small UI text legible. |
| `compressionLevel` | `6` | PNG effort, 0–9. Measured difference between 6 and 9 is about 1% of file size, so raising it rarely pays. |
| `typeDelayMs` | `0` | Pause between typed characters. Raise it for applications that drop fast input. |
| `providerName` | `native-win32` | Name recorded in the computer-use registration. |

Measured on a 2582×1550 browser window, PNG bytes by `maxEdge`:

| `maxEdge` | Image | Bytes |
|---|---|---|
| 1024 | 1024×615 | 533 KB |
| 1280 | 1280×768 | 762 KB |
| 1568 | 1568×941 | 1.08 MB |
| 1920 | 1920×1153 | 1.49 MB |

A route that normalizes images for its own token budget may reduce these before
they reach the model.

## How it is built

Direct Win32 through [koffi](https://koffi.dev) FFI — no native addon, no C++
toolchain, no compiled artifact to match a Node ABI. The published package is
JavaScript plus a prebuilt FFI binding.

```
src/
  index.ts          plugin entry: calibration, registration, prompt
  guidance.ts       the model-facing system-prompt section
  viewport.ts       image <-> screen coordinate mapping and staleness
  encode.ts         BGRA -> RGBA, downscale, PNG
  tools/            the eight tools
  win32/
    structs.ts      koffi structure layouts
    dll.ts          user32/gdi32/kernel32/shcore bindings and constants
    native.ts       layout assertions and UTF-16 decoding
    window.ts       DPI awareness, enumeration, geometry, foreground
    capture.ts      PrintWindow/BitBlt with fallback, colour sampling
    input.ts        SendInput: pointer, wheel, keys, Unicode text
    post.ts         posted messages: the background input route
```

Four details are load-bearing and would be silent failures if wrong:

- **DPI awareness is set before anything else.** `SetProcessDpiAwarenessContext`
  with `PER_MONITOR_AWARE_V2` must run before the first capture or coordinate
  query. Without it `GetSystemMetrics` reports scaled logical pixels while the
  capture returns physical pixels, so every click is off by the scale factor.
- **The `INPUT` structure is asserted to be 40 bytes.** A wrong stride makes
  `SendInput` deliver corrupt events with no error. The plugin refuses to start
  rather than send them.
- **Text uses `KEYEVENTF_UNICODE`.** Characters are delivered independently of
  the active keyboard layout, so Chinese, accented, and emoji input work without
  changing layouts. Surrogate pairs are kept adjacent.
- **Posted mouse messages carry client-area coordinates**, not screen ones, and
  the client origin is not the frame origin — a browser draws its own toolbar
  inside the client area. Posting a screen point mis-clicks by the height of that
  toolbar. `WM_MOUSEWHEEL` is the exception and does take screen coordinates.

## Limitations

- **Windows only.** The provider refuses to load elsewhere.
- **No session isolation.** Input goes to the interactive desktop. A locked or
  disconnected session has nothing to capture.
- **Protected windows.** Windows with DRM or elevated-integrity protection may
  refuse capture or reject synthesized input. The failure is reported, not hidden.
- **Posted input can be ignored.** The background route is the default because it
  is quiet, not because it is universal. A window that reads the hardware input
  queue rather than its message queue sees nothing, and the tool reports the
  refusal so the model can retry with `dispatch="foreground"`.
- **No accessibility data.** This provider deliberately does not read the UI
  Automation tree. Reading a control's value without seeing it is a different
  capability; use an MCP UI Automation server alongside if you need it.

## Development

```sh
npm install
npm run typecheck                        # compiles against the harness declarations
npm run build
npm run pipeline                         # capture -> encode -> viewport -> coordinates
npm run pipeline:click                   # the same, and sends a real click
npm run compose                          # mounts the plugin in a real Cordis context
npm run compose:real                     # mounts it against the real computer-use service
npm run bg-tools                         # drives a backgrounded Chromium page through the tools
npm run bench                            # image size by maxEdge and PNG effort
```

Three tsconfigs exist because they have different jobs. `tsconfig.json` typechecks
against the harness declaration files, so a build fails when the host's API
changes. `tsconfig.test.json` clears that mapping so the spike scripts resolve
the real packages from `node_modules` at runtime; a loader would otherwise follow
the mapping to a `.d.ts` file. `tsconfig.harness.json` does the opposite and maps
the specifiers onto the harness sources, which is the only way a test can mount a
real harness service instead of a stand-in. The spike scripts must be started with
the matching one.

`compose:real` is the composition check that matters. It mounts the plugin
against the real `@deepseek-ai/dsh-computer-use`, `@deepseek-ai/dsh-system-prompt`,
and `@deepseek-ai/dsh-tools` rather than stand-ins, and each of the three has an
API a stub would have hidden:

- The provider registry reserves its slot through a `ctx.effect` call made
  *inside* `register()`. Cordis resolves a service's `this.ctx` to its caller, so
  that effect binds to this plugin's fiber and disposal releases the slot — a
  claim about framework behaviour, and one whose failure would leave the slot
  occupied after an unload.
- The prompt service owns the section order this plugin asks for, and assembling
  is what the model actually receives, so the check asserts the guidance text
  appears in the assembly and leaves it again on disposal.
- The tool registry validates each definition and projects its schema to
  lossless JSON. Reading the catalog back is what shows the eight tools are
  registrable; a stub `register()` that accepts anything cannot.

The profile side is verifiable without starting the app:

```sh
dsh --profile web --dump-config          # composes the tree, patches applied
dsh --profile web --dump-config-schema   # imports every entry to read its Config
```

The schema dump is the stronger of the two, because printing an entry's config
schema requires importing its module. This plugin's `maxEdge`, `compressionLevel`,
and `typeDelayMs` appearing there, with their defaults, is what proves the patch
row resolves and the built module loads.

### Harness schema rules the tools follow

These are easy to get wrong and the error messages do not explain the rule:

- Tool `parameters` and tool `output.schema` are different DSLs. `parameters`
  marks a required field with `required: true` on the field. `output.schema`
  does too — but only on fields. A `required` key at the **root** of an output
  schema is rejected, whether it is `true` or an array of names, so requiredness
  there is expressed on each property.
- Every nested object in either DSL must state `additionalProperties`
  explicitly as `true` or `false`. Omitting it is an error.
- A function plugin exports `name`, `inject`, `Config`, and `apply`, and must
  have no default export; a default export makes the loader discard the
  namespace.
- Every registration must be yielded inside `ctx.effect()`, including
  `systemPrompt.section()`. A registration made outside the effect survives
  disposal.
- `spike/schema-probe.ts` and `spike/schema-probe2.ts` record which forms the
  installed harness accepts. Re-run them after a harness upgrade.

`spike/win32-smoke.ts` exercises enumeration, capture, and the foreground
workaround without the plugin layer.

## License

MIT
