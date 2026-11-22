/** Native voice settings and finalized-reply actions. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-plugin-manager/client'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { VoiceSettingsController } from './settings.ts'
import { VoiceSettings, VoiceProvidersToast } from './VoiceSettings.tsx'
import { createVoiceProviders, type VoiceProvidersFace } from './providers.ts'
import { VoicePlayback } from './playback.ts'
import { ReadAloud, VoiceToast } from './ReadAloud.tsx'
import { en, zh } from './locales.ts'
import { AutomaticVoice } from './automatic.ts'
import { StreamVoice, StreamNotice, type StreamVoiceFace } from './StreamVoice.tsx'
import type { VoiceOutput } from './output.ts'

export type { VoiceOutput, VoiceReplyOutcome, VoiceRequestId, VoicePause, VoicePauseId, VoicePauseReason,
  VoicePlaybackId, VoicePlaybackState, VoicePlaybackObservation } from './output.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared audio owner for explicitly authorized foreground replies. */
    voiceOutput: VoiceOutput
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** Optional recognition settings owned by the installed input plugin. */
    'settings.voice.recognition': { kind: 'list'; scope: 'root'; owner: { children?: never } }
  }
}

/** Derived data and operation callbacks injected into speech controls. */
export type VoiceFace = ReturnType<typeof voiceFace>

function voiceFace(playback: VoicePlayback, automatic: AutomaticVoice) {
  return { hooks: { voicePlayback: playback.state }, read: (...args: Parameters<VoicePlayback['read']>) => {
    automatic.interrupt()
    return playback.read(...args)
  },
  stop: playback.stop.bind(playback), dismiss: playback.dismiss.bind(playback) }
}

/** Required native form, Remote, dictionary and slot services. */
export const inject = ['slots', 'locale', 'remote', 'remote.tts', 'remote.credentials', 'configForms', 'sessions', 'uiConversation']

/** @param ctx - Client plugin lifetime. */
export function apply(ctx: Context): void {
  ctx.effect(() => ctx.locale.register('voice', { en, zh }), 'ui-voice: dictionaries')
  const settings = new VoiceSettingsController(ctx)
  const directory = createVoiceProviders(ctx)
  const providers: VoiceProvidersFace = { directory, hooks: { voiceProviders: directory.state, voiceProviderFeedback: directory.feedback } }
  const playback = new VoicePlayback(ctx.remote.tts, undefined, (diagnostic) => { console.warn('Speech stopped:', diagnostic) })
  const automatic = new AutomaticVoice(ctx, () => { playback.stop() })
  ctx.provide('voiceOutput', {
    mode: automatic.state,
    replies: automatic.replies,
    playback: automatic.playback,
    arm: async (sessionId) => {
      playback.stop()
      automatic.disable()
      await automatic.toggle(sessionId, true)
      if (!automatic.state.getSnapshot().enabled) throw new Error('Streaming voice output is unavailable')
    },
    authorize: (requestId) => { automatic.authorize(requestId) },
    pause: (requestId, reason) => automatic.pause(requestId, reason),
    resume: pause => automatic.resume(pause),
    confirmStop: pause => automatic.confirmStop(pause),
    stop: () => { automatic.disable() },
    settleStop: () => automatic.settleStop(),
  })
  const streamFace: StreamVoiceFace = { hooks: { automaticVoice: automatic.state, streamPlayback: automatic.player.state },
    toggleStream: (session) => { void automatic.toggle(session) }, ensureStreamSession: (session) => { automatic.ensureSession(session) },
    muteStream: (session) => { if (automatic.state.getSnapshot().session === session) automatic.mute() },
    pauseStream: (session) => { void automatic.togglePause(session) },
    dismissAutoNotice: (sequence) => { automatic.dismiss(sequence) } }
  const face = voiceFace(playback, automatic)
  ctx.effect(() => async () => { settings.dispose(); directory.dispose(); await automatic.dispose(); await playback.dispose() }, 'ui-voice: resources')
  ctx.effect(() => {
    const stop = (): void => { automatic.disable(); playback.stop() }
    window.addEventListener('pagehide', stop)
    return () => { window.removeEventListener('pagehide', stop) }
  }, 'ui-voice: page lifetime')
  ctx.on('connection/reset', () => { playback.stop(); automatic.disable(); void automatic.refresh(); void settings.refresh(); void directory.refresh() })
  ctx.on('conversation/cancel-requested', (session) => {
    if (automatic.state.getSnapshot().session === session) automatic.mute()
    if (playback.state.getSnapshot().owner?.startsWith(`${session}/`)) playback.stop()
  })
  ctx.effect(() => ctx.remote.$on('credentials/reference-updated', () => {
    void settings.refresh(); void directory.refresh(); void automatic.refresh()
  }), 'ui-voice: credential updates')
  ctx.effect(() => {
    const scopes = ['text-to-speech', 'text-to-speech-qwen'].map(ns => ctx.configForms.get(ns))
    const off = scopes.map(scope => scope.subscribe(() => { void automatic.refresh() }))
    return () => { for (const release of off) release() }
  }, 'ui-voice: streaming capability changes')
  ctx.effect(() => ctx.configForms.whileServed(['text-to-speech'], () => ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'voice', order: 25, label: () => ctx.locale.bind('voice')('title'), locale: 'voice',
    children: { 'settings.voice.recognition': { kind: 'list', scope: 'root' } },
    inject: () => ({ ...settings.face, ...providers, hooks: { ...settings.face.hooks, ...providers.hooks } }),
  }, VoiceSettings))), 'ui-voice: settings')
  ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register({
    name: 'conversation.chat.assistant-actions', id: 'voice', order: 15, locale: 'voice', inject: () => face,
  }, ReadAloud))
  ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
    name: 'conversation.input.right', id: 'stream-voice', order: 10, locale: 'voice', inject: () => streamFace,
  }, StreamVoice))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay', id: 'stream-voice-feedback', locale: 'voice', inject: () => streamFace,
  }, StreamNotice))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'voice-feedback', locale: 'voice', inject: () => face }, VoiceToast))
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'voice-provider-feedback', locale: 'voice', inject: () => providers }, VoiceProvidersToast))
}
