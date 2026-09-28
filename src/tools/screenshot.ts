/**
 * The screenshot tool: the model's only way to see the desktop.
 *
 * Every other tool in this plugin acts on coordinates measured from an image
 * this tool produced, so its output carries two things at once — the picture and
 * the mapping that turns a point on that picture back into a screen coordinate.
 * Keeping them in one result is what lets the input tools accept image pixels
 * directly instead of asking the model to do the arithmetic.
 *
 * @module dsh-computer-use-native/tools/screenshot
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { captureScreen, captureWindowAuto, virtualScreenRegion } from '../win32/capture.ts'
import type { CaptureFrame } from '../win32/capture.ts'
import { resolveWindow } from '../win32/window.ts'
import { encodeFrame } from '../encode.ts'
import { createViewport, describeViewport, type ViewportRegistry } from '../viewport.ts'

/** Where a capture should be taken from. */
export interface ScreenshotTarget {
  /** Case-insensitive window title fragment. */
  window?: string
  /** Native window handle. */
  hwnd?: number
  /** Capture the whole virtual desktop instead of a window. */
  screen?: boolean
}

/**
 * Choose the frame to capture.
 * @param target - the requested capture source.
 * @returns the captured frame plus an optional window identity for the viewport.
 * @throws when the target cannot be resolved or no route yields a frame.
 */
function acquireFrame(target: ScreenshotTarget): {
  frame: CaptureFrame
  window?: { hwnd: number, title: string, className: string }
  notes: string[]
} {
  const notes: string[] = []

  if (target.screen === true || (target.window === undefined && target.hwnd === undefined)) {
    const region = virtualScreenRegion()
    const frame = captureScreen(region)
    notes.push(`captured the full desktop (${region.width}x${region.height} px)`)
    return { frame, notes }
  }

  const info = resolveWindow(
    target.hwnd !== undefined ? { hwnd: target.hwnd } : { title: target.window ?? '' },
  )
  if (info.minimized) {
    throw new Error(
      `window ${info.hwnd} "${info.title}" is minimized and has nothing to capture; `
      + 'restore it with computer_window focus first',
    )
  }

  const result = captureWindowAuto(info.hwnd, info.rect, { allowScreenFallback: true })
  for (const attempt of result.attempts) {
    notes.push(`${attempt.method}: ${attempt.error ?? `${attempt.colours} distinct colours`}`)
  }
  if (result.blankSuspect) {
    notes.push(
      'WARNING: every capture route returned a near-uniform frame. The window may be '
      + 'protected, fully obscured, or still loading. Treat positions on this image as unreliable.',
    )
  }

  return {
    frame: result.frame,
    window: { hwnd: info.hwnd, title: info.title, className: info.className },
    notes,
  }
}

/**
 * Register the `computer_screenshot` tool.
 * @param ctx - context supplying the attachment store.
 * @param registry - viewport registry the capture is recorded in.
 * @returns the registry-ready tool definition.
 */
export function createScreenshotTool(ctx: Context, registry: ViewportRegistry) {
  return defineTool({
    name: 'computer_screenshot',
    description:
      'Capture the Windows desktop and return the image. This is the only way to see what is '
      + 'on screen, including inside Chromium, WebView2, and Electron windows that expose no '
      + 'accessible controls. Always screenshot immediately before measuring a click target: '
      + 'coordinates are only valid for the capture they were measured on. '
      + 'Pass a window title fragment to capture one window, or screen:true for the whole desktop.',
    parameters: {
      window: {
        type: 'string',
        description: 'Case-insensitive fragment of the window title to capture.',
      },
      hwnd: {
        type: 'integer',
        description: 'Native window handle from computer_window, when the title is ambiguous.',
      },
      screen: {
        type: 'boolean',
        description: 'Capture the entire desktop instead of one window.',
      },
      maxEdge: {
        type: 'integer',
        description:
          'Longest edge of the returned image in pixels (default 1568). Lower values cost '
          + 'fewer tokens but make small text harder to read.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          viewportId: { type: 'string', required: true },
          image: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              attachmentId: { type: 'string', required: true },
              mediaType: { type: 'string', required: true },
              bytes: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          screen: {
            type: 'object',
            additionalProperties: false,
            required: true,
            properties: {
              x: { type: 'integer', required: true },
              y: { type: 'integer', required: true },
              width: { type: 'integer', required: true },
              height: { type: 'integer', required: true },
            },
          },
          summary: { type: 'string', required: true },
        },
      },
      render: (_args, value): ContentBlock[] => [
        { type: 'text', text: value.summary },
        {
          type: 'image',
          attachment: {
            attachmentId: AttachmentId(value.image.attachmentId),
            mediaType: 'image/png' as const,
            bytes: value.image.bytes,
            width: value.image.width,
            height: value.image.height,
          },
        },
      ],
    },
    // Capturing mutates no shared state, but the viewport registry it writes to
    // is read by every input tool, so captures must not interleave.
    isConcurrencySafe: () => false,
    async execute(args) {
      const target: ScreenshotTarget = {}
      if (args.window !== undefined) target.window = args.window
      if (args.hwnd !== undefined) target.hwnd = args.hwnd
      if (args.screen !== undefined) target.screen = args.screen

      const acquired = acquireFrame(target)
      const encoded = await encodeFrame(acquired.frame, {
        ...args.maxEdge === undefined ? {} : { maxEdge: args.maxEdge },
      })

      const viewport = createViewport({
        image: { width: encoded.width, height: encoded.height },
        screen: {
          x: acquired.frame.origin.x,
          y: acquired.frame.origin.y,
          width: acquired.frame.width,
          height: acquired.frame.height,
        },
        ...acquired.window === undefined ? {} : { window: acquired.window },
        method: acquired.frame.method,
      })
      registry.remember(viewport)

      const attachment = await ctx.attachments.saveImage({
        data: encoded.data,
        mediaType: 'image/png',
        name: `screenshot-${viewport.id}.png`,
      })

      const summary = [
        describeViewport(viewport),
        ...acquired.notes.map(note => `note     ${note}`),
      ].join('\n')

      return {
        viewportId: viewport.id,
        image: {
          attachmentId: attachment.attachmentId,
          mediaType: 'image/png' as const,
          bytes: encoded.data.length,
          width: encoded.width,
          height: encoded.height,
        },
        screen: viewport.screen,
        summary,
      }
    },
  })
}
