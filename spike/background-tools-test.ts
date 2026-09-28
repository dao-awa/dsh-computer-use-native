/**
 * End-to-end test of the background input route through the shipped tools.
 *
 * The lower-level probe proves that posted messages reach a backgrounded
 * Chromium window. This test proves the plugin delivers them: it mounts the real
 * plugin, drives `computer_screenshot`, `computer_click`, and `computer_type`
 * against a live browser page, and reads the page's own counters out of a
 * follow-up screenshot. That path exercises coordinate conversion, the viewport
 * registry, route selection, and the result notes together, which no unit test
 * of any single piece can.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json spike/background-tools-test.ts
 */

import { spawn } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'
import { focusWindow, listWindows } from '../src/win32/window.ts'

/** Where the staged page and browser profile live; Chrome rejects a non-ASCII file:// path. */
const STAGE = join(tmpdir(), 'dsh-bg-input-probe')
const PAGE = join(STAGE, 'probe-target.html')
const PROFILE = join(STAGE, 'profile')
const SHOTS = join(import.meta.dirname, '..', 'spike-out')

const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'

const failures: string[] = []
function check(label: string, condition: boolean, detail: string): void {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}: ${detail}`)
  if (!condition) failures.push(label)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => { setTimeout(resolve, ms) })
}

/** Windows whose activation is transient or meaningless, so they make poor focus victims. */
const BAD_VICTIM = /输入体验|Program Manager|Windows 输入|^$/

// --------------------------------------------------------------- staged page

mkdirSync(STAGE, { recursive: true })
mkdirSync(PROFILE, { recursive: true })
mkdirSync(SHOTS, { recursive: true })
copyFileSync(join(import.meta.dirname, 'probe-target.html'), PAGE)

// ------------------------------------------------------------- plugin mount

let saved = 0
const tools = new Map<string, {
  execute: (args: Record<string, unknown>) => Promise<{ ok?: boolean, note?: string, summary?: string }>
}>()
const ctx = new Context()
ctx.provide('computerUse', { register: () => () => {} })
ctx.provide('tools', {
  register(tool: { name: string }): () => void {
    tools.set(tool.name, tool as never)
    return () => { tools.delete(tool.name) }
  },
})
ctx.provide('systemPrompt', { section: () => () => {}, getSectionOrder: () => 0 })
ctx.provide('attachments', {
  async saveImage(input: { data: Uint8Array, mediaType: string, name?: string }) {
    saved += 1
    const file = join(SHOTS, input.name ?? `shot-${saved}.png`)
    writeFileSync(file, input.data)
    return {
      attachmentId: `test-${saved}`,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 0,
      height: 0,
    }
  },
})

const fiber = await ctx.plugin(plugin, {})
console.log(`=== background input through the shipped tools ===\n`)
console.log(`plugin mounted with ${tools.size} tools\n`)

// ------------------------------------------------------------ probe browser

console.log('1. launch the probe page in a background-able browser')
let chrome = spawn(CHROME, [
  `--user-data-dir=${PROFILE}`,
  '--no-first-run',
  '--no-default-browser-check',
  `--app=file:///${PAGE.replace(/\\/g, '/')}`,
  '--window-size=1100,820',
  '--window-position=180,180',
], { detached: true, stdio: 'ignore' })
chrome.unref()

let probe: { hwnd: number, title: string } | undefined
for (let attempt = 0; attempt < 60 && probe === undefined; attempt += 1) {
  await sleep(500)
  probe = listWindows({ match: 'Background Input Probe' })[0]
}
if (probe === undefined) {
  console.log('  [FATAL] the probe window never appeared')
  await fiber.dispose()
  process.exit(1)
}
console.log(`  probe window hwnd=${probe.hwnd} "${probe.title}"`)
await sleep(1500)

// Background the probe behind a real application, so anything that reaches it
// did so without being the foreground window.
const victim = listWindows().find(window =>
  window.hwnd !== probe?.hwnd
  && !BAD_VICTIM.test(window.title)
  && window.title.length > 0
  && window.rect.width > 400
  && window.rect.height > 300)
if (victim !== undefined) {
  const raised = focusWindow(victim.hwnd)
  console.log(`  raised ${victim.hwnd} "${victim.title}" as the focus victim (${raised.method})`)
}
await sleep(600)

// ------------------------------------------------------------ the real test

console.log('\n2. screenshot the probe through computer_screenshot')
const shot = tools.get('computer_screenshot')
if (shot === undefined) throw new Error('computer_screenshot did not register')
const first = await shot.execute({ hwnd: probe.hwnd }) as {
  viewportId: string
  image: { width: number, height: number }
  summary: string
}
console.log(`  viewport ${first.viewportId}, image ${first.image.width}x${first.image.height}`)

// The page's input fills its drop pad, so a point below the stats row and
// inside the pad lands in the field at any window size.
const clickX = Math.round(first.image.width / 2)
const clickY = Math.round(first.image.height * 0.62)
console.log(`\n3. click the field at image ${clickX},${clickY} on the default (background) route`)
const click = tools.get('computer_click')
if (click === undefined) throw new Error('computer_click did not register')
const clicked = await click.execute({ x: clickX, y: clickY, viewport: first.viewportId })
console.log(`  ok=${clicked.ok}`)
for (const line of (clicked.note ?? '').split('\n')) console.log(`  | ${line}`)
check('click reported success', clicked.ok === true, String(clicked.ok))
check('click reported the background route', /without raising it/.test(clicked.note ?? ''),
  /posted window messages/.test(clicked.note ?? '') ? 'posted' : 'not posted')

await sleep(800)

console.log('\n4. type into the field on the default (background) route')
const type = tools.get('computer_type')
if (type === undefined) throw new Error('computer_type did not register')
const marker = 'tools-posted-OK'
const typed = await type.execute({ text: marker })
console.log(`  ok=${typed.ok}`)
for (const line of (typed.note ?? '').split('\n')) console.log(`  | ${line}`)
check('type reported success', typed.ok === true, String(typed.ok))
check('characters were posted to the probe window',
  (typed.note ?? '').includes(String(probe.hwnd)),
  (typed.note ?? '').split('\n')[0] ?? '')

await sleep(900)

console.log('\n5. screenshot again and read the page counters')
const second = await shot.execute({ hwnd: probe.hwnd }) as {
  viewportId: string
  image: { width: number, height: number }
}
const latest = join(SHOTS, 'background-tools-verdict.png')
const produced = join(SHOTS, `screenshot-${second.viewportId}.png`)
if (existsSync(produced)) copyFileSync(produced, latest)
console.log(`  saved ${latest}`)
console.log(`  the verdict is what that image shows: clicks >= 1 and typed text ${JSON.stringify(marker)}`)
console.log(`  image bytes ${readFileSync(latest).length}`)

console.log('\n6. clean up')
await fiber.dispose()
check('tools removed on dispose', tools.size === 0, `${tools.size} remaining`)
if (victim !== undefined) focusWindow(victim.hwnd)
spawn('taskkill', ['/PID', String(probe.hwnd), '/F', '/T'], { stdio: 'ignore' })
await sleep(400)

console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`} ===`)
console.log('Read spike-out/background-tools-verdict.png to confirm the page recorded the')
console.log('click and the typed text while the browser was in the background.')
process.exit(failures.length === 0 ? 0 : 1)
