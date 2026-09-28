/**
 * Screen and window capture through GDI.
 *
 * Two routes exist because neither covers every case:
 *
 * - `PrintWindow` asks a window to draw itself into a device context. It reaches
 *   windows that are occluded or partially off-screen, and with
 *   `PW_RENDERFULLCONTENT` it captures DirectComposition surfaces — Chromium,
 *   WebView2, Electron — which render as an empty frame under every other route.
 *   It fails on some hardware-accelerated and protected windows.
 * - `BitBlt` copies the composited desktop. It always matches what the user
 *   sees, but only for pixels that are actually on screen and unobstructed.
 *
 * The window route is tried first and its output is checked for content, so a
 * silently blank PrintWindow falls back to the screen instead of handing the
 * model an empty image.
 *
 * @module dsh-computer-use-native/win32/capture
 */

import {
  BI_RGB,
  BitBlt,
  CreateCompatibleBitmap,
  CreateCompatibleDC,
  DIB_RGB_COLORS,
  DeleteDC,
  DeleteObject,
  GetDC,
  GetDIBits,
  GetSystemMetrics,
  HWND_DESKTOP,
  PW_CLIENTONLY,
  PW_RENDERFULLCONTENT,
  PrintWindow,
  ReleaseDC,
  SM_CXVIRTUALSCREEN,
  SM_CYVIRTUALSCREEN,
  SM_XVIRTUALSCREEN,
  SM_YVIRTUALSCREEN,
  SelectObject,
} from './dll.ts'
import { getWindowInfo } from './window.ts'

/** `BitBlt` raster operation: direct copy of source pixels. */
const SRCCOPY_ROP = 0x00CC0020

/** How a frame was obtained. */
export type CaptureMethod = 'print-window' | 'screen'

/** One captured frame in the form the encoder expects. */
export interface CaptureFrame {
  /** Packed BGRA rows, top-down, `width * height * 4` bytes. */
  pixels: Buffer
  /** Frame width in physical pixels. */
  width: number
  /** Frame height in physical pixels. */
  height: number
  /** Screen coordinates of the frame's top-left corner. */
  origin: { x: number, y: number }
  /** Route that produced the frame. */
  method: CaptureMethod
}

/** A screen-space rectangle in physical pixels. */
export interface CaptureRegion {
  /** Left edge. */
  x: number
  /** Top edge. */
  y: number
  /** Width in pixels. */
  width: number
  /** Height in pixels. */
  height: number
}

/**
 * Read pixels out of a memory device context.
 * @param hdcMem - memory context holding the rendered bitmap.
 * @param hbm - bitmap selected into that context.
 * @param width - frame width in pixels.
 * @param height - frame height in pixels.
 * @param origin - screen coordinates the frame's top-left corner maps to.
 * @param method - route that produced the bitmap.
 * @returns the captured frame.
 */
function readBitmap(
  hdcMem: number,
  hbm: number,
  width: number,
  height: number,
  origin: { x: number, y: number },
  method: CaptureMethod,
): CaptureFrame {
  // A negative height asks GetDIBits for top-down rows, matching every image
  // encoder's expectation and removing a flip step.
  const info = {
    bmiHeader: {
      biSize: 40,
      biWidth: width,
      biHeight: -height,
      biPlanes: 1,
      biBitCount: 32,
      biCompression: BI_RGB,
      biSizeImage: 0,
      biXPelsPerMeter: 0,
      biYPelsPerMeter: 0,
      biClrUsed: 0,
      biClrImportant: 0,
    },
    bmiColors: [0, 0, 0],
  }
  const pixels = Buffer.alloc(width * height * 4)
  const lines = GetDIBits(hdcMem, hbm, 0, height, pixels, info, DIB_RGB_COLORS)
  if (lines === 0) throw new Error('GetDIBits returned no scan lines')
  return { pixels, width, height, origin, method }
}

/**
 * Count distinct sampled colours in a frame.
 *
 * Used to tell a real render from a blank one. A window that refused to draw
 * yields one or two colours; real UI content yields many. Sampling every 997th
 * pixel keeps this cheap on large frames while still crossing row boundaries.
 * @param frame - the captured frame.
 * @returns the number of distinct sampled 32-bit values.
 */
export function distinctColourCount(frame: CaptureFrame): number {
  const seen = new Set<number>()
  const stride = 4 * 997
  for (let offset = 0; offset + 4 <= frame.pixels.length; offset += stride) {
    seen.add(frame.pixels.readUInt32LE(offset))
    if (seen.size > 4096) break
  }
  return seen.size
}

/**
 * Capture a window by asking it to render itself.
 * @param hwnd - window to capture.
 * @param origin - screen coordinates of the window's top-left corner.
 * @param width - frame width in pixels.
 * @param height - frame height in pixels.
 * @param clientOnly - capture just the client area, excluding frame and title bar.
 * @returns the captured frame.
 * @throws when the window or the GDI resources cannot be prepared.
 */
export function captureWindow(
  hwnd: number,
  origin: { x: number, y: number },
  width: number,
  height: number,
  clientOnly = false,
): CaptureFrame {
  if (width <= 0 || height <= 0) throw new Error(`window has no capturable area (${width}x${height})`)

  const hdcScreen = GetDC(HWND_DESKTOP)
  if (!hdcScreen) throw new Error('GetDC returned no screen device context')

  const hdcMem = CreateCompatibleDC(hdcScreen)
  const hbm = CreateCompatibleBitmap(hdcScreen, width, height)
  const previous = SelectObject(hdcMem, hbm)
  let rendered = false

  try {
    const flags = PW_RENDERFULLCONTENT | (clientOnly ? PW_CLIENTONLY : 0)
    rendered = Boolean(PrintWindow(hwnd, hdcMem, flags))
    if (!rendered) throw new Error(`PrintWindow refused to render window ${hwnd}`)
    return readBitmap(hdcMem, hbm, width, height, origin, 'print-window')
  } finally {
    SelectObject(hdcMem, previous)
    DeleteObject(hbm)
    DeleteDC(hdcMem)
    ReleaseDC(HWND_DESKTOP, hdcScreen)
  }
}

