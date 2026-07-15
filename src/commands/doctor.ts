import { readFile, readdir, stat } from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  type LockModuleEntry,
  LOCKFILE_VERSION,
  baseDirFor,
  pointerPathFor,
  readLock,
  sha256,
} from './registry-shared.js'

export interface DoctorArgs {
  dir?: string
}

type Severity = 'ok' | 'info' | 'problem'

interface ModuleReport {
  name: string
  severity: Severity
  lines: string[]
}

/**
 * Read-only health check of vendored modules. Exit non-zero iff there are
 * problems beyond purely local modifications.
 */
export async function doctor(args: DoctorArgs): Promise<void> {
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const lock = await readLock(workspaceDir)
  const names = Object.keys(lock.modules).sort()

  console.log('')
  console.log('straper doctor')
  console.log('')

  let problems = 0

  if (lock.lockfileVersion !== LOCKFILE_VERSION) {
    console.log(
      `  ! unknown lockfileVersion ${lock.lockfileVersion} (expected ${LOCKFILE_VERSION})`,
    )
    problems += 1
  }

  if (names.length === 0) {
    console.log('  no modules in straper.lock')
  }

  for (const name of names) {
    const report = await checkModule(workspaceDir, name, lock.modules[name])
    printReport(report)
    if (report.severity === 'problem') problems += 1
  }

  const orphans = await findOrphans(workspaceDir, new Set(names))
  for (const orphan of orphans) {
    console.log(`  ? ${orphan} unmanaged (not in straper.lock)`)
  }

  console.log('')
  if (problems > 0) {
    console.log(`${problems} problem(s) found.`)
    process.exit(1)
  }
  console.log('All vendored modules healthy.')
  console.log('')
}

async function checkModule(
  workspaceDir: string,
  name: string,
  entry: LockModuleEntry,
): Promise<ModuleReport> {
  const lines: string[] = []
  let severity: Severity = 'ok'
  const escalate = (next: Severity): void => {
    if (next === 'problem' || (next === 'info' && severity === 'ok')) severity = next
  }

  for (const ref of entry.files) {
    const filePath = join(workspaceDir, ...ref.path.split('/'))
    const content = await readFileMaybe(filePath)
    if (content === undefined) {
      lines.push(`missing file: ${ref.path}`)
      escalate('problem')
      continue
    }
    if (hasConflictMarkers(content)) {
      lines.push(`unresolved conflict markers: ${ref.path}`)
      escalate('problem')
      continue
    }
    if (sha256(content) !== ref.sha256) {
      lines.push(`locally modified: ${ref.path}`)
      escalate('info')
    }
  }

  if (await readFileMaybe(pointerPathFor(workspaceDir, name)) === undefined) {
    lines.push(`pointer SKILL.md missing: .claude/skills/${name}/SKILL.md`)
    escalate('problem')
  }

  if (!(await dirExists(baseDirFor(workspaceDir, name)))) {
    lines.push(`base store missing: .straper/base/${name}`)
    escalate('problem')
  }

  return { name, severity, lines }
}

function printReport(report: ModuleReport): void {
  const marker = report.severity === 'problem' ? '✗' : report.severity === 'info' ? '~' : '✓'
  if (report.lines.length === 0) {
    console.log(`  ${marker} ${report.name}  ok`)
    return
  }
  console.log(`  ${marker} ${report.name}`)
  for (const line of report.lines) console.log(`      ${line}`)
}

async function findOrphans(workspaceDir: string, tracked: Set<string>): Promise<string[]> {
  const skillsDir = join(workspaceDir, 'skills')
  let entries
  try {
    entries = await readdir(skillsDir, { withFileTypes: true })
  } catch {
    return []
  }
  const orphans: string[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    if (entry.name.startsWith('.')) continue
    if (!tracked.has(entry.name)) orphans.push(entry.name)
  }
  return orphans.sort()
}

function hasConflictMarkers(content: Buffer): boolean {
  const text = content.toString('utf-8')
  return /^<{7}(?: |$)/m.test(text) && /^>{7}(?: |$)/m.test(text) && /^={7}$/m.test(text)
}

async function readFileMaybe(path: string): Promise<Buffer | undefined> {
  try {
    return await readFile(path)
  } catch {
    return undefined
  }
}

async function dirExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}
