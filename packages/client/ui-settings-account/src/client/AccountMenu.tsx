/** Persistent settings launcher with Aevora account and feedback placeholders. */
import {useState} from 'react'
import {Menu, Modal, IconEllipsisOutlineMedium, IconPaperPlaneOutlineMedium, IconSettingsOutlineMedium, IconUserOutlineMedium} from '@deepseek-ai/dsh-client-ui-primitives'
import type {InjectFace, PropsLocale, PropsRuntime} from '@deepseek-ai/dsh-client-ui-slots'
import type {AccountSectionInjected} from './AccountSection.tsx'
import css from './AccountMenu.module.css'

/** Settings launcher props supplied by the original account slot. */
export type AccountMenuProps = PropsRuntime<'settings.launcher'> & PropsLocale<'settings.account'> & InjectFace<AccountSectionInjected>

/** @param props - Settings navigation and localized copy. @returns local menu and pending-service notice. */
export function AccountMenu({wide, settingsShortcut, openSettings, t}: AccountMenuProps) {
  const [open,setOpen]=useState(false)
  const [notice,setNotice]=useState<'account'|'feedback'|null>(null)
  return <div className={css.root}>
    <Menu open={open} side="top" portal autoFocus className={css.anchor} listClassName={css.signedOutMenu}
      anchor={<button type="button" className={css.trigger} data-collapsed={!wide} data-signed-out aria-label={t('more')}
        aria-haspopup="menu" aria-expanded={open} onClick={()=>setOpen(value=>!value)}><IconEllipsisOutlineMedium size={14}/>{wide&&<span className={css.label}>{t('more')}</span>}</button>}
      items={[
        {id:'settings',label:t('settings'),icon:<IconSettingsOutlineMedium size={16}/>,...(settingsShortcut===undefined?{}:{shortcut:settingsShortcut})},
        {id:'feedback',label:t('contactUs')+' · '+t('aevora.pending'),icon:<IconPaperPlaneOutlineMedium size={16}/>},
        {id:'account',label:t('signIn')+' · '+t('aevora.pending'),icon:<IconUserOutlineMedium size={16}/>},
      ]} onClose={()=>setOpen(false)} onSelect={id=>{setOpen(false);if(id==='settings')openSettings();else setNotice(id==='account'?'account':'feedback')}}/>
    <Modal open={notice!==null} title={t(notice==='account'?'aevora.account.title':'aevora.feedback.title')}
      description={t(notice==='account'?'aevora.account.pending':'aevora.feedback.pending')} closeLabel={t('close')} onClose={()=>setNotice(null)}/>
  </div>
}
