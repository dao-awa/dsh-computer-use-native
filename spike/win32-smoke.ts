/**
 * Smoke test for the Win32 layer.
 *
 * Exercises the three foundations the plugin stands on, in the order the plugin
 * itself uses them: calibrate DPI awareness, enumerate and capture a window, and
 * confirm the input path can reach the desktop. A click is only sent when the
 * caller passes coordinates, so the default run is non-destructive.
 *
 * Run: npx tsx spike/win32-smoke.ts [--click X Y] [--title FRAGMENT]
 */

import { configureDpiAwareness, focusWindow, getWindowInfo, listWindows } from '../src/win32/window.ts'
import { captureScreen, captureWindowAuto, distinctColourCount, virtualScreenRegion } from '../src/win32/capture.ts'
import { assertInputLayout } from '../src/win32/native.ts'
import { clickAt, cursorPosition } from '../src/win32/input.ts'
import { GetSystemMetrics, SM_CXSCREEN, SM_CYSCREEN } from '../src/win32/dll.ts'

console.log('=== 1. calibration ===')
console.log(`  dpi awareness : ${configureDpiAwareness()}`)
console.log(`  primary screen: ${GetSystemMetrics(SM_CXSCREEN)}x${GetSystemMetrics(SM_CYSCREEN)}`)
console.log(`  virtual screen: ${JSON.stringify(virtualScreenRegion())}`)
console.log(`  sizeof(INPUT) : ${assertInputLayout()} (x64 ABI requires 40)`)
console.log(`  cursor        : ${JSON.stringify(cursorPosition())}`)

console.log('\n=== 2. window enumeration ===')
const all = listWindows()
console.log(`  ${all.length} titled, visible windows`)
for (const window of all.slice(0, 10)) {
  const label = window.title.length > 44 ? `${window.title.slice(0, 44)}…` : window.title
  console.log(`    ${String(window.hwnd).padStart(9)}  pid=${String(window.pid).padStart(6)}  ${window.rect.width}x${window.rect.height} @${window.rect.x},${window.rect.y}  "${label}"`)
}

console.log('\n=== 3. capture ===')
const titleFragment = process.argv.includes('--title')
  ? process.argv[process.argv.indexOf('--title') + 1]
  : undefined

// Prefer a Chromium-hosted window: those are exactly the surfaces the old
// accessibility-tree provider could not see into.
const target = (titleFragment
  ? all.find(window => window.title.toLowerCase().includes(titleFragment.toLowerCase()))
  : undefined)
  ?? all.find(window => /vivaldi|chrome|edge|electron|outlook/i.test(`${window.title} ${window.className}`))
  ?? all.find(window => window.title.length > 0)

if (target) {
  const info = getWindowInfo(target.hwnd)
  console.log(`  target: hwnd=${info.hwnd} "${info.title.slice(0, 50)}"`)
  console.log(`          class=${info.className} frame ${info.rect.width}x${info.rect.height} @${info.rect.x},${info.rect.y} dpi=${info.dpi}`)

  const result = captureWindowAuto(info.hwnd, info.rect, { allowScreenFallback: true })
  console.log(`  picked: ${result.frame.method} ${result.frame.width}x${result.frame.height} colours=${distinctColourCount(result.frame)} blankSuspect=${result.blankSuspect}`)
  for (const attempt of result.attempts) {
    console.log(`    ${attempt.method.padEnd(13)} ${attempt.error ?? `${attempt.colours} colours`}`)
  }
}

const screenFrame = captureScreen({ x: 0, y: 0, width: 640, height: 360 })
console.log(`  screen probe : ${screenFrame.width}x${screenFrame.height} colours=${distinctColourCount(screenFrame)}`)

console.log('\n=== 4. foreground workaround ===')
if (target) {
  const result = focusWindow(target.hwnd)
  console.log(`  method=${result.method} ok=${result.ok}`)
  console.log(`  foreground ${result.previous} -> ${result.current}`)
}

console.log('\n=== 5. input ===')
const clickIndex = process.argv.indexOf('--click')
if (clickIndex !== -1) {
  const x = Number(process.argv[clickIndex + 1])
  const y = Number(process.argv[clickIndex + 2])
  clickAt(x, y, 'left', 1)
  console.log(`  clicked ${x},${y}; cursor now ${JSON.stringify(cursorPosition())}`)
} else {
  console.log('  skipped (pass --click X Y to send a real click)')
}

console.log('\n=== smoke complete ===')
