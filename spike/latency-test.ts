/**
 * Break down where a screenshot's time actually goes.
 *
 * The tool's cost is not one thing: it captures through GDI, converts and scales
 * the pixels, and encodes them to PNG. Optimising the wrong stage makes the tool
 * more complicated without making it faster, so this measures each stage
 * separately and prints its share of the total.
 *
 * It also measures what a continuous view would cost: noticing that nothing
 * changed is a buffer comparison, not an encode, and that ratio is what decides
 * whether looking can be cheap enough to do constantly.
 *
 * Run: npm run latency
 */

import { createHash } from 'node:crypto'
import { configureDpiAwareness } from '../src/win32/window.ts'
import { captureScreen, virtualScreenRegion } from '../src/win32/capture.ts'
import { encodeFrame } from '../src/encode.ts'
import type { CaptureFrame } from '../src/win32/capture.ts'

/** Median of repeated samples, in milliseconds. */
function median(samples: number[]): number {
  const sorted = [...samples].sort((a, b) => a - b)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 1
    ? sorted[middle] ?? 0
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2
}

/** A full-size copy of a frame that encoding will not modify. */
function cloneFrame(frame: CaptureFrame): CaptureFrame {
  return { width: frame.width, height: frame.height, pixels: Buffer.from(frame.pixels) }
}

configureDpiAwareness()

const ROUNDS = 9
const region = virtualScreenRegion()
const megapixels = (region.width * region.height / 1_000_000).toFixed(1)

console.log('=== what one look costs ===\n')
console.log(`  screen region ${region.width}x${region.height} (${megapixels} MP)\n`)

const captureTimes: number[] = []
const hashTimes: number[] = []
const encodeTimes: number[] = []
let sample: CaptureFrame | undefined

for (let round = 0; round < ROUNDS; round += 1) {
  const captureStart = performance.now()
  const frame = captureScreen(region)
  captureTimes.push(performance.now() - captureStart)

  const hashStart = performance.now()
  createHash('sha256').update(frame.pixels).digest('hex')
  hashTimes.push(performance.now() - hashStart)

  const pristine = cloneFrame(frame)
  const encodeStart = performance.now()
  await encodeFrame(pristine, { maxEdge: 1568, compressionLevel: 6 })
  encodeTimes.push(performance.now() - encodeStart)

  sample = cloneFrame(frame)
}

const capture = median(captureTimes)
const hash = median(hashTimes)
const encode = median(encodeTimes)
const total = capture + hash + encode

console.log('  stage                              median     share')
for (const [label, value] of [
  ['capture the screen (GDI)', capture],
  ['hash the raw pixels', hash],
  ['convert, scale, encode to PNG', encode],
] as const) {
  console.log(`  ${label.padEnd(32)} ${value.toFixed(1).padStart(7)} ms   ${(value / total * 100).toFixed(0).padStart(3)}%`)
}
console.log(`  ${'total'.padEnd(32)} ${total.toFixed(1).padStart(7)} ms`)

const rawMiB = (sample ? sample.pixels.length / 1024 / 1024 : 0).toFixed(1)
console.log(`\n  noticing "nothing changed" costs ${hash.toFixed(1)} ms, ${(hash / total * 100).toFixed(1)}% of a look.`)
console.log(`  The raw frame is ${rawMiB} MiB; the encode is what dominates.`)

console.log('\n=== does hashing the pixels catch a real change ===\n')
if (sample) {
  const before = createHash('sha256').update(sample.pixels).digest('hex')
  const again = createHash('sha256').update(sample.pixels).digest('hex')
  const touched = Buffer.from(sample.pixels)
  // One byte of one pixel in the middle of the frame.
  const middle = Math.floor(touched.length / 2)
  touched[middle] = (touched[middle] ?? 0) ^ 0xff
  const after = createHash('sha256').update(touched).digest('hex')
  console.log(`  same buffer twice      -> ${before === again ? 'equal (no false change)' : 'DIFFERENT'}`)
  console.log(`  one pixel perturbed    -> ${before !== after ? 'different (change seen)' : 'MISSED THE CHANGE'}`)
}

console.log('\n=== encode effort trade-off, same frame ===\n')
console.log('  effort      bytes       ms   vs effort 6')
const effortTimes = new Map<number, number>()
for (const level of [0, 3, 6, 9]) {
  const samples: number[] = []
  let bytes = 0
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    const encoded = await encodeFrame(cloneFrame(sample!), { maxEdge: 1568, compressionLevel: level })
    samples.push(performance.now() - start)
    bytes = encoded.data.length
  }
  effortTimes.set(level, median(samples))
  console.log(`  ${String(level).padStart(6)}  ${(bytes / 1024).toFixed(0).padStart(6)} KiB  ${median(samples).toFixed(1).padStart(6)}`)
}
const effortBaseline = effortTimes.get(6) ?? 1
console.log('\n  relative to effort 6 (default), same bytes-read:')
for (const level of [0, 3, 6, 9]) {
  const value = effortTimes.get(level) ?? 0
  console.log(`  ${String(level).padStart(6)}  ${(value / effortBaseline * 100).toFixed(0).padStart(5)}% of its time`)
}

console.log('\n=== resolution trade-off, same frame, effort 6 ===\n')
console.log('  maxEdge     image      KiB       ms')
for (const maxEdge of [2560, 1568, 1100, 800, 512]) {
  const samples: number[] = []
  let bytes = 0
  let size = ''
  for (let round = 0; round < 5; round += 1) {
    const start = performance.now()
    const encoded = await encodeFrame(cloneFrame(sample!), { maxEdge, compressionLevel: 6 })
    samples.push(performance.now() - start)
    bytes = encoded.data.length
    size = `${encoded.width}x${encoded.height}`
  }
  console.log(`  ${String(maxEdge).padStart(7)}  ${size.padStart(9)}  ${(bytes / 1024).toFixed(0).padStart(6)}  ${median(samples).toFixed(1).padStart(6)}`)
}

console.log('\n=== what a continuous eye would cost per second ===\n')
console.log('  polling rate   capture+hash per second')
for (const rate of [1, 5, 10]) {
  const perPoll = capture + hash
  console.log(`  ${String(rate).padStart(8)} Hz   ${(perPoll * rate).toFixed(0).padStart(6)} ms/s  (${(perPoll * rate / 10).toFixed(1)}% of one core)`)
}
