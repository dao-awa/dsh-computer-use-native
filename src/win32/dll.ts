/**
 * Win32 DLL bindings loaded through koffi.
 *
 * Every function this plugin calls is declared once here with its real calling
 * convention and argument types. koffi resolves symbols lazily on first call,
 * so a missing export surfaces where it is used rather than at import.
 *
 * All `*W` entry points are the UTF-16 variants; the ANSI `*A` variants are
 * never bound because window titles routinely contain non-ASCII text.
 *
 * @module dsh-computer-use-native/win32/dll
 */

import koffi from 'koffi'
// Registers the Win32 structures with koffi before any signature below names
// them. The bindings are referenced by name inside the signature strings, so
// this import exists purely for its registration side effect.
import './structs.ts'

/** Shared Win32 handles and pseudo-handles used as sentinel values. */
export const HWND_DESKTOP = 0

/** `SetWindowPos` flags used to raise a window without activating it. */
export const SWP_NOSIZE = 0x0001
export const SWP_NOMOVE = 0x0002
export const SWP_NOZORDER = 0x0004
export const SWP_NOACTIVATE = 0x0010
export const SWP_SHOWWINDOW = 0x0040

/** `ShowWindow` commands. */
export const SW_RESTORE = 9
export const SW_SHOW = 5

/** `PrintWindow` flags. `PW_RENDERFULLCONTENT` is what makes Chromium render. */
export const PW_CLIENTONLY = 0x00000001
export const PW_RENDERFULLCONTENT = 0x00000002

/** `GetSystemMetrics` indices. */
export const SM_XVIRTUALSCREEN = 76
export const SM_YVIRTUALSCREEN = 77
export const SM_CXVIRTUALSCREEN = 78
export const SM_CYVIRTUALSCREEN = 79
export const SM_CMONITORS = 80
export const SM_CXSCREEN = 0
export const SM_CYSCREEN = 1

/** `GetDIBits` / `BITMAPINFOHEADER` constants. */
export const BI_RGB = 0
export const DIB_RGB_COLORS = 0

/** Mouse input flags for `SendInput`. */
export const MOUSEEVENTF_MOVE = 0x0001
export const MOUSEEVENTF_LEFTDOWN = 0x0002
export const MOUSEEVENTF_LEFTUP = 0x0004
export const MOUSEEVENTF_RIGHTDOWN = 0x0008
export const MOUSEEVENTF_RIGHTUP = 0x0010
export const MOUSEEVENTF_MIDDLEDOWN = 0x0020
export const MOUSEEVENTF_MIDDLEUP = 0x0040
export const MOUSEEVENTF_WHEEL = 0x0800
export const MOUSEEVENTF_HWHEEL = 0x1000
export const MOUSEEVENTF_ABSOLUTE = 0x8000

/** `INPUT` type discriminators. */
export const INPUT_MOUSE = 0
export const INPUT_KEYBOARD = 1

/** Keyboard `SendInput` flags. */
export const KEYEVENTF_EXTENDEDKEY = 0x0001
export const KEYEVENTF_KEYUP = 0x0002
export const KEYEVENTF_UNICODE = 0x0004
export const KEYEVENTF_SCANCODE = 0x0008

/** `SetProcessDpiAwarenessContext` pseudo-handle for per-monitor-v2 awareness. */
export const DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2 = -4

/** `WM_*` messages used by the window-message fallback input route. */
export const WM_CLOSE = 0x0010
export const WM_SETTEXT = 0x000C
export const WM_GETTEXT = 0x000D
export const WM_GETTEXTLENGTH = 0x000E
export const WM_KEYDOWN = 0x0100
export const WM_KEYUP = 0x0101
export const WM_CHAR = 0x0102
export const WM_MOUSEMOVE = 0x0200
export const WM_LBUTTONDOWN = 0x0201
export const WM_LBUTTONUP = 0x0202
export const WM_RBUTTONDOWN = 0x0204
export const WM_RBUTTONUP = 0x0205
export const WM_MBUTTONDOWN = 0x0207
export const WM_MBUTTONUP = 0x0208
export const WM_MOUSEWHEEL = 0x020A
export const WM_MOUSEHWHEEL = 0x020E
export const MK_LBUTTON = 0x0001
export const MK_RBUTTON = 0x0002
export const MK_MBUTTON = 0x0010

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')
const shcore = koffi.load('shcore.dll')

export { user32, gdi32, kernel32, shcore }

// ------------------------------------------------------------------ process

/** Declare per-monitor-v2 DPI awareness for the current process. */
export const SetProcessDpiAwarenessContext = user32.func(
  'bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)',
)

/** Declare per-monitor DPI awareness (Windows 8.1 fallback for the call above). */
export const SetProcessDpiAwareness = shcore.func(
  'int __stdcall SetProcessDpiAwareness(int value)',
)

/** Read and clear the calling thread's last-error code. */
export const GetLastError = kernel32.func('uint32 __stdcall GetLastError()')

