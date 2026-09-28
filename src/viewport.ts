/**
 * Coordinate mapping between captured images and the screen.
 *
 * The model reasons in image pixels: it looks at a picture that was downscaled
 * to fit a token budget and names a point on it. Windows expects screen pixels.
 * On a 150%-scaled 2560-wide display the two differ by a factor of 1.5 on top
 * of the token-budget downscale, so a mapping that is merely approximate misses
 * its target. Every conversion in this module is exact and reversible.
 *
 * A viewport also carries a fingerprint of the window it came from. A window
 * that has moved or resized since the capture invalidates every coordinate
 * derived from it, and acting on a stale viewport would click somewhere the
 * model never saw. The staleness check turns that silent miss into a refusal.
 *
 * @module dsh-computer-use-native/viewport
 */

import { getWindowInfo } from './win32/window.ts'

/** A screen-space rectangle in physical pixels. */
export interface ScreenRegion {
  /** Left edge. */
  x: number
  /** Top edge. */
  y: number
  /** Width in pixels. */
  width: number
  /** Height in pixels. */
  height: number
}

/** Everything needed to convert between one captured image and the screen. */
export interface Viewport {
  /** Short handle the model passes back to act on this exact capture. */
  id: string
  /** Image dimensions in the pixels the model actually saw. */
  image: { width: number, height: number }
  /** Screen rectangle the image was captured from, in physical pixels. */
  screen: ScreenRegion
  /** Window this viewport came from, absent for full-screen captures. */
  window?: { hwnd: number, title: string, className: string }
  /** Window frame at capture time, used to detect movement. */
  fingerprint?: { x: number, y: number, width: number, height: number }
  /** Capture route that produced the image. */
  method: string
  /** Epoch milliseconds when the capture was taken. */
  capturedAt: number
}

/** Monotonic counter backing viewport ids, which only need to be unique per session. */
let viewportCounter = 0

/**
 * Mint a viewport for a capture.
 * @param capture - the screen rectangle that was captured and the resulting image size.
 * @returns the viewport the model will reference.
 */
export function createViewport(capture: {
  image: { width: number, height: number }
  screen: ScreenRegion
  window?: { hwnd: number, title: string, className: string }
  method: string
}): Viewport {
  viewportCounter += 1
  const viewport: Viewport = {
    id: `vp${viewportCounter}`,
    image: capture.image,
    screen: capture.screen,
    method: capture.method,
    capturedAt: Date.now(),
  }
  if (capture.window !== undefined) viewport.window = capture.window
  if (capture.window !== undefined) {
    const info = getWindowInfo(capture.window.hwnd)
    viewport.fingerprint = {
      x: info.rect.x,
      y: info.rect.y,
      width: info.rect.width,
      height: info.rect.height,
    }
  }
  return viewport
}

/** Horizontal and vertical scale factors from image pixels to screen pixels. */
export function viewportScale(viewport: Viewport): { x: number, y: number } {
  return {
    x: viewport.screen.width / viewport.image.width,
    y: viewport.screen.height / viewport.image.height,
  }
}

/** A point in image-pixel space, as the model reported it. */
export interface ImagePoint {
  /** Horizontal pixel offset in the image. */
  x: number
  /** Vertical pixel offset in the image. */
  y: number
}

/** A point in physical screen-pixel space. */
export interface ScreenPoint {
  /** Horizontal screen coordinate. */
  x: number
  /** Vertical screen coordinate. */
  y: number
}

/**
 * Convert a point the model measured on the image into a screen coordinate.
 *
 * The result is rounded only at the end: intermediate rounding on a 1.5× scale
 * would accumulate into a visible offset across a full-width sweep.
 * @param viewport - the capture the coordinates were measured on.
 * @param point - the point in image pixels.
 * @returns the corresponding physical screen coordinate.
 * @throws when the point falls outside the image.
 */
export function imageToScreen(viewport: Viewport, point: ImagePoint): ScreenPoint {
  const { x, y } = requireInsideImage(viewport, point)
  const scale = viewportScale(viewport)
  return {
    x: Math.round(viewport.screen.x + x * scale.x),
    y: Math.round(viewport.screen.y + y * scale.y),
  }
}

/**
 * Convert a screen coordinate back into image pixels.
 * @param viewport - the capture to measure against.
 * @param point - the physical screen coordinate.
 * @returns the point in image pixels, which may lie outside the image.
 */
export function screenToImage(viewport: Viewport, point: ScreenPoint): ImagePoint {
  const scale = viewportScale(viewport)
  return {
    x: Math.round((point.x - viewport.screen.x) / scale.x),
    y: Math.round((point.y - viewport.screen.y) / scale.y),
  }
}

