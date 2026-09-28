/**
 * Isolate which part of a tool definition the value schema DSL rejects.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json spike/schema-probe.ts
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

function attempt(label: string, build: () => unknown): void {
  try {
    build()
    console.log(`  [OK]      ${label}`)
  } catch (error) {
    console.log(`  [REJECT]  ${label}`)
    console.log(`            ${(error as Error).message}`)
  }
}

const render = (): never[] => []

console.log('=== value schema form probe ===\n')

attempt('output schema with required: [...] array', () => defineTool({
  name: 'probe_a',
  description: 'Probe A, validating that an output schema may declare required as an array.',
  parameters: { a: { type: 'string', required: true } },
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['ok'],
      properties: { ok: { type: 'boolean' } },
    },
    render,
  },
  execute: async () => ({ ok: true }),
}))

attempt('parameters with field-level required: true', () => defineTool({
  name: 'probe_b',
  description: 'Probe B, validating that a parameter may declare required as a boolean.',
  parameters: { a: { type: 'string', required: true } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    render,
  },
  execute: async () => ({ ok: true }),
}))

attempt('nested object without additionalProperties', () => defineTool({
  name: 'probe_c',
  description: 'Probe C, validating that a nested output object may omit additionalProperties.',
  parameters: {},
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        inner: { type: 'object', properties: { x: { type: 'integer' } } },
      },
    },
    render,
  },
  execute: async () => ({ inner: { x: 1 } }),
}))

attempt('array output with typed items', () => defineTool({
  name: 'probe_d',
  description: 'Probe D, validating that an output array may declare typed items.',
  parameters: {},
  output: {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        rows: {
          type: 'array',
          items: { type: 'object', additionalProperties: false, properties: { hwnd: { type: 'integer' } } },
        },
      },
    },
    render,
  },
  execute: async () => ({ rows: [] }),
}))

attempt('enum on a parameter', () => defineTool({
  name: 'probe_e',
  description: 'Probe E, validating that a parameter may restrict its values with an enum.',
  parameters: { mode: { type: 'string', enum: ['a', 'b'] as const } },
  output: {
    schema: { type: 'object', additionalProperties: false, properties: { ok: { type: 'boolean' } } },
    render,
  },
  execute: async () => ({ ok: true }),
}))

console.log('\n=== done ===')
