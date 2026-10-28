/**
 * Session feedback: the `feedback/record` event, its command-independent
 * producer, the `sessionFeedback` Host Remote a product surface records
 * through, and the human-facing pending `/feedback` command. Direct recording appends one
 * authoritative log-only event and does not start model work. The append is
 * eager but unflushed, so acknowledgement reports that the entry is logged,
 * not that it reached disk.
 * @module @deepseek-ai/dsh-command-feedback
 */

import type { Context } from '@deepseek-ai/cordis'
import { CommandDefinitionId } from '@deepseek-ai/dsh-commands/brand'
import type { CommandInvocation, CommandResult } from '@deepseek-ai/dsh-commands'
import type { Session } from '@deepseek-ai/dsh-session'
import { TypertRemoteService, Remote } from '@deepseek-ai/dsh-typert-protocol'
import type {
  FeedbackCategory,
  FeedbackRecord,
  SessionFeedbackRecordRequest,
  SessionFeedbackRecordResult,
} from './types.ts'

export type * from './types.ts'

/**
 * Every feedback category in the order product surfaces present them; each
 * surface owns its localized labels.
 */
export const FEEDBACK_CATEGORIES = [
  'task-result',
  'instruction-following',
  'product-interaction',
  'service-stability',
  'resource-cost',
  'security-privacy-permission',
  'other',
] as const satisfies readonly FeedbackCategory[]

export const name = 'command-feedback'
export const inject = ['commands']


declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionFeedback: SessionFeedbackService
  }
}

/**
 * Record feedback independently of any UI trigger. Surrounding whitespace is
 * discarded and a blank text is recorded as absent; an entry with neither
 * text nor category is still recorded.
 * @param session - session the feedback describes.
 * @param entry - human-authored remark and its category.
 */
export function recordFeedback(session: Session, entry: FeedbackRecord): void {
  const text = entry.text?.trim() ?? ''
  session.append('feedback/record', {
    ...(text.length === 0 ? {} : { text }),
    ...(entry.category === undefined ? {} : { category: entry.category }),
  })
}

/**
 * Return the pending product-service notice without recording feedback.
 * @param invocation - unused invocation; submitted text is not inspected or recorded.
 * @returns an explicit not-connected result, without a stored-evaluation claim.
 */
function executeFeedbackCommand(_invocation: CommandInvocation): CommandResult {
 return {kind:'success',text:'Aevora feedback is not connected yet. No feedback was saved or submitted.'}
}

/** Host Remote through which a product surface records a Session-level remark. */
export class SessionFeedbackService extends TypertRemoteService {
  static inject = ['sessions']

  /**
   * @param ctx - Host context carrying the live Session store.
   */
  constructor(ctx: Context) {
    super(ctx, 'sessionFeedback')
  }

  /**
   * Record one remark on a live Session.
   * @param request - target Session plus the optional text and category.
   * @returns the recorded postcondition, or `session-not-found` when no live
   * Session carries the id.
   */
  @Remote('record')
  record(request: SessionFeedbackRecordRequest): Promise<SessionFeedbackRecordResult> {
    const session = this.ctx.sessions.get(request.sessionId)
    if (session === undefined) {
      return Promise.resolve({ ok: false, error: { code: 'session-not-found', sessionId: request.sessionId } })
    }
    recordFeedback(session, request)
    return Promise.resolve({ ok: true, value: { recorded: true } })
  }
}

/**
 * Register the global `/feedback` command for every composed command adapter
 * and mount the `sessionFeedback` Remote.
 * @param ctx - Host context.
 */
export function apply(ctx: Context): void {
  ctx.plugin(SessionFeedbackService)
  ctx.commands.register({
    definitionId: CommandDefinitionId('@deepseek-ai/dsh-command-feedback'),
    name: 'feedback',
    description: 'Aevora feedback (not connected)',
    input: { hint: '<text>' },
    recordInput: false,
    handler: executeFeedbackCommand,
  })
}
