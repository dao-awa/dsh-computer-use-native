/**
 * Technical feasibility spike for the computer-use plugin.
 *
 * Proves out, in one run, everything the plugin's design depends on:
 *   1. koffi can load user32/gdi32 and call them
 *   2. window enumeration with a native callback works
 *   3. window rect + title reading works (needed for coordinate mapping)
 *   4. the foreground-lock workaround (AttachThreadInput) actually works
 *   5. screen capture reaches WebView2 pixels, not a blank/black frame
 *   6. SendInput can deliver a real click
 *
 * Run: node spike/ffi-probe.cjs [--click x y]
 */

const koffi = require('koffi')
const fs = require('node:fs')
const path = require('node:path')

const user32 = koffi.load('user32.dll')
const gdi32 = koffi.load('gdi32.dll')
const kernel32 = koffi.load('kernel32.dll')

// ---------------------------------------------------------------- structs

const RECT = koffi.struct('RECT', { left: 'long', top: 'long', right: 'long', bottom: 'long' })
const POINT = koffi.struct('POINT', { x: 'long', y: 'long' })
const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32', biWidth: 'long', biHeight: 'long', biPlanes: 'uint16',
  biBitCount: 'uint16', biCompression: 'uint32', biSizeImage: 'uint32',
  biXPelsPerMeter: 'long', biYPelsPerMeter: 'long', biClrUsed: 'uint32', biClrImportant: 'uint32',
})
const BITMAPINFO = koffi.struct('BITMAPINFO', { bmiHeader: BITMAPINFOHEADER, bmiColors: koffi.array('uint32', 3) })

const INPUT_KEYBOARD = 1
const INPUT_MOUSE = 0
const MOUSEEVENTF_MOVE = 0x0001
const MOUSEEVENTF_ABSOLUTE = 0x8000
const MOUSEEVENTF_LEFTDOWN = 0x0002
const MOUSEEVENTF_LEFTUP = 0x0004
const KEYEVENTF_KEYUP = 0x0002
const KEYEVENTF_UNICODE = 0x0004
const SM_CXSCREEN = 0
const SM_CYSCREEN = 1
const SRCCOPY = 0x00CC0020
const PW_RENDERFULLCONTENT = 0x00000002

const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long', dy: 'long', mouseData: 'uint32', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
})
const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16', wScan: 'uint16', dwFlags: 'uint32', time: 'uint32', dwExtraInfo: 'uintptr_t',
})
const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', { uMsg: 'uint32', wParamL: 'uint16', wParamH: 'uint16' })
const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: koffi.union('INPUT_UNION', { mi: MOUSEINPUT, ki: KEYBDINPUT, hi: HARDWAREINPUT }),
})

// ------------------------------------------------------------- functions

const GetSystemMetrics = user32.func('int __stdcall GetSystemMetrics(int nIndex)')
const EnumWindows = user32.func('bool __stdcall EnumWindows(void *lpEnumFunc, intptr_t lParam)')
const IsWindowVisible = user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)')
const IsWindow = user32.func('bool __stdcall IsWindow(intptr_t hWnd)')
const GetWindowTextW = user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)')
const GetWindowTextLengthW = user32.func('int __stdcall GetWindowTextLengthW(intptr_t hWnd)')
const GetWindowRect = user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ RECT *lpRect)')
const GetClassNameW = user32.func('int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)')
const GetWindowThreadProcessId = user32.func('uint32 __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32 *lpdwProcessId)')
const GetForegroundWindow = user32.func('intptr_t __stdcall GetForegroundWindow()')
const SetForegroundWindow = user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)')
const ShowWindow = user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)')
const IsIconic = user32.func('bool __stdcall IsIconic(intptr_t hWnd)')
const AttachThreadInput = user32.func('bool __stdcall AttachThreadInput(uint32 idAttach, uint32 idAttachTo, bool fAttach)')
const GetCurrentThreadId = kernel32.func('uint32 __stdcall GetCurrentThreadId()')
const BringWindowToTop = user32.func('bool __stdcall BringWindowToTop(intptr_t hWnd)')
const SetActiveWindow = user32.func('intptr_t __stdcall SetActiveWindow(intptr_t hWnd)')
const SetFocus = user32.func('intptr_t __stdcall SetFocus(intptr_t hWnd)')
const GetClientRect = user32.func('bool __stdcall GetClientRect(intptr_t hWnd, _Out_ RECT *lpRect)')
const ClientToScreen = user32.func('bool __stdcall ClientToScreen(intptr_t hWnd, _Inout_ POINT *lpPoint)')
const SendInput = user32.func('uint32 __stdcall SendInput(uint32 nInputs, _In_ INPUT *pInputs, int cbSize)')
const SetCursorPos = user32.func('bool __stdcall SetCursorPos(int X, int Y)')
const GetDC = user32.func('intptr_t __stdcall GetDC(intptr_t hWnd)')
const ReleaseDC = user32.func('int __stdcall ReleaseDC(intptr_t hWnd, intptr_t hDC)')
const PrintWindow = user32.func('bool __stdcall PrintWindow(intptr_t hWnd, intptr_t hdcBlt, uint32 nFlags)')
const CreateCompatibleDC = gdi32.func('intptr_t __stdcall CreateCompatibleDC(intptr_t hdc)')
const CreateCompatibleBitmap = gdi32.func('intptr_t __stdcall CreateCompatibleBitmap(intptr_t hdc, int cx, int cy)')
const SelectObject = gdi32.func('intptr_t __stdcall SelectObject(intptr_t hdc, intptr_t h)')
const DeleteObject = gdi32.func('bool __stdcall DeleteObject(intptr_t ho)')
const DeleteDC = gdi32.func('bool __stdcall DeleteDC(intptr_t hdc)')
const GetDIBits = gdi32.func('int __stdcall GetDIBits(intptr_t hdc, intptr_t hbm, uint32 start, uint32 cLines, _Out_ void *lpvBits, _Inout_ BITMAPINFO *lpbmi, uint32 usage)')

