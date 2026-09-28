/**
 * Frame encoding for model consumption.
 *
 * GDI hands back 32-bit BGRA rows with the alpha byte unset; PNG carries RGBA.
 * Swapping the red and blue channels is therefore mandatory, and skipping it
 * produces an image whose colours are wrong in a way that still looks plausible
 * — which is worse than an obvious failure, because the model would reason
 * about the wrong pixels without noticing.
 *
 * Frames are downscaled before encoding. A 2560-wide window is legible to the
 * model at half that size, and the full-resolution PNG would cost roughly four
 * times the tokens for no additional understanding.
 *
 * @module dsh-computer-use-native/encode
 */

import sharp from 'sharp'
import type { CaptureFrame } from './win32/capture.ts'

/** An encoded image ready to be stored as an attachment. */
export interface EncodedImage {
  /** PNG bytes. */
  data: Buffer
  /** Media type of `data`. */
  mediaType: 'image/png'
  /** Encoded width in pixels; differs from the capture when downscaled. */
  width: number
  /** Encoded height in pixels. */
  height: number
  /** Width of the frame before downscaling. */
  sourceWidth: number
  /** Height of the frame before downscaling. */
  sourceHeight: number
}

/** Downscaling controls for {@link encodeFrame}. */
export interface EncodeOptions {
  /**
   * Longest edge of the encoded image. Frames wider or taller than this are
   * downscaled proportionally; smaller frames are left at their native size
   * because upscaling would spend tokens without adding detail.
   */
  maxEdge?: number
  /** PNG compression effort, 0-9. Higher costs CPU and yields smaller files. */
  compressionLevel?: number
}

/** Default longest edge: legible for UI text while bounding token cost. */
const DEFAULT_MAX_EDGE = 1568

/**
 * Swap the red and blue channels of a BGRA buffer in place and force alpha opaque.
 *
 * GDI leaves the alpha byte at zero for window captures. An encoder that honours
 * it would emit a fully transparent image, so every pixel is forced opaque rather
 * than trusting the source.
 * @param pixels - packed BGRA rows, modified in place.
 */
function bgraToRgba(pixels: Buffer): void {
  for (let offset = 0; offset + 4 <= pixels.length; offset += 4) {
    const blue = pixels[offset]!
    pixels[offset] = pixels[offset + 2]!
    pixels[offset + 2] = blue
    pixels[offset + 3] = 255
  }
}

/**
 * Encode a captured frame as PNG for the model.
 * @param frame - the captured frame, modified in place during channel conversion.
 * @param options - downscaling and compression controls.
 * @returns the encoded image plus the dimensions it was scaled from.
 */
export async function encodeFrame(
  frame: CaptureFrame,
  options: EncodeOptions = {},
): Promise<EncodedImage> {
  const maxEdge = options.maxEdge ?? DEFAULT_MAX_EDGE
  bgraToRgba(frame.pixels)

  let pipeline = sharp(frame.pixels, {
    raw: { width: frame.width, height: frame.height, channels: 4 },
  })

  const longest = Math.max(frame.width, frame.height)
  if (longest > maxEdge) {
    // `fit: inside` with only a width cap would distort tall frames; scaling on
    // the longest edge preserves aspect ratio for either orientation.
    const resize = frame.width >= frame.height
      ? { width: maxEdge }
      : { height: maxEdge }
    pipeline = pipeline.resize({ ...resize, fit: 'inside', withoutEnlargement: true })
  }

  const { data, info } = await pipeline
    .png({ compressionLevel: options.compressionLevel ?? 6 })
    .toBuffer({ resolveWithObject: true })

  return {
    data,
    mediaType: 'image/png',
    width: info.width,
    height: info.height,
    sourceWidth: frame.width,
    sourceHeight: frame.height,
  }
}