/** Current thread id, used to attach input queues for the foreground workaround. */
export const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')

/** Sleep for a number of milliseconds. */
export const Sleep = kernel32.func('void __stdcall Sleep(uint32 dwMilliseconds)')

// ------------------------------------------------------------------- screen

/** Read a system metric such as screen or virtual-screen dimensions. */
export const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)')

/** Effective DPI of the monitor hosting a window. */
export const GetDpiForWindow = user32.func('uint32 __stdcall GetDpiForWindow(intptr_t hwnd)')

// ------------------------------------------------------------------ windows

/** Enumerate every top-level window, stopping when the callback returns false. */
export const EnumWindows = user32.func(
  'bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)',
)

/** True when the window and its ancestors carry the visible style. */
export const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)')

/** True when the handle still identifies an existing window. */
export const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hWnd)')

/** True when the window is minimized. */
export const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hWnd)')

/** True when the window is zoomed (maximized). */
export const IsZoomed = user32.func('bool __stdcall IsZoomed(intptr_t hWnd)')

/** Read the window's title as UTF-16, returning the copied character count. */
export const GetWindowTextW = user32.func(
  'int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)',
)

/** Length of the window's title in UTF-16 code units, excluding the terminator. */
export const GetWindowTextLengthW = user32.func(
  'int __stdcall GetWindowTextLengthW(intptr_t hWnd)',
)

/** Read the window's class name as UTF-16. */
export const GetClassNameW = user32.func(
  'int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)',
)

/**
 * Find a child or top-level window by class and/or title.
 *
 * `EnumWindows` walks top-level windows only, so a control hosted inside a
 * window — a Notepad edit box, for instance — is reachable only through here.
 * Pass 0 for `parent` to search top-level windows, and 0 for a class or title
 * that should not constrain the search.
 */
export const FindWindowExW = user32.func(
  'intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t childAfter, str16 className, str16 windowName)',
)

/** Write the owning process and return the owning thread id. */
export const GetWindowThreadProcessId = user32.func(
  'uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *lpdwProcessId)',
)

/** Screen coordinates of the whole window, including its frame. */
export const GetWindowRect = user32.func(
  'bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ RECT *lpRect)',
)

/** Client-area size in client coordinates. */
export const GetClientRect = user32.func(
  'bool __stdcall GetClientRect(intptr_t hWnd, _Out_ RECT *lpRect)',
)

/** Map a client-area point to screen coordinates in place. */
export const ClientToScreen = user32.func(
  'bool __stdcall ClientToScreen(intptr_t hWnd, _Inout_ POINT *lpPoint)',
)

/**
 * Map a screen point to client-area coordinates in place.
 *
 * Mouse messages posted to a window carry client coordinates in `lParam`, so a
 * screenshot-derived screen point has to be converted before posting.
 */
export const ScreenToClient = user32.func(
  'bool __stdcall ScreenToClient(intptr_t hWnd, _Inout_ POINT *lpPoint)',
)

/**
 * The deepest window at a screen point, including child windows.
 *
 * This is the hit test the system performs for real mouse input, so it is what
 * decides which child a posted mouse message belongs to. Unlike
 * {@link ChildWindowFromPointEx} it reports a child only when the point is over
 * that child rather than falling back to the parent.
 */
export const WindowFromPoint = user32.func('intptr_t __stdcall WindowFromPoint(POINT pt)')

/** Walk a window's ancestry. */
export const GetAncestor = user32.func(
  'intptr_t __stdcall GetAncestor(intptr_t hWnd, uint32 gaFlags)',
)

/** `GetAncestor` flag: the parent window, skipping the owner. */
export const GA_PARENT = 1

/**
 * The window that would receive keyboard input for the calling thread's queue.
 *
 * A thread's focus is only visible to that thread, so reading another
 * application's focused control requires attaching to its input queue first —
 * see {@link AttachThreadInput}.
 */
export const GetFocus = user32.func('intptr_t __stdcall GetFocus()')

/** Window currently receiving keyboard input. */
export const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')

/** Raise a window and give it keyboard focus, subject to the foreground lock. */
export const SetForegroundWindow = user32.func(
  'bool __stdcall SetForegroundWindow(intptr_t hWnd)',
)

/** Move a window to the top of the Z order without activating it. */
export const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hWnd)')

/** Change a window's size, position, and Z order. */
export const SetWindowPos = user32.func(
  'bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32 uFlags)',
)

/** Show, hide, minimize, maximize, or restore a window. */
export const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)')

/** Enable or disable a window and its children. */
export const EnableWindow = user32.func('bool __stdcall EnableWindow(intptr_t hWnd, bool bEnable)')

/** Set the keyboard-focus window inside a thread's input queue. */
export const SetFocus = user32.func('intptr_t __stdcall SetFocus(intptr_t hWnd)')

/** Set the active window inside a thread's input queue. */
export const SetActiveWindow = user32.func('intptr_t __stdcall SetActiveWindow(intptr_t hWnd)')

