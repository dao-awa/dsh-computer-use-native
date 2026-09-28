/**
 * Composition test: load the plugin into a real Cordis context.
 *
 * Verifies the parts a module import cannot: that injection is satisfied, that
 * the computer-use slot is claimed, that every tool registers under a name the
 * harness accepts, and that disposing the fiber removes them again. The services
 * are minimal stand-ins for the harness ones, since this checks composition
 * rather than the services themselves.
 *
 * Run: npx tsx spike/compose-test.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import * as plugin from '../src/index.ts'

const failures: string[] = []
function check(label: string, condition: boolean, detail: string): void {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}: ${detail}`)
  if (!condition) failures.push(label)
}

/** Names the harness accepts for a tool. */
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/

console.log('=== composition test ===\n')

const registeredTools = new Map<string, unknown>()
const promptSections: { name: string, text: string }[] = []
let providerClaimed: string | undefined
let savedImages = 0

const ctx = new Context()

// Stand-ins for the harness services the plugin injects.
const computerUse = {
  register(name: unknown): () => void {
    if (providerClaimed !== undefined) {
      // The real registry refuses a second provider; mirroring that here is what
      // makes this test able to catch a double registration.
      throw new Error(`computer-use provider already registered: ${providerClaimed}`)
    }
    providerClaimed = String(name)
    return () => { providerClaimed = undefined }
  },
}
const tools = {
  register(tool: { name: string }): () => void {
    if (registeredTools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`)
    registeredTools.set(tool.name, tool)
    return () => { registeredTools.delete(tool.name) }
  },
}
const systemPrompt = {
  section(section: { name: string, text: string }): () => void {
    promptSections.push(section)
    return () => {
      const index = promptSections.indexOf(section)
      if (index >= 0) promptSections.splice(index, 1)
    }
  },
  getSectionOrder(): number {
    return 0
  },
}
const attachments = {
  async saveImage(input: { data: Uint8Array, mediaType: string, name?: string }) {
    savedImages += 1
    return {
      attachmentId: `test-${savedImages}`,
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 0,
      height: 0,
      ...input.name === undefined ? {} : { name: input.name },
    }
  },
}

ctx.provide('computerUse', computerUse)
ctx.provide('tools', tools)
ctx.provide('systemPrompt', systemPrompt)
ctx.provide('attachments', attachments)

console.log('1. mount the plugin')
const fiber = await ctx.plugin(plugin, {})

check('provider claimed the computer-use slot', providerClaimed !== undefined,
  providerClaimed ?? 'nothing registered')
check('provider name is the configured default', providerClaimed === 'native-win32', String(providerClaimed))

console.log('\n2. tool publication')
const expected = [
  'computer_screenshot',
  'computer_click',
  'computer_type',
  'computer_key',
  'computer_scroll',
  'computer_drag',
  'computer_move',
  'computer_window',
]
const names = [...registeredTools.keys()]
check('all eight tools registered', expected.every(name => names.includes(name)),
  `${names.length} tools: ${names.join(', ')}`)
check('no unexpected tools', names.every(name => expected.includes(name)),
  names.filter(name => !expected.includes(name)).join(', ') || 'none')
check('every tool name is harness-legal', names.every(name => TOOL_NAME.test(name)),
  names.filter(name => !TOOL_NAME.test(name)).join(', ') || 'all legal')

console.log('\n3. tool definitions are well formed')
for (const name of names) {
  const tool = registeredTools.get(name) as {
    description?: string
    parameters?: Record<string, unknown>
    output?: { schema?: unknown, render?: unknown }
    execute?: unknown
  }
  const problems: string[] = []
  if (typeof tool.description !== 'string' || tool.description.length < 20) problems.push('description')
  if (tool.parameters === undefined) problems.push('parameters')
  if (tool.output?.schema === undefined) problems.push('output.schema')
  if (typeof tool.output?.render !== 'function') problems.push('output.render')
  if (typeof tool.execute !== 'function') problems.push('execute')
  check(name, problems.length === 0, problems.length === 0 ? 'complete' : `missing ${problems.join(', ')}`)
}

console.log('\n4. system prompt section')
check('one section published', promptSections.length === 1, `${promptSections.length} sections`)
const section = promptSections[0]
check('section names the tools the model receives',
  section !== undefined && expected.every(name => section.text.includes(name)),
  section === undefined ? 'no section' : `${section.text.length} characters`)
check('section states the recency rule',
  section !== undefined && /screenshot immediately before acting/i.test(section.text),
  'recency rule present')

console.log('\n5. disposal removes every contribution')
await fiber.dispose()
check('provider released', providerClaimed === undefined, String(providerClaimed))
check('tools removed', registeredTools.size === 0, `${registeredTools.size} remaining`)
check('prompt section removed', promptSections.length === 0, `${promptSections.length} remaining`)

console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`} ===`)
process.exit(failures.length === 0 ? 0 : 1)
