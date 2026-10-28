/** Answer-rating placeholders; no feedback read, mutation or learning is performed. */
import {IconDislikeOutlineRegular,IconLikeOutlineRegular,Tooltip} from '@deepseek-ai/dsh-client-ui-primitives'
import type {MessageFeedbackActionProps} from './slots.ts'
import css from './MessageFeedbackActions.module.css'
/** @param props - Message identity, local dialog action and copy. @returns pending rating controls. */
export function MessageFeedbackActions({messageId,openDialog,t}: MessageFeedbackActionProps) {
 return <>{(['positive','negative'] as const).map(rating=><Tooltip key={rating} label={t(rating==='positive'?'action.like':'action.dislike')} side="bottom">
  <button type="button" className={css.action} aria-label={t(rating==='positive'?'action.like':'action.dislike')} onClick={()=>openDialog(messageId,rating)}>
   {rating==='positive'?<IconLikeOutlineRegular/>:<IconDislikeOutlineRegular/>}
  </button></Tooltip>)}</>
}
