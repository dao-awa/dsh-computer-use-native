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

## Requirements

- Windows 10 or later, x64.
- Node.js 22 or later.
- A model route that accepts image input.
- DSH with the `computerUse`, `tools`, `systemPrompt`, and `attachments` services.

## Install

```sh
dsh plugin add dsh-computer-use-native
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

## Foreground handling

Input is delivered to the foreground window, so aiming at a background window
would type into whatever is in front. When a screenshot names a window, the input
tools raise it first using `AttachThreadInput` to share the target's input queue,
which is the documented way around Windows' foreground lock. If the window
refuses activation, the tool reports the failure instead of sending input to the
wrong place.

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
```

Three details are load-bearing and would be silent failures if wrong:

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

## Limitations

- **Windows only.** The provider refuses to load elsewhere.
- **No session isolation.** Input goes to the interactive desktop. A locked or
  disconnected session has nothing to capture.
- **Protected windows.** Windows with DRM or elevated-integrity protection may
  refuse capture or reject synthesized input. The failure is reported, not hidden.
- **No accessibility data.** This provider deliberately does not read the UI
  Automation tree. Reading a control's value without seeing it is a different
  capability; use an MCP UI Automation server alongside if you need it.

## Development

```sh
npm install
npm run typecheck     # compiles against the installed harness declarations
npm run build
npx tsx spike/pipeline-test.ts          # capture -> encode -> viewport -> coordinates
npx tsx spike/pipeline-test.ts --click  # also sends a real click
npx tsx spike/size-bench.ts             # image size by maxEdge and PNG effort
```

`spike/win32-smoke.ts` exercises enumeration, capture, and the foreground
workaround without the plugin layer.

## License

MIT
