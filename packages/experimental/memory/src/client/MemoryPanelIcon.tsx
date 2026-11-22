/** Global navigation icon for the Memory management page. */

import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { IconDataOutlineMedium } from '@deepseek-ai/dsh-client-ui-primitives'

/** Render the existing data icon at the sidebar's requested size. */
export function MemoryPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>) {
  return <IconDataOutlineMedium size={size} aria-hidden="true" />
}