// ------------------------------------------------------------------ util

/**
 * Declare per-monitor-v2 DPI awareness. Must run before any window, screen, or
 * input call: without it GetSystemMetrics reports scaled logical pixels and
 * every computed click coordinate is wrong on a scaled display.
 */
function declareDpiAwareness() {
  try {
    const fn = user32.func('bool __stdcall SetProcessDpiAwarenessContext(intptr_t value)')
    const ok = fn(-4) // DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2
    return ok ? 'per-monitor-v2' : 'rejected'
  } catch (error) {
    const shcore = koffi.load('shcore.dll')
    const fn = shcore.func('int __stdcall SetProcessDpiAwareness(int value)')
    return fn(2) === 0 ? 'per-monitor' : 'failed'
  }
}

/** Read and clear the calling thread's last Win32 error. */
const GetLastError = kernel32.func('uint32 __stdcall GetLastError()')

/** Block the current thread for `ms`. A CJS script has no top-level await. */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}

/** Decode a UTF-16LE buffer that a Win32 W-function filled, stopping at NUL. */
function decodeW(buf, chars) {
  return buf.subarray(0, chars * 2).toString('utf16le').replace(/\0.*$/u, '')
}

/** Read a window's title, class, pid, and screen rect into a plain object. */
function describe(hwnd) {
  const len = GetWindowTextLengthW(hwnd)
  const tbuf = Buffer.alloc((len + 2) * 2)
  const tn = GetWindowTextW(hwnd, tbuf, len + 1)
  const cbuf = Buffer.alloc(512)
  const cn = GetClassNameW(hwnd, cbuf, 256)
  const r = {}
  GetWindowRect(hwnd, r)
  const pid = [0]
  const tid = GetWindowThreadProcessId(hwnd, pid)
  return {
    hwnd: Number(hwnd),
    title: decodeW(tbuf, tn),
    cls: decodeW(cbuf, cn),
    pid: pid[0],
    tid,
    rect: { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top },
  }
}

// -------------------------------------------------------------- 1. basics

console.log('=== 1. koffi + user32 basics ===')
const dpiMode = declareDpiAwareness()
const screenW = GetSystemMetrics(SM_CXSCREEN)
const screenH = GetSystemMetrics(SM_CYSCREEN)
console.log(`  dpi awareness: ${dpiMode}`)
console.log(`  screen: ${screenW} x ${screenH}`)
console.log(`  sizeof(INPUT) = ${koffi.sizeof(INPUT)} (Win32 x64 expects 40)`)

// ---------------------------------------------------- 2. window enumeration

console.log('\n=== 2. EnumWindows with native callback ===')
const windows = []
const EnumWindowsProc = koffi.proto('bool __stdcall EnumWindowsProc(intptr_t hwnd, intptr_t lParam)')
const cb = koffi.register((hwnd) => {
  if (IsWindowVisible(hwnd)) {
    const d = describe(hwnd)
    if (d.title) windows.push(d)
  }
  return true
}, koffi.pointer(EnumWindowsProc))
EnumWindows(cb, 0)
koffi.unregister(cb)
console.log(`  visible titled windows: ${windows.length}`)
for (const w of windows.slice(0, 12)) {
  console.log(`    [${w.pid}] "${w.title.slice(0, 46)}" ${w.rect.w}x${w.rect.h} @${w.rect.x},${w.rect.y}`)
}

// ------------------------------------------------- 3. foreground lock probe

