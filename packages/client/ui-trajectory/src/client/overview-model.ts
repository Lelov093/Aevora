/** Incremental, locale-independent overview facts owned by the trajectory target. */
import type { AssistantBlock, ConversationNode, RequestView, ToolCallBlock } from '@deepseek-ai/dsh-client-ui-conversation/client'
import { assertNever } from '@deepseek-ai/dsh-util-values'
import type { TrajectoryConversationViewNode } from './trajectory-contract.ts'

/** Presentation category inferred only from a recorded tool name. */
export type OverviewAction = 'read' | 'search' | 'write' | 'edit' | 'shell' | 'web' | 'delegate' | 'question' | 'other'
/** Recorded operation state; an unsettled call has no implied side-effect outcome. */
export type OverviewState = 'done' | 'running' | 'error' | 'stopped' | 'unknown'
/** One recorded operation, message, or context lifecycle in a turn. */
export interface OverviewItem {
  readonly id: string
  readonly seq: number
  readonly kind: 'tool' | 'response' | 'context' | 'compaction' | 'retry' | 'unknown'
  readonly state: OverviewState
  readonly text: string
  readonly inputText?: string
  readonly action?: OverviewAction
  readonly toolName?: string
  readonly callId?: string
  readonly object?: string
  readonly duration?: number
  readonly children?: readonly OverviewItem[]
  readonly retryCount?: number
}
/** A loaded turn or a standalone group between turns; completion is a durable turn fact. */
export interface OverviewTurn {
  readonly key: string
  readonly turn?: number
  readonly seq: number
  readonly request: string
  readonly startedAt?: number
  readonly items: readonly OverviewItem[]
  readonly ending?: { readonly state: OverviewState; readonly error?: string; readonly time: number }
}

const names: Readonly<Record<string, OverviewAction>> = {
  read: 'read', read_image: 'read', glob: 'search', grep: 'search', write: 'write', edit: 'edit',
  bash: 'shell', pwsh: 'shell', terminal: 'shell', run_code: 'shell', web: 'web', web_search: 'web', web_fetch: 'web',
  subagent: 'delegate', subagent_fork: 'delegate', subagent_control: 'delegate', ask_user_question: 'question',
}

function blockText(blocks: readonly AssistantBlock[]): string {
  return blocks.flatMap(block => block.kind === 'text' ? [block.text] : []).join('\n')
}

function toolItem(call: ToolCallBlock, seq: number): OverviewItem {
  const settled = 'kind' in call
  const toolName = settled ? call.call?.name ?? call.name : call.name
  const error = settled && call.isError
  const interrupted = settled && (call.error?.code === 'INTERRUPTED' || call.error?.code === 'ABORTED' || call.error?.code === 'interrupted' || call.error?.code === 'aborted')
  const object = ['file_path', 'path', 'url', 'query', 'pattern', 'description']
    .map(key => call.args.text(key)).find(value => value !== undefined && value !== '')
  return {
    id: `call:${call.callId}`, seq, kind: 'tool', callId: call.callId, toolName,
    action: names[toolName] ?? 'other',
    state: interrupted ? 'unknown' : settled ? error ? 'error' : 'done' : 'running',
    inputText: settled ? call.call?.argsRaw ?? '' : 'argsRaw' in call ? call.argsRaw : '',
    text: settled ? call.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n') : '',
    ...(object === undefined ? {} : { object }),
    ...(settled && call.callTime !== null ? { duration: Math.max(0, call.time - call.callTime) } : {}),
    ...(call.subCalls.length === 0 ? {} : { children: call.subCalls.map(child => toolItem(child, seq)) }),
  }
}

function messageItems(node: ConversationNode): OverviewItem[] {
  switch (node.kind) {
    case 'user': case 'steering': return []
    case 'assistant': return [{ id: `response:${node.seq}`, seq: node.seq, kind: 'response', state: node.interrupted ? 'stopped' : 'done', text: blockText(node.blocks) }]
    case 'tool-result': return [toolItem(node, node.seq)]
    case 'compaction': return [{ id: `compaction:${node.seq}`, seq: node.seq, kind: 'compaction', state: 'done', text: '' }]
    case 'model-retry': return [{ id: `retry:${node.seq}`, seq: node.seq, kind: 'retry', state: node.retryState === 'cancelled' ? 'stopped' : node.retryState === 'scheduled' ? 'running' : 'done', text: '' }]
    case 'turn-error': return [{ id: `error:${node.seq}`, seq: node.seq, kind: 'unknown', state: node.code === 'INTERRUPTED' ? 'stopped' : 'error', text: node.message }]
    case 'turn-max-tokens': return [{ id: `limit:${node.seq}`, seq: node.seq, kind: 'unknown', state: 'error', text: '' }]
    case 'context': return [{ id: `context:${node.seq}`, seq: node.seq, kind: 'context', state: 'done', text: '' }]
    case 'command': case 'unknown':
      return [{ id: `record:${node.seq}`, seq: node.seq, kind: 'unknown', state: 'unknown', text: '' }]
    default: return assertNever(node)
  }
}

function requestText(node: ConversationNode): string {
  return node.kind === 'user' || node.kind === 'steering'
    ? node.content.flatMap(block => block.type === 'text' ? [block.text] : []).join('\n')
    : ''
}

