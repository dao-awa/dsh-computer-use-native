/**
 * Mouse and keyboard injection through `SendInput`.
 *
 * `SendInput` writes into the system input stream, which every window reads, so
 * this is the route that cannot be refused. It delivers to the foreground window
 * alone, which is why a caller aiming at a specific window must raise it first,
 * and it moves the real cursor, which is why the caller-visible cursor position
 * is saved and restored around point operations.
 *
 * The cheaper route is {@link module:dsh-computer-use-native/win32/post}, which
 * posts messages to one window's queue instead. Posted messages are measured to
 * reach Chromium, WebView2, and classic Win32 controls without raising anything,
 * but a window is free to ignore them, so both routes stay available and the
 * tools report which one ran.
 *
 * Text is delivered as Unicode code units (`KEYEVENTF_UNICODE`) rather than
 * virtual-key presses. That is the only route that reaches characters outside
 * the active keyboard layout, so Chinese, Cyrillic, and emoji all work on any
 * layout without switching it.
 *
 * @module dsh-computer-use-native/win32/input
 */

import {
  GetCursorPos,
  INPUT_KEYBOARD,
  INPUT_MOUSE,
  KEYEVENTF_EXTENDEDKEY,
  KEYEVENTF_KEYUP,
  KEYEVENTF_UNICODE,
  MOUSEEVENTF_LEFTDOWN,
  MOUSEEVENTF_LEFTUP,
  MOUSEEVENTF_MIDDLEDOWN,
  MOUSEEVENTF_MIDDLEUP,
  MOUSEEVENTF_RIGHTDOWN,
  MOUSEEVENTF_RIGHTUP,
  MOUSEEVENTF_WHEEL,
  MOUSEEVENTF_HWHEEL,
  SendInput,
  SetCursorPos,
  Sleep,
} from './dll.ts'
import { assertInputLayout, sleepSync } from './native.ts'

/** Mouse buttons this plugin can drive. */
export type MouseButton = 'left' | 'right' | 'middle'

/** Virtual-key codes for named keys, so callers never pass raw numbers. */
const VIRTUAL_KEYS: Readonly<Record<string, number>> = {
  backspace: 0x08, tab: 0x09, enter: 0x0D, return: 0x0D, shift: 0x10,
  ctrl: 0x11, control: 0x11, alt: 0x12, menu: 0x12, pause: 0x13, capslock: 0x14,
  escape: 0x1B, esc: 0x1B, space: 0x20, pageup: 0x21, prio: 0x21, pagedown: 0x22,
  next: 0x22, end: 0x23, home: 0x24, left: 0x25, up: 0x26, right: 0x27, down: 0x28,
  printscreen: 0x2C, insert: 0x2D, delete: 0x2E, del: 0x2E, help: 0x2F,
  '0': 0x30, '1': 0x31, '2': 0x32, '3': 0x33, '4': 0x34, '5': 0x35, '6': 0x36,
  '7': 0x37, '8': 0x38, '9': 0x39,
  a: 0x41, b: 0x42, c: 0x43, d: 0x44, e: 0x45, f: 0x46, g: 0x47, h: 0x48,
  i: 0x49, j: 0x4A, k: 0x4B, l: 0x4C, m: 0x4D, n: 0x4E, o: 0x4F, p: 0x50,
  q: 0x51, r: 0x52, s: 0x53, t: 0x54, u: 0x55, v: 0x56, w: 0x57, x: 0x58,
  y: 0x59, z: 0x5A,
  win: 0x5B, lwin: 0x5B, rwin: 0x5C, apps: 0x5D, sleep: 0x5F,
  numpad0: 0x60, numpad1: 0x61, numpad2: 0x62, numpad3: 0x63, numpad4: 0x64,
  numpad5: 0x65, numpad6: 0x66, numpad7: 0x67, numpad8: 0x68, numpad9: 0x69,
  multiply: 0x6A, add: 0x6B, separator: 0x6C, subtract: 0x6D, decimal: 0x6E,
  divide: 0x6F,
  f1: 0x70, f2: 0x71, f3: 0x72, f4: 0x73, f5: 0x74, f6: 0x75, f7: 0x76,
  f8: 0x77, f9: 0x78, f10: 0x79, f11: 0x7A, f12: 0x7B, f13: 0x7C, f14: 0x7D,
  f15: 0x7E, f16: 0x7F, f17: 0x80, f18: 0x81, f19: 0x82, f20: 0x83, f21: 0x84,
  f22: 0x85, f23: 0x86, f24: 0x87,
  numlock: 0x90, scrolllock: 0x91,
  semicolon: 0xBA, equals: 0xBB, plus: 0xBB, comma: 0xBC, minus: 0xBD,
  period: 0xBE, slash: 0xBF, grave: 0xC0, backtick: 0xC0,
  bracketleft: 0xDB, backslash: 0xDC, bracketright: 0xDD, quote: 0xDE,
}

