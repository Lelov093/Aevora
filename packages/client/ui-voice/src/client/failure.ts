/** Sanitized speech outcomes shared by manual and streaming feedback. */
import { remoteErrorOf } from '@deepseek-ai/dsh-typert-protocol'
import type { RemoteErrorDetailsMap } from '@deepseek-ai/dsh-api-remotes/client'
import type { VoiceKey } from './locales.ts'

type Usage = RemoteErrorDetailsMap['tts/synthesis-failed']['usage']
const messages = {
  unconfigured: 'speechConfigurationFailed', authentication: 'speechAuthenticationFailed', network: 'speechNetworkFailed',
  protocol: 'speechProtocolFailed', provider: 'speechProviderFailed', limit: 'speechLimitFailed', timeout: 'speechTimeoutFailed',
  playback: 'speechPlaybackFailed', unknown: 'speechUnknownFailed',
} as const satisfies Record<string, VoiceKey>

/** No provider messages, text, endpoints or credentials enter this record. */
export interface SpeechDiagnostic {
  readonly reason: keyof typeof messages
  readonly stage: RemoteErrorDetailsMap['tts/synthesis-failed']['stage'] | 'synthesis' | 'playback' | 'text'
  readonly usage: Usage
}

/** Decode a typed Remote failure or contain a local audio failure.
 * @param error - Remote or browser operation failure.
 * @param stage - local operation phase when no provider phase is available.
 * @param usage - observations retained before a local failure.
 * @returns only known categories, phase and measured usage.
 */
export function speechDiagnostic(error: unknown, stage: 'synthesis' | 'playback' | 'text',
  usage: Usage = { inputTokens: null, outputTokens: null, characters: null }): SpeechDiagnostic {
  const remote = remoteErrorOf(error)
  if (remote?.code === 'tts/synthesis-failed') {
    const reason = remote.details.reason
    return { reason: Object.hasOwn(messages, reason) ? reason as keyof typeof messages : 'unknown',
      stage: remote.details.stage, usage: remote.details.usage }
  }
  if (remote?.code === 'tts/invalid-text') return { reason: 'limit', stage: 'text', usage }
  if (remote !== undefined) return { reason: 'unknown', stage: 'connection', usage }
  return { reason: stage === 'playback' ? 'playback' : 'unknown', stage, usage }
}

/** Select actionable copy without displaying raw provider messages.
 * @param diagnostic - last contained failure.
 * @returns localized speech copy key.
 */
export function speechFailureKey(diagnostic: SpeechDiagnostic | null | undefined): VoiceKey {
  return messages[diagnostic?.reason ?? 'unknown']
}
