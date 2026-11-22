/** Wire types for Tavily Search. */

export type TavilySearchDepth = 'basic' | 'fast' | 'ultra-fast' | 'advanced'
export type TavilyTopic = 'general' | 'news' | 'finance'

/** Request body sent to Tavily Search. */
export interface TavilySearchRequest {
  query: string
  search_depth: TavilySearchDepth
  topic: TavilyTopic
  max_results?: number
  include_answer: true
}

/** One normalized source entry returned by Tavily. */
export interface TavilyResult {
  url: string
  title?: string | null
  content?: string | null
  published_date?: string | null
}

/** Tavily Search response envelope. */
export interface TavilySearchResponse {
  answer?: string | null
  results?: TavilyResult[]
}

/** Best-effort Tavily error response. */
export interface TavilyError {
  detail?: { error?: string } | string | Array<{ msg?: string }>
  error?: string
  message?: string
}
