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
import { focusWindow, listWindows } from '../win32/window.ts'
import {
  imageToScreen,
  viewportIsStale,
  type Viewport,
  type ViewportRegistry,
} from '../viewport.ts'

/** What a pointer tool resolved its target to. */
interface ResolvedPoint {
  /** Physical screen coordinate the input will be sent to. */
  screen: { x: number, y: number }
  /** The viewport the image coordinates were measured on. */
  viewport: Viewport
  /** Window brought forward before the input, when one was named. */
  focused?: { hwnd: number, title: string, method: string }
}

/**
 * Convert image coordinates into a screen point, raising the source window first.
 *
 * The click is delivered by `SendInput`, which reaches whatever window holds the
 * foreground. A viewport that names a window therefore has to raise it, or the
 * click lands on the wrong application. The raise is reported back so the model
 * can tell that the desktop focus changed.
 * @param registry - viewport registry to resolve against.
 * @param args - the raw tool arguments naming coordinates and an optional viewport.
 * @returns the screen point and what was done to prepare it.
 * @throws when the viewport is unknown, stale, or the point lies outside the image.
 */
function resolvePoint(
  registry: ViewportRegistry,
  args: { x: number, y: number, viewport?: string, focus?: boolean },
): ResolvedPoint {
  const viewport = registry.resolve(args.viewport)

  if (viewportIsStale(viewport)) {
    throw new Error(
      `viewport ${viewport.id} is stale: the window moved or resized after the capture, `
      + 'so its coordinates no longer address what the image showed. Take a fresh screenshot.',
    )
  }

  const screen = imageToScreen(viewport, { x: args.x, y: args.y })

  // Raising the window is the default whenever the viewport knows one, because
  // input aimed at a background window is the failure this ordering prevents.
  const shouldFocus = args.focus ?? viewport.window !== undefined
  if (shouldFocus && viewport.window !== undefined) {
    const result = focusWindow(viewport.window.hwnd)
    if (!result.ok) {
      throw new Error(
        `could not bring window ${viewport.window.hwnd} "${viewport.window.title}" to the `
        + `foreground (method=${result.method}), so the input would reach a different window. `
        + 'Click the window once yourself, or retry.',
      )
    }
    return {
      screen,
      viewport,
      focused: { hwnd: viewport.window.hwnd, title: viewport.window.title, method: result.method },
    }
  }

  return { screen, viewport }
}

/** Render the note that accompanies every input result. */
function inputNote(point: ResolvedPoint, action: string): string {
  const lines = [
    `${action} at screen ${point.screen.x},${point.screen.y} `
    + `(image ${point.viewport.image.width}x${point.viewport.image.height} -> viewport ${point.viewport.id})`,
  ]
  if (point.focused !== undefined) {
    lines.push(`raised window ${point.focused.hwnd} "${point.focused.title}" via ${point.focused.method}`)
  }
  lines.push('A delivered input is not proof of its effect; screenshot to verify the outcome.')
  return lines.join('\n')
}

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
      'Bring the source window forward before the input. Defaults to true when the '
      + 'screenshot was of a window, because input otherwise reaches whatever is in front.',
  },
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
      + 'pixels and converted to screen coordinates automatically. When the screenshot was of a '
      + 'window, that window is raised first so the click reaches it rather than whatever was in '
      + 'front. Screenshot afterwards to confirm the effect.',
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
      clickAt(point.screen.x, point.screen.y, args.button ?? 'left', args.clicks ?? 1)
      return { ok: true, note: inputNote(point, `${args.clicks ?? 1}x ${args.button ?? 'left'} click`) }
    },
  })

  const type = defineTool({
    name: 'computer_type',
    description:
      'Type text into the focused window as Unicode, so any character works regardless of the '
      + 'active keyboard layout, including Chinese and emoji. Click the target field first to '
      + 'place the caret. This does not press Enter.',
    parameters: {
      text: {
        type: 'string',
        required: true,
        description: 'The exact text to type.',
      },
      focus: {
        type: 'string',
        description:
          'Window title fragment to raise before typing. Omit to type into whatever is focused.',
      },
      delayMs: {
        type: 'integer',
        description: 'Pause between characters in milliseconds, for targets that drop fast input.',
      },
    },
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      let focused: string | undefined
      if (args.focus !== undefined) {
        const matches = listWindows({ match: args.focus })
        const target = matches[0]
        if (target === undefined) throw new Error(`no visible window matches "${args.focus}"`)
        const result = focusWindow(target.hwnd)
        if (!result.ok) {
          throw new Error(
            `could not bring "${target.title}" to the foreground (method=${result.method})`,
          )
        }
        focused = `raised window ${target.hwnd} "${target.title}"`
      }
      typeText(args.text, args.delayMs ?? 0)
      const characters = [...args.text].length
      return {
        ok: true,
        note: [
          `typed ${characters} character${characters === 1 ? '' : 's'}`,
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
      + 'for literal text.',
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
      focus: {
        type: 'string',
        description: 'Window title fragment to raise before sending.',
      },
    },
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const parts = args.keys.split('+').map(part => part.trim()).filter(part => part.length > 0)
      if (parts.length === 0) throw new Error('keys must name at least one key')

      let focused: string | undefined
      if (args.focus !== undefined) {
        const matches = listWindows({ match: args.focus })
        const target = matches[0]
        if (target === undefined) throw new Error(`no visible window matches "${args.focus}"`)
        const result = focusWindow(target.hwnd)
        if (!result.ok) {
          throw new Error(
            `could not bring "${target.title}" to the foreground (method=${result.method})`,
          )
        }
        focused = `raised window ${target.hwnd} "${target.title}"`
      }

      const repeat = args.repeat ?? 1
      for (let index = 0; index < repeat; index++) pressChord(parts)

      return {
        ok: true,
        note: [
          `sent ${args.keys}${repeat > 1 ? ` ${repeat} times` : ''}`,
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
      scrollAt(point.screen.x, point.screen.y, vertical, horizontal)
      return {
        ok: true,
        note: inputNote(point, `scrolled vertical=${vertical} horizontal=${horizontal}`),
      }
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
      dragBetween(point.screen.x, point.screen.y, destination.x, destination.y)
      return {
        ok: true,
        note: inputNote(
          point,
          `dragged to screen ${destination.x},${destination.y}`,
        ),
      }
    },
  })

  const move = defineTool({
    name: 'computer_move',
    description:
      'Move the pointer to a point measured on the most recent screenshot without clicking. '
      + 'Useful for revealing hover-only menus and tooltips before deciding what to click.',
    parameters: POINT_PARAMETERS,
    output: { schema: ACTION_OUTPUT, render: ACTION_RENDER },
    isConcurrencySafe: () => false,
    async execute(args) {
      const point = resolvePoint(registry, args)
      moveCursor(point.screen.x, point.screen.y)
      return { ok: true, note: inputNote(point, 'moved pointer') }
    },
  })

  return [click, type, key, scroll, drag, move]
}
