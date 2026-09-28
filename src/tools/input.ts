/**
 * Input tools: clicking, typing, key chords, scrolling, and dragging.
 *
 * Every pointer tool accepts image pixels, not screen pixels. The model measures
 * a target on the screenshot it just took, and the tool converts that point
 * through the viewport that produced the image. Asking the model to apply the
 * scale itself would put a multiplication on a 1.5× factor in the reasoning
 * path, where a rounding slip silently shifts the click by tens of pixels.
 *
 * @module dsh-computer-use-native/tools/input
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import {
  clickAt,
  dragBetween,
  moveCursor,
  pressChord,
  scrollAt,
  typeText,
} from '../win32/input.ts'
import {
  foregroundWindow,
  postClick,
  postDrag,
  postKey,
  postMouseMove,
  postText,
  postWheel,
  screenPointToClient,
} from '../win32/post.ts'
import { focusWindow, listWindows } from '../win32/window.ts'
import {
  imageToScreen,
  viewportIsStale,
  type Viewport,
  type ViewportRegistry,
} from '../viewport.ts'

/** How an input reaches its target window. */
export type Dispatch = 'background' | 'foreground'

/** What a pointer tool resolved its target to. */
interface ResolvedPoint {
  /** Physical screen coordinate the input addresses. */
  screen: { x: number, y: number }
  /** The same point in the target's client area, which posted messages need. */
  client?: { x: number, y: number }
  /** The viewport the image coordinates were measured on. */
  viewport: Viewport
  /** The route that will carry the input. */
  dispatch: Dispatch
  /** The window the input is addressed to, when the viewport names one. */
  target?: { hwnd: number, title: string }
  /** Window raised before the input, set only on the foreground route. */
  focused?: { hwnd: number, title: string, method: string }
}

/**
 * Convert image coordinates into an addressed screen point.
 *
 * Two routes exist because they trade opposite costs:
 *
 * - `background` posts window messages, so the target is never raised, the real
 *   cursor never moves, and whoever is using the machine keeps their focus. It
 *   needs the viewport to name a window, and a window is free to ignore a posted
 *   message.
 * - `foreground` moves the real cursor with `SendInput`, which reaches every
 *   window, at the cost of raising the target and taking the desktop over.
 *
 * Background is the default because a silent no-op the model can see and retry
 * is a smaller failure than commandeering the machine. A full-desktop capture
 * names no window, so it can only use the foreground route.
 * @param registry - viewport registry to resolve against.
 * @param args - the raw tool arguments naming coordinates and an optional viewport.
 * @returns the screen point, the client point, and what was done to prepare them.
 * @throws when the viewport is unknown, stale, or the point lies outside the image.
 */
function resolvePoint(
  registry: ViewportRegistry,
  args: { x: number, y: number, viewport?: string, focus?: boolean, dispatch?: Dispatch },
): ResolvedPoint {
  const viewport = registry.resolve(args.viewport)

  if (viewportIsStale(viewport)) {
    throw new Error(
      `viewport ${viewport.id} is stale: the window moved or resized after the capture, `
      + 'so its coordinates no longer address what the image showed. Take a fresh screenshot.',
    )
  }

  const screen = imageToScreen(viewport, { x: args.x, y: args.y })
  const window = viewport.window

  // `focus: true` is the explicit request for the old behaviour, so it overrides
  // the background default rather than being ignored.
  const requested = args.dispatch ?? (args.focus === true ? 'foreground' : 'background')
  const route: Dispatch = requested === 'background' && window === undefined
    ? 'foreground'
    : requested

  if (route === 'background' && window !== undefined) {
    return {
      screen,
      client: screenPointToClient(window.hwnd, screen),
      viewport,
      dispatch: 'background',
      target: { hwnd: window.hwnd, title: window.title },
    }
  }

  // The foreground route delivers to whatever holds the foreground, so a named
  // window has to be raised or the input lands on a different application.
  if (window !== undefined) {
    const result = focusWindow(window.hwnd)
    if (!result.ok) {
      throw new Error(
        `could not bring window ${window.hwnd} "${window.title}" to the `
        + `foreground (method=${result.method}), so the input would reach a different window. `
        + 'Click the window once yourself, or retry.',
      )
    }
    return {
      screen,
      viewport,
      dispatch: 'foreground',
      target: { hwnd: window.hwnd, title: window.title },
      focused: { hwnd: window.hwnd, title: window.title, method: result.method },
    }
  }

  return { screen, viewport, dispatch: 'foreground' }
}

