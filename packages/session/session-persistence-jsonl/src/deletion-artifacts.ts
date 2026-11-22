/** Identifies Session-owned JSONL files and verifies their removal under a write lease. */
import { lstat, readdir, realpath, unlink } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type { SessionHeader } from '@deepseek-ai/dsh-session'
import { z } from 'zod'
import { parseGenerationLogFilename, sessionDir } from './format.ts'
import { LEASE_FILENAME, type SessionWriteLease } from './lease.ts'

/** Durable inventory of recognized files within an identity-checked Session directory. */
export interface SessionLogRemoval {
  readonly directoryIdentity: string
  readonly files: readonly { readonly name: string; readonly identity: string }[]
}

/** Validates the artifact inventory when recovery reads it from the journal. */
export const storedSessionLogRemoval = z.strictObject({
  cwd: z.string().optional(),
  directoryIdentity: z.string().min(1),
  files: z.array(z.strictObject({ name: z.string().min(1), identity: z.string().min(1) })),
})

/**
 * Inventory all generations and known materialization or migration temporary files.
 * @param root - verified canonical managed root.
 * @param header - backend-verified Session header.
 * @param lease - held writer lease for that directory.
 * @returns identity of each verified artifact, excluding the held lock.
 */
export async function inspectSessionLogRemoval(
  root: string, header: Pick<SessionHeader, 'id' | 'cwd'>, lease: SessionWriteLease,
): Promise<SessionLogRemoval> {
  const directory = await requireDirectory(root, header, lease)
  return {
    directoryIdentity: directory.identity,
    files: await enumerateFiles(directory.path),
  }
}

/**
 * Delete the verified files, allowing the same inventory to resume after a partial removal.
 * @param root - verified canonical managed root.
 * @param header - recorded Session identity from the persistence backend.
 * @param lease - held writer lease for the directory.
 * @param plan - the accepted inventory.
 */
export async function purgeSessionLogRemoval(
  root: string, header: Pick<SessionHeader, 'id' | 'cwd'>, lease: SessionWriteLease, plan: SessionLogRemoval,
): Promise<void> {
  const directory = await requireDirectory(root, header, lease)
  if (directory.identity !== plan.directoryIdentity) throw new Error('Session deletion directory identity changed')
  const actual = await enumerateFiles(directory.path)
  const expected = new Map(plan.files.map(file => [file.name, file.identity]))
  for (const file of actual) {
    if (expected.get(file.name) !== file.identity) throw new Error('Session deletion artifact identity changed')
  }
  for (const file of actual) await unlink(join(directory.path, file.name))
  if ((await enumerateFiles(directory.path)).length !== 0) throw new Error('Session deletion log removal could not be verified')
}

async function requireDirectory(root: string, header: Pick<SessionHeader, 'id' | 'cwd'>, lease: SessionWriteLease) {
  const path = sessionDir(root, header.cwd, header.id)
  if (!lease.covers(path) || relative(path, await realpath(path)) !== '') {
    throw new Error('Session deletion requires the writer lease of the canonical artifact directory')
  }
  const stats = await lstat(path, { bigint: true })
  if (!stats.isDirectory()) throw new Error('Session deletion artifact directory is unavailable')
  return { path, identity: `${stats.dev}:${stats.ino}` }
}

async function enumerateFiles(directory: string): Promise<SessionLogRemoval['files']> {
  const names = (await readdir(directory)).sort()
  const files: Array<SessionLogRemoval['files'][number]> = []
  for (const name of names) {
    if (name === LEASE_FILENAME) continue
    if (!isOwnedLogFilename(name)) throw new Error('Unknown artifact in the Session deletion directory')
    const stat = await lstat(join(directory, name), { bigint: true })
    if (!stat.isFile() || stat.nlink !== 1n) throw new Error('Session deletion artifact is not an exclusively owned regular file')
    files.push({ name, identity: `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}` })
  }
  return files
}

function isOwnedLogFilename(name: string): boolean {
  const generation = name.replace(/\.[a-f\d]{12}\.tmp$/u, '')
  return parseGenerationLogFilename(generation, 'none') !== undefined
    || parseGenerationLogFilename(generation, 'zstd') !== undefined
    || /^session\.migration\.[a-f\d]+\.jsonl(?:\.zstd)?\.tmp$/u.test(name)
}
