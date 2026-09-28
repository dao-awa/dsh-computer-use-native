/**
 * Computer use for Windows, driven directly through Win32.
 *
 * The provider registers the exclusive computer-use slot and publishes a
 * screenshot-and-input tool set. It exists because accessibility-tree automation
 * cannot see into Chromium, WebView2, or Electron windows: those applications
 * expose almost no controls, so a tree-based agent reports an empty window and
 * cannot read the interface. Screenshots carry the pixels regardless of toolkit,
 * and a vision-capable model reads them.
 *
 * Process-wide calibration happens here, before any tool runs. DPI awareness
 * determines whether every later coordinate is expressed in physical or scaled
 * pixels; switching it after a capture would silently invalidate the mapping
 * between images and screen positions.
 *
 * @module dsh-computer-use-native
 */

import type { Context } from '@deepseek-ai/cordis'
import Schema from '@deepseek-ai/schemastery'
import { ComputerUseProviderName } from '@deepseek-ai/dsh-computer-use/brand'
import { assertInputLayout } from './win32/native.ts'
import { configureDpiAwareness, listWindows } from './win32/window.ts'
import { ViewportRegistry } from './viewport.ts'
import { Eye } from './eye.ts'
import { createScreenshotTool } from './tools/screenshot.ts'
import { createInputTools } from './tools/input.ts'
import { createWindowTool } from './tools/window.ts'
import { GUIDANCE } from './guidance.ts'
import type {} from '@deepseek-ai/dsh-computer-use'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-attachment'

/** Cordis plugin identity. */
export const name = 'computer-use-native-win32'

/**
 * Services required before tools can be published.
 *
 * `attachments` is required rather than optional: without a durable image store
 * a screenshot cannot reach the model, so a configuration missing it would
 * publish tools that always fail. The Loader refuses the entry instead.
 */
export const inject = ['computerUse', 'tools', 'systemPrompt', 'attachments']

/** Deployment-varying knobs, all changeable from cordis.yml. */
export interface Config {
  /**
   * Longest edge of a returned screenshot in pixels. Lower values spend fewer
   * tokens per capture; higher values make small UI text legible.
   */
  maxEdge: number
  /** PNG compression effort, 0-9. Higher costs CPU per capture and yields smaller images. */
  compressionLevel: number
  /**
   * Pause between typed characters in milliseconds. Raise it for applications
   * that drop input delivered faster than they can process it.
   */
  typeDelayMs: number
  /** Provider name recorded in the computer-use registration. */
  providerName: string
}

/** Parsed configuration; every field defaults so an empty entry is valid. */
export const Config: Schema<Partial<Config>, Config> = Schema.object({
  maxEdge: Schema.natural().default(1568),
  compressionLevel: Schema.natural().min(0).max(9).default(6),
  typeDelayMs: Schema.natural().default(0),
  providerName: Schema.string().default('native-win32'),
})

/**
 * Publish the Win32 computer-use tools.
 * @param ctx - context supplying the computer-use slot, tool registry, prompt, and attachment store.
 * @param config - parsed plugin configuration.
 * @returns after calibration, registration, and tool publication complete.
 * @throws when the host is not Windows or the input structure layout is wrong.
 */
export async function apply(ctx: Context, config: Config): Promise<void> {
  if (process.platform !== 'win32') {
    throw new Error(
      `computer-use-native-win32 drives Win32 directly and cannot run on ${process.platform}; `
      + 'unload this entry or mount a provider for the host platform',
    )
  }

  // Calibration is process-wide and must precede the first capture or input, so
  // it runs during plugin start rather than lazily inside a tool.
  const dpiMode = configureDpiAwareness()
  const inputSize = assertInputLayout()

  const registry = new ViewportRegistry()
  // Remembered looks live for the plugin's lifetime, so a repeat glance at an
  // unchanged screen stays cheap across turns rather than within one.
  const eye = new Eye()

  // Every contribution is registered inside one effect so that unloading the
  // plugin releases all of it: the exclusive provider slot, the tools, and the
  // prompt section. Registering the section outside this effect would leave it
  // behind on disposal.
  ctx.effect(function* () {
    yield ctx.computerUse.register(ComputerUseProviderName(config.providerName))
    yield ctx.tools.register(createScreenshotTool(ctx, registry, eye))
    for (const tool of createInputTools(ctx, registry)) yield ctx.tools.register(tool)
    yield ctx.tools.register(createWindowTool(ctx))
    yield ctx.systemPrompt.section({
      name: 'computer-use:native-win32',
      order: ctx.systemPrompt.getSectionOrder('TOOL_COMPUTER_USE'),
      text: GUIDANCE,
    })
  }, 'computer-use-native-win32')

  const windowCount = listWindows().length
  ctx.logger?.info?.(
    `computer-use-native-win32 ready: dpi=${dpiMode} sizeof(INPUT)=${inputSize} `
    + `windows=${windowCount} maxEdge=${config.maxEdge}`,
  )
}
