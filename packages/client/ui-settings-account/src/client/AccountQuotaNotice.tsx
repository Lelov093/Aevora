/** Account-service placeholder for quota notices; no recharge or platform navigation. */
import {Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {HostObservable,InjectFace,PropsLocale,PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {AccountSnapshot} from './AccountSection.tsx'
import type {PlatformPages,PlatformPageClaim} from './platform-pages.ts'
import type {QuotaNoticeOwnerProps} from '@deepseek-ai/dsh-client-ui-chat/client'
/** Injected share of the account route's frame-wide quota notice entry. */
export interface AccountQuotaNoticeInjected {
  /** Desktop-only: show one page in the account feature's shared native host; absent in ordinary browsers. */
  openPlatformPage?: PlatformPages['open']
  hooks: {
    account: HostObservable<AccountSnapshot>
    /** The page the shared host is showing, or null while it is closed. */
    platformPage: HostObservable<PlatformPageClaim | null>
  }
}

type AccountQuotaNoticeProps = PropsRuntime<'shell.quota-notice'>
  & {matched: QuotaNoticeOwnerProps}

  & PropsLocale<'settings.account'>
  & InjectFace<AccountQuotaNoticeInjected>


/** @param props - Native notice dismiss action and localized copy. @returns account service notice. */
export function AccountQuotaNotice({dismiss,t}: AccountQuotaNoticeProps) {
 return <Modal open title={t('aevora.account.title')} description={t('aevora.account.pending')} closeLabel={t('close')} onClose={dismiss}/>
}
