/** User-added online recognition profiles over native credentials and ASR registration. */
import type { Context, Volatile } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type {} from '@deepseek-ai/dsh-experimental-speech-to-text'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type { SpeechProviderId } from '@deepseek-ai/dsh-experimental-speech-to-text/types'
import { QwenSpeechProvider } from './provider.ts'

/** Persisted non-secret recognition configuration. */
export interface QwenSpeechProfile {
  /** User-visible configuration name. */
  name: string
  /** Independent native credential reference. */
  apiKeyEnv: string
  /** Complete region-specific WSS endpoint without embedded credentials. */
  endpoint: string
  /** Model supporting the Qwen streaming ASR task protocol. */
  model: string
}

/** Explicit resource limits shared by named profiles. */
export interface Config {
  /** Explicitly added configurations; empty does not select an online vendor. */
  profiles: Volatile<Record<string, QwenSpeechProfile>>
  /** Connection and task-start deadline in milliseconds. */
  handshakeMs: number
  /** Final-result deadline after finishing input, in milliseconds. */
  finishTimeoutMs: number
  /** Whole task deadline in milliseconds; no reconnect or rotation. */
  taskTimeoutMs: number
  /** Maximum one server message or input PCM frame, in bytes. */
  maxFrameBytes: number
  /** Maximum queued serialized events and socket buffer, in bytes. */
  maxQueuedBytes: number
  /** Maximum PCM audio admitted per task, in bytes. */
  maxAudioBytes: number
  /** Maximum retained UTF-8 transcript and sentence bookkeeping, in bytes. */
  maxTextBytes: number
}

/** Profiles start empty; adding a card never calls a provider. */
export const Config = z.object({
  profiles: z.dict(z.object({ name: z.string().min(1).required(),
    apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').required(),
    endpoint: z.string().pattern(/^wss:\/\/[^\s@/?#]+(?:\/[^\s#]*)?$/).required(), model: z.string().min(1).required(),
  })).default({}).volatile(),
  handshakeMs: z.natural().min(1000).default(10_000), finishTimeoutMs: z.natural().min(1000).default(15_000),
  taskTimeoutMs: z.natural().min(1000).default(150_000), maxFrameBytes: z.natural().min(1024).default(64 * 1024),
  maxQueuedBytes: z.natural().min(1024).default(128 * 1024), maxAudioBytes: z.natural().min(2).default(4 * 1024 * 1024),
  maxTextBytes: z.natural().min(128).default(128 * 1024),
})

export const inject = ['speechToText', 'credentials']

/** Register named profiles and cancel their accepted work before removing them.
 * @param ctx - Cordis registration and credential owner.
 * @param config - validated native configuration.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => {
    const routes = new Map<string, { profile: QwenSpeechProfile; remove: () => Promise<void> }>()
    const pending = new Set<Promise<void>>()
    const withdraw = (key: string): void => {
      const previous = routes.get(key)
      if (!previous) return
      routes.delete(key)
      const promise = previous.remove(); pending.add(promise)
      void promise.then(() => { pending.delete(promise) }, (_releaseFailure: unknown) => { console.error('Recognition provider cleanup failed') })
    }
    const reconcile = (): void => {
      const profiles = config.profiles.get()
      for (const [key, route] of routes) if (JSON.stringify(profiles[key]) !== JSON.stringify(route.profile)) withdraw(key)
      for (const [key, profile] of Object.entries(profiles)) {
        if (routes.has(key)) continue
        const url = new URL(profile.endpoint)
        if (url.protocol !== 'wss:' || url.username || url.password || url.hash) throw new Error('ASR endpoint must use WSS without credentials or fragment')
        const pinned = { ...profile }
        const provider = new QwenSpeechProvider(`qwen-asr:${key}` as SpeechProviderId, profile.name, async () => {
          const key = (await ctx.credentials.resolve(credentialRef(pinned.apiKeyEnv)))?.value
          return { endpoint: pinned.endpoint, model: pinned.model, key,
            handshakeMs: config.handshakeMs, finishTimeoutMs: config.finishTimeoutMs, taskTimeoutMs: config.taskTimeoutMs,
            maxFrameBytes: config.maxFrameBytes, maxQueuedBytes: config.maxQueuedBytes,
            maxAudioBytes: config.maxAudioBytes, maxTextBytes: config.maxTextBytes }
        })
        routes.set(key, { profile: pinned, remove: ctx.speechToText.register(provider) })
      }
    }
    reconcile()
    const off = ctx.on('loader/volatile-update', reconcile)
    return async () => { off(); for (const key of routes.keys()) withdraw(key); await Promise.allSettled(pending) }
  }, 'qwen-asr: named recognizers')
}