/** Keys that Windows expects to carry the extended-key flag. */
const EXTENDED_KEYS = new Set([
  0x21, 0x22, 0x23, 0x24, 0x25, 0x26, 0x27, 0x28, 0x2D, 0x2E, 0x5B, 0x5C, 0x5D, 0x6F,
])

/**
 * Resolve a key name to its virtual-key code.
 * @param key - a name from the supported set, or a `0x`-prefixed hex code.
 * @returns the virtual-key code.
 * @throws when the name is not recognized.
 */
export function virtualKeyFor(key: string): number {
  const normalized = key.trim().toLowerCase()
  if (normalized.startsWith('0x')) {
    const parsed = Number.parseInt(normalized.slice(2), 16)
    if (Number.isFinite(parsed)) return parsed
  }
  const code = VIRTUAL_KEYS[normalized]
  if (code === undefined) {
    throw new Error(
      `unknown key "${key}"; use a name like "enter", "f5", or "a", or a code like "0x41"`,
    )
  }
  return code
}

/** Build one keyboard `INPUT` record. */
function keyboardInput(vk: number, scan: number, flags: number): Record<string, unknown> {
  return {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: vk, wScan: scan, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  }
}

/** Build one mouse `INPUT` record that does not carry its own coordinates. */
function mouseInput(flags: number, data = 0): Record<string, unknown> {
  return {
    type: INPUT_MOUSE,
    u: { mi: { dx: 0, dy: 0, mouseData: data, dwFlags: flags, time: 0, dwExtraInfo: 0 } },
  }
}

/** Deliver a batch and assert the whole batch was accepted. */
function deliver(records: Record<string, unknown>[], what: string): void {
  const size = assertInputLayout()
  const sent = SendInput(records.length, records, size)
  if (sent !== records.length) {
    throw new Error(`SendInput delivered ${sent} of ${records.length} events for ${what}`)
  }
}

/** Read the current cursor position. */
export function cursorPosition(): { x: number, y: number } {
  const point: Record<string, number> = {}
  GetCursorPos(point)
  return { x: point.x ?? 0, y: point.y ?? 0 }
}

/**
 * Move the cursor to a screen position.
 * @param x - target X in physical screen pixels.
 * @param y - target Y in physical screen pixels.
 */
export function moveCursor(x: number, y: number): void {
  if (!SetCursorPos(Math.round(x), Math.round(y))) {
    throw new Error(`SetCursorPos refused ${Math.round(x)},${Math.round(y)}`)
  }
}

/** Flags for one button's press and release. */
function buttonFlags(button: MouseButton): { down: number, up: number } {
  switch (button) {
    case 'left': return { down: MOUSEEVENTF_LEFTDOWN, up: MOUSEEVENTF_LEFTUP }
    case 'right': return { down: MOUSEEVENTF_RIGHTDOWN, up: MOUSEEVENTF_RIGHTUP }
    case 'middle': return { down: MOUSEEVENTF_MIDDLEDOWN, up: MOUSEEVENTF_MIDDLEUP }
    default: throw new Error(`unsupported mouse button "${String(button)}"`)
  }
}

/**
 * Click at a screen position.
 *
 * The cursor is moved first and left where the click landed, because subsequent
 * actions and the user's own view of the desktop both depend on seeing where
 * the agent acted.
 * @param x - target X in physical screen pixels.
 * @param y - target Y in physical screen pixels.
 * @param button - which button to press.
 * @param count - number of clicks; 2 produces a double-click.
 */
export function clickAt(x: number, y: number, button: MouseButton = 'left', count = 1): void {
  moveCursor(x, y)
  Sleep(24)
  const { down, up } = buttonFlags(button)
  for (let index = 0; index < count; index++) {
    deliver([mouseInput(down), mouseInput(up)], `${button} click ${index + 1}`)
    if (index + 1 < count) Sleep(40)
  }
}

/**
 * Press a mouse button down at a position and hold it.
 * @param x - target X in physical screen pixels.
 * @param y - target Y in physical screen pixels.
 * @param button - which button to hold.
 */
export function mouseDown(x: number, y: number, button: MouseButton = 'left'): void {
  moveCursor(x, y)
  Sleep(24)
  deliver([mouseInput(buttonFlags(button).down)], `${button} down`)
}

/**
 * Release a held mouse button.
 * @param button - which button to release.
 */
export function mouseUp(button: MouseButton = 'left'): void {
  deliver([mouseInput(buttonFlags(button).up)], `${button} up`)
}

/**
 * Drag from one position to another with a move between press and release.
 * @param from - starting X in physical screen pixels.
 * @param fromY - starting Y in physical screen pixels.
 * @param to - ending X in physical screen pixels.
 * @param toY - ending Y in physical screen pixels.
 * @param button - which button to drag with.
 */
