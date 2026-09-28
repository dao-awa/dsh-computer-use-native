/**
 * The window management tool.
 *
 * Discovering which windows exist is the first step of every desktop task, and
 * on Windows it is also the step that fails most often: a title fragment matches
 * several windows, a window is minimized, or the window the user means is a
 * child of another process. This tool makes the inventory visible before the
 * model commits to a target.
 *
 * @module dsh-computer-use-native/tools/window
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { focusWindow, getWindowInfo, listWindows } from '../win32/window.ts'

/** Serialize one window for the model. */
function windowLine(window: {
  hwnd: number
  title: string
  className: string
  pid: number
  rect: { x: number, y: number, width: number, height: number }
  minimized: boolean
}): string {
  const state = window.minimized ? ' [minimized]' : ''
  const title = window.title.length > 60 ? `${window.title.slice(0, 60)}...` : window.title
  return `${String(window.hwnd).padStart(9)}  pid=${String(window.pid).padStart(6)}  `
    + `${window.rect.width}x${window.rect.height} @${window.rect.x},${window.rect.y}  `
    + `"${title}"  <${window.className}>${state}`
}

/**
 * Register the `computer_window` tool.
 * @param _ctx - context reserved for future services; window control needs none today.
 * @returns the registry-ready tool definition.
 */
export function createWindowTool(_ctx: Context): ToolDefinition {
  return defineTool({
    name: 'computer_window',
    description:
      'List the desktop windows, or bring one to the foreground, or read one window\'s details. '
      + 'Start here when you do not know what is open, and use it to obtain an hwnd before '
      + 'screenshotting a window whose title is ambiguous. Raising a window is what makes '
      + 'subsequent input reach it.',
    parameters: {
      action: {
        type: 'string',
        enum: ['list', 'focus', 'info'] as const,
        required: true,
        description: 'list = enumerate windows, focus = raise one, info = details for one.',
      },
      match: {
        type: 'string',
        description:
          'Case-insensitive fragment of the window title to filter or select. Required for '
          + 'focus and info unless hwnd is given.',
      },
      hwnd: {
        type: 'integer',
        description: 'Native window handle, when it is already known.',
      },
      includeHidden: {
        type: 'boolean',
        description: 'For list: also return untitled and invisible windows. Default false.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          ok: { type: 'boolean', required: true },
          summary: { type: 'string', required: true },
          windows: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                hwnd: { type: 'integer', required: true },
                title: { type: 'string', required: true },
                className: { type: 'string', required: true },
                pid: { type: 'integer', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{ type: 'text' as const, text: value.summary }],
    },
    isConcurrencySafe: () => true,
    async execute(args) {
      if (args.action === 'list') {
        const windows = listWindows({
          ...args.match === undefined ? {} : { match: args.match },
          ...args.includeHidden === undefined ? {} : { includeHidden: args.includeHidden },
        })
        if (windows.length === 0) {
          return {
            ok: true,
            summary: args.match === undefined
              ? 'no visible titled windows found'
              : `no visible titled window matches "${args.match}"`,
            windows: [],
          }
        }
        const header = `${windows.length} window${windows.length === 1 ? '' : 's'}:`
        const body = windows.map(windowLine).join('\n')
        return {
          ok: true,
          summary: `${header}\n${body}\n\nScreenshot a window by passing its title fragment or hwnd.`,
          windows: windows.map(window => ({
            hwnd: window.hwnd,
            title: window.title,
            className: window.className,
            pid: window.pid,
          })),
        }
      }

      if (args.hwnd === undefined && args.match === undefined) {
        throw new Error(`action "${args.action}" needs either match or hwnd`)
      }

      if (args.action === 'info') {
        const info = args.hwnd !== undefined
          ? getWindowInfo(args.hwnd)
          : (() => {
            const matches = listWindows({ match: args.match ?? '', includeHidden: true, includeTiny: true })
            if (matches.length === 0) throw new Error(`no window title matches "${args.match}"`)
            if (matches.length > 1) {
              const listed = matches.slice(0, 6).map(windowLine).join('\n')
              throw new Error(`"${args.match}" matches ${matches.length} windows:\n${listed}`)
            }
            return matches[0]!
          })()

        const lines = [
          `hwnd      ${info.hwnd}`,
          `title     "${info.title}"`,
          `class     ${info.className}`,
          `pid       ${info.pid}`,
          `frame     ${info.rect.width}x${info.rect.height} at (${info.rect.x},${info.rect.y})`,
          `client    ${info.client.width}x${info.client.height} at (${info.client.x},${info.client.y})`,
          `dpi       ${info.dpi}`,
          `state     ${info.minimized ? 'minimized' : info.maximized ? 'maximized' : 'normal'}`,
        ]
        return { ok: true, summary: lines.join('\n'), windows: [] }
      }

      // action === 'focus'
      const target = args.hwnd !== undefined
        ? getWindowInfo(args.hwnd)
        : (() => {
          const matches = listWindows({ match: args.match ?? '' })
          if (matches.length === 0) throw new Error(`no visible window matches "${args.match}"`)
          if (matches.length > 1) {
            const listed = matches.slice(0, 6).map(windowLine).join('\n')
            throw new Error(
              `"${args.match}" matches ${matches.length} windows; pass hwnd to pick one:\n${listed}`,
            )
          }
          return matches[0]!
        })()

      const result = focusWindow(target.hwnd)
      if (!result.ok) {
        return {
          ok: false,
          summary:
            `could not raise window ${target.hwnd} "${target.title}" (method=${result.method}). `
            + `Foreground stayed on ${result.current}. The window may refuse activation; `
            + 'clicking it once yourself usually resolves this.',
          windows: [],
        }
      }
      return {
        ok: true,
        summary:
          `raised window ${target.hwnd} "${target.title}" via ${result.method} `
          + `(foreground ${result.previous} -> ${result.current})`,
        windows: [],
      }
    },
  })
}
