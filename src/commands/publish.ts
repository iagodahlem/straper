import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path'

import { RUNTIME_BASELINE_V1 } from '../baseline.js'
import {
  buildSkillMdContent,
  error as exitWithError,
  skillDescriptionFor,
  toPosix,
} from './registry-shared.js'

export interface PublishArgs {
  module: string
  dir?: string
  registryRepo?: string
}

export interface PublishResult {
  module: string
  version: string
  deps: string[]
  registryRepo: string
  branch: string
  worktreePath: string
  commit: string
  sourceCommit: string
  contentHash: string
}

interface GitResult {
  status: number
  stdout: string
  stderr: string
}

const EXCLUDED_DIRS = new Set(['state', 'logs', 'node_modules', '.git'])
const JS_EXT = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx'])
const SH_EXT = new Set(['.sh', '.bash'])

/** Pipeline failure. Thrown (not process.exit) so finally-block temp cleanup runs first. */
class PublishError extends Error {}

function fail(message: string): never {
  throw new PublishError(message)
}

function git(cwd: string, args: string[]): GitResult {
  const res = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf-8' })
  return { status: res.status ?? 1, stdout: res.stdout ?? '', stderr: res.stderr ?? '' }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Publish a workspace skill (skills/<module>/) into a straper registry checkout.
 * Privilege is environmental: refuses unless the workspace has both a gate
 * engine (skills/scrub/scrub.sh) and gate config (config/publish-gate.conf).
 */
export async function publish(args: PublishArgs): Promise<PublishResult> {
  try {
    return await publishPipeline(args)
  } catch (err) {
    // Cleanup (finally blocks) has already run; only now convert to exit(1).
    if (err instanceof PublishError) exitWithError(err.message)
    throw err
  }
}

async function publishPipeline(args: PublishArgs): Promise<PublishResult> {
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const registryRepo = resolveRegistryRepo(args.registryRepo)
  const module = args.module

  const scrubPath = join(workspaceDir, 'skills', 'scrub', 'scrub.sh')
  const gateConfig = join(workspaceDir, 'config', 'publish-gate.conf')
  if (!(await pathExists(scrubPath))) {
    fail(
      `Publishing requires a gate engine at skills/scrub/scrub.sh in the workspace (${workspaceDir}). This workspace has none, so it cannot publish.`,
    )
  }
  if (!(await pathExists(gateConfig))) {
    fail(
      `Publishing requires gate config at config/publish-gate.conf in the workspace (${workspaceDir}). This workspace has none, so it cannot publish.`,
    )
  }

  const moduleDir = join(workspaceDir, 'skills', module)
  if (!(await pathExists(join(moduleDir, `${module}.md`)))) {
    fail(`Module not found: skills/${module}/${module}.md (expected under ${workspaceDir}).`)
  }

  // Publish exactly what HEAD tracks: gate, deps scan, copy, and content hash all
  // run over the staged HEAD payload so source_commit and the ledger hash agree.
  const sourceCommit = await workspaceHead(workspaceDir)
  let stagingDir: string | undefined
  let createdWorktree: { path: string; base: string; branch: string } | undefined
  let published = false
  try {
    let sourceDir = moduleDir
    if (sourceCommit) {
      stagingDir = await stageModuleFromHead(workspaceDir, module)
      sourceDir = stagingDir
      if (!(await pathExists(join(sourceDir, `${module}.md`)))) {
        fail(
          `skills/${module}/${module}.md is not committed at HEAD — commit the module before publishing.`,
        )
      }
      const dirty = git(workspaceDir, [
        'status',
        '--porcelain',
        '--',
        `skills/${module}`,
      ]).stdout.trim()
      if (dirty) {
        console.warn(
          `Warning: skills/${module} has uncommitted changes — publishing the content committed at HEAD; uncommitted changes are NOT being published.`,
        )
      }
    }

    // Name-based exclusions only matter in the non-git fallback; the staged
    // set is already exactly HEAD's tracked files.
    const relFiles = await collectModuleFiles(sourceDir, sourceCommit === '')
    if (relFiles.length === 0) {
      fail(`No files found under skills/${module} — nothing to publish.`)
    }

    runGate(module, workspaceDir, scrubPath, sourceDir, relFiles)

    const mainMd = await readFile(join(sourceDir, `${module}.md`), 'utf-8')
    const declaredDeps = parseDependsOn(mainMd)
    const deps = await captureDeps(
      module,
      workspaceDir,
      moduleDir,
      sourceDir,
      relFiles,
      declaredDeps,
    )

    if (!(await pathExists(join(registryRepo, '.git')))) {
      fail(`Registry repo is not a git repository: ${registryRepo}.`)
    }

    const existing = git(registryRepo, ['show', `HEAD:registry/${module}/module.json`])
    const version =
      existing.status === 0 ? bumpPatch(parseVersion(existing.stdout, module)) : '0.1.0'

    const manifestDescription =
      existing.status === 0 ? parseManifestDescription(existing.stdout) : undefined
    const skillDescription = skillDescriptionFor(mainMd, manifestDescription)
    if (!skillDescription) {
      fail(
        `Cannot derive a description for skills/${module}/${module}.md — add a "description:" to its frontmatter. The Agent Skills spec requires SKILL.md to have one.`,
      )
    }

    const contentHash = await computeContentHash(sourceDir, relFiles)
    const publishedAt = new Date().toISOString()
    const date = publishedAt.slice(0, 10)

    const branch = uniqueBranch(registryRepo, `straper/publish-${module}`)
    const worktreeBase = await mkdtemp(join(tmpdir(), `straper-publish-${module}-`))
    const worktreePath = join(worktreeBase, module)
    const add = git(registryRepo, ['worktree', 'add', worktreePath, '-b', branch, 'HEAD'])
    if (add.status !== 0) {
      await rm(worktreeBase, { recursive: true, force: true })
      fail(`git worktree add failed in ${registryRepo}:\n${(add.stderr || add.stdout).trim()}`)
    }
    createdWorktree = { path: worktreePath, base: worktreeBase, branch }

    const registryModuleDir = join(worktreePath, 'registry', module)
    for (const rel of relFiles) {
      const dest = join(registryModuleDir, ...rel.split('/'))
      await mkdir(dirname(dest), { recursive: true })
      await writeFile(dest, await readFile(join(sourceDir, ...rel.split('/'))))
    }

    const moduleJson = {
      name: module,
      type: 'skill',
      version,
      deps,
      config_keys: [] as string[],
      source_commit: sourceCommit,
      published_at: publishedAt,
    }
    await writeFile(
      join(registryModuleDir, 'module.json'),
      JSON.stringify(moduleJson, null, 2) + '\n',
      'utf-8',
    )
    await appendChangelog(registryModuleDir, module, version, date)
    // Registry-surface metadata for external skill installers; excluded from
    // vendoring, the lock, and the module content hash (source files only).
    await writeFile(
      join(registryModuleDir, 'SKILL.md'),
      buildSkillMdContent(module, mainMd, skillDescription),
      'utf-8',
    )
    await writeLedger(workspaceDir, module, {
      version,
      source_commit: sourceCommit,
      content_hash: contentHash,
      published_at: publishedAt,
    })

    const commit = commitRegistry(worktreePath, module, version)

    console.log('')
    console.log(`Published ${module} v${version} into the registry.`)
    console.log(`  Registry: ${registryRepo}`)
    console.log(`  Branch:   ${branch}`)
    console.log(`  Worktree: ${worktreePath}`)
    console.log(`  Commit:   ${commit}`)
    console.log(`  Deps:     ${deps.length > 0 ? deps.join(', ') : '(none)'}`)
    console.log(`  Ledger:   .straper-publish.json (modules.${module})`)
    console.log('')
    console.log('Next: review the branch, then push and open a PR.')

    published = true
    return {
      module,
      version,
      deps,
      registryRepo,
      branch,
      worktreePath,
      commit,
      sourceCommit,
      contentHash,
    }
  } finally {
    if (stagingDir) await rm(stagingDir, { recursive: true, force: true, maxRetries: 3 })
    if (!published && createdWorktree) {
      git(registryRepo, ['worktree', 'remove', '--force', createdWorktree.path])
      git(registryRepo, ['branch', '-D', createdWorktree.branch])
      await rm(createdWorktree.base, { recursive: true, force: true, maxRetries: 3 })
    }
  }
}

/** HEAD sha when workspaceDir is the root of a git repo with commits; '' otherwise. */
async function workspaceHead(workspaceDir: string): Promise<string> {
  const top = git(workspaceDir, ['rev-parse', '--show-toplevel'])
  if (top.status !== 0) return ''
  try {
    if ((await realpath(top.stdout.trim())) !== (await realpath(workspaceDir))) return ''
  } catch {
    return ''
  }
  const head = git(workspaceDir, ['rev-parse', 'HEAD'])
  return head.status === 0 ? head.stdout.trim() : ''
}

/** Extract HEAD:skills/<module> (tracked files only) into a temp staging dir. */
async function stageModuleFromHead(workspaceDir: string, module: string): Promise<string> {
  const stagingDir = await mkdtemp(join(tmpdir(), `straper-stage-${module}-`))
  const tarPath = join(stagingDir, '.module.tar')
  const archive = git(workspaceDir, [
    'archive',
    '--format=tar',
    '-o',
    tarPath,
    `HEAD:skills/${module}`,
  ])
  if (archive.status !== 0) {
    await rm(stagingDir, { recursive: true, force: true })
    fail(
      `git archive failed for skills/${module} (is the module committed?):\n${archive.stderr.trim()}`,
    )
  }
  const extract = spawnSync('tar', ['-x', '-f', tarPath, '-C', stagingDir], { encoding: 'utf-8' })
  if (extract.status !== 0) {
    await rm(stagingDir, { recursive: true, force: true })
    fail(`Failed to extract module archive:\n${(extract.stderr ?? '').trim()}`)
  }
  await rm(tarPath, { force: true })
  return stagingDir
}

function resolveRegistryRepo(flag?: string): string {
  const repo = flag ?? process.env.STRAPER_REGISTRY_REPO
  if (!repo) {
    fail(
      'No registry repo given. Pass --registry-repo <path> or set STRAPER_REGISTRY_REPO. The bundled read-only registry is not a publish target.',
    )
  }
  return resolve(repo)
}

function isExcluded(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.startsWith('.local')
}

async function collectModuleFiles(moduleDir: string, applyExclusions: boolean): Promise<string[]> {
  const rels: string[] = []
  async function walk(dir: string, prefix: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (applyExclusions && isExcluded(entry.name)) continue
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const full = join(dir, entry.name)
      if (entry.isDirectory()) await walk(full, rel)
      else if (entry.isFile()) rels.push(rel)
    }
  }
  await walk(moduleDir, '')
  return rels.sort()
}

