import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import mark from './assets/aevora-mark.svg'

/**
 * Render the Aevora mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the decorative Aevora mark.
 */
export function OfficialBrandMark({ size, className }: SidebarBrandMarkOwnerProps & { readonly className?: string | undefined }) {
  return <img src={mark} width={size} height={size} className={className} alt="" draggable={false} />
}

/**
 * Render the localized product name independently of its mark.
 * @param props - Shared shell translation supplied by the slot renderer.
 * @returns the product name in the current theme's text color.
 */
export function OfficialBrandName({ t }: { readonly t: (key: 'brand.localBuild') => string }) {
  return <span>{t('brand.localBuild')}</span>
}
