/** Build the public source distribution using the original package compilers and bundlers. */
import { spawnSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'
import {
  CLIENT_BUILD_RECORD_PATH, clientBuildProcessEnvironment, repositoryClientBuildEnvironment,
  resolveClientBuildEnvironment, writeClientBuildRecord,
} from './client-build-environment.ts'
import { libraryBuildSteps } from './compile-referenced-projects.ts'
import { pnpmCommand } from './release/process.ts'

const root = resolve(import.meta.dirname, '..')
const environment = clientBuildProcessEnvironment(process.env,
  resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), undefined))
const [command, ...prefix] = pnpmCommand()
const steps = [
  { label: 'Native addon', command, args: [...prefix, 'run', 'build:native-system'] },
  ...libraryBuildSteps(root, 'all').map(step => ({ label: step.label, command: step.command, args: step.args })),
  { label: 'Web application', command, args: [...prefix, 'run', 'build:web'] },
]
rmSync(resolve(root, CLIENT_BUILD_RECORD_PATH), { force: true })
for (const step of steps) {
  console.log('Building: ' + step.label)
  const result = spawnSync(step.command, step.args, { cwd: root, env: environment, stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) throw new Error(step.label + ' failed: ' + String(result.status ?? result.signal))
}
const record = writeClientBuildRecord(root, resolveClientBuildEnvironment(repositoryClientBuildEnvironment(root), undefined))
console.log('Build complete: ' + String(record.artifacts.fileCount) + ' client artifacts')
