/** Host-owned authenticated delivery of the private standalone capture Worklet. */
import { readFile } from 'node:fs/promises'
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-connection'

/** Register only the fixed script; the native carrier owns trust, authentication and owner admission.
 * @param ctx - optional voice contribution lifetime.
 */
export function apply(ctx: Context): void {
  ctx.inject(['connection'], (scope) => {
    scope.effect(() => scope.connection.fetch.register({
      path: '/api/voice-input.pcm-worklet.js', methods: ['GET', 'HEAD'], requestBody: 'buffered',
      fetch: async request => new Response(request.method === 'HEAD' ? null : await readFile(new URL('../runtime/pcm-worklet.js', import.meta.url)),
        { headers: { 'Content-Type': 'text/javascript; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } }),
    }), 'voice-input: private worklet')
  })
}
