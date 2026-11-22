/** Optional Tavily Provider for the shared `ctx.web` search seam. */
import type {} from '@deepseek-ai/cordis-plugin-loader'
import type { Context, Volatile } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import { WebError } from '@deepseek-ai/dsh-web'
import type {} from '@deepseek-ai/dsh-web'
import { TavilySearchProvider } from './provider.ts'

export { TavilySearchProvider, TAVILY_DEFAULT_BASE_URL, TAVILY_DEFAULT_SEARCH_DEPTH, TAVILY_DEFAULT_TOPIC } from './provider.ts'
export type { TavilySearchProviderOptions } from './provider.ts'
export type { TavilySearchDepth, TavilyTopic } from './types.ts'

export const name = 'web-search-tavily'
export const inject = ['web']

export interface Config {
  profiles?: Volatile<Record<string, {
    name: string
    apiKeyEnv: string
    endpoint: string
    searchDepth: 'basic' | 'fast' | 'ultra-fast' | 'advanced'
    topic: 'general' | 'news' | 'finance'
  }>>
}

export const Config = z.object({
  profiles: z.dict(z.object({
    name: z.string().min(1).required(),
    apiKeyEnv: z.string().pattern(/^[A-Za-z_][A-Za-z0-9_]*$/).role('credential-ref').required(),
    endpoint: z.string().pattern(/^https?:\/\/[^\s@/?#]+(?:\/[^\s#]*)?$/).required(),
    searchDepth: z.union(['basic', 'fast', 'ultra-fast', 'advanced'] as const).required(),
    topic: z.union(['general', 'news', 'finance'] as const).required(),
  })).default({}).volatile(),
})

export function apply(ctx: Context, config: Config): void {
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
        const make = (profile: ReturnType<typeof current>, apiKey: string) => new TavilySearchProvider({
          apiKey, baseURL: profile.endpoint, searchDepth: profile.searchDepth, topic: profile.topic,
        })
        routes.set(key, ctx.web.registerSearchProvider({
          id: `tavily:${key}`,
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
  }, 'tavily: named providers')
}