/** Render the note that accompanies every input result. */
function inputNote(point: ResolvedPoint, action: string): string {
  const lines = [
    `${action} at screen ${point.screen.x},${point.screen.y} `
    + `(image ${point.viewport.image.width}x${point.viewport.image.height} -> viewport ${point.viewport.id})`,
  ]
  if (point.dispatch === 'background' && point.target !== undefined) {
    lines.push(
      `posted window messages to ${point.target.hwnd} "${point.target.title}" without raising it `
      + `(client ${point.client?.x ?? 0},${point.client?.y ?? 0}); the desktop focus was left alone`,
    )
  }
  if (point.focused !== undefined) {
    lines.push(`raised window ${point.focused.hwnd} "${point.focused.title}" via ${point.focused.method}`)
  }
  lines.push('A delivered input is not proof of its effect; screenshot to verify the outcome.')
  return lines.join('\n')
}

/**
 * Carry out an action on whichever route the resolved point selected.
 *
 * Every pointer tool has the same two-route shape, so the branch and its guards
 * live here instead of being repeated in each tool. A posted message that the
 * target refuses is reported as a failure rather than as success: the whole cost
 * of the background route is that it can silently do nothing, and the result is
 * the only place the model can learn that it did.
 * @param point - the resolved target and route.
 * @param label - action name for the result note.
 * @param posted - what to post when the background route applies.
 * @param injected - what to send through `SendInput` on the foreground route.
 * @returns the result payload shared by the action tools.
 */
function dispatchAction(
  point: ResolvedPoint,
  label: string,
  posted: (hwnd: number, client: { x: number, y: number }) => boolean,
  injected: () => void,
): { ok: boolean, note: string } {
  const { client, target } = point
  if (point.dispatch === 'background' && client !== undefined && target !== undefined) {
    const before = foregroundWindow()
    const queued = posted(target.hwnd, client)
    const after = foregroundWindow()
    const lines = [inputNote(point, label)]
    if (after !== before) {
      lines.push(
        `the target took the foreground as a result (${before} -> ${after}). A control that needs `
        + 'keyboard focus, such as a text field, activates its own window when clicked.',
      )
    }
    if (!queued) {
      lines.push('The target refused the posted message; retry with dispatch="foreground".')
    }
    return { ok: queued, note: lines.join('\n') }
  }
  injected()
  return { ok: true, note: inputNote(point, label) }
}

/** Shared argument schema for choosing how an input is delivered. */
const DISPATCH_PARAMETERS = {
  dispatch: {
    type: 'string',
    enum: ['background', 'foreground'],
    description:
      'How to deliver the input. "background" posts window messages so the target is never '
      + 'raised and the desktop focus is untouched — the default, and correct when someone is '
      + 'using the machine. It silently does nothing if the target ignores posted messages. '
      + '"foreground" raises the target and moves the real cursor, which reaches every window '
      + 'but takes the desktop over.',
  },
} as const

/** Shared argument schema for tools that act at a point on the last screenshot. */
const POINT_PARAMETERS = {
  x: {
    type: 'integer',
    required: true,
    description: 'Horizontal position in pixels on the most recent screenshot.',
  },
  y: {
    type: 'integer',
    required: true,
    description: 'Vertical position in pixels on the most recent screenshot.',
  },
  viewport: {
    type: 'string',
    description: 'Viewport id from an earlier screenshot; defaults to the most recent one.',
  },
  focus: {
    type: 'boolean',
    description:
      'Force the foreground route for this call, raising the source window and moving the real '
      + 'cursor. Shorthand for dispatch="foreground".',
  },
  ...DISPATCH_PARAMETERS,
} as const

/** Output schema shared by the simple action tools. */
const ACTION_OUTPUT = {
  type: 'object',
  additionalProperties: false,
  properties: {
    ok: { type: 'boolean', required: true },
    note: { type: 'string', required: true },
  },
} as const

/** Render a plain acknowledgement. */
const ACTION_RENDER = (_args: unknown, value: { ok: boolean, note: string }) =>
  [{ type: 'text' as const, text: value.note }]

/**
 * Register the pointer and keyboard tools.
 * @param _ctx - context reserved for future services; input needs none today.
 * @param registry - viewport registry holding the captures coordinates refer to.
 * @returns the registry-ready tool definitions.
 */
