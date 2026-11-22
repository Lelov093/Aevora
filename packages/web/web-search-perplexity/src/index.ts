/**
 * Perplexity-backed `WebSearchProvider` plugin. It contributes to the
 * `ctx.web` registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-search-perplexity
 */
import type {} from '@deepseek-ai/cordis-plugin-loader'


import type { Context, Volatile } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-web'
import { PerplexitySearchProvider, PERPLEXITY_DEFAULT_BASE_URL, PERPLEXITY_DEFAULT_MAX_TOKENS, PERPLEXITY_DEFAULT_MODEL } from './provider.ts'

export {
  PERPLEXITY_DEFAULT_BASE_URL,
  PERPLEXITY_DEFAULT_MAX_TOKENS,
  PERPLEXITY_DEFAULT_MODEL,
  PERPLEXITY_PROVIDER_ID,
  PerplexitySearchProvider,
} from './provider.ts'
export type { PerplexityRecency, PerplexitySearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-perplexity'

/** The web seam this provider registers into. */
export const inject = ['web']

/** Plugin config (all optional — `apply` fills env-var and constant defaults). */
export interface Config {
  /** Independently named user configurations, with credentials stored separately. */
  profiles?: Volatile<Record<string, {
    /** User-visible configuration name. */
    name: string
    /** Host credential reference, resolved for each search. */
    apiKeyEnv: string
    /** API root implementing this adapter protocol. */
    endpoint: string
    /** Search model served by this configuration. */
    model: string
  }>>

  /** Perplexity API key. Falls back to `$PERPLEXITY_API_KEY`. Empty → unavailable. */
  apiKey?: string
  /** Endpoint base; `/chat/completions` is appended. Defaults to the public API. */
  baseURL?: string
  /** Search model name. Defaults to `sonar`. */
  model?: string
  /** Upper bound on generated answer tokens. Defaults to 1024. */
  maxTokens?: number
  /** Recency window sent as `search_recency_filter`. Omitted = no filter. */
  searchRecency?: 'day' | 'week' | 'month' | 'year'
}

/** Validated legacy settings and live named-provider configurations. */
export const Config = z.object({
  profiles: z.dict(z.object({
    name: z.string().min(1).required(), apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').required(),
    endpoint: z.string().pattern(/^https?:\/\/[^\s@/?#]+(?:\/[^\s#]*)?$/).required(),
    model: z.string().min(1).required(),
  })).default({}).volatile(),
  apiKey: z.string(),
  baseURL: z.string(),
  model: z.string(),
  maxTokens: z.number().step(1).min(1),
  searchRecency: z.union(['day', 'week', 'month', 'year'] as const),
})

/** Register the Perplexity search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new PerplexitySearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('PERPLEXITY_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? PERPLEXITY_DEFAULT_BASE_URL,
    model: config.model ?? PERPLEXITY_DEFAULT_MODEL,
    maxTokens: config.maxTokens ?? PERPLEXITY_DEFAULT_MAX_TOKENS,
    ...config.searchRecency !== undefined ? { searchRecency: config.searchRecency } : {},
  }))
  ctx.effect(() => {
    const routes = new Map<string, () => void>()
    const profiles = () => config.profiles?.get() ?? {}
    const reconcile = (): void => {
      for (const [key, remove] of routes) if (!Object.hasOwn(profiles(), key)) { remove(); routes.delete(key) }
      for (const key of Object.keys(profiles())) {
        if (routes.has(key)) continue
        const current = () => {
          const profile = profiles()[key]
          if (profile === undefined) throw new WebError('Search configuration was removed', 'WEB_PROVIDER_CONFIGURED_MISSING')
          return profile
        }
        const make = (profile: ReturnType<typeof current>, apiKey: string) => new PerplexitySearchProvider({
          apiKey, baseURL: profile.endpoint,
          model: profile.model, maxTokens: config.maxTokens ?? PERPLEXITY_DEFAULT_MAX_TOKENS,
          ...config.searchRecency !== undefined ? { searchRecency: config.searchRecency } : {},
        })
        routes.set(key, ctx.web.registerSearchProvider({
          id: `perplexity:${key}`,
          available: () => make(current(), 'configuration-only').available(),
          ready: async () => {
            try { return (await ctx.get('credentials')?.describe(credentialRef(current().apiKeyEnv)))?.configured ?? false }
            catch (_unreadableCredential) { return false }
          },
          search: async (request, signal) => {
            const profile = current()
            const credential = await ctx.get('credentials')?.resolve(credentialRef(profile.apiKeyEnv))
            signal?.throwIfAborted()
            if (credential === undefined) throw new WebError('Search credential is not configured', 'WEB_PROVIDER_UNAVAILABLE')
            return make(profile, credential.value).search(request, signal)
          },
        }))
      }
    }
    reconcile()
    const off = ctx.on('loader/volatile-update', reconcile)
    return () => { off(); for (const remove of routes.values()) remove(); routes.clear() }
  }, 'perplexity: named providers')
}
