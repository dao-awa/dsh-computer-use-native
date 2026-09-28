/**
 * Input injection by posting window messages.
 *
 * `SendInput` writes into the system input stream, so it only reaches whichever
 * window is in the foreground and the caller must raise its target first. That
 * makes the desktop unusable for the person at the keyboard for as long as an
 * agent is working. Posting messages instead delivers them straight to one
 * window's queue: the target never has to be raised, the real cursor never
 * moves, and the foreground window is left alone.
 *
 * Posting is not a substitute for `SendInput` everywhere. It is measured to work
 * on Chromium, WebView2, and classic Win32 controls, but a window is free to
 * ignore a posted message — one that reads the hardware input queue rather than
 * its message queue sees nothing. The tools therefore expose both routes and
 * report which one ran.
 *
 * Three coordinate spaces meet here, and mixing them up mis-clicks silently:
 *
 * - a screenshot of a window frame is in screen pixels offset by the frame
 *   origin;
 * - a mouse message's `lParam` is in client-area pixels;
 * - `WM_MOUSEWHEEL` alone carries *screen* pixels, unlike every other mouse
 *   message.
 *
 * Every function below takes client-area coordinates and the module converts
 * the one message that needs screen coordinates itself.
 *
 * @module dsh-computer-use-native/win32/post
 */

import {
  AttachThreadInput,
  ClientToScreen,
  GA_PARENT,
  GetAncestor,
  GetCurrentThreadId,
  GetFocus,
  GetForegroundWindow,
  GetWindowThreadProcessId,
  MK_LBUTTON,
  MK_MBUTTON,
  MK_RBUTTON,
  MapVirtualKeyW,
  PostMessageW,
  ScreenToClient,
  Sleep,
  WM_CHAR,
  WM_KEYDOWN,
  WM_KEYUP,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MBUTTONDOWN,
  WM_MBUTTONUP,
  WM_MOUSEMOVE,
  WM_MOUSEHWHEEL,
  WM_MOUSEWHEEL,
  WM_RBUTTONDOWN,
  WM_RBUTTONUP,
  WindowFromPoint,
} from './dll.ts'
import { virtualKeyFor, type MouseButton } from './input.ts'

/** `MapVirtualKey` translation: virtual-key code to scan code. */
const MAPVK_VK_TO_VSC = 0

/** Repeat count in the low word of a key message's `lParam`. */
const KEY_REPEAT_ONE = 1

/** Which window currently holds the foreground. */
export function foregroundWindow(): number {
  return Number(GetForegroundWindow())
}

/**
 * Convert a screen point into a window's client area.
 * @param hwnd - target window.
 * @param screen - point in physical screen pixels.
 * @returns the point in client-area pixels.
 */
export function screenPointToClient(
  hwnd: number,
  screen: { x: number, y: number },
): { x: number, y: number } {
  const point: Record<string, number> = { x: screen.x, y: screen.y }
  ScreenToClient(hwnd, point)
  return { x: point.x ?? 0, y: point.y ?? 0 }
}

/** Pack client coordinates into a mouse message's `lParam`. */
function packClient(x: number, y: number): number {
  return ((y & 0xffff) << 16) | (x & 0xffff)
}

/** How far up the parent chain to look before giving up. */
const ANCESTRY_LIMIT = 64

/**
 * Whether a window lies on another window's ancestry.
 * @param candidate - window to test.
 * @param root - window the chain must reach.
 * @returns whether `candidate` is `root` or one of its descendants.
 */
function isDescendantOf(candidate: number, root: number): boolean {
  let current = candidate
  for (let depth = 0; current !== 0 && depth < ANCESTRY_LIMIT; depth += 1) {
    if (current === root) return true
    current = Number(GetAncestor(current, GA_PARENT))
  }
  return false
}

