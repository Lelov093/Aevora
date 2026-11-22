/** Product-owned running mark for the Chat status row. */
import { AevoraStatusMark } from '@deepseek-ai/dsh-client-ui-primitives'

/**
 * Render the decorative running mark with the shared Aevora process language.
 * @returns the product-owned running marker.
 */
export function RunningWhaleTail() {
  return <AevoraStatusMark kind="running" size={14} />
}
