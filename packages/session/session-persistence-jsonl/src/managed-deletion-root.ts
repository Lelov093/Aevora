/** Local root admission for the opt-in Session deletion composition. */
import { lstat, mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { isAbsolute, join, relative, resolve } from 'node:path'
import { SessionId } from '@deepseek-ai/dsh-session'
import { LEASE_FILENAME, SessionWriteLease } from './lease.ts'

const markerName = '.dsh-managed-session-root'
const markerVersion = 'session-deletion-root-v1\n'
const rootLeaseId = SessionId('managed-session-deletion-root')

/** Management lease held for the lifetime of one dedicated, opt-in storage root. */
export interface ManagedDeletionRoot {
  readonly path: string
  /** Close the cross-process root lease after Session services have stopped. */
  release(): Promise<void>
}

/**
 * Enroll or reopen a dedicated local directory for deletion-enabled Host storage.
 * An existing populated directory without the marker requires separate migration.
 * @param requestedRoot - configured absolute dedicated path.
 * @returns a validated path and its held root-management lease.
 */
export async function openManagedDeletionRoot(requestedRoot: string): Promise<ManagedDeletionRoot> {
  if (!isAbsolute(requestedRoot) || requestedRoot.startsWith('\\\\') || requestedRoot.startsWith('//')) {
    throw new Error('Managed Session deletion requires an absolute local storage root')
  }
  const root = resolve(requestedRoot)
  await mkdir(root, { recursive: true, mode: 0o700 })
  if (relative(root, await realpath(root)) !== '' || !(await lstat(root)).isDirectory()) {
    throw new Error('Managed Session deletion requires the canonical storage root directory')
  }
  const lease = await SessionWriteLease.acquire(root, rootLeaseId, 'root')
  try {
    const marker = await readMarker(root)
    if (marker === undefined) {
      const entries = await readdir(root)
      if (entries.some(name => name !== LEASE_FILENAME)) {
        throw new Error('Managed Session deletion requires a dedicated empty root for initial enrollment')
      }
      await writeFile(join(root, markerName), markerVersion, { flag: 'wx', mode: 0o600, flush: true })
    } else if (marker !== markerVersion) {
      throw new Error('Unsupported managed Session root marker version')
    }
  } catch (error: unknown) {
    await lease.release()
    throw error
  }
  return { path: root, release: () => lease.release() }
}

/**
 * Refuse ordinary JSONL startup on a dedicated deletion-managed root.
 * @param root - configured ordinary Session root.
 */
export async function assertUnmanagedSessionRoot(root: string): Promise<void> {
  if (await readMarker(resolve(root)) !== undefined) {
    throw new Error('The Session root requires the managed deletion composition')
  }
}

async function readMarker(root: string): Promise<string | undefined> {
  const marker = join(root, markerName)
  try {
    const status = await lstat(marker)
    if (!status.isFile() || status.nlink !== 1 || status.size !== markerVersion.length) {
      throw new Error('Invalid managed Session root marker')
    }
    return await readFile(marker, 'utf8')
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