/**
 * The window that a mouse message at a screen point belongs to.
 *
 * Windows delivers real mouse input to the deepest window under the pointer, not
 * to the frame. A window that owns its whole surface — a browser, or a XAML app
 * with no child windows — is that deepest window itself, so this returns the
 * frame and nothing changes. A window built from separate control windows, which
 * is most classic Win32 software, needs the message to arrive at the control or
 * the frame discards it.
 * @param root - the window the caller addressed.
 * @param screen - pointer position in screen pixels.
 * @returns the deepest descendant of `root` at that point, or `root` when the
 * point belongs to another window or to no child.
 */
function routeToChildAtScreen(root: number, screen: { x: number, y: number }): number {
  const hit = Number(WindowFromPoint({ x: screen.x, y: screen.y }))
  return hit !== 0 && hit !== root && isDescendantOf(hit, root) ? hit : root
}

/**
 * Redirect a client-area point to the child window that owns it.
 * @param hwnd - the window the caller addressed.
 * @param x - client-area x within `hwnd`.
 * @param y - client-area y within `hwnd`.
 * @returns the window to post to, and the point in that window's client area.
 */
function routeToChild(hwnd: number, x: number, y: number): { hwnd: number, x: number, y: number } {
  const screen: Record<string, number> = { x, y }
  if (!ClientToScreen(hwnd, screen)) return { hwnd, x, y }
  const screenPoint = { x: screen.x ?? 0, y: screen.y ?? 0 }
  const child = routeToChildAtScreen(hwnd, screenPoint)
  if (child === hwnd) return { hwnd, x, y }
  const client: Record<string, number> = { x: screenPoint.x, y: screenPoint.y }
  if (!ScreenToClient(child, client)) return { hwnd, x, y }
  return { hwnd: child, x: client.x ?? 0, y: client.y ?? 0 }
}

/**
 * The window that would receive typed characters inside a target window.
 *
 * A thread's keyboard focus is private to that thread, so it is only readable
 * after attaching to the target's input queue. The focus window is frequently a
 * control rather than the frame — an edit box inside a dialog, for instance —
 * and a frame that receives `WM_CHAR` on its control's behalf discards it.
 * @param hwnd - the window the caller addressed.
 * @returns the focused descendant of `hwnd`, or `hwnd` when focus is elsewhere.
 */
function routeToFocus(hwnd: number): number {
  // koffi writes a pointer-to-primitive out parameter into an array slot, where
  // a pointer-to-struct one is written into a plain object's fields.
  const process = [0]
  const targetThread = Number(GetWindowThreadProcessId(hwnd, process))
  const ownThread = Number(GetCurrentThreadId())
  if (targetThread === 0) return hwnd
  if (targetThread === ownThread) {
    const focus = Number(GetFocus())
    return focus !== 0 && isDescendantOf(focus, hwnd) ? focus : hwnd
  }
  if (!AttachThreadInput(ownThread, targetThread, true)) return hwnd
  let focus = 0
  try {
    focus = Number(GetFocus())
  } finally {
    AttachThreadInput(ownThread, targetThread, false)
  }
  return focus !== 0 && isDescendantOf(focus, hwnd) ? focus : hwnd
}

/** The down/up message pair and the `wParam` key state for one button. */
const BUTTON_MESSAGES: Record<MouseButton, { down: number, up: number, held: number }> = {
  left: { down: WM_LBUTTONDOWN, up: WM_LBUTTONUP, held: MK_LBUTTON },
  right: { down: WM_RBUTTONDOWN, up: WM_RBUTTONUP, held: MK_RBUTTON },
  middle: { down: WM_MBUTTONDOWN, up: WM_MBUTTONUP, held: MK_MBUTTON },
}

/**
 * Move the pointer inside a window without pressing anything.
 * @param hwnd - target window.
 * @param x - client-area x.
 * @param y - client-area y.
 * @returns whether the message was queued.
 */
