/**
 * Determine whether posted window messages drive a Chromium window while it is
 * not in the foreground.
 *
 * The plugin injects through `SendInput`, which only reaches the foreground
 * window, so every point operation must raise its target first and the desktop
 * is unusable meanwhile. This probe measures whether `PostMessage` is a real
 * alternative: it backgrounds a Chromium window, posts a click and keystrokes,
 * and records both the foreground transitions and a screenshot of the page's own
 * readout.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json spike/background-input-probe.ts
 */

import { spawn } from 'node:child_process'
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ClientToScreen,
  FindWindowExW,
  GetClientRect,
  GetForegroundWindow,
  MK_LBUTTON,
  PostMessageW,
  ScreenToClient,
  SendMessageBuffer,
  SendMessageW,
  WM_CHAR,
  WM_GETTEXT,
  WM_GETTEXTLENGTH,
  WM_LBUTTONDOWN,
  WM_LBUTTONUP,
  WM_MOUSEMOVE,
} from '../src/win32/dll.ts'
import { decodeUtf16, readPointer, sleepSync } from '../src/win32/native.ts'
import { captureWindowAuto, distinctColourCount } from '../src/win32/capture.ts'
import { configureDpiAwareness, focusWindow, listWindows, resolveWindow } from '../src/win32/window.ts'
import { encodeFrame } from '../src/encode.ts'

const here = dirname(fileURLToPath(import.meta.url))
// Chrome will not open a file:// URL whose path holds non-ASCII characters, and
// this project lives under a Chinese directory name, so the page and the browser
// profile are staged in the ASCII temp directory instead.
const stage = join(tmpdir(), 'dsh-bg-input-probe')
mkdirSync(stage, { recursive: true })
const target = join(stage, 'probe-target.html')
copyFileSync(join(here, 'probe-target.html'), target)
const profileDir = join(stage, 'profile')
const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

/** One observed fact, printed as it is established. */
function note(label: string, detail: string): void {
  console.log(`  ${label}: ${detail}`)
}

/** Pack two 16-bit client coordinates into the `lParam` of a mouse message. */
function packPoint(x: number, y: number): number {
  return ((y & 0xffff) << 16) | (x & 0xffff)
}

/** Read a control's text through the message interface rather than a screenshot. */
function readWindowText(hwnd: number): string {
  const length = Number(SendMessageW(hwnd, WM_GETTEXTLENGTH, 0, 0))
  if (length <= 0) return ''
  const buffer = Buffer.alloc((length + 1) * 2)
  const copied = Number(SendMessageBuffer(hwnd, WM_GETTEXT, length + 1, buffer))
  return decodeUtf16(buffer, copied)
}

/** Capture a window and save it beside the probe as evidence. */
async function savePng(hwnd: number, name: string): Promise<void> {
  try {
    const result = captureWindowAuto(hwnd, undefined, { allowScreenFallback: true })
    const encoded = await encodeFrame(result.frame, { maxEdge: 1000, compressionLevel: 6 })
    writeFileSync(join(here, name), encoded.data)
    const route = result.attempts.map(a => a.method).join('+')
    console.log(`         saved ${name} — ${route}, ${distinctColourCount(result.frame)} colours, ${Math.round(encoded.data.length / 1024)} KB`)
  } catch (error) {
    console.log(`         capture failed: ${(error as Error).message}`)
  }
}

/**
 * Screen coordinates of a window's client-area centre.
 *
 * Mouse messages posted to a window carry client coordinates, and the client
 * origin is not the frame origin — Chromium draws its own toolbar inside the
 * client area — so a screenshot point has to cross both spaces.
 * @param hwnd - window to measure.
 * @returns the client centre in screen pixels, or undefined when unreadable.
 */
function clientCentreOnScreen(hwnd: number): { x: number, y: number, width: number, height: number } | undefined {
  // koffi fills a plain object in place for an `_Out_` struct parameter.
  const rect: Record<string, number> = {}
  if (!GetClientRect(hwnd, rect)) return undefined
  const width = (rect.right ?? 0) - (rect.left ?? 0)
  const height = (rect.bottom ?? 0) - (rect.top ?? 0)
  if (width <= 0 || height <= 0) return undefined
  const point: Record<string, number> = { x: Math.round(width / 2), y: Math.round(height / 2) }
  ClientToScreen(hwnd, point)
  return { x: point.x ?? 0, y: point.y ?? 0, width, height }
}

/**
 * Convert a screen point to the client coordinates a mouse message needs.
 * @param hwnd - target window.
 * @param screen - point in screen pixels.
 * @returns the same point in the window's client space.
 */
function toClient(hwnd: number, screen: { x: number, y: number }): { x: number, y: number } {
  const point: Record<string, number> = { x: screen.x, y: screen.y }
  ScreenToClient(hwnd, point)
  return { x: point.x ?? 0, y: point.y ?? 0 }
}

configureDpiAwareness()
console.log('=== can posted messages drive a background Chromium window? ===\n')

// ------------------------------------------------------------------ target

console.log('1. bring up the probe target')
function findProbe(): ReturnType<typeof resolveWindow> | undefined {
  try {
    return resolveWindow({ title: 'Background Input Probe' })
  } catch {
    return undefined
  }
}

