/**
 * Window discovery, inspection, and activation.
 *
 * The activation path exists because Windows refuses `SetForegroundWindow` from
 * a process the user is not currently interacting with. That refusal is what
 * makes naive automation send input to whatever window already had focus. The
 * bypass here attaches the calling thread's input queue to the target's, which
 * makes the request legal, and falls back to a synthetic Alt tap when even that
 * is denied.
 *
 * @module dsh-computer-use-native/win32/window
 */

import koffi from 'koffi'
import {
  AttachThreadInput,
  BringWindowToTop,
  ClientToScreen,
  DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2,
  GetClassNameW,
  GetClientRect,
  GetCurrentThreadId,
  GetDpiForWindow,
  GetForegroundWindow,
  GetWindowTextLengthW,
  GetWindowTextW,
  GetWindowThreadProcessId,
  GetWindowRect,
  INPUT_KEYBOARD,
  IsIconic,
  IsWindow,
  IsWindowVisible,
  IsZoomed,
  KEYEVENTF_KEYUP,
  SW_RESTORE,
  SendInput,
  SetFocus,
  SetForegroundWindow,
  SetProcessDpiAwareness,
  SetProcessDpiAwarenessContext,
  Sleep,
  ShowWindow,
  user32,
} from './dll.ts'
import { assertInputLayout, decodeUtf16, readPointer } from './native.ts'

/** Virtual-key code for Alt, used to release the foreground lock. */
const VK_MENU = 0x12

/**
 * Callback signature for `EnumWindows`.
 *
 * koffi rejects a second `proto()` registered under the same type name, so this
 * is declared once at module scope. Declaring it inside `listWindows` made every
 * enumeration after the first throw `Duplicate type name 'EnumWindowsProc'`.
 */
const EnumWindowsProc = koffi.proto(
  'bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)',
)

/** `EnumWindows`, resolved once alongside the callback type it takes. */
const EnumWindows = user32.func(
  'bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)',
)

/** A top-level window as the model sees it. */
export interface WindowInfo {
  /** Native window handle, stable for the window's lifetime. */
  hwnd: number
  /** Window title, empty for untitled windows. */
  title: string
  /** Win32 class name, which identifies the UI framework in use. */
  className: string
  /** Owning process id. */
  pid: number
  /** Owning thread id, needed to attach input queues. */
  threadId: number
  /** Window frame in physical screen pixels. */
  rect: { x: number, y: number, width: number, height: number }
  /** Client area in physical screen pixels, excluding frame and title bar. */
  client: { x: number, y: number, width: number, height: number }
  /** Whether the window is minimized. */
  minimized: boolean
  /** Whether the window is maximized. */
  maximized: boolean
  /** Effective DPI of the hosting monitor. */
  dpi: number
}

/** How a request to raise a window resolved. */
export interface FocusResult {
  /** Whether the window ended up in the foreground. */
  ok: boolean
  /** Handle that held the foreground before the attempt. */
  previous: number
  /** Handle that holds the foreground after the attempt. */
  current: number
  /** Strategy that produced the outcome. */
  method: 'already-foreground' | 'attach-thread-input' | 'alt-key' | 'denied'
}

let dpiConfigured = false

/**
 * Declare per-monitor-v2 DPI awareness once per process.
 *
 * Without this, `GetSystemMetrics`, `GetWindowRect`, and `SendInput`'s absolute
 * coordinate space all operate in scaled logical pixels while screenshots are
 * captured in physical pixels. Every derived click coordinate would then be off
 * by the scale factor.
 * @returns the awareness mode that was applied.
 */
export function configureDpiAwareness(): string {
  if (dpiConfigured) return 'cached'
  dpiConfigured = true
  try {
    if (SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2)) {
      return 'per-monitor-v2'
    }
  } catch (error) {
    // The export is absent before Windows 10 1703; fall through to the shcore call.
    void error
  }
  try {
    return SetProcessDpiAwareness(2) === 0 ? 'per-monitor' : 'system'
  } catch (error) {
    void error
    return 'unaware'
  }
}

