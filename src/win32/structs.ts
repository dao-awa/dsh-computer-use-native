/**
 * Win32 structure and union layouts for koffi.
 *
 * koffi resolves structure definitions when a function signature names them, so
 * this module must be evaluated before any `user32.func(...)` call that uses the
 * types below. Import order in `dll.ts` guarantees that.
 *
 * Field widths follow the Win32 x64 ABI: `LONG` is 32-bit, `BOOL` is a 32-bit
 * int, and pointers are 64-bit. `INPUT` is padded by the C compiler to the size
 * of its largest member, which is what makes `sizeof(INPUT)` 40 on x64 rather
 * than the 32 its fields naively sum to.
 *
 * @module dsh-computer-use-native/win32/structs
 */

import koffi from 'koffi'

/** Screen or client rectangle. Coordinates are signed screen pixels. */
export const RECT = koffi.struct('RECT', {
  left: 'long',
  top: 'long',
  right: 'long',
  bottom: 'long',
})

/** A single signed screen point. */
export const POINT = koffi.struct('POINT', {
  x: 'long',
  y: 'long',
})

/** Size in pixels. */
export const SIZE = koffi.struct('SIZE', {
  cx: 'long',
  cy: 'long',
})

/** Device-independent bitmap header. A negative `biHeight` requests top-down rows. */
export const BITMAPINFOHEADER = koffi.struct('BITMAPINFOHEADER', {
  biSize: 'uint32',
  biWidth: 'long',
  biHeight: 'long',
  biPlanes: 'uint16',
  biBitCount: 'uint16',
  biCompression: 'uint32',
  biSizeImage: 'uint32',
  biXPelsPerMeter: 'long',
  biYPelsPerMeter: 'long',
  biClrUsed: 'uint32',
  biClrImportant: 'uint32',
})

/** A bitmap header plus the colour table that follows it. */
export const BITMAPINFO = koffi.struct('BITMAPINFO', {
  bmiHeader: BITMAPINFOHEADER,
  bmiColors: koffi.array('uint32', 3),
})

/** Mouse event payload inside `INPUT`. */
export const MOUSEINPUT = koffi.struct('MOUSEINPUT', {
  dx: 'long',
  dy: 'long',
  mouseData: 'uint32',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
})

/** Keyboard event payload inside `INPUT`. */
export const KEYBDINPUT = koffi.struct('KEYBDINPUT', {
  wVk: 'uint16',
  wScan: 'uint16',
  dwFlags: 'uint32',
  time: 'uint32',
  dwExtraInfo: 'uintptr_t',
})

/** Hardware event payload inside `INPUT`; unused but required for the union size. */
export const HARDWAREINPUT = koffi.struct('HARDWAREINPUT', {
  uMsg: 'uint32',
  wParamL: 'uint16',
  wParamH: 'uint16',
})

/** The union arm of `INPUT` selected by its `type` discriminator. */
export const INPUT_UNION = koffi.union('INPUT_UNION', {
  mi: MOUSEINPUT,
  ki: KEYBDINPUT,
  hi: HARDWAREINPUT,
})

/**
 * One entry of a `SendInput` batch. `sizeof(INPUT)` must be 40 on x64; the
 * plugin asserts this at startup because a wrong stride silently corrupts the
 * whole batch rather than failing loudly.
 */
export const INPUT = koffi.struct('INPUT', {
  type: 'uint32',
  u: INPUT_UNION,
})

/** A window's extended placement, used to read restore bounds. */
export const WINDOWPLACEMENT = koffi.struct('WINDOWPLACEMENT', {
  length: 'uint32',
  flags: 'uint32',
  showCmd: 'uint32',
  ptMinPosition: POINT,
  ptMaxPosition: POINT,
  rcNormalPosition: RECT,
})

/** The packed button-and-modifier word carried in mouse messages. */
export const MOUSE_MESSAGE_PARAMS = koffi.struct('MOUSE_MESSAGE_PARAMS', {
  x: 'int16',
  y: 'int16',
  buttons: 'uint16',
})
