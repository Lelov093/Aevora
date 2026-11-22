/** Scoped directory ownership for artifacts created by a managed Session composition. */
import { createHash } from 'node:crypto'
import { lstat, mkdir, realpath, rm } from 'node:fs/promises'
import { isAbsolute, join, relative } from 'node:path'
import type { SessionId } from '@deepseek-ai/dsh-session'

/** An artifact owner cleans and verifies only its own configured storage. */
export interface SessionDeletionArtifactOwner {
  removeDeletedSessions(ids: readonly SessionId[]): Promise<void>
  verifyDeletedSessions(ids: readonly SessionId[]): Promise<void>
}

/** Dedicate a separately configured artifact root to Session-scoped files. */
export class SessionArtifactRoot {
  /**
   * @param root - dedicated absolute directory for this owner's managed artifacts.
   */
  constructor(private readonly root: string) {
    if (!isAbsolute(root)) throw new Error('Managed Session artifacts require an absolute directory')
  }

  /**
   * Create a directory for this Session's artifacts.
   * @param id - owning Session identity.
   * @returns the checked private directory.
   */
  async prepare(id: SessionId): Promise<string> {
    const path = this.directory(id)
    await mkdir(path, { recursive: true, mode: 0o700 })
    await this.requireCanonicalDirectory(path)
    return path
  }

  /**
   * Remove artifacts below the deterministic Session directory.
   * @param ids - verified deletion members.
   */
  async remove(ids: readonly SessionId[]): Promise<void> {
    for (const id of ids) {
      const path = this.directory(id)
      if (!await this.exists(path)) continue
      await this.requireCanonicalDirectory(path)
      await rm(path, { recursive: true, force: true })
    }
  }

  /**
   * Check the scoped physical directories after removal.
   * @param ids - verified deletion members.
   */
  async verify(ids: readonly SessionId[]): Promise<void> {
    for (const id of ids) {
      if (await this.exists(this.directory(id))) throw new Error('Managed Session artifacts still remain')
    }
  }

  private directory(id: SessionId): string {
    return join(this.root, createHash('sha256').update(id).digest('hex'))
  }

  private async requireCanonicalDirectory(path: string): Promise<void> {
    const status = await lstat(path)
    if (!status.isDirectory() || relative(path, await realpath(path)) !== '') {
      throw new Error('Managed Session artifact directory has an unexpected identity')
    }
  }

  private async exists(path: string): Promise<boolean> {
    try {
      await lstat(path)
      return true
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
      throw error
    }
  }
}