/** Read a window's title. */
function windowTitle(hwnd: number): string {
  const length = GetWindowTextLengthW(hwnd)
  if (length <= 0) return ''
  const buffer = Buffer.alloc((length + 1) * 2)
  const copied = GetWindowTextW(hwnd, buffer, length + 1)
  return decodeUtf16(buffer, copied)
}

/** Read a window's class name. */
function windowClass(hwnd: number): string {
  const buffer = Buffer.alloc(512)
  const copied = GetClassNameW(hwnd, buffer, 256)
  return decodeUtf16(buffer, copied)
}

/**
 * Inspect one window.
 * @param hwnd - handle of an existing top-level window.
 * @returns the window's identity, geometry, and state.
 */
export function getWindowInfo(hwnd: number): WindowInfo {
  const pidOut = [0]
  const threadId = GetWindowThreadProcessId(hwnd, pidOut)

  // koffi fills these records in place. A call that fails leaves the fields
  // unset rather than raising, so each read falls back to zero.
  const frame: Record<string, number> = {}
  GetWindowRect(hwnd, frame)
  const clientRect: Record<string, number> = {}
  GetClientRect(hwnd, clientRect)
  const origin: Record<string, number> = { x: 0, y: 0 }
  ClientToScreen(hwnd, origin)

  const left = frame.left ?? 0
  const top = frame.top ?? 0
  const right = frame.right ?? 0
  const bottom = frame.bottom ?? 0
  const clientLeft = clientRect.left ?? 0
  const clientTop = clientRect.top ?? 0
  const clientRight = clientRect.right ?? 0
  const clientBottom = clientRect.bottom ?? 0

  return {
    hwnd,
    title: windowTitle(hwnd),
    className: windowClass(hwnd),
    pid: pidOut[0] ?? 0,
    threadId,
    rect: { x: left, y: top, width: right - left, height: bottom - top },
    client: {
      x: origin.x ?? 0,
      y: origin.y ?? 0,
      width: clientRight - clientLeft,
      height: clientBottom - clientTop,
    },
    minimized: Boolean(IsIconic(hwnd)),
    maximized: Boolean(IsZoomed(hwnd)),
    dpi: GetDpiForWindow(hwnd) || 96,
  }
}

/** Narrowing applied while enumerating windows. */
export interface WindowFilter {
  /** Keep only windows whose title or class contains this text, case-insensitively. */
  match?: string
  /** Keep only windows owned by this process. */
  pid?: number
  /** Include windows without a title and windows that are not visible. */
  includeHidden?: boolean
  /** Include zero-area, off-screen windows such as IME hosts and tray helpers. */
  includeTiny?: boolean
}

/**
 * Enumerate top-level windows.
 * @param filter - optional narrowing applied while enumerating.
 * @returns matching windows, largest first so the most salient window leads.
 */
export function listWindows(filter: WindowFilter = {}): WindowInfo[] {
  const found: WindowInfo[] = []
  const callback = koffi.register((hwnd: number): boolean => {
    if (!IsWindow(hwnd)) return true
    if (!filter.includeHidden && !IsWindowVisible(hwnd)) return true

    const info = getWindowInfo(hwnd)
    if (info.rect.width <= 0 || info.rect.height <= 0) return true
    if (!filter.includeTiny && info.rect.width < 40 && info.rect.height < 40) return true
    if (!filter.includeHidden && info.title.length === 0) return true
    if (filter.pid !== undefined && info.pid !== filter.pid) return true

    if (filter.match !== undefined) {
      const needle = filter.match.toLowerCase()
      const haystack = `${info.title}\u0000${info.className}`.toLowerCase()
      if (!haystack.includes(needle)) return true
    }

    found.push(info)
    return true
  }, koffi.pointer(EnumWindowsProc))

  try {
    EnumWindows(callback, 0)
  } finally {
    koffi.unregister(callback)
  }

  return found.sort((a, b) => b.rect.width * b.rect.height - a.rect.width * a.rect.height)
}

