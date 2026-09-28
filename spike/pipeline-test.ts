/**
 * End-to-end test of the capture-to-click pipeline.
 *
 * Exercises the exact sequence the tools perform, without needing a running
 * harness: capture a window, encode it for the model, mint a viewport, convert a
 * point measured on the encoded image back to screen coordinates, and click it.
 *
 * The point of the test is the coordinate round trip. A player window is
 * captured, a point at a known fraction of the image is converted, and the
 * resulting screen coordinate is checked against where that fraction actually
 * falls on screen. If DPI awareness, the downscale, or the viewport arithmetic
 * were wrong, the two would disagree.
 *
 * Run: npx tsx spike/pipeline-test.ts [--click]
 */

import { writeFileSync } from 'node:fs'
import { captureWindowAuto, distinctColourCount, virtualScreenRegion, captureScreen } from '../src/win32/capture.ts'
import { configureDpiAwareness, getWindowInfo, listWindows, focusWindow } from '../src/win32/window.ts'
import { clickAt, cursorPosition } from '../src/win32/input.ts'
import { encodeFrame } from '../src/encode.ts'
import { createViewport, describeViewport, imageToScreen, screenToImage, viewportIsStale, ViewportRegistry } from '../src/viewport.ts'

const failures: string[] = []
function check(label: string, condition: boolean, detail: string): void {
  const mark = condition ? 'PASS' : 'FAIL'
  console.log(`  [${mark}] ${label}: ${detail}`)
  if (!condition) failures.push(label)
}

console.log('=== pipeline test ===\n')
configureDpiAwareness()

console.log('1. capture a real window')
const windows = listWindows()
const target = windows.find(w => /vivaldi|chrome|edge|explorer/i.test(`${w.title} ${w.className}`))
if (target === undefined) {
  console.error('no suitable window found; open a browser or Explorer window and retry')
  process.exit(2)
}
const info = getWindowInfo(target.hwnd)
console.log(`   target hwnd=${info.hwnd} "${info.title.slice(0, 46)}" ${info.rect.width}x${info.rect.height} @${info.rect.x},${info.rect.y}`)

const captured = captureWindowAuto(info.hwnd, info.rect, { allowScreenFallback: true })
check('capture produced real content', distinctColourCount(captured.frame) > 4,
  `${captured.frame.method}, ${distinctColourCount(captured.frame)} colours`)
check('capture matches window size',
  captured.frame.width === info.rect.width && captured.frame.height === info.rect.height,
  `${captured.frame.width}x${captured.frame.height} vs ${info.rect.width}x${info.rect.height}`)

console.log('\n2. encode for the model')
const encoded = await encodeFrame(captured.frame, { maxEdge: 1568 })
check('encoded as PNG', encoded.data.subarray(0, 8).toString('hex') === '89504e470d0a1a0a',
  `${encoded.data.length} bytes`)
check('downscaled to the token budget', Math.max(encoded.width, encoded.height) <= 1568,
  `${encoded.width}x${encoded.height} from ${encoded.sourceWidth}x${encoded.sourceHeight}`)
const pngPath = new URL('./pipeline-capture.png', import.meta.url)
writeFileSync(pngPath, encoded.data)
console.log(`   wrote ${pngPath.pathname}`)

console.log('\n3. mint the viewport')
const viewport = createViewport({
  image: { width: encoded.width, height: encoded.height },
  screen: {
    x: captured.frame.origin.x,
    y: captured.frame.origin.y,
    width: captured.frame.width,
    height: captured.frame.height,
  },
  window: { hwnd: info.hwnd, title: info.title, className: info.className },
  method: captured.frame.method,
})
console.log(describeViewport(viewport).split('\n').map(line => `   ${line}`).join('\n'))

console.log('\n4. coordinate round trip')
const scale = { x: viewport.screen.width / viewport.image.width, y: viewport.screen.height / viewport.image.height }
console.log(`   scale ${scale.x.toFixed(4)}x ${scale.y.toFixed(4)}y`)

