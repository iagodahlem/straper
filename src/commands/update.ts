import { execFileSync } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'

import { replaceModuleHooks } from './hooks-install.js'
import {
  type LockFile,
  type LockFileRef,
  type LockModuleEntry,
  type ModuleManifest,
  agentsDirEnabled,
  baseDirFor,
  canonicalPointerBytes,
  collectDirFiles,
  dedupe,
  pointerTargets,
  readLock,
  readManifest,
  resolveRegistryRoot,
  sha256,
  toPosix,
  writeFiles,
  writeLock,
} from './registry-shared.js'

export interface UpdateArgs {
  modules: string[]
  dir?: string
  registry?: string
}

interface UpdateOutcome {
  conflicts: string[]
  hadError: boolean
}

/**
 * Update vendored modules to the current registry version via a 3-way merge
 * that preserves local edits. No args = every module in the lockfile.
 */
export async function update(args: UpdateArgs): Promise<void> {
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const registryRoot = resolveRegistryRoot({ registry: args.registry })
  const lock = await readLock(workspaceDir)

  const targets = args.modules.length ? dedupe(args.modules) : Object.keys(lock.modules).sort()
  if (targets.length === 0) {
    console.log('No modules installed. Nothing to update.')
    return
  }

  const outcome: UpdateOutcome = { conflicts: [], hadError: false }

  for (const name of targets) {
    await updateModule(name, { workspaceDir, registryRoot, lock }, outcome)
  }

  await writeLock(workspaceDir, lock)

  if (outcome.conflicts.length > 0) {
    console.log('')
    console.log(`Conflicts in ${outcome.conflicts.length} file(s) — resolve the markers, then commit:`)
    for (const path of outcome.conflicts) console.log(`  ${path}`)
  }

  if (outcome.conflicts.length > 0 || outcome.hadError) {
    process.exit(1)
  }
}

interface UpdateContext {
  workspaceDir: string
  registryRoot: string
  lock: LockFile
}

async function updateModule(
  name: string,
  ctx: UpdateContext,
  outcome: UpdateOutcome,
): Promise<void> {
  const entry = ctx.lock.modules[name]
  if (!entry) {
    process.stderr.write(`Error: "${name}" is not installed. Run \`straper add ${name}\` first.\n`)
    outcome.hadError = true
    return
  }

  let manifest
  try {
    manifest = await readManifest(ctx.registryRoot, name)
  } catch {
    process.stderr.write(
      `Error: "${name}" is in the lockfile but missing from the registry. Skipping.\n`,
    )
    outcome.hadError = true
    return
  }

  const skillDir = join(ctx.workspaceDir, 'skills', name)
  const baseDir = baseDirFor(ctx.workspaceDir, name)
  const registryFiles = await collectDirFiles(join(ctx.registryRoot, name), { skipRootMeta: true })
  const baseFiles = await collectDirFiles(baseDir)
  const baseMissing = !(await dirExists(baseDir))

  if (manifest.version === entry.version && mapsEqual(registryFiles, baseFiles)) {
    console.log(`${name} is up to date (v${entry.version})`)
    return
  }

  // Without a base store a safe 3-way merge is impossible: any working file that
  // differs from the new registry bytes may hold local edits we cannot merge.
  if (baseMissing) {
    const workingFiles = await collectDirFiles(skillDir)
    const dirty = [...workingFiles.keys()].some((rel) => {
      const reg = registryFiles.get(rel)
      return !reg || !buffersEqual(workingFiles.get(rel) as Buffer, reg)
    })
    if (dirty) {
      process.stderr.write(
        `Error: "${name}" has no base store (.straper/base/${name}) and its working files differ from the registry. ` +
          `Cannot merge safely — reconcile skills/${name}/ manually, then re-run \`straper add ${name}\`. Skipping.\n`,
      )
      outcome.hadError = true
      return
    }
  }

  // Canonical pointer for the currently-installed version, from the pre-refresh
  // base store bytes — the yardstick for detecting a customized pointer below.
  const installedCanonicalPointer = await canonicalPointerBytes(baseDir, name, manifest)

  const conflicts = await mergeWorkingTree({
    skillDir,
    workspaceDir: ctx.workspaceDir,
    name,
    registryFiles,
    baseFiles,
  })
  outcome.conflicts.push(...conflicts)

  // Base store and lock hashes always track the freshly published bytes.
  await rm(baseDir, { recursive: true, force: true })
  await writeFiles(baseDir, ctx.workspaceDir, registryFiles)
  const skillRefs: LockFileRef[] = [...registryFiles.keys()].sort().map((rel) => {
    const destPath = join(skillDir, ...rel.split('/'))
    return {
      path: toPosix(relative(ctx.workspaceDir, destPath)),
      sha256: sha256(registryFiles.get(rel) as Buffer),
    }
  })

  const pointerRefs: LockFileRef[] = []
  for (const pointerPath of pointerTargets(ctx.workspaceDir, name, { agentsDir: agentsDirEnabled() })) {
    pointerRefs.push(
      await emitPointer(ctx.workspaceDir, skillDir, pointerPath, name, manifest, installedCanonicalPointer),
    )
  }
  const files = [...skillRefs, ...pointerRefs].sort((a, b) => a.path.localeCompare(b.path))

  // Re-wire module-contributed hooks: strip the previously-installed entries
  // (from the lock) and splice the new version's hooks.json declarations.
  const hooks = await replaceModuleHooks(ctx.workspaceDir, skillDir, name, entry.hooks ?? [])

  ctx.lock.modules[name] = {
    version: manifest.version,
    source_commit: manifest.source_commit ?? '',
    type: manifest.type,
    files,
    ...(hooks.length > 0 ? { hooks } : {}),
  } satisfies LockModuleEntry

  const label = conflicts.length > 0 ? ` (${conflicts.length} conflict(s))` : ''
  console.log(`updated ${name} ${entry.version} -> ${manifest.version}${label}`)
}

