/** Source-safe lifecycle for the optional speech Remote and browser UI. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-experimental-api-speech-to-text/remote'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { TypertRemoteContribution } from '@deepseek-ai/dsh-typert-protocol'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { VoiceInput, type VoiceInputInjected } from './VoiceInput.tsx'
import { VoicePresence, VoiceTranscript, type VoicePresenceState } from './VoicePresence.tsx'
import { VoiceChatEntry } from './VoiceChatEntry.tsx'
import { createChatConsent } from './chat-consent.ts'
import type { SessionId } from '@deepseek-ai/dsh-api-remotes/client'
import { Recording } from './audio.ts'
import { createMicrophoneDeviceStore } from './microphone-device.ts'
import { en, ja, es, fr, de, ru, pt, NS, zh } from './locales.ts'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import { observeReadiness } from './readiness.ts'
import { VoicePreparation } from './PreparationCard.tsx'
import { VoiceSetupPrompt } from './VoiceSetupPrompt.tsx'
import { LiveRecognition } from './live-recognition.ts'
import { RecordingError } from './audio.ts'
import { createRecognitionSettings, type RecognitionSettingsFace } from './recognition-settings.ts'
import { RecognitionSettings, RecognitionToast } from './RecognitionSettings.tsx'
import { ContinuousVoice } from './continuous.ts'
import { createTurnSettings } from './turn-settings.ts'
import { TurnSettings } from './TurnSettings.tsx'

export const inject = ['remote', 'slots', 'locale']

function registerUi(ctx: Context): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }))
  const recordings = new Set<Recording>()
  const liveRecordings = new Set<LiveRecognition>()
  const modes = new Set<ContinuousVoice>()
  const voicePresence = createSnapshotStore<VoicePresenceState | null>(null)
  const chatRequests = new Map<SessionId, () => void>()
  let continuousContext: Context | undefined
  ctx.inject(['voiceOutput', 'sessions', 'conversation', 'remote.voiceTurns'], (scope) => {
    continuousContext = scope
    scope.effect(() => async () => {
      continuousContext = undefined
      await Promise.all([...modes].map(mode => mode.dispose()))
    })
    scope.on('conversation/cancel-requested', (session) => { for (const mode of modes) if (mode.sessionId === session) mode.pause() })
  })
  const microphone = createMicrophoneDeviceStore()
  const readiness = observeReadiness(ctx)
  ctx.effect(() => readiness.dispose)
  ctx.effect(() => async () => { await Promise.all([...recordings].map(recording => recording.dispose())) })
  ctx.effect(() => async () => { await Promise.all([...liveRecordings].map(recording => recording.dispose())) })
  ctx.on('connection/reset', () => {
    for (const mode of modes) mode.pause('failed')
    for (const recording of liveRecordings) recording.disconnect()
    for (const recording of recordings) void recording.dispose()
  })
  // The Plugins page provides its navigation only while the current Peer may use it.
  const pluginNavigation = createSnapshotStore(false)
  ctx.inject(['pluginNavigation'], (scope: Context) => {
    scope.effect(() => {
      pluginNavigation.set(true)
      return () => { pluginNavigation.set(false) }
    }, 'voice-input: plugin navigation presence')
  })
  const actions: VoiceInputInjected = {
    publishVoicePresence: (sessionId, next) => {
      const current = voicePresence.getSnapshot()
      if (next === null) {
        if (current?.sessionId === sessionId) voicePresence.set(null)
      } else if (current?.sessionId !== sessionId || current.phase !== next.phase || current.text !== next.text) {
        voicePresence.set({ sessionId, phase: next.phase, text: next.text })
      }
    },
    bindChatRequest: (sessionId, request) => {
      chatRequests.set(sessionId, request)
      return () => { if (chatRequests.get(sessionId) === request) chatRequests.delete(sessionId) }
    },
    chatConsent: createChatConsent(),
    openSettings: () => { ctx.get('pluginNavigation')?.openBundle('@deepseek-ai/dsh-experimental-voice-input-bundle') },
    hooks: { speechReadiness: readiness.state, microphoneDevice: microphone, pluginNavigation },
    selectMicrophone: (device) => { microphone.set(device) },
    createRecording: () => {
      if (modes.size > 0 || liveRecordings.size > 0 || recordings.size > 0) throw new RecordingError('interrupted')
      const recording = new Recording(() => { recordings.delete(recording) }, microphone.getSnapshot().id)
      recordings.add(recording)
      return recording
    },
    createLive: (changed) => {
      if (modes.size > 0 || recordings.size > 0 || liveRecordings.size > 0) throw new RecordingError('interrupted')
      const operation = new LiveRecognition(ctx.remote.speech, microphone.getSnapshot().id, changed,
        () => { liveRecordings.delete(operation) })
      liveRecordings.add(operation)
      return operation
    },
    createContinuous: (session, selection, sampleRate) => {
      if (!continuousContext || modes.size || recordings.size || liveRecordings.size) throw new RecordingError('interrupted')
      const mode = new ContinuousVoice(continuousContext, session, microphone.getSnapshot().id, selection, sampleRate,
        () => { modes.delete(mode) })
      modes.add(mode)
      return mode
    },
    getContinuous: session => [...modes].find(mode => mode.sessionId === session),
    ensureContinuousSession: (session) => {
      for (const mode of modes) if (mode.sessionId !== session) void mode.dispose()
    },
    transcribe: async (request, signal) => await ctx.remote.speech.transcribe(request, signal),
    configure: async (patch) => { const result = await ctx.remote.speech.configure(patch); if (!result.ok) throw result.error },
    prepare: async (providerId, options) => {
      const result = await ctx.remote.speech.prepare(providerId, options); if (!result.ok) throw result.error
    },
    cancelPreparation: async (providerId) => {
      const result = await ctx.remote.speech.cancelPreparation(providerId); if (!result.ok) throw result.error
    },
  }
  ctx.slots.inject('conversation.input.activity', () => ctx.slots.register({
    name: 'conversation.input.activity', locale: NS, inject: () => actions,
  }, VoiceInput))
  ctx.slots.inject('conversation.input.empty-action', () => ctx.slots.register({
    name: 'conversation.input.empty-action', locale: NS,
    select: ({ enabled }) => enabled ? true : null,
    inject: (sessionId: SessionId) => ({ requestChat: () => { chatRequests.get(sessionId)?.() } }),
  }, VoiceChatEntry))
  ctx.slots.inject('conversation.input.preview', () => ctx.slots.register({
    name: 'conversation.input.preview', id: 'voice-transcript', locale: NS,
    inject: () => ({ hooks: { voicePresence } }),
  }, VoiceTranscript))
  ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({
    name: 'conversation.input.dock', id: 'voice-presence', order: 30, locale: NS,
    inject: () => ({ hooks: { voicePresence } }),
  }, VoicePresence))
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config',
    key: '@deepseek-ai/dsh-experimental-voice-input-bundle', locale: NS, inject: () => actions,
  }, VoicePreparation))
  ctx.slots.inject('plugins.bundle.activation', () => ctx.slots.register({ name: 'plugins.bundle.activation',
    key: '@deepseek-ai/dsh-experimental-voice-input-bundle', locale: NS, inject: () => actions,
  }, VoiceSetupPrompt))
  ctx.inject(['configForms', 'remote.credentials'], (scope) => {
    const turnSettings = createTurnSettings(scope)
    scope.effect(() => turnSettings.dispose)
    scope.slots.inject('settings.voice.recognition', () => scope.slots.register({
      name: 'settings.voice.recognition', id: 'voice-turn-resources', locale: NS, inject: () => turnSettings.face,
    }, TurnSettings))
    const directory = createRecognitionSettings(scope)
    const face: RecognitionSettingsFace = { recognitionDirectory: directory,
      hooks: { recognitionProfiles: directory.state, recognitionFeedback: directory.feedback } }
    scope.effect(() => () => { directory.dispose() })
    scope.on('connection/reset', () => { void directory.refresh() })
    scope.effect(() => scope.remote.$on('credentials/reference-updated', () => { void directory.refresh() }))
    scope.slots.inject('settings.voice.recognition', () => scope.slots.register({
      name: 'settings.voice.recognition', id: 'asr-profiles', locale: NS, inject: () => face,
    }, RecognitionSettings))
    scope.slots.inject('shell.overlay', () => scope.slots.register({ name: 'shell.overlay', id: 'asr-profiles-feedback', locale: NS, inject: () => face }, RecognitionToast))
  })

}

/**
 * Mount this experimental namespace without adding it to stable API Remotes.
 * @param ctx - Client runtime owning the Remote, dictionaries and slots.
 * @param contribution - generated speech Remote definitions.
 * @param turns - optional local turn Remote contribution; omitted by preview-only consumers.
 * @returns disposer joining UI and Remote withdrawal.
 */
export async function mountVoiceInput(ctx: Context, contribution: TypertRemoteContribution,
  turns?: TypertRemoteContribution): Promise<() => Promise<void>> {
  const disposeRemote = await ctx.remote.$mount(contribution)
  const disposeTurns = turns === undefined ? undefined : await ctx.remote.$mount(turns)
  const ui = ctx.inject(['remote.speech', 'slots', 'locale'], registerUi)
  try { await ui } catch (error) { await ui.dispose(); await disposeTurns?.(); await disposeRemote(); throw error }
  return async () => { try { await ui.dispose() } finally { await disposeTurns?.(); await disposeRemote() } }
}
