/** Report what the window enumerator sees, to debug target resolution. */

import { configureDpiAwareness, listWindows, resolveWindow } from '../src/win32/window.ts'

console.log('dpi mode:', configureDpiAwareness())

const all = listWindows()
console.log('total windows enumerated:', all.length)
console.log('')

console.log('windows matching probe/chrome/标签:')
for (const w of all) {
  if (/probe|chrome|标签/i.test(w.title)) {
    console.log(`  hwnd=${w.hwnd} class=${w.className} pid=${w.pid} title=${JSON.stringify(w.title)}`)
  }
}

console.log('')
console.log('first 20 enumerated:')
for (const w of all.slice(0, 20)) {
  console.log(`  [${w.className}] pid=${w.pid} ${JSON.stringify(w.title.slice(0, 50))}`)
}

console.log('')
try {
  const hit = resolveWindow({ title: 'Background Input Probe' })
  console.log('resolveWindow by title ->', hit.hwnd, JSON.stringify(hit.title))
} catch (error) {
  console.log('resolveWindow by title FAILED:', (error as Error).message)
}

console.log('')
try {
  const hit = resolveWindow({ title: 'background input probe' })
  console.log('resolveWindow case-insensitive ->', hit.hwnd)
} catch (error) {
  console.log('resolveWindow case-insensitive FAILED:', (error as Error).message)
}
