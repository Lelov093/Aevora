/** One Session's pending feedback/rating notice; submitting and recording are unavailable. */
import {Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {FeedbackDialogProps} from './slots.ts'
/** @param props - Session-owned dialog snapshot, dismiss action and copy. @returns pending-service notice. */
export function FeedbackDialog({useDialog,dismiss,t}: FeedbackDialogProps) {
 const target=useDialog(state=>state.target)
 const rating=target?.kind==='message'
 return <Modal open={target!==null} title={t(rating?'aevora.rating.title':'aevora.feedback.title')}
  description={t(rating?'aevora.rating.pending':'aevora.feedback.pending')} closeLabel={t('close')} onClose={dismiss}/>
}
