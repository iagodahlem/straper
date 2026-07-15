import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import { dirname, join, relative, resolve, sep } from 'node:path'

import { REGISTRY_DIR } from '../constants.js'

export interface ModuleManifest {
  name: string
  type: string
  version: string
  deps?: string[]
  config_keys?: string[]
  source_commit?: string
  published_at?: string
  description?: string
}

export interface LockFileRef {
  path: string
  sha256: string
}

export interface LockModuleEntry {
  version: string
  source_commit: string
  type: string
  files: LockFileRef[]
}

export interface LockFile {
  lockfileVersion: number
  modules: Record<string, LockModuleEntry>
}

export const LOCKFILE_NAME = 'straper.lock'
export const LOCKFILE_VERSION = 1
export const REGISTRY_METADATA_FILES = new Set(['module.json', 'CHANGELOG.md', 'SKILL.md'])
export const BASE_STORE_DIR = join('.straper', 'base')

/**
 * Resolve the registry directory.
 * Priority: --registry flag > STRAPER_REGISTRY_DIR env > bundled registry/.
 */
export function resolveRegistryRoot(opts: { registry?: string }): string {
  if (opts.registry) return resolve(opts.registry)
  const envDir = process.env.STRAPER_REGISTRY_DIR
  if (envDir) return resolve(envDir)
  // Remote/GitHub registry fetch lands here once the repo is public; until then resolve the bundled registry.
  return REGISTRY_DIR
}

export function baseDirFor(workspaceDir: string, name: string): string {
  return join(workspaceDir, BASE_STORE_DIR, name)
}

export function pointerPathFor(workspaceDir: string, name: string): string {
  return join(workspaceDir, '.claude', 'skills', name, 'SKILL.md')
}

/** Universal cross-agent pointer read natively by Cursor/Codex/Amp and Vercel's installer. */
export function agentsPointerPathFor(workspaceDir: string, name: string): string {
  return join(workspaceDir, '.agents', 'skills', name, 'SKILL.md')
}

/** The .agents/skills pointer is on by default; --no-agents-dir or STRAPER_NO_AGENTS_DIR=1 opts out. */
export function agentsDirEnabled(disable?: boolean): boolean {
  if (disable) return false
  return process.env.STRAPER_NO_AGENTS_DIR !== '1'
}

/**
 * Consumer-pointer paths a command should manage for a module: always the
 * Claude pointer, plus the universal .agents pointer unless opted out. Pointer
 * bytes are identical across targets (path-independent), so callers reuse one
 * canonical buffer and one comparison per module.
 */
export function pointerTargets(
  workspaceDir: string,
  name: string,
  opts: { agentsDir: boolean },
): string[] {
  const targets = [pointerPathFor(workspaceDir, name)]
  if (opts.agentsDir) targets.push(agentsPointerPathFor(workspaceDir, name))
  return targets
}

export function buildPointerContent(name: string, description: string): string {
  return `---
name: ${name}
description: ${description}
---

Vendored skill. Read and follow \`skills/${name}/${name}.md\` for the full definition and workflow.
`
}

/**
 * Collect every file under a directory as a map of POSIX-relative path -> bytes.
 * With skipRootMeta, registry metadata files (module.json, CHANGELOG.md) at the
 * directory root are excluded.
 */
export async function collectDirFiles(
  root: string,
  opts: { skipRootMeta?: boolean } = {},
): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>()

  async function walk(dir: string, prefix: string, atRoot: boolean): Promise<void> {
    let entries
    try {
      entries = await readdir(dir, { withFileTypes: true })
    } catch (err: unknown) {
      if (isNodeError(err) && err.code === 'ENOENT') return
      throw err
    }
    for (const entry of entries) {
      if (atRoot && opts.skipRootMeta && REGISTRY_METADATA_FILES.has(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full, rel, false)
      } else {
        files.set(rel, await readFile(full))
      }
    }
  }

  await walk(root, '', true)
  return files
}

/**
 * Write a map of POSIX-relative path -> bytes under destDir, returning a lock ref
 * (workspace-relative path + sha256) per written file.
 */
export async function writeFiles(
  destDir: string,
  workspaceDir: string,
  contents: Map<string, Buffer>,
): Promise<LockFileRef[]> {
  const refs: LockFileRef[] = []
  for (const rel of [...contents.keys()].sort()) {
    const bytes = contents.get(rel) as Buffer
    const destPath = join(destDir, ...rel.split('/'))
    await mkdir(dirname(destPath), { recursive: true })
    await writeFile(destPath, bytes)
    refs.push({ path: toPosix(relative(workspaceDir, destPath)), sha256: sha256(bytes) })
  }
  return refs
}