/**
 * Reject a point that falls outside the captured image.
 *
 * The model occasionally reports a coordinate on the wrong axis or from an
 * earlier image. Clicking the clamp of such a value would act on an unrelated
 * part of the desktop, so the mismatch is reported instead.
 * @param viewport - the capture the coordinates were measured on.
 * @param point - the candidate point.
 * @returns the same point when it is inside.
 * @throws when either axis is outside `[0, size]`.
 */
function requireInsideImage(viewport: Viewport, point: ImagePoint): ImagePoint {
  const { width, height } = viewport.image
  const offX = point.x < 0 || point.x > width
  const offY = point.y < 0 || point.y > height
  if (offX || offY) {
    throw new Error(
      `point ${point.x},${point.y} lies outside viewport ${viewport.id} (${width}x${height} px); `
      + 'take a fresh screenshot and measure the target on that image',
    )
  }
  return point
}

/**
 * Whether the window behind a viewport has moved or resized since the capture.
 *
 * Coordinates measured on the old image no longer address the same controls
 * once the window moves, so a stale viewport must not be used for input.
 * @param viewport - the viewport to check.
 * @returns true when the window geometry changed or the window is gone.
 */
export function viewportIsStale(viewport: Viewport): boolean {
  if (viewport.fingerprint === undefined || viewport.window === undefined) return false
  try {
    const info = getWindowInfo(viewport.window.hwnd)
    const now = info.rect
    const then = viewport.fingerprint
    return now.x !== then.x || now.y !== then.y
      || now.width !== then.width || now.height !== then.height
  } catch (error) {
    // A window that no longer exists cannot host any coordinate.
    void error
    return true
  }
}

/**
 * Tracks the most recent viewport so a click can be issued without echoing an id.
 *
 * The model usually screenshots and then immediately clicks. Requiring the id on
 * every call would add a parameter that carries no intent, so the latest
 * viewport is the default while an explicit id still selects an older capture.
 */
export class ViewportRegistry {
  private latest: Viewport | undefined
  private readonly byId = new Map<string, Viewport>()

  /**
   * Record a viewport as the most recent one.
   * @param viewport - the viewport to remember.
   */
  remember(viewport: Viewport): void {
    this.latest = viewport
    this.byId.set(viewport.id, viewport)
    // Bound the map so a long session that screenshots constantly cannot grow it
    // without limit; the model only ever references recent captures.
    if (this.byId.size > 24) {
      const oldest = this.byId.keys().next()
      if (!oldest.done && oldest.value !== viewport.id) this.byId.delete(oldest.value)
    }
  }

  /**
   * The most recent viewport, when there is one.
   *
   * Tools that name their own target — typing, which posts to the window the
   * last screenshot came from — need the window without requiring a capture to
   * exist, so this differs from {@link resolve} by returning undefined instead
   * of throwing.
   * @returns the latest viewport, or undefined before any capture.
   */
  latestViewport(): Viewport | undefined {
    return this.latest
  }

  /**
   * Find the viewport a call refers to.
   * @param id - an explicit viewport id, or undefined for the most recent capture.
   * @returns the viewport.
   * @throws when no viewport has been captured, or the id is unknown.
   */
  resolve(id?: string): Viewport {
    if (id !== undefined) {
      const found = this.byId.get(id)
      if (found === undefined) {
        const known = [...this.byId.keys()].join(', ')
        throw new Error(
          `unknown viewport "${id}"${known ? `; known viewports: ${known}` : ''}. `
          + 'Take a screenshot to establish a viewport.',
        )
      }
      return found
    }
    if (this.latest === undefined) {
      throw new Error('no screenshot has been taken yet; take one before sending input')
    }
    return this.latest
  }

  /**
   * Forget the tracked viewports, called when input makes earlier captures stale.
   */
  clear(): void {
    this.latest = undefined
    this.byId.clear()
  }
}

/**
 * Render the mapping note that accompanies every screenshot.
 *
 * The model needs the screen size and scale to reason about positions, and it
 * needs to know that its coordinates are accepted directly. Stating both keeps
 * it from applying the conversion itself, which is where manual arithmetic on a
 * non-integer scale goes wrong.
 * @param viewport - the viewport being described.
 * @returns a compact multi-line description for the model.
 */
export function describeViewport(viewport: Viewport): string {
  const scale = viewportScale(viewport)
  const lines = [
    `viewport ${viewport.id} (${viewport.method})`,
    `image    ${viewport.image.width}x${viewport.image.height} px  <-- measure coordinates on this image`,
    `screen   ${viewport.screen.width}x${viewport.screen.height} px at (${viewport.screen.x},${viewport.screen.y})`,
    `scale    ${scale.x.toFixed(4)}x  ${scale.y.toFixed(4)}y`,
    `Give x,y in image pixels; the input tools convert them to screen coordinates.`,
  ]
  if (viewport.window !== undefined) {
    lines.splice(1, 0, `window   ${viewport.window.hwnd}  "${viewport.window.title}"  ${viewport.window.className}`)
  }
  return lines.join('\n')
}