export function createInputTools(_ctx: Context, registry: ViewportRegistry): ToolDefinition[] {
  const click = defineTool({
    name: 'computer_click',
    description:
      'Click at a point measured on the most recent screenshot. The point is given in image '
      + 'pixels and converted to screen coordinates automatically. By default the click is posted '
      + 'to the window the screenshot came from, so that window is not raised and whoever is using '
      + 'the machine keeps their focus; pass dispatch="foreground" to raise the window and move the '
      + 'real cursor instead. Screenshot afterwards to confirm the effect.',
    parameters: {
      ...POINT_PARAMETERS,
      button: {
        type: 'string',
        enum: ['left', 'right', 'middle'] as const,
        description: 'Mouse button to press (default left).',
      },
      clicks: {
        type: 'integer',
        description: 'Number of clicks; 2 sends a double-click (default 1).',
      },
    },
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const point = resolvePoint(registry, args)
      const button = args.button ?? 'left'
      const count = args.clicks ?? 1
      return dispatchAction(
        point,
        `${count}x ${button} click`,
        (hwnd, client) => postClick(hwnd, client.x, client.y, button, count),
        () => clickAt(point.screen.x, point.screen.y, button, count),
      )
    },
  })

  const type = defineTool({
    name: 'computer_type',
    description:
      'Type text as Unicode, so any character works regardless of the active keyboard layout, '
      + 'including Chinese and emoji. By default the characters are posted to the window the last '
      + 'screenshot came from, which leaves the desktop focus alone; the target field still has to '
      + 'hold focus inside that window, so click it first. Pass dispatch="foreground" to type into '
      + 'whatever window is in front instead. This does not press Enter.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The exact text to type.',
      },
      window: {
        type: 'string',
        description:
          'Window title fragment to type into. Defaults to the window of the most recent '
          + 'screenshot on the background route, and to whatever is focused on the foreground route.',
      },
      delayMs: {
        type: 'integer',
        description: 'Pause between characters in milliseconds, for targets that drop fast input.',
      },
      ...DISPATCH_PARAMETERS,
    },
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const characters = [...args.text].length
      const delayMs = args.delayMs ?? 0

      const named = args.window === undefined
        ? undefined
        : listWindows({ match: args.window })[0]
      if (args.window !== undefined && named === undefined) {
        throw new Error(`no visible window matches "${args.window}"`)
      }

      if ((args.dispatch ?? 'background') === 'background') {
        const target = named ?? registry.latestViewport()?.window
        if (target !== undefined) {
          const queued = postText(target.hwnd, args.text, delayMs)
          return {
            ok: queued > 0,
            note: [
              `posted ${queued} of ${characters} characters to window ${target.hwnd} `
              + `"${target.title}" without raising it; the desktop focus was left alone`,
              'Posted characters only reach a field that already holds focus inside that window. '
              + 'If nothing appeared, click the field first, or retry with dispatch="foreground".',
              'Screenshot to verify the text landed in the intended field.',
            ].join('\n'),
          }
        }
      }

      // The foreground route types into whatever holds the foreground, so a
      // named window has to be raised first.
      let focused: string | undefined
      if (named !== undefined) {
        const result = focusWindow(named.hwnd)
        if (!result.ok) {
          throw new Error(
            `could not bring "${named.title}" to the foreground (method=${result.method})`,
          )
        }
        focused = `raised window ${named.hwnd} "${named.title}"`
      }
      typeText(args.text, delayMs)
      return {
        ok: true,
        note: [
          `typed ${characters} character${characters === 1 ? '' : 's'} through the system input queue`,
          ...focused === undefined ? [] : [focused],
          'Screenshot to verify the text landed in the intended field.',
        ].join('\n'),
      }
    },
  })

  const key = defineTool({
    name: 'computer_key',
    description:
      'Press a key or a chord such as "enter", "escape", "tab", or "ctrl+shift+t". Modifiers '
      + 'are held for the whole chord. Use this for submission and shortcuts; use computer_type '
      + 'for literal text. By default the keystroke is posted to the window the last screenshot '
      + 'came from, which leaves the desktop focus alone; pass dispatch="foreground" to send it '
      + 'through the system input queue instead.',
    parameters: {
      keys: {
        type: 'string',
        required: true,
        description:
          'Key or chord, for example "enter", "f5", "ctrl+a", "alt+tab". Separate chord parts with "+".',
      },
      repeat: {
        type: 'integer',
        description: 'Times to send the chord (default 1).',
      },
      window: {
        type: 'string',
        description:
          'Window title fragment to send to. Defaults to the window of the most recent screenshot '
          + 'on the background route, and to whatever is focused on the foreground route.',
      },
      ...DISPATCH_PARAMETERS,
    },
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const parts = args.keys.split('+').map(part => part.trim()).filter(part => part.length > 0)
      if (parts.length === 0) throw new Error('keys must name at least one key')

      const named = args.window === undefined
        ? undefined
        : listWindows({ match: args.window })[0]
      if (args.window !== undefined && named === undefined) {
        throw new Error(`no visible window matches "${args.window}"`)
      }

      const repeat = args.repeat ?? 1

      if ((args.dispatch ?? 'background') === 'background') {
        const target = named ?? registry.latestViewport()?.window
        if (target !== undefined) {
          // A chord is pressed modifier-first and released in reverse, so the
          // target never sees the base key while a modifier is already up.
          let queued = true
          for (let index = 0; index < repeat; index += 1) {
            for (const part of parts) queued = postKey(target.hwnd, part) && queued
            for (const part of [...parts].reverse()) {
              queued = postKey(target.hwnd, part) && queued
            }
          }
          return {
            ok: queued,
            note: [
              `posted ${args.keys}${repeat > 1 ? ` ${repeat} times` : ''} to window ${target.hwnd} `
              + `"${target.title}" without raising it; the desktop focus was left alone`,
              'A posted key only reaches a window that already holds focus. If nothing happened, '
              + 'click the window first, or retry with dispatch="foreground".',
              'Screenshot to verify the outcome.',
            ].join('\n'),
          }
        }
      }

      let focused: string | undefined
      if (named !== undefined) {
        const result = focusWindow(named.hwnd)
        if (!result.ok) {
          throw new Error(
            `could not bring "${named.title}" to the foreground (method=${result.method})`,
          )
        }
        focused = `raised window ${named.hwnd} "${named.title}"`
      }

      for (let index = 0; index < repeat; index++) pressChord(parts)

      return {
        ok: true,
        note: [
          `sent ${args.keys}${repeat > 1 ? ` ${repeat} times` : ''} through the system input queue`,
          ...focused === undefined ? [] : [focused],
          'Screenshot to verify the outcome.',
        ].join('\n'),
      }
    },
  })

  const scroll = defineTool({
    name: 'computer_scroll',
    description:
      'Scroll the wheel at a point measured on the most recent screenshot. Positive vertical '
      + 'scrolls toward the start of the content, negative toward the end.',
    parameters: {
      ...POINT_PARAMETERS,
      vertical: {
        type: 'integer',
        description: 'Wheel notches; negative scrolls down (toward the end). Default -3.',
      },
      horizontal: {
        type: 'integer',
        description: 'Horizontal wheel notches; positive scrolls right. Default 0.',
      },
    },
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const point = resolvePoint(registry, args)
      const vertical = args.vertical ?? -3
      const horizontal = args.horizontal ?? 0
      return dispatchAction(
        point,
        `scrolled vertical=${vertical} horizontal=${horizontal}`,
        hwnd => postWheel(hwnd, point.screen, vertical, horizontal),
        () => scrollAt(point.screen.x, point.screen.y, vertical, horizontal),
      )
    },
  })

  const drag = defineTool({
    name: 'computer_drag',
    description:
      'Drag from one point to another, both measured on the most recent screenshot. Use for '
      + 'sliders, window moves, drag-and-drop, and text selection.',
    parameters: {
      ...POINT_PARAMETERS,
      toX: {
        type: 'integer',
        required: true,
        description: 'Destination horizontal position in screenshot pixels.',
      },
      toY: {
        type: 'integer',
        required: true,
        description: 'Destination vertical position in screenshot pixels.',
      },
    },
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const point = resolvePoint(registry, args)
      const destination = imageToScreen(point.viewport, { x: args.toX, y: args.toY })
      return dispatchAction(
        point,
        `dragged to screen ${destination.x},${destination.y}`,
        (hwnd, client) => postDrag(hwnd, client, screenPointToClient(hwnd, destination)),
        () => dragBetween(point.screen.x, point.screen.y, destination.x, destination.y),
      )
    },
  })

  const move = defineTool({
    name: 'computer_move',
    description:
      'Move the pointer to a point measured on the most recent screenshot without clicking. '
      + 'Useful for revealing hover-only menus and tooltips before deciding what to click. On '
      + 'the default background route the move is posted to the window, so hover effects fire '
      + 'there but the visible cursor does not travel; pass dispatch="foreground" to move the '
      + 'real cursor.',
    parameters: POINT_PARAMETERS,
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const point = resolvePoint(registry, args)
      return dispatchAction(
        point,
        'moved pointer',
        (hwnd, client) => postMouseMove(hwnd, client.x, client.y),
        () => moveCursor(point.screen.x, point.screen.y),
      )
    },
  })

  return [click, type, key, scroll, drag, move]
}
