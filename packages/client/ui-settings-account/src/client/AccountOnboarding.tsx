/** Account-service placeholder inside model settings; API-key setup stays independent. */
import {Button, Modal} from '@deepseek-ai/dsh-client-ui-primitives'
import type {InjectFace, PropsLocale, PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
import type {AccountSectionInjected} from './AccountSection.tsx'
/** @param props - Native onboarding close/API-key actions and localized copy. @returns a non-authenticating account notice. */
export function AccountOnboarding({complete,useApiKey,t}: PropsRuntime<'settings.models.sign-in'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>) {
 return <Modal open title={t('aevora.account.title')} description={t('aevora.account.pending')} closeLabel={t('close')} onClose={complete}
 footer={<Button onClick={useApiKey}>{t('addApiKey')}</Button>}/>
}
