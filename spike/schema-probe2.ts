/**
 * Probe value-schema requiredness forms in the output position.
 *
 * Run: npx tsx --tsconfig tsconfig.test.json spike/schema-probe2.ts
 */

import { defineTool } from '@deepseek-ai/dsh-tools'

function attempt(label: string, schema: Record<string, unknown>): void {
  try {
    defineTool({
      name: `p${Math.abs(label.length)}`,
      description: 'A probe tool used to determine which output schema forms the value schema DSL accepts.',
      parameters: {},
      output: { schema: schema as never, render: () => [] },
      execute: async () => ({}),
    })
    console.log(`  [OK]      ${label}`)
  } catch (error) {
    console.log(`  [REJECT]  ${label}`)
    console.log(`            ${(error as Error).message}`)
  }
}

console.log('=== output schema requiredness probe ===\n')

attempt('root object, no required anywhere', {
  type: 'object',
  additionalProperties: false,
  properties: { a: { type: 'string' }, b: { type: 'integer' } },
})

attempt('root object, field-level required: true', {
  type: 'object',
  additionalProperties: false,
  properties: { a: { type: 'string', required: true }, b: { type: 'integer' } },
})

attempt('root object, nested field-level required: true', {
  type: 'object',
  additionalProperties: false,
  properties: {
    outer: {
      type: 'object',
      additionalProperties: false,
      properties: { inner: { type: 'string', required: true } },
    },
  },
})

attempt('root object, root required: ["a"]', {
  type: 'object',
  additionalProperties: false,
  required: ['a'],
  properties: { a: { type: 'string' } },
})

attempt('root object, root required: true', {
  type: 'object',
  additionalProperties: false,
  required: true,
  properties: { a: { type: 'string' } },
})

console.log('\n=== done ===')