// The centre of the image must map to the centre of the captured screen region.
const centreImage = { x: Math.round(encoded.width / 2), y: Math.round(encoded.height / 2) }
const centreScreen = imageToScreen(viewport, centreImage)
const expectedCentre = {
  x: viewport.screen.x + Math.round(viewport.screen.width / 2),
  y: viewport.screen.y + Math.round(viewport.screen.height / 2),
}
check('image centre maps to region centre',
  Math.abs(centreScreen.x - expectedCentre.x) <= 1 && Math.abs(centreScreen.y - expectedCentre.y) <= 1,
  `got ${centreScreen.x},${centreScreen.y}, expected ~${expectedCentre.x},${expectedCentre.y}`)

// Both corners must land exactly on the region edges.
const topLeft = imageToScreen(viewport, { x: 0, y: 0 })
check('image origin maps to region origin',
  topLeft.x === viewport.screen.x && topLeft.y === viewport.screen.y,
  `${topLeft.x},${topLeft.y} vs ${viewport.screen.x},${viewport.screen.y}`)

const bottomRight = imageToScreen(viewport, { x: encoded.width, y: encoded.height })
check('image extent maps to region extent',
  Math.abs(bottomRight.x - (viewport.screen.x + viewport.screen.width)) <= 1
  && Math.abs(bottomRight.y - (viewport.screen.y + viewport.screen.height)) <= 1,
  `${bottomRight.x},${bottomRight.y}`)

// A round trip through both directions must be lossless for interior points.
let worstRoundTrip = 0
for (const fraction of [0.1, 0.25, 0.5, 0.75, 0.9]) {
  const original = { x: Math.round(encoded.width * fraction), y: Math.round(encoded.height * fraction) }
  const back = screenToImage(viewport, imageToScreen(viewport, original))
  worstRoundTrip = Math.max(worstRoundTrip, Math.abs(back.x - original.x), Math.abs(back.y - original.y))
}
check('round trip is exact', worstRoundTrip <= 1, `worst deviation ${worstRoundTrip} px`)

console.log('\n5. bounds and staleness guards')
let rejected = false
try {
  imageToScreen(viewport, { x: encoded.width + 50, y: 10 })
} catch (error) {
  rejected = true
}
check('out-of-image point is refused', rejected, rejected ? 'threw as expected' : 'accepted an impossible point')
check('fresh capture is not stale', !viewportIsStale(viewport), 'fingerprint matches')

const registry = new ViewportRegistry()
registry.remember(viewport)
check('registry resolves the latest viewport', registry.resolve().id === viewport.id, registry.resolve().id)
check('registry resolves by id', registry.resolve(viewport.id).id === viewport.id, viewport.id)
let unknownRejected = false
try {
  registry.resolve('vp999')
} catch (error) {
  unknownRejected = true
}
check('unknown viewport id is refused', unknownRejected, 'threw as expected')

console.log('\n6. focus workaround')
const focus = focusWindow(info.hwnd)
check('window can be raised', focus.ok, `method=${focus.method}, fg ${focus.previous} -> ${focus.current}`)

console.log('\n7. full-screen capture path')
const full = captureScreen(virtualScreenRegion())
check('virtual desktop captured', distinctColourCount(full) > 4,
  `${full.width}x${full.height}, ${distinctColourCount(full)} colours`)

console.log('\n8. input')
if (process.argv.includes('--click')) {
  const before = cursorPosition()
  const destination = imageToScreen(viewport, { x: Math.round(encoded.width / 2), y: Math.round(encoded.height / 2) })
  clickAt(destination.x, destination.y, 'left', 1)
  const after = cursorPosition()
  check('cursor moved to the clicked point',
    Math.abs(after.x - destination.x) <= 2 && Math.abs(after.y - destination.y) <= 2,
    `${before.x},${before.y} -> ${after.x},${after.y}, target ${destination.x},${destination.y}`)
} else {
  console.log('   skipped (pass --click to send a real click at the window centre)')
}

console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`} ===`)
process.exit(failures.length === 0 ? 0 : 1)