let browser = findProbe()
if (browser === undefined) {
  const child = spawn(chrome, [
    `--app=file:///${target.replace(/\\/g, '/')}`,
    '--window-size=1000,700',
    '--window-position=120,120',
    '--no-first-run',
    '--no-default-browser-check',
    '--user-data-dir=' + profileDir,
  ], { detached: true, stdio: 'ignore' })
  child.unref()
  // A fresh user-data-dir makes the first launch slow while Chrome builds the
  // profile, so allow well past the steady-state startup time.
  for (let attempt = 0; attempt < 60 && browser === undefined; attempt += 1) {
    sleepSync(500)
    browser = findProbe()
  }
} else {
  console.log('  reusing the already-open probe window')
}
if (browser === undefined) {
  console.log('  [FATAL] the probe window never appeared')
  process.exit(1)
}
const targetHwnd = browser.hwnd
console.log(`  hwnd=${targetHwnd} class=${browser.className} pid=${browser.pid}`)
console.log(`  frame ${browser.rect.width}x${browser.rect.height} at ${browser.rect.x},${browser.rect.y}`)

// The page needs a moment after first paint before its listeners are attached.
sleepSync(1800)
await savePng(targetHwnd, 'probe-0-initial.png')

// ------------------------------------------------- pick a real victim window

console.log('\n2. background the target behind a real application window')
const candidates = listWindows()
  .filter((w) => w.hwnd !== targetHwnd && w.rect.width >= 500 && w.rect.height >= 400)
  .filter((w) => !/输入体验|Program Manager|Windows 输入/.test(w.title))
console.log(`  ${candidates.length} candidate windows to raise instead:`)
for (const w of candidates.slice(0, 6)) {
  console.log(`    ${w.hwnd}  ${w.className}  ${JSON.stringify(w.title.slice(0, 40))}`)
}

const victim = candidates[0]
if (victim === undefined) {
  console.log('  [FATAL] no usable victim window')
  process.exit(1)
}
const raised = focusWindow(victim.hwnd)
sleepSync(600)
const foregroundAfterRaise = readPointer(GetForegroundWindow())
note('raised', `${victim.hwnd} "${victim.title.slice(0, 36)}" via ${raised.method}`)
note('foreground now', String(foregroundAfterRaise))
note('target is backgrounded', String(foregroundAfterRaise !== targetHwnd))

// ------------------------------------------------------------ posted click

console.log('\n3. post a click into the background window')
const centre = clientCentreOnScreen(targetHwnd)
if (centre === undefined) {
  console.log('  [FATAL] could not read the client area')
  process.exit(1)
}
const client = toClient(targetHwnd, centre)
note('client area', `${centre.width}x${centre.height}`)
note('client centre on screen', `${centre.x},${centre.y}`)
note('client centre in client space', `${client.x},${client.y}`)

const lparam = packPoint(client.x, client.y)
PostMessageW(targetHwnd, WM_MOUSEMOVE, 0, lparam)
sleepSync(120)
const downOk = PostMessageW(targetHwnd, WM_LBUTTONDOWN, MK_LBUTTON, lparam)
sleepSync(140)
const upOk = PostMessageW(targetHwnd, WM_LBUTTONUP, 0, lparam)
sleepSync(900)
note('WM_LBUTTONDOWN posted', String(downOk))
note('WM_LBUTTONUP posted', String(upOk))
note('foreground after click', String(readPointer(GetForegroundWindow())))
note('click stole the foreground', String(readPointer(GetForegroundWindow()) === targetHwnd))
await savePng(targetHwnd, 'probe-1-after-click.png')

// --------------------------------------------------------- posted keystrokes

console.log('\n4. post keystrokes into the background window')
const text = 'bg-input-OK'
for (const character of text) {
  PostMessageW(targetHwnd, WM_CHAR, character.charCodeAt(0), 1)
  sleepSync(50)
}
sleepSync(900)
note('characters posted', String(text.length))
note('foreground after typing', String(readPointer(GetForegroundWindow())))
note('typing stole the foreground', String(readPointer(GetForegroundWindow()) === targetHwnd))
await savePng(targetHwnd, 'probe-2-after-typing.png')

console.log('\n4b. post a named key (Tab) as WM_KEYDOWN/WM_KEYUP')
PostMessageW(targetHwnd, 0x0100, 0x09, 1)
sleepSync(80)
PostMessageW(targetHwnd, 0x0101, 0x09, 1)
sleepSync(500)
await savePng(targetHwnd, 'probe-3-after-tab.png')

// ------------------------------------------------ classic Win32 control group

console.log('\n5. control: posted text into a classic Win32 Edit control')
const pad = spawn('notepad.exe', [], { detached: true, stdio: 'ignore' })
pad.unref()
sleepSync(2500)
// The edit box is a child window, so it is reachable only through FindWindowExW
// rather than the top-level enumeration.
let notepadFrame = 0
for (let attempt = 0; attempt < 20 && notepadFrame === 0; attempt += 1) {
  notepadFrame = Number(FindWindowExW(0, 0, 'Notepad', null))
  if (notepadFrame === 0) sleepSync(400)
}
const editHwnd = Number(FindWindowExW(notepadFrame, 0, 'Edit', null))
if (notepadFrame === 0 || editHwnd === 0) {
  console.log(`  [SKIP] notepad frame=${notepadFrame} edit=${editHwnd}`)
} else {
  console.log(`  notepad frame=${notepadFrame} edit=${editHwnd}`)
  const marker = 'posted-message-text'
  for (const character of marker) {
    PostMessageW(editHwnd, WM_CHAR, character.charCodeAt(0), 1)
    sleepSync(30)
  }
  sleepSync(700)
  const readBack = readWindowText(editHwnd)
  note('Edit content', JSON.stringify(readBack.slice(0, 60)))
  note('posted text arrived', String(readBack.includes(marker)))
  spawn('taskkill', ['/PID', String(notepadFrame), '/F', '/T'], { stdio: 'ignore' })
  spawn('taskkill', ['/IM', 'notepad.exe', '/F'], { stdio: 'ignore' })
}

console.log('\n=== done ===')
console.log('The screenshots carry the verdict for Chromium: read')
console.log('probe-1-after-click.png and probe-2-after-typing.png to see whether the')
console.log('page counted the click and recorded the typed text.')
