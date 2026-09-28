/**
 * Re-encode the spike's raw capture as PNG so the model can actually look at it.
 * Windows GDI hands back BGRA; PNG wants RGBA, so the channels need swapping.
 *
 * Run: node spike/to-png.cjs <input.bmp> <output.png> [maxWidth]
 */

const fs = require('node:fs')
const path = require('node:path')
const sharp = require('sharp')

const [, , inPath, outPath, maxWidthArg] = process.argv

if (!inPath || !outPath) {
  console.error('usage: node spike/to-png.cjs <input.bmp> <output.png> [maxWidth]')
  process.exit(2)
}

const buf = fs.readFileSync(inPath)

if (buf.subarray(0, 2).toString('ascii') !== 'BM') {
  console.error(`not a BMP: magic=${JSON.stringify(buf.subarray(0, 2).toString('ascii'))}`)
  process.exit(2)
}

const dataOffset = buf.readUInt32LE(10)
const dibSize = buf.readUInt32LE(14)
const width = buf.readInt32LE(18)
const rawHeight = buf.readInt32LE(22)
const bpp = buf.readUInt16LE(28)
const compression = buf.readUInt32LE(30)

const topDown = rawHeight < 0
const height = Math.abs(rawHeight)

console.log(`BMP: ${width}x${height} ${bpp}bpp compression=${compression} offset=${dataOffset} topDown=${topDown} fileSize=${buf.length}`)

if (bpp !== 32 || compression !== 0) {
  console.error(`unsupported: need 32bpp BI_RGB, got ${bpp}bpp compression=${compression}`)
  process.exit(2)
}

// Copy the pixel block so the source buffer can be transformed in place.
const stride = width * 4
const pixels = Buffer.alloc(stride * height)
for (let y = 0; y < height; y++) {
  // Bottom-up BMP stores its first row at the bottom of the image.
  const srcRow = topDown ? y : height - 1 - y
  buf.copy(pixels, y * stride, dataOffset + srcRow * stride, dataOffset + (srcRow + 1) * stride)
}

// BGRA -> RGBA
for (let i = 0; i < pixels.length; i += 4) {
  const b = pixels[i]
  pixels[i] = pixels[i + 2]
  pixels[i + 2] = b
  pixels[i + 3] = 255
}

const maxWidth = maxWidthArg ? Number(maxWidthArg) : 0
let image = sharp(pixels, { raw: { width, height, channels: 4 } })
if (maxWidth > 0 && width > maxWidth) image = image.resize({ width: maxWidth })

image
  .png({ compressionLevel: 9 })
  .toFile(outPath)
  .then(info => {
    console.log(`wrote ${path.resolve(outPath)} — ${info.width}x${info.height}, ${info.size} bytes`)
  })
  .catch(error => {
    console.error('encode failed:', error.message)
    process.exit(1)
  })
