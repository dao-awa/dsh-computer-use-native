/**
 * Prove that posted mouse and keyboard messages reach the right child control.
 *
 * Windows delivers real input to the deepest window under the pointer, and most
 * classic Win32 software is built from separate control windows. Posting to the
 * frame instead means the frame receives messages that were meant for a control
 * and discards them, which is silent: the messages are queued successfully and
 * nothing happens.
 *
 * The probe drives a WinForms form, whose controls are real child windows, and
 * reads the text box back to see whether the characters arrived. A foreground
 * check runs alongside it, because the whole point of the posted route is that
 * the target never has to be raised.
 *
 * Run: npm run child-routing
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import {
  FindWindowExW,
  GetClassNameW,
  GetForegroundWindow,
  GetWindowRect,
  ScreenToClient,
  Sleep,
  WM_GETTEXT,
  SendMessageBuffer,
} from '../src/win32/dll.ts'
import { foregroundWindow, postClick, postText } from '../src/win32/post.ts'

const failures: string[] = []
function check(label: string, condition: boolean, detail: string): void {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}: ${detail}`)
  if (!condition) failures.push(label)
}

/** Read a window's text through `WM_GETTEXT` and decode it. */
function windowText(hwnd: number): string {
  const buffer = Buffer.alloc(2048)
  const length = Number(SendMessageBuffer(hwnd, WM_GETTEXT, 1024, buffer))
  return buffer.subarray(0, Math.max(0, length) * 2).toString('utf16le')
}

/** Read a window's class name. */
function className(hwnd: number): string {
  const buffer = Buffer.alloc(512)
  const length = Number(GetClassNameW(hwnd, buffer, 256))
  return buffer.subarray(0, Math.max(0, length) * 2).toString('utf16le')
}

/** Every child window of a window, in enumeration order. */
function children(hwnd: number): number[] {
  const found: number[] = []
  let child = Number(FindWindowExW(hwnd, 0, null, null))
  while (child !== 0 && found.length < 64) {
    found.push(child)
    child = Number(FindWindowExW(hwnd, child, null, null))
  }
  return found
}

const TITLE = 'DSH Child Routing Probe'
const TYPED = 'routed-to-the-child'

console.log('=== child-window routing ===\n')
console.log('1. start a window whose controls are real child windows')

// Recorded before the probe exists, so a form that raised itself would show up
// as a change rather than becoming the baseline the test compares against.
const before = foregroundWindow()

const script = join(dirname(fileURLToPath(import.meta.url)), 'child-routing-form.ps1')
const child = spawn('powershell.exe', [
  '-NoProfile',
  '-ExecutionPolicy', 'Bypass',
  '-File', script,
], { stdio: 'ignore', detached: false })

let form = 0
for (let attempt = 0; attempt < 60 && form === 0; attempt += 1) {
  Sleep(250)
  form = Number(FindWindowExW(0, 0, null, TITLE))
}
check('the probe window appeared', form !== 0, form === 0 ? 'not found after 15s' : `hwnd ${form}`)

if (form === 0) {
  child.kill()
  process.exit(1)
}

const kids = children(form)
const field = kids.find(handle => className(handle).toUpperCase().includes('EDIT')) ?? 0
check('the form owns a child edit control', field !== 0,
  field === 0 ? `no EDIT among ${kids.length} children` : `hwnd ${field} class ${className(field)}`)
check('the edit control is a distinct window from the form', field !== form,
  `form ${form}, field ${field}`)
check('the probe did not raise itself when it appeared', foregroundWindow() === before,
  `${before} -> ${foregroundWindow()}`)

console.log('\n2. aim at the control, address the frame')

// The caller works in the frame's client coordinates, exactly as a screenshot of
// the frame would give them. Routing is what has to find the control.
const box: Record<string, number> = {}
GetWindowRect(field, box)
const centre: Record<string, number> = {
  x: Math.round(((box.left ?? 0) + (box.right ?? 0)) / 2),
  y: Math.round(((box.top ?? 0) + (box.bottom ?? 0)) / 2),
}
const inFrame: Record<string, number> = { x: centre.x ?? 0, y: centre.y ?? 0 }
ScreenToClient(form, inFrame)
console.log(`  the control's centre is at ${inFrame.x},${inFrame.y} in the form's client area`)

check('the text box starts empty', windowText(field).trim() === '',
  JSON.stringify(windowText(field)))

console.log('\n3. post a click at that point and type')
postClick(form, inFrame.x ?? 0, inFrame.y ?? 0)
Sleep(150)
const queued = postText(form, TYPED)
Sleep(200)

const arrived = windowText(field)
check('every character was queued', queued === TYPED.length, `${queued} of ${TYPED.length}`)
check('the characters reached the child control', arrived === TYPED, JSON.stringify(arrived))

console.log('\n4. the desktop focus was left alone')
const after = foregroundWindow()
check('the foreground window did not change', after === before,
  before === after ? `still ${after}` : `${before} -> ${after}`)
check('the probe window never came forward', after !== form,
  after === form ? 'the probe took the foreground' : 'the probe stayed behind')
check('the probe is not the foreground window now', Number(GetForegroundWindow()) !== form,
  `foreground ${Number(GetForegroundWindow())}, probe ${form}`)

child.kill()
Sleep(300)

console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`} ===`)
process.exit(failures.length === 0 ? 0 : 1)