/**
 * Run the publish-profile gate over the module's files. FAIL (exit 1) aborts;
 * WARN (exit 0) passes; a usage error (exit 2) aborts loudly.
 */
function runGate(
  module: string,
  workspaceDir: string,
  scrubPath: string,
  sourceDir: string,
  relFiles: string[],
): void {
  const absFiles = relFiles.map((rel) => join(sourceDir, ...rel.split('/')))
  const gate = spawnSync('bash', [scrubPath, '--profile', 'publish', ...absFiles], {
    cwd: workspaceDir,
    encoding: 'utf-8',
  })
  const out = (gate.stdout || '').trim()
  const errOut = (gate.stderr || '').trim()
  if (gate.status === 2) {
    fail(`Publish gate usage error:\n${errOut || out}`)
  }
  if (gate.status !== 0) {
    fail(`Publish gate FAILED for ${module} — resolve before publishing:\n${out || errOut}`)
  }
}

/**
 * Static self-containment check. Returns the module's real deps: the union of
 * declared depends_on and every cross-skill static reach. Aborts if the module
 * reaches an undeclared skill, or reaches anything outside the skill that is
 * neither a dep nor part of the runtime baseline.
 */
async function captureDeps(
  module: string,
  workspaceDir: string,
  moduleDir: string,
  sourceDir: string,
  relFiles: string[],
  declaredDeps: string[],
): Promise<string[]> {
  const declared = new Set(declaredDeps)
  const reached = new Set<string>()
  const failures: string[] = []

  for (const rel of relFiles) {
    // Bytes come from the (possibly staged) source dir; specifier paths resolve
    // against the module's logical workspace location.
    const specs = scanSpecifiers(rel, await readFile(join(sourceDir, ...rel.split('/')), 'utf-8'))
    if (specs.length === 0) continue
    const fileDir = dirname(join(moduleDir, ...rel.split('/')))
    for (const spec of specs) {
      if (!spec.startsWith('.') && !spec.startsWith('/')) continue
      const resolvedAbs = isAbsolute(spec) ? spec : resolve(fileDir, spec)
      const relToModule = relative(moduleDir, resolvedAbs)
      if (relToModule !== '' && !relToModule.startsWith('..') && !isAbsolute(relToModule)) {
        continue // internal reach — self-contained
      }
      const relToWs = toPosix(relative(workspaceDir, resolvedAbs))
      if (RUNTIME_BASELINE_V1.includes(relToWs)) continue // blessed baseline — legal, not a dep
      const skillMatch = /^skills\/([^/]+)\//.exec(relToWs)
      if (skillMatch && skillMatch[1] !== module) {
        const other = skillMatch[1]
        if (declared.has(other)) {
          reached.add(other)
        } else {
          failures.push(
            `skills/${module}/${rel} statically reaches skills/${other}/ (${spec}) but ${other} is not declared — add ${other} to depends_on`,
          )
        }
        continue
      }
      failures.push(
        `skills/${module}/${rel} reaches ${relToWs} (${spec}) which is outside the skill and not part of the runtime baseline`,
      )
    }
  }

  if (failures.length > 0) {
    fail(`Module ${module} is not self-contained:\n  ${failures.join('\n  ')}`)
  }

  return [...new Set([...declared, ...reached])].sort()
}

