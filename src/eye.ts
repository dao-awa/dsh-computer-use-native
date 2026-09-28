/**
 * Cheap repeated looking.
 *
 * Converting a frame to PNG and storing it is what a screenshot costs, measured
 * at roughly seventy percent of the total. A person does not pay that to glance
 * again at something that has not moved: the previous look is still what they
 * are seeing. This module gives a capture a cheap identity, so a repeat look at
 * an unchanged screen is recognised as a repeat instead of being encoded and
 * attached a second time.
 *
 * Comparing buffers is not free, but it is the cheap half of the work: hashing
 * the raw pixels measured an order of magnitude below encoding them, and it needs
 * no attachment, no scaling, and no image in the request.
 *
 * Nothing here polls on its own. A background timer would keep a core busy
 * whether or not anyone is looking, and the caller that asks to wait is the one
 * that knows what it is waiting for.
 *
 * @module dsh-computer-use-native/eye
 */

import { Sleep } from './win32/dll.ts'
import type { CaptureFrame } from './win32/capture.ts'
import type { Viewport } from './viewport.ts'

/** Cells across a signature grid. */
const GRID_COLUMNS = 32

/** Cells down a signature grid. */
const GRID_ROWS = 20

/** Pixels sampled per axis inside each grid cell. */
const SAMPLES_PER_AXIS = 4

/** Luminance levels a cell may move by before it counts as changed. */
const CELL_TOLERANCE = 10

/**
 * Share of cells that must move before the view counts as changed.
 *
 * A caret, a spinner, and a progress bar all move a few cells and none of them
 * changes what is on screen. A window opening, a page loading, or a menu
 * appearing moves a large block of them. Two percent of 640 cells is thirteen,
 * which sits between those two cases rather than at either edge.
 */
const CHANGED_FRACTION = 0.02

/** What a previous look at one target showed. */
export interface RememberedLook {
  /** The view that was returned, as {@link signature} described it. */
  view: Uint8Array
  /** When the pixels were captured, in epoch milliseconds. */
  at: number
  /** The viewport the caller was given for that view. */
  viewport: Viewport
}

/**
 * A coarse picture of what a screen looks like.
 *
 * The whole-desktop digest it replaces was both slower and less useful: measured
 * against a live desktop, five samples taken a fifth of a second apart produced
 * five different digests, because a caret blinks and a loading indicator turns.
 * A person watching that screen sees one unchanging page. Byte identity answers
 * "is this the same frame", which is not the question being asked; this answers
 * "is this the same view", which is.
 *
 * The frame is reduced to a grid of average luminances, so a change has to cover
 * a meaningful part of a cell to register at all. Sampling a fixed number of
 * pixels per cell keeps the cost independent of resolution.
 *
 * @param frame - the captured frame, as packed BGRA rows.
 * @returns one byte per grid cell, row-major.
 */
export function signature(frame: CaptureFrame): Uint8Array {
  const cells = new Uint8Array(GRID_COLUMNS * GRID_ROWS)
  const { pixels, width, height } = frame
  if (width <= 0 || height <= 0) return cells

  for (let row = 0; row < GRID_ROWS; row += 1) {
    const top = Math.floor(row * height / GRID_ROWS)
    const bottom = Math.max(top + 1, Math.floor((row + 1) * height / GRID_ROWS))
    for (let column = 0; column < GRID_COLUMNS; column += 1) {
      const left = Math.floor(column * width / GRID_COLUMNS)
      const right = Math.max(left + 1, Math.floor((column + 1) * width / GRID_COLUMNS))

      let total = 0
      let samples = 0
      for (let step = 0; step < SAMPLES_PER_AXIS; step += 1) {
        const y = Math.min(bottom - 1, top + Math.floor((step + 0.5) * (bottom - top) / SAMPLES_PER_AXIS))
        for (let across = 0; across < SAMPLES_PER_AXIS; across += 1) {
          const x = Math.min(right - 1, left + Math.floor((across + 0.5) * (right - left) / SAMPLES_PER_AXIS))
          const offset = (y * width + x) * 4
          if (offset + 2 >= pixels.length) continue
          // Rec. 601 weights in integer form: green carries most of the
          // perceived brightness, which is what makes a small colour shift
          // register as a small luminance shift rather than a large one.
          const blue = pixels[offset] ?? 0
          const green = pixels[offset + 1] ?? 0
          const red = pixels[offset + 2] ?? 0
          total += (red * 77 + green * 151 + blue * 28) >> 8
          samples += 1
        }
      }

      cells[row * GRID_COLUMNS + column] = samples === 0 ? 0 : Math.round(total / samples)
    }
  }
  return cells
}