export function postMouseMove(hwnd: number, x: number, y: number): boolean {
  const target = routeToChild(hwnd, x, y)
  return Boolean(PostMessageW(target.hwnd, WM_MOUSEMOVE, 0, packClient(target.x, target.y)))
}

/**
 * Click inside a window by posting button messages.
 *
 * Each press is preceded by a move so that windows tracking hover state, which
 * includes every browser, see the pointer arrive before the button goes down.
 * @param hwnd - target window.
 * @param x - client-area x.
 * @param y - client-area y.
 * @param button - which button to press.
 * @param count - how many clicks; 2 sends a double click.
 * @returns whether every message was queued.
 */
export function postClick(
  hwnd: number,
  x: number,
  y: number,
  button: MouseButton = 'left',
  count = 1,
): boolean {
  const messages = BUTTON_MESSAGES[button]
  const target = routeToChild(hwnd, x, y)
  const lparam = packClient(target.x, target.y)
  let queued = postMouseMove(hwnd, x, y)
  for (let press = 0; press < count; press += 1) {
    queued = Boolean(PostMessageW(target.hwnd, messages.down, messages.held, lparam)) && queued
    // A press and release posted back to back are coalesced by some toolkits
    // into a single event, so leave a gap the message loop can drain.
    Sleep(20)
    queued = Boolean(PostMessageW(target.hwnd, messages.up, 0, lparam)) && queued
    if (press + 1 < count) Sleep(40)
  }
  return queued
}

/**
 * Press, move, and release inside a window.
 * @param hwnd - target window.
 * @param from - client-area start point.
 * @param to - client-area end point.
 * @param button - which button to hold.
 * @param steps - intermediate move messages, so the target sees a real gesture.
 * @param delayMs - pause between moves.
 * @returns whether every message was queued.
 */
export function postDrag(
  hwnd: number,
  from: { x: number, y: number },
  to: { x: number, y: number },
  button: MouseButton = 'left',
  steps = 12,
  delayMs = 12,
): boolean {
  const messages = BUTTON_MESSAGES[button]
  // A real press captures the pointer, so every later message of the gesture
  // reaches the window that took the press. Routing the whole drag by its start
  // point reproduces that; routing each move on its own would not.
  const target = routeToChild(hwnd, from.x, from.y)
  const offsetX = from.x - target.x
  const offsetY = from.y - target.y
  let queued = postMouseMove(hwnd, from.x, from.y)
  Sleep(delayMs)
  queued = Boolean(PostMessageW(
    target.hwnd,
    messages.down,
    messages.held,
    packClient(target.x, target.y),
  )) && queued
  Sleep(delayMs)

  const total = Math.max(1, steps)
  for (let step = 1; step <= total; step += 1) {
    const ratio = step / total
    const x = Math.round(from.x + (to.x - from.x) * ratio) - offsetX
    const y = Math.round(from.y + (to.y - from.y) * ratio) - offsetY
    queued = Boolean(PostMessageW(target.hwnd, WM_MOUSEMOVE, messages.held, packClient(x, y))) && queued
    Sleep(delayMs)
  }

  queued = Boolean(PostMessageW(
    target.hwnd,
    messages.up,
    0,
    packClient(to.x - offsetX, to.y - offsetY),
  )) && queued
  return queued
}

/**
 * The `wParam` of a wheel message.
 *
 * The delta is a signed value in the high word, where one notch is 120 units and
 * Windows expects at most three notches per event. The low word carries key
 * state, which is zero for a wheel.
 * @param notches - wheel notches; positive scrolls toward the start.
 * @returns the packed `wParam`.
 */
function wheelWParam(notches: number): number {
  const clamped = Math.max(-3, Math.min(3, Math.round(notches))) * 120
  return (clamped & 0xffff) << 16
}