export async function readLock(workspaceDir: string): Promise<LockFile> {
  try {
    const raw = await readFile(join(workspaceDir, LOCKFILE_NAME), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<LockFile>
    return {
      lockfileVersion: parsed.lockfileVersion ?? LOCKFILE_VERSION,
      modules: parsed.modules ?? {},
    }
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return { lockfileVersion: LOCKFILE_VERSION, modules: {} }
    }
    throw err
  }
}

export async function writeLock(workspaceDir: string, lock: LockFile): Promise<void> {
  const sorted: LockFile = { lockfileVersion: lock.lockfileVersion, modules: {} }
  for (const key of Object.keys(lock.modules).sort()) {
    const entry = lock.modules[key]
    // Reconstruct explicitly so any legacy field (e.g. installed_at) is dropped.
    sorted.modules[key] = {
      version: entry.version,
      source_commit: entry.source_commit,
      type: entry.type,
      files: [...entry.files].sort((a, b) => a.path.localeCompare(b.path)),
    }
  }
  await writeFile(join(workspaceDir, LOCKFILE_NAME), JSON.stringify(sorted, null, 2) + '\n', 'utf-8')
}

export async function readManifest(registryRoot: string, name: string): Promise<ModuleManifest> {
  const manifestPath = join(registryRoot, name, 'module.json')
  let raw: string
  try {
    raw = await readFile(manifestPath, 'utf-8')
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      error(
        `Module "${name}" not found in registry at ${registryRoot}. Expected ${join(name, 'module.json')}.`,
      )
    }
    throw err
  }
  return JSON.parse(raw) as ModuleManifest
}

/**
 * Description precedence: skill main .md frontmatter > module.json > placeholder.
 */
export async function deriveDescription(
  skillDir: string,
  name: string,
  manifest: ModuleManifest,
): Promise<string> {
  const mainMd = join(skillDir, `${name}.md`)
  try {
    const md = await readFile(mainMd, 'utf-8')
    const fm = parseFrontmatter(md)
    if (fm.description) return fm.description
  } catch {
    // No main .md or unreadable — fall through to manifest/placeholder.
  }
  if (manifest.description) return manifest.description
  return `${name} skill (vendored from the registry)`
}

/**
 * Spec description for a module's SKILL.md: main .md frontmatter description,
 * then the manifest description. Undefined when neither exists — the Agent
 * Skills spec requires a description, so callers must fail rather than guess.
 */
export function skillDescriptionFor(mainMd: string, manifestDescription?: string): string | undefined {
  const fm = parseFrontmatter(mainMd)
  if (fm.description) return fm.description
  if (manifestDescription) return manifestDescription
  return undefined
}

/**
 * Build spec-compliant SKILL.md bytes from a module's main .md: same body,
 * frontmatter guaranteed to carry `name: <module>` and a description. Existing
 * frontmatter passes through with name normalized and description injected if
 * absent; a module with no frontmatter gets a minimal spec block prepended.
 */
export function buildSkillMdContent(name: string, mainMd: string, description: string): string {
  const lines = mainMd.split('\n')
  let end = -1
  if (lines[0]?.trim() === '---') {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') {
        end = i
        break
      }
    }
  }
  if (end === -1) {
    return `---\nname: ${name}\ndescription: ${description}\n---\n\n${mainMd.replace(/^\n+/, '')}`
  }
  const body = lines.slice(end + 1).join('\n')
  let sawName = false
  let sawDescription = false
  const kept = lines.slice(1, end).map((line) => {
    const key = /^([A-Za-z0-9_-]+):/.exec(line)?.[1]
    if (key === 'name') {
      sawName = true
      return `name: ${name}`
    }
    if (key === 'description') sawDescription = true
    return line
  })
  const head: string[] = []
  if (!sawName) head.push(`name: ${name}`)
  if (!sawDescription) head.push(`description: ${description}`)
  return `---\n${[...head, ...kept].join('\n')}\n---\n${body}`
}

/**
 * Canonical consumer-pointer bytes for a module, deriving the description from
 * the skill/base bytes under sourceDir. This is the pointer `add` would emit.
 */
export async function canonicalPointerBytes(
  sourceDir: string,
  name: string,
  manifest: ModuleManifest,
): Promise<Buffer> {
  const description = await deriveDescription(sourceDir, name, manifest)
  return Buffer.from(buildPointerContent(name, description), 'utf-8')
}

export function parseFrontmatter(md: string): Record<string, string> {
  const lines = md.split('\n')
  if (lines[0]?.trim() !== '---') return {}
  const result: Record<string, string> = {}
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') break
    const match = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(lines[i])
    if (!match) continue
    let value = match[2].trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    result[match[1]] = value
  }
  return result
}

export function sha256(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex')
}

export function toPosix(p: string): string {
  return sep === '/' ? p : p.split(sep).join('/')
}

export function dedupe(names: string[]): string[] {
  return [...new Set(names)]
}

export function error(message: string): never {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

export function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}
