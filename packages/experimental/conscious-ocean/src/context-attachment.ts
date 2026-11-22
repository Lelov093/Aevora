/** Model-visible attachment of a prepared Context Manifest through AgentLoop admission. */

import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ContextFormed, UserMessage } from '@deepseek-ai/dsh-llm'
import type { CognitiveSourceId, ContextManifest, ContextFragment, ActivationTraceId, ContextManifestId } from './types.ts'
import { memorySourceId } from './activation.ts'
import type { DeterministicMemoryActivationResult } from './activation.ts'

/** Durable source metadata for a model-visible recalled Context Manifest message. */
export type ConsciousOceanContextSource = {
  readonly kind: 'conscious-ocean-context'
  readonly manifestId: ContextManifestId
  readonly traceId: ActivationTraceId
  readonly fragmentIds: readonly string[]
  readonly sourceRefs: readonly CognitiveSourceId[]
} & Extract<ContextFormed, { form: 'recall' }>

declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'conscious-ocean-context': ConsciousOceanContextSource
  }
}

/** The admission result that makes one prepared Manifest model-visible and durable. */
export interface ContextManifestAttachment {
  /** Manifest copy whose selected fragments were admitted to the Session surface. */
  readonly manifest: ContextManifest
  /** User-role message passed through `agent/pre-step` to AgentLoop. */
  readonly message: UserMessage
}

function renderFragment(item: DeterministicMemoryActivationResult['selectedItems'][number], fragment: ContextFragment, index: number): string {
  const applicability = item.applicability === undefined ? '' : `\nApplicability: ${item.applicability}`
  return `Memory ${String(index + 1)}:\n${item.content}${applicability}\nSource revision: ${String(fragment.sourceRevision)}`
}

/**
 * Build a durable model-visible message from one deterministic preparation result.
 *
 * The AgentLoop owns admission and the later provider request. This function only
 * marks selected fragments as attached and returns a message for the wrapping
 * `agent/pre-step` listener; the actual `user/message` event is appended by the
 * loop before it derives the provider request.
 *
 * @param prepared - deterministic trace, Manifest, and same-snapshot records.
 * @returns an attachment candidate, or `undefined` when the Manifest selected no records.
 * @throws when the prepared record snapshot cannot satisfy its Manifest fragments.
 */
export function createContextManifestAttachment(
  prepared: DeterministicMemoryActivationResult,
): ContextManifestAttachment | undefined {
  if (prepared.manifest.fragments.length === 0) return undefined
  const records = prepared.manifest.fragments.map((fragment, index) => {
    const item = prepared.selectedItems[index]
    if (item === undefined || item.revision !== fragment.sourceRevision
      || fragment.sourceRefs.length !== 1 || fragment.sourceRefs[0] !== memorySourceId(item.memoryId)) {
      throw new Error(`Conscious Ocean Context Manifest fragment ${fragment.fragmentId} has no matching Memory snapshot`)
    }
    return { item, fragment }
  })
  const fragments = records.map(({ fragment }) => ({ ...fragment, attached: 'yes' as const }))
  const manifest: ContextManifest = { ...prepared.manifest, fragments }
  const message = createUserMessage({
    content: [{
      type: 'text',
      text: `Confirmed Memory recalled for this request:\n\n${records.map(({ item, fragment }, index) => renderFragment(item, fragment, index)).join('\n\n')}`,
    }],
    source: {
      kind: 'conscious-ocean-context',
      form: 'recall',
      manifestId: manifest.manifestId,
      traceId: manifest.traceId,
      fragmentIds: fragments.map(fragment => fragment.fragmentId),
      sourceRefs: fragments.flatMap(fragment => fragment.sourceRefs),
    },
  })
  return { manifest, message }
}