/** Extract require/import (JS) or source/. (shell) specifier strings from one file. */
function scanSpecifiers(rel: string, content: string): string[] {
  const ext = extname(rel)
  const specs: string[] = []
  if (JS_EXT.has(ext)) {
    const patterns = [
      /(?:require|import)\(\s*['"]([^'"]+)['"]\s*\)/g,
      /(?:^|[^\w.])(?:import|export)\b[^'"\n]*?from\s*['"]([^'"]+)['"]/g,
      /(?:^|[^\w.])import\s*['"]([^'"]+)['"]/g,
    ]
    for (const pattern of patterns) {
      let m: RegExpExecArray | null
      while ((m = pattern.exec(content)) !== null) specs.push(m[1])
    }
  } else if (SH_EXT.has(ext) || ext === '') {
    for (const line of content.split('\n')) {
      const m = /^\s*(?:source|\.)\s+["']?([^"'\s;|&]+)/.exec(line)
      if (m) specs.push(m[1])
    }
  }
  return specs
}

/** Parse a `depends_on` list from a skill's main .md frontmatter (block or inline form). */
function parseDependsOn(md: string): string[] {
  const lines = md.split('\n')
  if (lines[0]?.trim() !== '---') return []
  let end = -1
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      end = i
      break
    }
  }
  if (end === -1) return []

  const deps: string[] = []
  let inDeps = false
  const unquote = (v: string): string => v.trim().replace(/^['"]|['"]$/g, '')
  for (let i = 1; i < end; i++) {
    const line = lines[i]
    const keyMatch = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line)
    if (keyMatch) {
      inDeps = false
      if (keyMatch[1] === 'depends_on') {
        const inline = keyMatch[2].trim()
        if (inline.startsWith('[')) {
          for (const part of inline.replace(/^\[|\]$/g, '').split(',')) {
            const v = unquote(part)
            if (v) deps.push(v)
          }
        } else {
          inDeps = true
        }
      }
      continue
    }
    if (inDeps) {
      const item = /^\s*-\s*(.+?)\s*$/.exec(line)
      if (item) deps.push(unquote(item[1]))
      else if (line.trim() !== '') inDeps = false
    }
  }
  return deps
}