function materialize(key: string, nodes: Iterable<TrajectoryConversationViewNode>): OverviewTurn | undefined {
  const ordered = [...nodes].sort((a, b) => a.anchorSeq - b.anchorSeq)
  const first = ordered[0]
  if (first === undefined) return undefined
  const location = first.location
  const turn = location.kind === 'step' || location.kind === 'turn' ? location.turn.turn : first.data.kind === 'turn-end' ? first.data.turn : undefined
  const startedAt = location.kind === 'step' || location.kind === 'turn' ? location.turn.start?.time : undefined
  let request = ''
  let ending: OverviewTurn['ending']
  const items: OverviewItem[] = []
  const compactions = new Set<number>()
  for (const node of ordered) {
    const data = node.data
    switch (data.kind) {
      case 'node': {
        const text = requestText(data.node)
        if (text) request = request ? `${request}\n${text}` : text
        if (data.node.kind !== 'compaction' || !compactions.has(data.node.seq)) items.push(...messageItems(data.node))
        break
      }
      case 'tool': items.push(toolItem(data.root, node.anchorSeq)); break
      case 'assistant': {
        if (data.request?.retry) items.push({ id: `${node.key}:retry`, seq: node.anchorSeq, kind: 'retry', retryCount: data.request.retry, state: data.request.status === 'running' ? 'running' : data.request.status === 'complete' ? 'done' : 'error', text: data.request.error ?? '' })
        if (data.node) items.push(...messageItems(data.node))
        else if (data.partial) items.push({ id: node.key, seq: node.anchorSeq, kind: 'response', state: 'running', text: blockText(data.partial.blocks) })
        else if (data.request) items.push({ id: node.key, seq: node.anchorSeq, kind: 'response', state: data.request.status === 'error' ? 'error' : data.request.status === 'running' ? 'running' : 'done', text: data.request.error ?? '' })
        break
      }
      case 'compaction': {
        const recordSeq = data.request.resultSeq ?? data.request.startSeq
        compactions.add(recordSeq)
        items.push({ id: node.key, seq: node.anchorSeq, kind: 'compaction', state: data.request.status === 'running' ? 'running' : data.request.status === 'error' ? 'error' : 'done', text: data.request.error ?? '' })
        break
      }
      case 'turn-end': ending = { state: data.outcome === 'completed' ? 'done' : data.outcome === 'aborted' || data.outcome === 'interrupted' || data.outcome === 'forked' ? 'stopped' : data.error !== undefined || data.outcome === 'error' || data.outcome === 'blocked' || data.outcome === 'max-tokens' ? 'error' : 'unknown', time: data.time, ...(data.error === undefined ? {} : { error: data.error }) }; break
      case 'system-prompt': case 'request-header': case 'session-end': break
    }
  }
  return {
    key, seq: first.anchorSeq, request, items,
    ...(turn === undefined ? {} : { turn }),
    ...(startedAt === undefined ? {} : { startedAt }),
    ...(ending === undefined ? {} : { ending }),
  }
}

/** Incremental turn index; a streaming update rebuilds only its owning loaded turn. */
export class TrajectoryOverviewIndex {
  private readonly owners = new Map<string, string>()
  private readonly groups = new Map<string, Map<string, TrajectoryConversationViewNode>>()
  private readonly published = new Map<string, OverviewTurn>()
  private readonly dirty = new Set<string>()
  private readonly compactions = new Map<number, string>()

  /** Discard the previous loaded window before a full replacement. */
  clear(): void {
    this.owners.clear(); this.groups.clear(); this.published.clear(); this.dirty.clear(); this.compactions.clear()
  }

  /**
   * Index one immutable contribution without reading unrelated turns.
   * @param node - Updated target-owned contribution and location.
   */
  upsert(node: TrajectoryConversationViewNode): void {
    if (node.data.kind === 'compaction') this.compactions.set(node.data.request.startSeq, node.key)
    const location = node.location
    const explicit = node.data.kind === 'turn-end' ? node.data.turn : undefined
    const turn = location.kind === 'turn' || location.kind === 'step' ? location.turn.turn : explicit
    const group = turn === undefined ? `between:${node.key}` : `turn:${turn}`
    const previous = this.owners.get(node.key)
    if (previous !== undefined && previous !== group) {
      this.groups.get(previous)?.delete(node.key)
      this.dirty.add(previous)
    }
    let members = this.groups.get(group)
    if (!members) { members = new Map(); this.groups.set(group, members) }
    if (members.get(node.key) === node) return
    members.set(node.key, node); this.owners.set(node.key, group); this.dirty.add(group)
  }

  /**
   * Share a session-boundary interruption already resolved by the original request projection.
   * @param request - Final compaction facts from the detailed trajectory builder.
   */
  settleCompaction(request: Extract<RequestView, { purpose: 'compaction' }>): void {
    const key = this.compactions.get(request.startSeq)
    const group = key === undefined ? undefined : this.owners.get(key)
    if (key === undefined || group === undefined) return
    const members = this.groups.get(group)
    const previous = members?.get(key)
    if (previous?.data.kind !== 'compaction' || previous.data.request.status !== 'running') return
    members?.set(key, { ...previous, data: { kind: 'compaction', request } })
    this.dirty.add(group)
  }

  /**
   * Publish immutable loaded-turn models while retaining unchanged turn identities.
   * @returns Chronologically ordered groups with visible records or durable endings.
   */
  snapshot(): readonly OverviewTurn[] {
    for (const key of this.dirty) {
      const members = this.groups.get(key)
      if (!members?.size) { this.published.delete(key); this.groups.delete(key) }
      else {
        const turn = materialize(key, members.values())
        if (turn !== undefined) this.published.set(key, turn)
      }
    }
    this.dirty.clear()
    return [...this.published.values()].filter(turn => turn.request !== '' || turn.items.length > 0 || turn.ending !== undefined).sort((a, b) => a.seq - b.seq)
  }
}