/**
 * How much of a view changed between two signatures.
 * @param before - signature of the earlier frame.
 * @param after - signature of the later frame.
 * @returns the fraction of grid cells whose luminance moved by more than
 * {@link CELL_TOLERANCE}, from 0 to 1.
 */
export function changedFraction(before: Uint8Array, after: Uint8Array): number {
  const length = Math.min(before.length, after.length)
  if (length === 0) return 0
  let changed = 0
  for (let index = 0; index < length; index += 1) {
    if (Math.abs((before[index] ?? 0) - (after[index] ?? 0)) > CELL_TOLERANCE) changed += 1
  }
  return changed / length
}

/**
 * Whether two signatures show the same view.
 * @param before - signature of the earlier frame.
 * @param after - signature of the later frame.
 * @returns whether the change stays below {@link CHANGED_FRACTION}.
 */
export function looksUnchanged(before: Uint8Array, after: Uint8Array): boolean {
  return changedFraction(before, after) < CHANGED_FRACTION
}

/**
 * Identify a capture target.
 *
 * Two looks share a key only when they would produce the same pixels: the same
 * window, or the whole desktop. Image size is deliberately excluded, so asking
 * for a smaller image of an unchanged screen is still recognised as an unchanged
 * screen.
 * @param target - the requested capture source.
 * @returns a stable key for that source.
 */
export function targetKey(target: { screen?: boolean, window?: string, hwnd?: number }): string {
  if (target.screen === true || (target.window === undefined && target.hwnd === undefined)) {
    return 'screen'
  }
  if (target.hwnd !== undefined) return `hwnd:${target.hwnd}`
  return `title:${(target.window ?? '').toLowerCase()}`
}

/**
 * Remembers what each capture target last showed.
 *
 * Keyed by target rather than globally: a look at one window says nothing about
 * whether another window changed, and reusing one key's hash for another would
 * report a change that never happened.
 */
export class Eye {
  private readonly looks = new Map<string, RememberedLook>()

  /** The last look recorded for a target. */
  recall(key: string): RememberedLook | undefined {
    return this.looks.get(key)
  }

  /** Record what a target showed. */
  remember(key: string, view: Uint8Array, viewport: Viewport): void {
    this.looks.set(key, { view, at: viewport.capturedAt, viewport })
  }
}

/** How often a wait re-checks the screen. */
const WATCH_INTERVAL_MS = 60

/** The result of watching a screen for a change. */
export interface WatchOutcome {
  /** Whether the view differed from the reference before the deadline. */
  changed: boolean
  /** The frame in hand when watching stopped. */
  frame: CaptureFrame
  /** How long watching took, in milliseconds. */
  waitedMs: number
}

/**
 * Watch a screen until it stops showing the reference view.
 *
 * This is what makes an action's result observable rather than guessed at. A
 * caller that has just clicked something can wait for the interface to respond,
 * instead of capturing a half-drawn frame or sleeping for a fixed time that is
 * wrong in both directions.
 * @param capture - produces a fresh frame of the watched region.
 * @param reference - the view the screen is expected to move away from, or
 * `undefined` when there is nothing to compare against.
 * @param timeoutMs - how long to keep watching before giving up.
 * @returns whether a change was seen, the frame in hand when watching stopped,
 * and how long it took.
 */
export function watchForChange(
  capture: () => CaptureFrame,
  reference: Uint8Array | undefined,
  timeoutMs: number,
): WatchOutcome {
  const started = Date.now()
  let frame = capture()
  if (reference === undefined) {
    return { changed: false, frame, waitedMs: 0 }
  }
  while (looksUnchanged(reference, signature(frame))) {
    if (Date.now() - started >= timeoutMs) {
      return { changed: false, frame, waitedMs: Date.now() - started }
    }
    Sleep(WATCH_INTERVAL_MS)
    frame = capture()
  }
  return { changed: true, frame, waitedMs: Date.now() - started }
}
