/**
 * Mount the plugin against the real computer-use service.
 *
 * The other composition test stands in for the harness services, which cannot
 * catch a wrong assumption about how they behave. The real registry matters most
 * because it implements the exclusive provider slot through `ctx.effect` inside
 * `register()` rather than returning a plain disposer. Cordis resolves a
 * service's `this.ctx` to the caller through its tracker, so that effect binds to
 * this plugin's fiber — but that is a claim about framework behaviour, and this
 * test is what checks it. If the tracing did not hold, the plugin would appear to
 * work and then leave the provider slot occupied after disposal.
 *
 * Run from the plugin directory with the harness path mappings:
 *   npx tsx --tsconfig tsconfig.harness.json spike/real-service-test.ts
 */

import { Context } from '@deepseek-ai/cordis'
import { ComputerUseRegistry } from '@deepseek-ai/dsh-computer-use'
import { SystemPrompt } from '@deepseek-ai/dsh-system-prompt'
import * as plugin from '../src/index.ts'

const failures: string[] = []
function check(label: string, condition: boolean, detail: string): void {
  console.log(`  [${condition ? 'PASS' : 'FAIL'}] ${label}: ${detail}`)
  if (!condition) failures.push(label)
}

const registeredTools = new Map<string, unknown>()

const ctx = new Context()
ctx.provide('tools', {
  register(tool: { name: string }): () => void {
    if (registeredTools.has(tool.name)) throw new Error(`duplicate tool ${tool.name}`)
    registeredTools.set(tool.name, tool)
    return () => { registeredTools.delete(tool.name) }
  },
})
ctx.provide('attachments', {
  async saveImage(input: { data: Uint8Array, mediaType: string }) {
    return {
      attachmentId: 'probe',
      mediaType: input.mediaType,
      bytes: input.data.length,
      width: 0,
      height: 0,
    }
  },
})

console.log('=== real computer-use service ===\n')

// Both services are real. The registry owns the exclusive provider slot, and the
// prompt service owns the section this plugin publishes into; a stand-in for
// either would hide a wrong assumption about its API.
const registry = new ComputerUseRegistry(ctx)
const systemPrompt = new SystemPrompt(ctx, {
  includeHarnessIdentity: false,
  includeRuntimeContext: false,
  personaPrefix: '',
  personaSuffix: '',
  toolOrder: undefined as unknown as string[],
})

console.log('1. the real services are installed')
// `ctx.computerUse` is a tracking proxy rather than the raw instance, so the two
// are compared through the state the service owns, not by identity.
check('service is reachable through the context',
  ctx.computerUse !== undefined && ctx.computerUse.providerName === registry.providerName,
  ctx.computerUse === undefined ? 'ctx.computerUse is undefined' : 'ctx.computerUse resolves')
check('no provider before the plugin mounts', registry.providerName === undefined,
  String(registry.providerName))
check('the prompt service names the computer-use section order',
  systemPrompt.getSectionOrder('TOOL_COMPUTER_USE') > 0,
  String(systemPrompt.getSectionOrder('TOOL_COMPUTER_USE')))

console.log('\n2. mount the plugin against them')
const fiber = await ctx.plugin(plugin, {})
check('the provider slot is claimed', registry.providerName !== undefined, String(registry.providerName))
check('the claimed name is the configured default', registry.providerName === 'native-win32',
  String(registry.providerName))
check('all eight tools registered', registeredTools.size === 8, `${registeredTools.size} tools`)

// Assembling is what the model actually receives, so this checks the section by
// its effect rather than by reading the service's internal layer state, which is
// scoped to the registering context and not visible from here.
const assembly = JSON.stringify(await systemPrompt.assemble())
check('the guidance reached the assembled prompt',
  assembly.includes('computer_screenshot') && assembly.includes('dispatch'),
  assembly.includes('computer_screenshot')
    ? `${assembly.length} characters assembled`
    : 'the guidance text is absent from the assembly')

console.log('\n3. the slot really is exclusive')
let secondAttempt = 'no error'
try {
  registry.register('some-other-provider' as never)
} catch (error) {
  secondAttempt = error instanceof Error ? error.message : String(error)
}
check('a second provider is refused', secondAttempt !== 'no error', secondAttempt)

console.log('\n4. disposal releases the slot')
await fiber.dispose()
check('the provider slot is released', registry.providerName === undefined, String(registry.providerName))
check('tools were removed', registeredTools.size === 0, `${registeredTools.size} remaining`)
const afterDispose = JSON.stringify(await systemPrompt.assemble())
check('the guidance left the assembled prompt', !afterDispose.includes('computer_screenshot'),
  afterDispose.includes('computer_screenshot') ? 'the guidance survived disposal' : 'removed')

console.log('\n5. the slot can be claimed again after disposal')
const second = await ctx.plugin(plugin, {})
check('a fresh mount re-claims the slot', registry.providerName === 'native-win32', String(registry.providerName))
await second.dispose()
check('and releases it again', registry.providerName === undefined, String(registry.providerName))

console.log(`\n=== ${failures.length === 0 ? 'ALL CHECKS PASSED' : `${failures.length} CHECK(S) FAILED: ${failures.join(', ')}`} ===`)
process.exit(failures.length === 0 ? 0 : 1)