export function dragBetween(
  from: number, fromY: number, to: number, toY: number, button: MouseButton = 'left',
): void {
  mouseDown(from, fromY, button)
  const steps = 12
  for (let step = 1; step <= steps; step++) {
    const ratio = step / steps
    moveCursor(from + (to - from) * ratio, fromY + (toY - fromY) * ratio)
    Sleep(12)
  }
  Sleep(40)
  mouseUp(button)
}

/**
 * Scroll the wheel at a position.
 * @param x - X in physical screen pixels where the wheel event is aimed.
 * @param y - Y in physical screen pixels where the wheel event is aimed.
 * @param vertical - wheel notches; positive scrolls up, negative scrolls down.
 * @param horizontal - horizontal notches; positive scrolls right.
 */
export function scrollAt(x: number, y: number, vertical: number, horizontal = 0): void {
  moveCursor(x, y)
  Sleep(20)
  const records: Record<string, unknown>[] = []
  if (vertical !== 0) {
    // One notch is WHEEL_DELTA (120); a negative value scrolls toward the end.
    records.push(mouseInput(MOUSEEVENTF_WHEEL, (-vertical * 120) & 0xFFFFFFFF))
  }
  if (horizontal !== 0) {
    records.push(mouseInput(MOUSEEVENTF_HWHEEL, (-horizontal * 120) & 0xFFFFFFFF))
  }
  if (records.length === 0) return
  deliver(records, 'scroll')
}

/**
 * Press and release a single key.
 * @param key - key name or `0x`-prefixed code.
 */
export function tapKey(key: string | number): boolean {
  const vk = typeof key === 'number' ? key : virtualKeyFor(key)
  const extended = EXTENDED_KEYS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0
  deliver([
    keyboardInput(vk, 0, extended),
    keyboardInput(vk, 0, extended | KEYEVENTF_KEYUP),
  ], `key ${vk}`)
  return true
}

/** Modifier names accepted in a key chord. */
const MODIFIERS: Readonly<Record<string, number>> = {
  ctrl: 0x11, control: 0x11, shift: 0x10, alt: 0x12, win: 0x5B,
}

/**
 * Press a chord such as `ctrl+shift+t`.
 *
 * Modifiers are held for the whole chord and released in reverse order, which is
 * the order applications expect; releasing a modifier early turns the chord into
 * a sequence of separate keystrokes.
 * @param keys - modifier and key names joined by `+`.
 */
export function pressChord(keys: string[]): void {
  if (keys.length === 0) throw new Error('a key chord needs at least one key')

  const modifierCodes: number[] = []
  const remaining: string[] = []
  for (const raw of keys) {
    const name = raw.trim().toLowerCase()
    const modifier = MODIFIERS[name]
    if (modifier !== undefined && remaining.length === 0) modifierCodes.push(modifier)
    else remaining.push(raw)
  }
  if (remaining.length === 0) throw new Error('a key chord needs a non-modifier key')

  const records: Record<string, unknown>[] = []
  for (const code of modifierCodes) records.push(keyboardInput(code, 0, 0))
  for (const name of remaining) {
    const vk = virtualKeyFor(name)
    const extended = EXTENDED_KEYS.has(vk) ? KEYEVENTF_EXTENDEDKEY : 0
    records.push(keyboardInput(vk, 0, extended))
    records.push(keyboardInput(vk, 0, extended | KEYEVENTF_KEYUP))
  }
  for (const code of modifierCodes.reverse()) {
    records.push(keyboardInput(code, 0, KEYEVENTF_KEYUP))
  }
  deliver(records, `chord ${keys.join('+')}`)
}

/**
 * Type text as Unicode, reaching any character regardless of keyboard layout.
 *
 * Each UTF-16 code unit becomes a key-down/key-up pair with the character in
 * `wScan` and no virtual key. Characters outside the Basic Multilingual Plane —
 * emoji and rarer CJK — are already two code units in a JavaScript string, and
 * the surrogate halves must stay adjacent for the receiver to combine them, so
 * the pairs are delivered in one batch with no intervening events.
 * @param text - the text to type.
 * @param perCharacterDelayMs - pause between characters for targets that drop
 *   input faster than they can process it.
 */
export function typeText(text: string, perCharacterDelayMs = 0): void {
  if (text.length === 0) return
  const records: Record<string, unknown>[] = []
  for (let index = 0; index < text.length; index++) {
    const unit = text.charCodeAt(index)
    records.push(keyboardInput(0, unit, KEYEVENTF_UNICODE))
    records.push(keyboardInput(0, unit, KEYEVENTF_UNICODE | KEYEVENTF_KEYUP))
    if (perCharacterDelayMs > 0 && index + 1 < text.length) {
      deliver(records.splice(0, records.length), 'text chunk')
      sleepSync(perCharacterDelayMs)
    }
  }
  if (records.length > 0) deliver(records, 'text')
}