/**
 * Share an input queue between two threads. Attaching the calling thread to the
 * foreground window's thread is what lets `SetForegroundWindow` succeed when the
 * foreground lock would otherwise refuse the request.
 */
export const AttachThreadInput = user32.func(
  'bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)',
)

/** Whether the window may legally become foreground right now. */
export const AllowSetForegroundWindow = user32.func(
  'bool __stdcall AllowSetForegroundWindow(uint32 dwProcessId)',
)

/** Deliver a message to a window's procedure synchronously. */
export const SendMessageW = user32.func(
  'intptr_t __stdcall SendMessageW(intptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)',
)

/**
 * `SendMessageW` with a pointer `lParam`.
 *
 * Messages that read or write a caller-owned buffer (`WM_GETTEXT`) need this
 * binding: koffi rejects a Buffer passed to the `intptr_t` parameter of the
 * numeric form above.
 */
export const SendMessageBuffer = user32.func(
  'intptr_t __stdcall SendMessageW(intptr_t hWnd, uint32 Msg, uintptr_t wParam, void *lParam)',
)

/** Deliver a message without waiting for it to be processed. */
export const PostMessageW = user32.func(
  'bool __stdcall PostMessageW(intptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)',
)

/** Child window at a client-relative point, or 0 when none matches. */
export const ChildWindowFromPointEx = user32.func(
  'intptr_t __stdcall ChildWindowFromPointEx(intptr_t hWnd, POINT pt, uint32 uFlags)',
)

// ------------------------------------------------------------------ capture

/**
 * Ask a window to render itself into a device context. Passing
 * `PW_RENDERFULLCONTENT` is what makes DirectComposition surfaces — Chromium,
 * WebView2, Electron — draw their real content instead of a blank frame.
 */
export const PrintWindow = user32.func(
  'bool __stdcall PrintWindow(intptr_t hWnd, intptr_t hdcBlt, uint32 nFlags)',
)

/** Device context for a window's client area, or the screen when hWnd is 0. */
export const GetDC = user32.func('intptr_t __stdcall GetDC(intptr_t hWnd)')

/** Release a device context acquired from `GetDC`. */
export const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr_t hWnd, intptr_t hDC)')

/** Create a memory device context compatible with another. */
export const CreateCompatibleDC = gdi32.func(
  'intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)',
)

/** Create a bitmap compatible with a device context. */
export const CreateCompatibleBitmap = gdi32.func(
  'intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int cx, int cy)',
)

/** Select a GDI object into a device context, returning the previous object. */
export const SelectObject = gdi32.func(
  'intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t h)',
)

/** Delete a GDI object. */
export const DeleteObject = gdi32.func('bool __stdcall DeleteObject(intptr_t ho)')

/** Delete a device context. */
export const DeleteDC = gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)')

/** Copy a bitmap's bits into a caller-supplied buffer as a DIB. */
export const GetDIBits = gdi32.func(
  'int __stdcall GetDIBits(intptr_t hdc, intptr_t hbm, uint32 start, uint32 cLines, _Out_ void *lpvBits, _Inout_ BITMAPINFO *lpbmi, uint32 usage)',
)

/** Bit-block transfer between device contexts, used for the screen fallback. */
export const BitBlt = gdi32.func(
  'bool __stdcall BitBlt(intptr_t hdcDest, int x, int y, int cx, int cy, intptr_t hdcSrc, int x1, int y1, uint32 rop)',
)

// -------------------------------------------------------------------- input

/**
 * Inject mouse or keyboard events into the system input stream.
 *
 * This is the route that reaches a window reading the hardware input queue
 * rather than its message queue, and the only one that moves the real cursor.
 * It delivers to the foreground window alone, so a caller aiming at a specific
 * window must raise it first. Posting messages is the cheaper default and does
 * reach Chromium, but a window is free to ignore what it is posted.
 */
export const SendInput = user32.func(
  'uint32 __stdcall SendInput(uint32 nInputs, _In_ INPUT *pInputs, int cbSize)',
)

/** Move the cursor to absolute screen coordinates. */
export const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int X, int Y)')

/** Current cursor position in screen coordinates. */
export const GetCursorPos = user32.func('bool __stdcall GetCursorPos(_Out_ POINT *lpPoint)')

/**
 * Translate a virtual-key code into a scan code.
 *
 * `WM_KEYDOWN` carries the scan code in bits 16-23 of `lParam`, and a window
 * that reads it there sees a different key than the virtual-key code alone
 * implies when the two disagree.
 */
export const MapVirtualKeyW = user32.func(
  'uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)',
)

/** Swap the meaning of the primary and secondary mouse buttons. */
export const SwapMouseButton = user32.func('bool __stdcall SwapMouseButton(bool fSwap)')

/** Physical key state for a virtual-key code. */
export const GetAsyncKeyState = user32.func('short __stdcall GetAsyncKeyState(int vKey)')
