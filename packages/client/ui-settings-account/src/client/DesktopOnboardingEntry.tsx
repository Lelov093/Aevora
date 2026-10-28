/** Framework-hook projection into the desktop introduction's pure view. */
import {useEffect} from 'react'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type { AccountSnapshot } from './AccountSection.tsx'
import type { DesktopOnboardingProps, DesktopOnboardingState } from './onboarding-contract.ts'

/** Observable sources and actions supplied by the account plugin's apply closure. */
export interface DesktopOnboardingInjected extends Omit<DesktopOnboardingProps, 'state' | 'account' | 't' | 'exiting' | 'locale'> {
  /** Publish whether onboarding covers the workspace. @param visible - includes loading, saving, and exit animation. */
  setVisible: (visible: boolean) => void
  hooks: {
    onboarding: HostObservable<DesktopOnboardingState>
    account: HostObservable<AccountSnapshot>
  }
}

/** @param props - Visibility action owned by the shell. @returns no cloud-account onboarding in Aevora. */
export function DesktopOnboardingEntry({setVisible}: PropsRuntime<'shell.overlay'> & PropsLocale<'settings.account'> & InjectFace<DesktopOnboardingInjected>) {
 useEffect(()=>{setVisible(false)},[setVisible])
 return null
}
