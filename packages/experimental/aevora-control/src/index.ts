/** Aevora control-plane Host entry for the existing DSH Plugins page. */
import { Service, type Context } from '@deepseek-ai/cordis'

/** Loader entry name. */
export const name = 'aevora-control'

/** This service owns no runtime capability. */
export const inject: readonly string[] = []

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Marker service for the Aevora Plugins page control surface. */
    aevoraControl: AevoraControlService
  }
}

/** Keeps the Aevora control tab mounted while the Aevora Profile is active. */
export class AevoraControlService extends Service {
  static inject = inject

  /**
   * @param ctx - Host context that owns the Profile and Loader.
   */
  constructor(ctx: Context) {
    super(ctx, 'aevoraControl')
  }
}

export default AevoraControlService
