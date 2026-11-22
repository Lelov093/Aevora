/** Finalized-reply speech action and root-owned failure feedback. */
import { useEffect } from 'react'
import { extractMarkdownPlainText, IconPlayOutlineRegular, IconStopFillRegular, Toast, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ChatNode } from '@deepseek-ai/dsh-client-ui-chat/client'
import type { VoiceFace } from './index.ts'
import css from './voice.module.css'
import { speechFailureKey } from './failure.ts'

/** Renderer-derived finalized reply action. */
export type ReadAloudProps = PropsRuntime<'conversation.chat.assistant-actions'> & PropsLocale<'voice'> & InjectFace<VoiceFace>

/** @param props - finalized reply identity, Chat projection and playback callbacks. @returns read/stop action. */
export function ReadAloud(props: ReadAloudProps) {
  const { sessionId, messageId, t, stop } = props
  const owner = `${sessionId}/${messageId}`
  const phase = props.useVoicePlayback(value => value.owner === owner ? value.phase : 'idle')
  const text = props.useChat((snapshot) => {
    for (const node of snapshot.nodes.values()) {
      if (node.kind !== 'turn-tail') continue
      const reply = (node as ChatNode<'turn-tail'>).data.closing
      if (reply?.finalNode.messageId !== messageId || reply.status !== 'settled') continue
      return extractMarkdownPlainText(reply.blocks.filter(block => block.kind === 'text').map(block => block.text).join(''))
    }
    return ''
  })
  useEffect(() => () => { stop(owner) }, [owner, stop])
  const label = t(phase === 'synthesizing' ? 'preparing' : phase === 'playing' ? 'stop' : 'read')
  return <Tooltip label={label} side="bottom"><button type="button" className={css.action} aria-label={label}
    disabled={!text.trim()} aria-busy={phase === 'synthesizing'} data-voice-read={messageId}
    onClick={() => { if (phase !== 'idle') stop(owner); else void props.read(sessionId, messageId, text) }}>
    {phase === 'idle' ? <IconPlayOutlineRegular /> : <IconStopFillRegular />}
  </button></Tooltip>
}

/** Root feedback props survive a Session view closing. */
export type VoiceToastProps = PropsRuntime<'shell.overlay'> & PropsLocale<'voice'> & InjectFace<VoiceFace>

/** @param props - global playback feedback and copy. @returns a transient failure toast. */
export function VoiceToast(props: VoiceToastProps) {
  const failure = props.useVoicePlayback(value => value.failure)
  const diagnostic = props.useVoicePlayback(value => value.diagnostic)
  return failure === null ? null : <Toast key={failure} text={props.t(speechFailureKey(diagnostic))}
    onDone={() =>{  props.dismiss(failure) }} />
}
