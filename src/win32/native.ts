/**
 * Small helpers shared by the Win32 modules.
 *
 * @module dsh-computer-use-native/win32/native
 */

import koffi from 'koffi'
import { INPUT } from './structs.ts'

/**
 * Decode a buffer that a Win32 `*W` function filled with UTF-16 code units.
 * @param buffer - destination buffer passed to the Win32 call.
 * @param chars - number of code units the call reported writing.
 * @returns the decoded string, truncated at the first NUL.
 */
export function decodeUtf16(buffer: Buffer, chars: number): string {
  if (chars <= 0) return ''
  return buffer.subarray(0, chars * 2).toString('utf16le').replace(/\0.*$/su, '')
}

/**
 * Normalize a handle returned through koffi to a JavaScript number.
 *
 * koffi may surface a pointer-sized return as a number, a bigint, or an opaque
 * external object depending on the declared type. Handles are compared and
 * echoed back to the model, so they must be plain numbers.
 * @param value - the raw return value of a pointer-returning Win32 call.
 * @returns the handle as a number, or 0 when the call returned a null handle.
 */
export function readPointer(value: unknown): number {
  if (typeof value === 'number') return value
  if (typeof value === 'bigint') return Number(value)
  if (value === null || value === undefined) return 0
  if (typeof value === 'object') {
    // koffi's external wrapper exposes the address as its primitive value.
    const numeric = Number(value)
    return Number.isFinite(numeric) ? numeric : 0
  }
  return 0
}

/**
 * Verify the compiled `INPUT` layout matches the Win32 x64 ABI.
 *
 * A wrong stride makes `SendInput` read past the end of the batch and deliver
 * garbage events instead of failing, so this is checked before any input ships.
 * @returns the measured size in bytes.
 * @throws when the size is not the 40 bytes the x64 ABI requires.
 */
export function assertInputLayout(): number {
  const size = koffi.sizeof(INPUT)
  if (size !== 40) {
    throw new Error(
      `INPUT struct is ${size} bytes but the Win32 x64 ABI requires 40; `
      + 'input injection would deliver corrupt events',
    )
  }
  return size
}

/**
 * Clamp a number into an inclusive range.
 * @param value - candidate value.
 * @param min - lowest accepted value.
 * @param max - highest accepted value.
 * @returns the clamped value.
 */
export function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value
}

/** Block the calling thread for a short, synchronous delay. */
export function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
}