/** How a caller identified the window it means. */
export interface WindowTarget {
  /** Native window handle. */
  hwnd?: number
  /** Owning process id. */
  pid?: number
  /** Case-insensitive title fragment. */
  title?: string
}

/**
 * Resolve a window reference to exactly one window.
 *
 * A fragment matching several windows is an error rather than an arbitrary
 * pick, because acting on the wrong window is worse than failing.
 * @param target - handle, process id, or title fragment.
 * @returns the resolved window.
 * @throws when nothing matches, or when a fragment matches more than one window.
 */
export function resolveWindow(target: WindowTarget): WindowInfo {
  if (target.hwnd !== undefined) {
    if (!IsWindow(target.hwnd)) throw new Error(`window handle ${target.hwnd} no longer exists`)
    return getWindowInfo(target.hwnd)
  }

  if (target.pid !== undefined) {
    const matches = listWindows({ pid: target.pid, includeHidden: true })
    if (matches.length === 0) throw new Error(`no visible window belongs to process ${target.pid}`)
    return matches[0]!
  }

  if (target.title !== undefined) {
    const matches = listWindows({ match: target.title, includeHidden: true, includeTiny: true })
    if (matches.length === 0) throw new Error(`no window title matches "${target.title}"`)
    if (matches.length > 1) {
      const listed = matches.slice(0, 6).map(w => `  ${w.hwnd}  "${w.title}"`).join('\n')
      throw new Error(
        `"${target.title}" matches ${matches.length} windows; pass one hwnd instead:\n${listed}`,
      )
    }
    return matches[0]!
  }

  throw new Error('provide hwnd, pid, or title to identify a window')
}

/**
 * Tap Alt to convince Windows the user is active, releasing the foreground lock.
 * @returns whether both the press and the release were delivered.
 */
function sendAltTap(): boolean {
  const down = {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: VK_MENU, wScan: 0, dwFlags: 0, time: 0, dwExtraInfo: 0 } },
  }
  const up = {
    type: INPUT_KEYBOARD,
    u: { ki: { wVk: VK_MENU, wScan: 0, dwFlags: KEYEVENTF_KEYUP, time: 0, dwExtraInfo: 0 } },
  }
  const delivered = SendInput(2, [down, up], assertInputLayout())
  return delivered === 2
}

/**
 * Bring a window to the foreground, working around the Win32 foreground lock.
 *
 * `SetForegroundWindow` fails when the calling process does not own the current
 * foreground and the user is not interacting with it. Attaching this thread's
 * input queue to the target's makes the caller a legitimate foreground owner.
 * @param hwnd - window to raise.
 * @returns the strategy used and the resulting foreground handle.
 */
export function focusWindow(hwnd: number): FocusResult {
  const previous = readPointer(GetForegroundWindow())
  if (previous === hwnd) {
    return { ok: true, previous, current: previous, method: 'already-foreground' }
  }

  if (IsIconic(hwnd)) ShowWindow(hwnd, SW_RESTORE)

  const pidOut = [0]
  const targetThread = GetWindowThreadProcessId(hwnd, pidOut)
  const ownThread = GetCurrentThreadId()

  let attached = false
  try {
    if (targetThread !== ownThread) {
      attached = Boolean(AttachThreadInput(ownThread, targetThread, true))
    }
    SetForegroundWindow(hwnd)
    BringWindowToTop(hwnd)
    SetFocus(hwnd)
  } finally {
    if (attached) AttachThreadInput(ownThread, targetThread, false)
  }

  Sleep(60)
  if (readPointer(GetForegroundWindow()) === hwnd) {
    return { ok: true, previous, current: hwnd, method: 'attach-thread-input' }
  }

  if (sendAltTap()) {
    Sleep(40)
    SetForegroundWindow(hwnd)
    BringWindowToTop(hwnd)
    Sleep(60)
    if (readPointer(GetForegroundWindow()) === hwnd) {
      return { ok: true, previous, current: hwnd, method: 'alt-key' }
    }
  }

  return { ok: false, previous, current: readPointer(GetForegroundWindow()), method: 'denied' }
}