/**
 * Capture a region of the composited desktop.
 * @param region - region to copy, in physical screen pixels.
 * @returns the captured frame.
 * @throws when the region is empty or the copy fails.
 */
export function captureScreen(region: CaptureRegion): CaptureFrame {
  if (region.width <= 0 || region.height <= 0) {
    throw new Error(`capture region is empty (${region.width}x${region.height})`)
  }

  const hdcScreen = GetDC(HWND_DESKTOP)
  if (!hdcScreen) throw new Error('GetDC returned no screen device context')

  const hdcMem = CreateCompatibleDC(hdcScreen)
  const hbm = CreateCompatibleBitmap(hdcScreen, region.width, region.height)
  const previous = SelectObject(hdcMem, hbm)

  try {
    const copied = BitBlt(
      hdcMem, 0, 0, region.width, region.height,
      hdcScreen, region.x, region.y, SRCCOPY_ROP,
    )
    if (!copied) throw new Error(`BitBlt failed for region ${region.x},${region.y} ${region.width}x${region.height}`)
    return readBitmap(hdcMem, hbm, region.width, region.height, { x: region.x, y: region.y }, 'screen')
  } finally {
    SelectObject(hdcMem, previous)
    DeleteObject(hbm)
    DeleteDC(hdcMem)
    ReleaseDC(HWND_DESKTOP, hdcScreen)
  }
}

/**
 * Describe the full virtual desktop, spanning every monitor.
 * @returns the bounding region of all monitors in physical pixels.
 */
export function virtualScreenRegion(): CaptureRegion {
  return {
    x: GetSystemMetrics(SM_XVIRTUALSCREEN),
    y: GetSystemMetrics(SM_YVIRTUALSCREEN),
    width: GetSystemMetrics(SM_CXVIRTUALSCREEN),
    height: GetSystemMetrics(SM_CYVIRTUALSCREEN),
  }
}

/**
 * Minimum sampled colour count that counts as a real render.
 *
 * A window that refuses to draw yields a uniform frame — one colour for a black
 * or white surface, two for a simple gradient. Genuine UI content, even a plain
 * text window, crosses this threshold. The value sits well above the failure
 * cases and well below any real interface.
 */
const BLANK_FRAME_COLOUR_LIMIT = 4

/** Outcome of an automatic capture, including which routes were attempted. */
export interface AutoCaptureResult {
  /** The frame that was accepted. */
  frame: CaptureFrame
  /** Routes tried in order, each with its sampled colour count or error. */
  attempts: { method: CaptureMethod, colours?: number, error?: string }[]
  /** True when every route produced a blank frame. */
  blankSuspect: boolean
}

/**
 * Capture a window, falling back to the screen when the window refuses to render.
 *
 * `PrintWindow` cannot draw every window class: input-method hosts, some UWP
 * surfaces, and hardware-overlay windows return a uniform frame. The screen
 * route then captures the same pixels the user sees, at the cost of requiring
 * the window to be visible and unobstructed. Trying both and comparing sampled
 * colour counts is what keeps a silently blank screenshot from reaching the
 * model, which would otherwise act on an image it cannot interpret.
 * @param hwnd - window to capture.
 * @param region - window frame in physical screen pixels; read from the window
 *   when omitted, which is the safer form because a rect the caller read earlier
 *   can be stale if the window moved in between.
 * @param options - capture tuning.
 * @returns the best available frame plus the route history.
 */
export function captureWindowAuto(
  hwnd: number,
  region?: CaptureRegion,
  options: { clientOnly?: boolean, allowScreenFallback?: boolean } = {},
): AutoCaptureResult {
  const area = region ?? getWindowInfo(hwnd).rect
  const attempts: AutoCaptureResult['attempts'] = []

  try {
    const frame = captureWindow(
      hwnd, { x: area.x, y: area.y }, area.width, area.height, options.clientOnly ?? false,
    )
    const colours = distinctColourCount(frame)
    attempts.push({ method: 'print-window', colours })
    if (colours > BLANK_FRAME_COLOUR_LIMIT) return { frame, attempts, blankSuspect: false }
  } catch (error) {
    attempts.push({ method: 'print-window', error: (error as Error).message })
  }

  if (options.allowScreenFallback === false) {
    throw new Error(
      `PrintWindow produced no usable frame for window ${hwnd}: `
      + attempts.map(a => a.error ?? `${a.colours} colours`).join('; '),
    )
  }

  // The screen route copies composited pixels, so the target must be on top.
  // Raising it first is what makes the fallback meaningful rather than a
  // capture of whatever window happened to be covering it.
  try {
    const frame = captureScreen(area)
    const colours = distinctColourCount(frame)
    attempts.push({ method: 'screen', colours })
    if (colours > BLANK_FRAME_COLOUR_LIMIT) return { frame, attempts, blankSuspect: false }
    return { frame, attempts, blankSuspect: true }
  } catch (error) {
    attempts.push({ method: 'screen', error: (error as Error).message })
    throw new Error(
      `no capture route produced a frame for window ${hwnd}: `
      + attempts.map(a => `${a.method}=${a.error ?? `${a.colours} colours`}`).join('; '),
    )
  }
}