interface MergeInput {
  skillDir: string
  workspaceDir: string
  name: string
  registryFiles: Map<string, Buffer>
  baseFiles: Map<string, Buffer>
}

/**
 * Reconcile the working tree under skills/<name>/ with the new registry bytes,
 * writing conflict markers where local and registry both changed. Returns the
 * workspace-relative paths of any conflicted files.
 */
async function mergeWorkingTree(input: MergeInput): Promise<string[]> {
  const { skillDir, workspaceDir, registryFiles, baseFiles } = input
  const conflicts: string[] = []
  const relPaths = new Set([...registryFiles.keys(), ...baseFiles.keys()])

  for (const rel of relPaths) {
    const destPath = join(skillDir, ...rel.split('/'))
    const reg = registryFiles.get(rel)
    const base = baseFiles.get(rel)
    const working = await readFileMaybe(destPath)

    if (reg && base) {
      if (buffersEqual(reg, base)) {
        if (!working) await writeFileAt(destPath, reg)
        continue
      }
      if (!working || buffersEqual(working, base) || buffersEqual(working, reg)) {
        await writeFileAt(destPath, reg)
        continue
      }
      const { merged, conflicted } = threeWayMerge(base, working, reg)
      await writeFileAt(destPath, merged)
      if (conflicted) conflicts.push(toPosix(relative(workspaceDir, destPath)))
    } else if (reg && !base) {
      if (!working || buffersEqual(working, reg)) {
        await writeFileAt(destPath, reg)
        continue
      }
      // File freshly added upstream colliding with a local same-named file.
      const { merged, conflicted } = threeWayMerge(Buffer.alloc(0), working, reg)
      await writeFileAt(destPath, merged)
      if (conflicted) conflicts.push(toPosix(relative(workspaceDir, destPath)))
    } else if (!reg && base && working) {
      if (buffersEqual(working, base)) {
        await rm(destPath, { force: true })
      } else {
        console.log(
          `kept locally-edited file removed upstream: ${toPosix(relative(workspaceDir, destPath))}`,
        )
      }
    }
  }

  return conflicts
}

/**
 * Refresh the consumer pointer for the new version, but preserve a pointer the
 * workspace has customized (differs from the installed canonical): leave it on
 * disk and record its actual bytes so `doctor` stays clean.
 */
async function emitPointer(
  workspaceDir: string,
  skillDir: string,
  pointerPath: string,
  name: string,
  manifest: ModuleManifest,
  installedCanonicalPointer: Buffer,
): Promise<LockFileRef> {
  const ref = (bytes: Buffer): LockFileRef => ({
    path: toPosix(relative(workspaceDir, pointerPath)),
    sha256: sha256(bytes),
  })

  const existing = await readFileMaybe(pointerPath)
  if (existing && !buffersEqual(existing, installedCanonicalPointer)) {
    console.log(`kept customized pointer: ${toPosix(relative(workspaceDir, pointerPath))}`)
    return ref(existing)
  }

  const bytes = await canonicalPointerBytes(skillDir, name, manifest)
  await mkdir(dirname(pointerPath), { recursive: true })
  await writeFile(pointerPath, bytes)
  return ref(bytes)
}

function threeWayMerge(
  base: Buffer,
  ours: Buffer,
  theirs: Buffer,
): { merged: Buffer; conflicted: boolean } {
  const dir = mkdtempSync(join(tmpdir(), 'straper-merge-'))
  try {
    const ourPath = join(dir, 'ours')
    const basePath = join(dir, 'base')
    const theirPath = join(dir, 'theirs')
    writeFileSync(ourPath, ours)
    writeFileSync(basePath, base)
    writeFileSync(theirPath, theirs)
    try {
      const merged = execFileSync(
        'git',
        ['merge-file', '-p', '-L', 'local', '-L', 'base', '-L', 'registry', ourPath, basePath, theirPath],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      return { merged, conflicted: false }
    } catch (err: unknown) {
      if (isMergeConflict(err)) {
        return { merged: err.stdout, conflicted: true }
      }
      throw err
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

function isMergeConflict(err: unknown): err is { status: number; stdout: Buffer } {
  return (
    err instanceof Error &&
    'status' in err &&
    typeof (err as { status?: unknown }).status === 'number' &&
    (err as { status: number }).status > 0 &&
    Buffer.isBuffer((err as { stdout?: unknown }).stdout)
  )
}

async function writeFileAt(destPath: string, bytes: Buffer): Promise<void> {
  await mkdir(dirname(destPath), { recursive: true })
  await writeFile(destPath, bytes)
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

function buffersEqual(a: Buffer, b: Buffer): boolean {
  return a.length === b.length && a.equals(b)
}

function mapsEqual(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  if (a.size !== b.size) return false
  for (const [key, value] of a) {
    const other = b.get(key)
    if (!other || !buffersEqual(value, other)) return false
  }
  return true
}
