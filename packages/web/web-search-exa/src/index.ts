/**
 * Exa-backed `WebSearchProvider` plugin. It contributes to the `ctx.web`
 * registry without owning the service.
 *
 * @module @deepseek-ai/dsh-web-search-exa
 */
import type {} from '@deepseek-ai/cordis-plugin-loader'


import type { Context, Volatile } from '@deepseek-ai/cordis'
import { launchEnvironmentOf } from '@deepseek-ai/dsh-launch-environment'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-web'
import {
  ExaSearchProvider,
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
} from './provider.ts'

export {
  EXA_DEFAULT_BASE_URL,
  EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
  EXA_DEFAULT_SEARCH_TYPE,
  EXA_PROVIDER_ID,
  ExaSearchProvider,
} from './provider.ts'
export type { ExaSearchProviderOptions } from './provider.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'web-search-exa'

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
  }>>

  /** Exa API key. Falls back to `$EXA_API_KEY`. Empty → provider unavailable. */
  apiKey?: string
  /** Endpoint base; `/search` is appended. Defaults to the public API. */
  baseURL?: string
  /** Retrieval mode sent as Exa's `type`. Defaults to `auto`. */
  searchType?: 'auto' | 'keyword' | 'neural'
  /** Default result count when a request carries no `maxResults`. Omitted = none. */
  numResults?: number
  /** Highlight sentences requested per result. Defaults to 1. */
  highlightsPerResult?: number
}

/** Validated legacy settings and live named-provider configurations. */
export const Config = z.object({
  profiles: z.dict(z.object({
    name: z.string().min(1).required(), apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').required(),
    endpoint: z.string().pattern(/^https?:\/\/[^\s@/?#]+(?:\/[^\s#]*)?$/).required(),
  })).default({}).volatile(),
  apiKey: z.string(),
  baseURL: z.string(),
  searchType: z.union(['auto', 'keyword', 'neural'] as const),
  numResults: z.number().step(1).min(1),
  highlightsPerResult: z.number().step(1).min(1),
})

/** Register the Exa search provider with `ctx.web`. */
export function apply(ctx: Context, config: Config): void {
  ctx.web.registerSearchProvider(new ExaSearchProvider({
    // Every environment layer may name this key: the product trusts the
    // project it is launched in, and the managed store is not involved here.
    apiKey: config.apiKey ?? launchEnvironmentOf(ctx).get('EXA_API_KEY')?.value ?? '',
    baseURL: config.baseURL ?? EXA_DEFAULT_BASE_URL,
    searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
    highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
    ...config.numResults !== undefined ? { numResults: config.numResults } : {},
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
        const make = (profile: ReturnType<typeof current>, apiKey: string) => new ExaSearchProvider({
          apiKey, baseURL: profile.endpoint,
          highlightsPerResult: config.highlightsPerResult ?? EXA_DEFAULT_HIGHLIGHTS_PER_RESULT,
          searchType: config.searchType ?? EXA_DEFAULT_SEARCH_TYPE,
          ...config.numResults !== undefined ? { numResults: config.numResults } : {},
        })
        routes.set(key, ctx.web.registerSearchProvider({
          id: `exa:${key}`,
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
  }, 'exa: named providers')
}