function parseVersion(json: string, module: string): string {
  try {
    const version = (JSON.parse(json) as { version?: unknown }).version
    if (typeof version !== 'string') throw new Error('missing version')
    return version
  } catch {
    fail(`Existing registry/${module}/module.json is not valid JSON with a version.`)
  }
}

function parseManifestDescription(json: string): string | undefined {
  try {
    const description = (JSON.parse(json) as { description?: unknown }).description
    return typeof description === 'string' ? description : undefined
  } catch {
    return undefined
  }
}

function bumpPatch(current: string): string {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(current.trim())
  if (!match) fail(`Existing version is not semver (X.Y.Z): ${current}`)
  return `${match[1]}.${match[2]}.${Number(match[3]) + 1}`
}

async function computeContentHash(sourceDir: string, relFiles: string[]): Promise<string> {
  const hash = createHash('sha256')
  for (const rel of [...relFiles].sort()) {
    hash.update(rel, 'utf8')
    hash.update('\0')
    hash.update(await readFile(join(sourceDir, ...rel.split('/'))))
    hash.update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}

function uniqueBranch(repo: string, base: string): string {
  let candidate = base
  let n = 2
  while (git(repo, ['show-ref', '--verify', '--quiet', `refs/heads/${candidate}`]).status === 0) {
    candidate = `${base}-${n++}`
  }
  return candidate
}

async function appendChangelog(
  registryModuleDir: string,
  module: string,
  version: string,
  date: string,
): Promise<void> {
  const changelogPath = join(registryModuleDir, 'CHANGELOG.md')
  const entry = `## ${version} — ${date}\n\nPublish ${module} v${version}.\n`
  let existing: string | undefined
  try {
    existing = await readFile(changelogPath, 'utf-8')
  } catch {
    existing = undefined
  }
  if (existing === undefined) {
    await writeFile(changelogPath, `# ${module} changelog\n\n${entry}`, 'utf-8')
    return
  }
  const lines = existing.split('\n')
  let insertAt = 0
  if (lines[0]?.startsWith('# ')) {
    insertAt = 1
    while (insertAt < lines.length && lines[insertAt].trim() === '') insertAt += 1
  }
  const head = lines.slice(0, insertAt).join('\n')
  const tail = lines.slice(insertAt).join('\n')
  const rebuilt = `${head}\n\n${entry}\n${tail}`.replace(/\n{3,}/g, '\n\n')
  await writeFile(changelogPath, rebuilt.endsWith('\n') ? rebuilt : `${rebuilt}\n`, 'utf-8')
}

interface LedgerRecord {
  version: string
  source_commit: string
  content_hash: string
  published_at: string
}

async function writeLedger(
  workspaceDir: string,
  module: string,
  record: LedgerRecord,
): Promise<void> {
  const ledgerPath = join(workspaceDir, '.straper-publish.json')
  let ledger: { modules: Record<string, LedgerRecord> } = { modules: {} }
  try {
    const parsed = JSON.parse(await readFile(ledgerPath, 'utf-8')) as {
      modules?: Record<string, LedgerRecord>
    }
    ledger = { modules: parsed.modules ?? {} }
  } catch {
    ledger = { modules: {} }
  }
  ledger.modules[module] = record
  const sorted: { modules: Record<string, LedgerRecord> } = { modules: {} }
  for (const key of Object.keys(ledger.modules).sort()) sorted.modules[key] = ledger.modules[key]
  await writeFile(ledgerPath, JSON.stringify(sorted, null, 2) + '\n', 'utf-8')
}

function commitRegistry(worktreePath: string, module: string, version: string): string {
  const addRes = git(worktreePath, ['add', 'registry'])
  if (addRes.status !== 0) {
    fail(`git add failed in registry worktree:\n${(addRes.stderr || addRes.stdout).trim()}`)
  }
  const identity: string[] = []
  if (!git(worktreePath, ['config', 'user.email']).stdout.trim()) {
    identity.push('-c', 'user.email=straper@localhost')
  }
  if (!git(worktreePath, ['config', 'user.name']).stdout.trim()) {
    identity.push('-c', 'user.name=straper')
  }
  const message = `feat(registry): publish ${module} module v${version}`
  const commit = git(worktreePath, [...identity, 'commit', '--no-verify', '-m', message])
  if (commit.status !== 0) {
    fail(`git commit failed in registry worktree:\n${(commit.stderr || commit.stdout).trim()}`)
  }
  return git(worktreePath, ['rev-parse', 'HEAD']).stdout.trim()
}
