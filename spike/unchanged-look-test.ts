/**
 * Prove that looking twice at an unchanged screen is nearly free.
 *
 * Encoding dominates a screenshot: measured at about seventy percent of the
 * total, with the capture next and the pixel comparison last. A person does not
 * pay that to glance again at something that has not moved, and an agent that
 * re-reads its own environment before every step should not either.
 *
 * This drives the shipped `computer_screenshot` against the real desktop — no
 * staged window, no fabricated page — and checks that the second look reports
 * the screen as unchanged, sends no image, and costs a fraction of the first.
 * It then forces a fresh look and checks that the image comes back, so the
 * cheap path cannot be reached by simply never sending anything.
 *
 * Run: npm run unchanged-look
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'

const SHOTS = join(import.meta.dirname, '..', 'spike-out')
mkdirSync(SHOTS, { recursive: true })

const failures: string[] = []
function check(label: string, condition: boolean, detail: string): void {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}: ${detail}`)
  if (!condition) failures.push(label)
}

/** One tool result, as the model would receive it. */
interface LookResult {
  viewportId: string
  image?: { attachmentId: string, bytes: number, width: number, height: number }
  summary: string
}

let saves = 0
const tools = new Map<string, { execute: (args: Record<string, unknown>) => Promise<LookResult> }>()

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
    saves += 1
    writeFileSync(join(SHOTS, input.name ?? `unchanged-${saves}.png`), input.data)
    return {
      attachmentId: `test-${saves}`,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 0,
      height: 0,
    }
  },
})

await ctx.plugin(plugin, {})
const look = tools.get('computer_screenshot')
if (look === undefined) {
  console.log('computer_screenshot was not registered')
  process.exit(1)
}

console.log('=== looking twice at the same screen ===\n')

const first = await timed(() => look.execute({}))
console.log('1. the first look')
console.log(`  ${first.ms.toFixed(0)} ms, image ${describeImage(first.value.image)}`)
check('the first look returned an image', first.value.image !== undefined,
  first.value.image === undefined ? 'no image' : `${first.value.image.width}x${first.value.image.height}`)
check('the first look stored an attachment', saves === 1, `${saves} saves`)
const firstViewport = first.value.viewportId

console.log('\n2. the second look, with nothing touched in between')
const second = await timed(() => look.execute({}))
console.log(`  ${second.ms.toFixed(0)} ms, ${second.value.image === undefined ? 'no image sent' : 'image sent'}`)
console.log('  summary: ' + second.value.summary.split('\n').join('\n           '))
check('the second look sent no image', second.value.image === undefined,
  second.value.image === undefined ? 'no image' : 'an image was re-sent')
check('the second look stored no attachment', saves === 1, `${saves} saves`)
check('the second look points back at the first viewport',
  second.value.viewportId === firstViewport,
  `${firstViewport} -> ${second.value.viewportId}`)
check('the second look says the screen is unchanged',
  /unchanged/i.test(second.value.summary), second.value.summary.split('\n')[0] ?? '')
check('looking again is cheaper than looking',
  second.ms < first.ms / 2,
  `${second.ms.toFixed(0)} ms vs ${first.ms.toFixed(0)} ms (${(second.ms / first.ms * 100).toFixed(0)}%)`)

console.log('\n3. asking for the picture again anyway')
const forced = await timed(() => look.execute({ fresh: true }))
console.log(`  ${forced.ms.toFixed(0)} ms, image ${describeImage(forced.value.image)}`)
check('a fresh look returns an image even when nothing changed',
  forced.value.image !== undefined, forced.value.image === undefined ? 'no image' : 'image sent')
check('a fresh look stored a new attachment', saves === 2, `${saves} saves`)

console.log('\n4. what the saving is worth')
const ratio = second.ms / first.ms
console.log(`  first look   ${first.ms.toFixed(0)} ms`)
console.log(`  repeat look  ${second.ms.toFixed(0)} ms   (${(ratio * 100).toFixed(0)}% of the first)`)
console.log(`  a perceive-act-perceive loop pays the full cost only when the screen moved.`)

console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`} ===`)
process.exit(failures.length === 0 ? 0 : 1)

/** A result plus how long producing it took. */
async function timed(run: () => Promise<LookResult>): Promise<{ value: LookResult, ms: number }> {
  const started = performance.now()
  const value = await run()
  return { value, ms: performance.now() - started }
}

/** Describe an image field for the log. */
function describeImage(image: LookResult['image']): string {
  if (image === undefined) return 'none'
  return `${image.width}x${image.height}, ${(image.bytes / 1024).toFixed(0)} KiB`
}
