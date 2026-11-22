/** Configurable online synthesis using Host-owned credential references. */
import type {} from '@deepseek-ai/cordis-plugin-loader'

import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-text-to-speech'
import { QwenTtsProvider } from './provider.ts'
import { TtsFailure } from '@deepseek-ai/dsh-text-to-speech'
import type { TtsProviderId } from '@deepseek-ai/dsh-text-to-speech/types'

/** An independently named online synthesis configuration; no literal credential is stored. */
export interface QwenProfile {
  /** User-visible configuration name. */
  name: string
  /** Host credential reference for this configuration. */
  apiKeyEnv: string
  /** Full region-specific WSS task endpoint. */
  endpoint: string
  /** Qwen-Audio-TTS task model. */
  model: string
  /** Voice supported by the model and region. */
  voice: string
  /** Speaking rate, from 0.5 to 2. */
  rate: number
}

/** Required synthesis registry and Host credential owner. */
export const inject = ['textToSpeech', 'credentials']

/** Live provider configuration, pinned once per task. */
export interface Config {
  /** User-added configurations reconciled through native live settings. */
  profiles: Volatile<Record<string, QwenProfile>>
  /** Full region-specific WSS task endpoint; empty until configured by the user. */
  endpoint: Volatile<string>
  /** Host credential reference containing the provider API key. */
  apiKeyEnv: Volatile<string>
  /** Model supporting the Qwen-Audio-TTS task protocol. */
  model: Volatile<string>
  /** Voice identifier supported by the selected model and region. */
  voice: Volatile<string>
  /** Speaking rate from 0.5 to 2, where 1 is normal. */
  rate: Volatile<number>
  /** Mono PCM sample rate in hertz. */
  sampleRate: Volatile<number>
  /** Maximum elapsed synthesis time including connection setup, in milliseconds. */
  timeoutMs: Volatile<number>
  /** WebSocket connection deadline, independent of task duration. */
  handshakeMs: Volatile<number>
  /** Normal input-idle rotation, below the protocol's 23-second interval. */
  textIdleMs: Volatile<number>
  /** Maximum audio inactivity after sending text or finishing input. */
  audioIdleMs: Volatile<number>
  /** Maximum pending stream audio and metadata bytes. */
  maxBufferedAudioBytes: Volatile<number>
  /** Maximum complete PCM bytes retained for one request. */
  maxAudioBytes: Volatile<number>
  /** Maximum bytes accepted in one WebSocket message. */
  maxFrameBytes: Volatile<number>
}

/** Validated runtime settings; an empty endpoint deliberately requires user configuration. */
export const Config = z.object({
  profiles: z.dict(z.object({
    name: z.string().min(1).required(), apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').required(),
    endpoint: z.string().pattern(/^wss:\/\/[^\s@/?#]+(?:\/[^\s#]*)?$/).required(),
    model: z.string().min(1).required(), voice: z.string().min(1).required(), rate: z.number().min(0.5).max(2).required(),
  })).default({}).volatile(),
  endpoint: z.string().pattern(/^(?:|wss:\/\/[^\s@/?#]+(?:\/[^\s#]*)?)$/).default('').volatile(),
  apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').default('AEVORA_TTS_API_KEY').volatile(),
  model: z.string().min(1).default('qwen-audio-3.1-tts-flash').volatile(),
  voice: z.string().min(1).default('longanhuan_v3.1').volatile(),
  rate: z.number().min(0.5).max(2).default(1).volatile(),
  sampleRate: z.union([8000, 16000, 22050, 24000, 44100, 48000]).default(24000).volatile(),
  timeoutMs: z.natural().min(1000).default(120_000).volatile(),
  handshakeMs: z.natural().min(1000).default(10_000).volatile(),
  textIdleMs: z.natural().min(1).max(22_000).default(20_000).volatile(),
  audioIdleMs: z.natural().min(1000).default(30_000).volatile(),
  maxBufferedAudioBytes: z.natural().min(1024).default(1024 * 1024).volatile(),
  maxAudioBytes: z.natural().min(2).default(24 * 1024 * 1024).volatile(),
  maxFrameBytes: z.natural().min(1024).default(1024 * 1024).volatile(),
})

/**
 * Register the online provider for this plugin lifetime.
 * @param ctx - provider registration owner.
 * @param config - current profile settings.
 */
export function apply(ctx: Context, config: Config): void {
  const resources = () => ({ sampleRate: config.sampleRate.get(), timeoutMs: config.timeoutMs.get(),
    handshakeMs: config.handshakeMs.get(), textIdleMs: config.textIdleMs.get(), audioIdleMs: config.audioIdleMs.get(),
    maxBufferedAudioBytes: config.maxBufferedAudioBytes.get(), maxAudioBytes: config.maxAudioBytes.get(),
    maxFrameBytes: config.maxFrameBytes.get() })
  const provider = new QwenTtsProvider(async () => {
    const endpoint = config.endpoint.get().trim()
    if (endpoint !== '') {
      const url = new URL(endpoint)
      if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error('Speech endpoint must use wss without embedded credentials or fragment')
    }
    const request = { endpoint, model: config.model.get(), voice: config.voice.get(), rate: config.rate.get(), ...resources() }
    const key = await ctx.credentials.resolve(credentialRef(config.apiKeyEnv.get()))
    return { ...request, key: key?.value }
  })
  ctx.effect(() => ctx.textToSpeech.register({ id: provider.id, available: () => config.endpoint.get().trim() !== '',
    synthesize: (input, signal) => provider.synthesize(input, signal),
    stream: (input, signal) => provider.stream(input, signal) }), 'qwen-tts: legacy provider')
  ctx.effect(() => {
    const routes = new Map<string, () => Promise<void>>()
    const pending = new Set<Promise<void>>()
    const withdraw = (key: string): void => {
      const remove = routes.get(key)
      if (remove === undefined) return
      routes.delete(key)
      const settlement = remove()
      pending.add(settlement)
      void settlement.finally(() => { pending.delete(settlement) })
    }
    const reconcile = (): void => {
      const profiles = config.profiles.get()
      for (const key of routes.keys()) if (!Object.hasOwn(profiles, key)) withdraw(key)
      for (const key of Object.keys(profiles)) {
        if (routes.has(key)) continue
        const named = new QwenTtsProvider(async () => {
          const profile = config.profiles.get()[key]
          if (profile === undefined) throw new TtsFailure('unconfigured')
          const request = { ...profile, ...resources() }
          return { ...request, key: (await ctx.credentials.resolve(credentialRef(profile.apiKeyEnv)))?.value }
        }, `qwen-online:${key}` as TtsProviderId)
        routes.set(key, ctx.textToSpeech.register(named))
      }
    }
    reconcile()
    const off = ctx.on('loader/volatile-update', reconcile)
    return async () => { off(); for (const key of routes.keys()) withdraw(key); await Promise.allSettled(pending) }
  }, 'qwen-tts: named providers')
}
