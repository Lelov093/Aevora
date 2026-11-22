/** Tavily-backed WebSearchProvider adapter. */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebSearchProvider, WebSearchRequest, WebSearchResult, WebSearchSource } from '@deepseek-ai/dsh-web'
import type { TavilyError, TavilyResult, TavilySearchResponse, TavilySearchRequest, TavilySearchDepth, TavilyTopic } from './types.ts'

export const TAVILY_DEFAULT_BASE_URL = 'https://api.tavily.com'
export const TAVILY_DEFAULT_SEARCH_DEPTH: TavilySearchDepth = 'basic'
export const TAVILY_DEFAULT_TOPIC: TavilyTopic = 'general'
const TAVILY_MAX_RESULTS = 20

export interface TavilySearchProviderOptions {
  apiKey: string
  baseURL: string
  searchDepth: TavilySearchDepth
  topic: TavilyTopic
}

/** Map one Tavily result to the provider-neutral source fields. */
export function mapTavilyResult(result: TavilyResult): WebSearchSource {
  if (typeof result.url !== 'string' || result.url.length === 0) throw new TypeError('Tavily result URL is missing')
  return {
    url: result.url,
    ...typeof result.title === 'string' && result.title.length > 0 ? { title: result.title } : {},
    ...typeof result.content === 'string' && result.content.length > 0 ? { summary: result.content } : {},
    ...typeof result.published_date === 'string' && result.published_date.length > 0 ? { publishedAt: result.published_date } : {},
  }
}

/** Map a Tavily response to the dsh-web result vocabulary. */
export function mapTavilyResponse(response: TavilySearchResponse): WebSearchResult {
  if (!Array.isArray(response.results)) throw new TypeError('Tavily response results must be an array')
  const sources = response.results.map(mapTavilyResult)
  const answer = typeof response.answer === 'string' && response.answer.length > 0 ? response.answer : undefined
  return { ...answer !== undefined ? { content: answer } : {}, sources, truncated: false }
}

export class TavilySearchProvider implements WebSearchProvider {
  readonly id = 'tavily'

  constructor(private readonly options: TavilySearchProviderOptions) {}

  available(): boolean {
    return this.options.apiKey.length > 0
      && isValidBaseUrl(this.options.baseURL)
      && isSearchDepth(this.options.searchDepth)
      && isTopic(this.options.topic)
  }

  async search(request: WebSearchRequest, signal?: AbortSignal): Promise<WebSearchResult> {
    const body: TavilySearchRequest = {
      query: request.query,
      search_depth: this.options.searchDepth,
      topic: this.options.topic,
      include_answer: true,
      ...request.maxResults !== undefined ? { max_results: clampMaxResults(request.maxResults) } : {},
    }
    let response: Response
    try {
      response = await fetch(`${trimTrailingSlashes(this.options.baseURL)}/search`, {
        method: 'POST',
        redirect: 'error',
        headers: {
          authorization: `Bearer ${this.options.apiKey}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: JSON.stringify(body),
        ...signal !== undefined ? { signal } : {},
      })
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily search request failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }

    if (!response.ok) {
      const message = await readErrorMessage(response)
      throw new WebError(message, 'WEB_PROVIDER_ERROR')
    }
    try {
      return mapTavilyResponse(await response.json() as TavilySearchResponse)
    } catch (error: unknown) {
      if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
      throw new WebError(`Tavily returned an unprocessable response body: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
    }
  }
}

async function readErrorMessage(response: Response): Promise<string> {
  let message = `Tavily API error (HTTP ${response.status})`
  try {
    const parsed = await response.json() as TavilyError
    const detail = typeof parsed.detail === 'string'
      ? parsed.detail
      : Array.isArray(parsed.detail) ? parsed.detail.map(item => item.msg).filter((item): item is string => item !== undefined).join('; ')
        : parsed.detail?.error ?? parsed.error ?? parsed.message
    if (detail !== undefined && detail.length > 0) message = detail
  } catch (error: unknown) {
    if (isAbortError(error)) throw new WebError('Tavily search aborted', 'WEB_ABORTED', { cause: error })
  }
  const retryAfter = response.status === 429 ? response.headers.get('retry-after') : null
  return retryAfter === null || retryAfter.length === 0 ? message : `${message} (Retry-After: ${retryAfter})`
}

function trimTrailingSlashes(value: string): string { return value.replace(/\/+$/u, '') }
function clampMaxResults(value: number): number { return Math.max(0, Math.min(TAVILY_MAX_RESULTS, Math.trunc(value))) }
function isValidBaseUrl(value: string): boolean {
  try {
    const url = new URL(value)
    return (url.protocol === 'http:' || url.protocol === 'https:') && url.username.length === 0 && url.password.length === 0 && url.hash.length === 0
  } catch { return false }
}
function isSearchDepth(value: string): value is TavilySearchDepth { return ['basic', 'fast', 'ultra-fast', 'advanced'].includes(value) }
function isTopic(value: string): value is TavilyTopic { return ['general', 'news', 'finance'].includes(value) }
function isAbortError(error: unknown): boolean { return error instanceof DOMException && error.name === 'AbortError' }