/**
 * Scroll a window by posting wheel messages.
 *
 * `WM_MOUSEWHEEL` and `WM_MOUSEHWHEEL` are the only mouse messages whose
 * `lParam` holds screen rather than client coordinates, so the point arrives
 * already in that space.
 * @param hwnd - target window.
 * @param screen - pointer position in screen pixels, as wheel messages expect.
 * @param vertical - vertical wheel notches; positive scrolls toward the start.
 * @param horizontal - horizontal wheel notches; positive scrolls right.
 * @returns whether every message was queued.
 */
export function postWheel(
  hwnd: number,
  screen: { x: number, y: number },
  vertical: number,
  horizontal = 0,
): boolean {
  const target = routeToChildAtScreen(hwnd, screen)
  const lparam = ((screen.y & 0xffff) << 16) | (screen.x & 0xffff)
  let queued = true
  if (vertical !== 0) {
    queued = Boolean(PostMessageW(target, WM_MOUSEWHEEL, wheelWParam(vertical), lparam)) && queued
  }
  if (horizontal !== 0) {
    queued = Boolean(PostMessageW(target, WM_MOUSEHWHEEL, wheelWParam(horizontal), lparam)) && queued
  }
  return queued
}

/**
 * Type text into a window as character messages.
 *
 * Characters go to the control that holds keyboard focus inside the target,
 * because that is what the target's own message loop would do with them. A
 * window that owns its whole surface receives them directly. Either way a
 * caller that has not put focus in a field first will see the characters
 * dropped, since nothing is there to consume them.
 * @param hwnd - target window.
 * @param text - text to send; each UTF-16 code unit becomes one message.
 * @param perCharacterDelayMs - pause between characters.
 * @returns how many characters were queued.
 */
export function postText(hwnd: number, text: string, perCharacterDelayMs = 0): number {
  const target = routeToFocus(hwnd)
  let queued = 0
  for (const character of text) {
    // A character above the basic plane is a surrogate pair, and each half must
    // be posted as its own message in order for the pair to stay adjacent.
    const code = character.codePointAt(0) ?? 0
    if (code > 0xffff) {
      const offset = code - 0x10000
      const high = 0xd800 + (offset >> 10)
      const low = 0xdc00 + (offset & 0x3ff)
      if (PostMessageW(target, WM_CHAR, high, KEY_REPEAT_ONE)) queued += 1
      if (perCharacterDelayMs > 0) Sleep(perCharacterDelayMs)
      if (PostMessageW(target, WM_CHAR, low, KEY_REPEAT_ONE)) queued += 1
    } else if (PostMessageW(target, WM_CHAR, code, KEY_REPEAT_ONE)) {
      queued += 1
    }
    if (perCharacterDelayMs > 0) Sleep(perCharacterDelayMs)
  }
  return queued
}

/**
 * Press and release a named key in a window.
 *
 * The scan code in `lParam` is filled from the virtual-key code so that a target
 * which translates the message back through the keyboard layout sees the key the
 * caller named. Like {@link postText} the key goes to the focused control, which
 * is where the target's message loop would deliver it.
 * @param hwnd - target window.
 * @param key - key name accepted by {@link virtualKeyFor}, or a virtual-key code.
 * @param extended - set the extended-key bit for keys such as the arrow cluster.
 * @returns whether both messages were queued.
 */
export function postKey(hwnd: number, key: string | number, extended = false): boolean {
  const vkey = typeof key === 'number' ? key : virtualKeyFor(key)
  if (vkey <= 0) return false
  const target = routeToFocus(hwnd)
  const scan = Number(MapVirtualKeyW(vkey, MAPVK_VK_TO_VSC)) & 0xff
  const base = KEY_REPEAT_ONE | (scan << 16) | (extended ? 1 << 24 : 0)
  const down = Boolean(PostMessageW(target, WM_KEYDOWN, vkey, base))
  Sleep(20)
  // Bit 30 marks the transition and bit 31 the release, which is how a window
  // tells a key-up from a repeat of the key-down.
  const up = Boolean(PostMessageW(target, WM_KEYUP, vkey, base | (1 << 30) | (1 << 31)))
  return down && up
}