console.log('\n=== 3. foreground-lock workaround (AttachThreadInput) ===')
const target = windows.find(w => /Outlook/i.test(w.title))
if (target) {
  const before = Number(GetForegroundWindow())
  console.log(`  before: fg=${before}, target=${target.hwnd} ("${target.title.slice(0, 40)}")`)

  const myTid = GetCurrentThreadId()
  const okAttach = AttachThreadInput(myTid, target.tid, true)
  const okSet = SetForegroundWindow(target.hwnd)
  const okTop = BringWindowToTop(target.hwnd)
  const okFocus = SetFocus(target.hwnd)
  AttachThreadInput(myTid, target.tid, false)

  sleepSync(600)
  const after = Number(GetForegroundWindow())
  console.log(`  AttachThreadInput=${okAttach}  SetForegroundWindow=${okSet}  BringWindowToTop=${okTop}  SetFocus=${okFocus}`)
  console.log(`  after : fg=${after}  -> ${after === target.hwnd ? 'SUCCESS (foreground lock bypassed)' : 'still not foreground'}`)
} else {
  console.log('  no Outlook window found to test against')
}

// ------------------------------------------------------------- 4. capture

console.log('\n=== 4. screen capture (PrintWindow on a WebView2 window) ===')
const capTarget = windows.find(w => /Outlook/i.test(w.title)) ?? windows[0]
if (capTarget && capTarget.rect.w > 0) {
  const { w, h } = capTarget.rect
  const hdcScreen = GetDC(0)
  const hdcMem = CreateCompatibleDC(hdcScreen)
  const hbm = CreateCompatibleBitmap(hdcScreen, w, h)
  const old = SelectObject(hdcMem, hbm)

  const okPrint = PrintWindow(capTarget.hwnd, hdcMem, PW_RENDERFULLCONTENT)

  const bi = { bmiHeader: { biSize: koffi.sizeof(BITMAPINFOHEADER), biWidth: w, biHeight: -h, biPlanes: 1, biBitCount: 32, biCompression: 0, biSizeImage: 0, biXPelsPerMeter: 0, biYPelsPerMeter: 0, biClrUsed: 0, biClrImportant: 0 }, bmiColors: [0, 0, 0] }
  const pixels = Buffer.alloc(w * h * 4)
  const lines = GetDIBits(hdcMem, hbm, 0, h, pixels, bi, 0)

  SelectObject(hdcMem, old)
  DeleteObject(hbm)
  DeleteDC(hdcMem)
  ReleaseDC(0, hdcScreen)

  // A blank capture would be a single repeated colour. Count distinct bytes.
  const seen = new Set()
  let nonBlack = 0
  for (let i = 0; i < pixels.length; i += 4 * 997) {
    seen.add(pixels.readUInt32LE(i))
    if (pixels[i] || pixels[i + 1] || pixels[i + 2]) nonBlack++
  }
  console.log(`  target: "${capTarget.title.slice(0, 40)}" ${w}x${h}`)
  console.log(`  PrintWindow=${okPrint}  GetDIBits lines=${lines}  sampled distinct colours=${seen.size}  non-black samples=${nonBlack}`)
  console.log(`  verdict: ${seen.size > 50 ? 'REAL CONTENT captured (WebView2 renders)' : 'BLANK/UNIFORM - capture failed'}`)

  const out = path.join(__dirname, 'capture-probe.bmp')
  const header = Buffer.alloc(14)
  header.write('BM', 0, 'ascii')
  header.writeUInt32LE(14 + 40 + pixels.length, 2)
  header.writeUInt32LE(54, 10)
  const dib = Buffer.alloc(40)
  dib.writeUInt32LE(40, 0); dib.writeInt32LE(w, 4); dib.writeInt32LE(-h, 8)
  dib.writeUInt16LE(1, 12); dib.writeUInt16LE(32, 14); dib.writeUInt32LE(0, 16)
  fs.writeFileSync(out, Buffer.concat([header, dib, pixels]))
  console.log(`  wrote ${out}`)
}

// -------------------------------------------------------------- 5. input

console.log('\n=== 5. input delivery ===')
const args = process.argv.slice(2)
if (args[0] === '--click') {
  const x = Number(args[1]); const y = Number(args[2])
  const nx = Math.round(x * 65535 / (screenW - 1))
  const ny = Math.round(y * 65535 / (screenH - 1))
  const mk = (flags) => ({ type: INPUT_MOUSE, u: { mi: { dx: nx, dy: ny, mouseData: 0, dwFlags: MOUSEEVENTF_MOVE | MOUSEEVENTF_ABSOLUTE | flags, time: 0, dwExtraInfo: 0 } } })
  const down = [mk(MOUSEEVENTF_LEFTDOWN)]
  const up = [mk(MOUSEEVENTF_LEFTUP)]
  const n1 = SendInput(1, down, koffi.sizeof(INPUT))
  sleepSync(90)
  const n2 = SendInput(1, up, koffi.sizeof(INPUT))
  console.log(`  SendInput down=${n1} up=${n2} at ${x},${y}`)
} else {
  console.log('  (skipped; pass --click X Y to test a real click)')
  console.log(`  sizeof(INPUT)=${koffi.sizeof(INPUT)} ready for SendInput`)
}

console.log('\n=== spike complete ===')
