/** Bounded line protocol over native managed pipes; each worker has at most one outstanding call. */
import type { Context } from '@deepseek-ai/cordis'
import type { SubprocessHandle } from '@deepseek-ai/dsh-subprocess'
import type { Config } from './config.ts'

/** One managed inference process, including startup and abnormal pipe closure. */
export class ModelWorker {
  private readonly handle: SubprocessHandle
  private pending: { resolve(value: unknown): void; reject(error: unknown): void } | undefined
  private buffer = ''
  private failure: Error | undefined
  private readonly ready: Promise<unknown>

  constructor(ctx: Context, argv: readonly string[], private readonly config: Config, signal: AbortSignal) {
    const first = Promise.withResolvers<unknown>()
    this.pending = first; this.ready = first.promise
    this.handle = ctx.subprocess.spawn({ argv, cwd: process.cwd(), graceMs: config.graceMs, signal,
      env: { ELECTRON_RUN_AS_NODE: '1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', PYTHONUNBUFFERED: '1' },
      stdio: { stdin: 'pipe', stdout: 'pipe', stderr: { maxBytes: config.maxLogBytes } } })
    this.handle.stdout?.on('data', this.data)
    this.handle.stdout?.on('error', this.fail)
    this.handle.stdin?.on('error', this.fail)
    void this.handle.done.then(() => { this.fail(new Error('Voice model process exited')) }, this.fail)
    void this.ready.catch((_startupFailure: unknown) => { /* start() owns the startup report. */ })
  }

  private readonly fail = (_error: unknown): void => {
    this.failure ??= new Error('Voice model process or protocol failed')
    this.pending?.reject(this.failure); this.pending = undefined
    this.handle.terminate()
  }

  private readonly data = (chunk: Buffer): void => {
    this.buffer += chunk.toString('utf8')
    if (Buffer.byteLength(this.buffer) > this.config.maxLogBytes) { this.fail(new Error('Model output limit')); return }
    const newline = this.buffer.indexOf('\n')
    if (newline < 0) return
    try {
      if (!this.pending || this.buffer.indexOf('\n', newline + 1) >= 0) throw new Error('Unexpected model output')
      const value: unknown = JSON.parse(this.buffer.slice(0, newline))
      this.buffer = this.buffer.slice(newline + 1)
      const pending = this.pending; this.pending = undefined; pending.resolve(value)
    } catch (error) { this.fail(error) }
  }

  private async wait(promise: Promise<unknown>, timeoutMs: number, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const failed = Promise.withResolvers<never>()
    const abort = (): void => { failed.reject(signal.reason) }
    signal.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { failed.reject(new Error('Voice model timed out')) }, timeoutMs)
    try { return await Promise.race([promise, failed.promise]) }
    catch (error) { this.fail(error); throw error }
    finally { clearTimeout(timer); signal.removeEventListener('abort', abort) }
  }

  /** Wait for a model load without starting another process.
   * @param signal - mode lifetime.
   * @returns after the model reports a completed load.
   */
  async start(signal: AbortSignal): Promise<void> {
    if (!this.handle.stdin || !this.handle.stdout) throw new Error('Voice model pipes are unavailable')
    const value = await this.wait(this.ready, this.config.startupTimeoutMs, signal)
    if (typeof value !== 'object' || value === null || !('ready' in value) || value.ready !== true) throw new Error('Voice model did not become ready')
  }

  /** Send one bounded request; the caller validates the returned JSON.
   * @param command - bounded worker input.
   * @param signal - mode lifetime.
   * @returns parsed model response, before caller-specific validation.
   */
  async request(command: object, signal: AbortSignal): Promise<unknown> {
    if (this.failure) throw this.failure
    if (this.pending) throw new Error('Concurrent voice model request')
    const pending = Promise.withResolvers<unknown>()
    this.pending = pending
    try {
      if (!this.handle.stdin) throw new Error('Voice model input is unavailable')
      this.handle.stdin.write(`${JSON.stringify(command)}\n`, (error) => { if (error) this.fail(error) })
      return await this.wait(pending.promise, this.config.inferenceTimeoutMs, signal)
    } catch (error) { this.fail(error); throw error }
  }

  /** Terminate and join the managed process range. */
  async dispose(): Promise<void> {
    this.fail(new Error('Voice mode ended'))
    await this.handle.waitForExit()
    this.handle.stdout?.off('data', this.data)
    this.handle.stdout?.off('error', this.fail)
    this.handle.stdin?.off('error', this.fail)
  }
}
