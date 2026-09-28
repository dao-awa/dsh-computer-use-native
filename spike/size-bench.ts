/**
 * Measure the token-cost trade-off of the screenshot settings.
 *
 * A capture is re-encoded at several longest-edge limits and PNG efforts so the
 * plugin's defaults can be chosen from measured bytes rather than guessed. The
 * attachment service may re-compress for a route, so these figures bound the
 * cost the plugin itself imposes before any such normalization.
 *
 * Run: npx tsx spike/size-bench.ts
 */

import { captureWindowAuto } from '../src/win32/capture.ts'
import { configureDpiAwareness, getWindowInfo, listWindows } from '../src/win32/window.ts'
import { encodeFrame } from '../src/encode.ts'

configureDpiAwareness()

const windows = listWindows()
const target = windows.find(w => /vivaldi|chrome|edge/i.test(`${w.title} ${w.className}`))
if (target === undefined) {
  console.error('no browser window found')
  process.exit(2)
}
const info = getWindowInfo(target.hwnd)
console.log(`source: "${info.title.slice(0, 50)}" ${info.rect.width}x${info.rect.height}\n`)

const edges = [1024, 1280, 1568, 1920]
const levels = [6, 9]

console.log('maxEdge  effort   dimensions      bytes      KB   vs 1568/e6')
console.log('-'.repeat(64))

let baseline = 0
for (const effort of levels) {
  for (const maxEdge of edges) {
    // Each encode mutates its frame's pixels in place, so capture per run.
    const captured = captureWindowAuto(info.hwnd, info.rect, { allowScreenFallback: true })
    const encoded = await encodeFrame(captured.frame, { maxEdge, compressionLevel: effort })
    if (maxEdge === 1568 && effort === 6) baseline = encoded.data.length
    const ratio = baseline === 0 ? '' : `${((encoded.data.length / baseline) * 100).toFixed(0)}%`
    console.log(
      `${String(maxEdge).padStart(7)}  ${String(effort).padStart(6)}   `
      + `${String(`${encoded.width}x${encoded.height}`).padEnd(14)}  `
      + `${String(encoded.data.length).padStart(8)}  ${String(Math.round(encoded.data.length / 1024)).padStart(6)}   ${ratio}`,
    )
  }
}
