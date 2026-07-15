import { execFileSync } from 'node:child_process'
import {
  chmod,
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
  cp,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'

import { SCAFFOLD_DIR } from '../constants.js'
import { init } from './init.js'

export interface MigrateArgs {
  dir?: string
  dryRun?: boolean
  skipValidate?: boolean
}

interface MigrationContext {
  workspaceDir: string
  agentName: string
  userName: string
  dryRun: boolean
  skipValidate: boolean
  refDir: string
  migrationBranch: string
  counts: MigrationCounts
}

interface MigrationCounts {
  added: number
  replaced: number
  removed: number
  edited: number
}

const MIGRATION_BRANCH = 'migrate/skills-architecture'

/**
 * Migrate an existing pre-skills workspace to the current skills architecture.
 */
export async function migrate(args: MigrateArgs): Promise<void> {
  // The registry-aware migration path isn't built yet; a scaffold with no baked-in
  // skills/ has nothing to migrate to. Exit clearly instead of failing later with a
  // misleading reference-scaffold error.
  if (!(await directoryExists(join(SCAFFOLD_DIR, 'skills')))) {
    process.stderr.write(
      'Error: straper migrate is being reworked for the registry model and is not available in this release.\n' +
        'For a new workspace, use `straper init`.\n',
    )
    process.exit(1)
  }

  const dryRun = args.dryRun ?? false
  const skipValidate = args.skipValidate ?? false
  const workspaceDir = resolve(args.dir ?? process.cwd())
  const refDir = await mkdtemp(join(tmpdir(), 'straper-migrate-ref-'))

  try {
    const { agentName, userName } = await runPreflight(workspaceDir)

    const ctx: MigrationContext = {
      workspaceDir,
      agentName,
      userName,
      dryRun,
      skipValidate,
      refDir,
      migrationBranch: MIGRATION_BRANCH,
      counts: { added: 0, replaced: 0, removed: 0, edited: 0 },
    }

    if (dryRun) {
      printSection('Dry Run: Migration Plan')
    } else {
      printSection('Migration: Creating Branch')
      ensureBranchDoesNotExist(ctx.workspaceDir, ctx.migrationBranch)
      runGit(ctx.workspaceDir, ['checkout', '-b', ctx.migrationBranch])
      info(`Created branch: ${ctx.migrationBranch}`)
      process.stdout.write('\n')
    }

    printSection('Scaffolding Reference Workspace')
    await scaffoldReferenceWorkspace(ctx)
    info(`Reference workspace created at ${ctx.refDir}`)
    process.stdout.write('\n')

    printSection('Copying Structural Files')
    await copyStructuralFiles(ctx)
    process.stdout.write('\n')

    printSection('Removing Deprecated Files')
    await removeDeprecatedFiles(ctx)
    process.stdout.write('\n')

    if (dryRun) {
      printSection('Permissions')
      dry('[CHMOD]', 'scripts/**/*.sh, scripts/**/*.js, skills/**/*.sh, skills/**/*.js')
      dry('[CHMOD]', `scripts/${ctx.agentName} (shell wrapper)`)
      process.stdout.write('\n')
    } else {
      printSection('Making Scripts Executable')
      await makeScriptsExecutable(ctx)
      info('Permissions set on scripts/ and skills/')
      process.stdout.write('\n')
    }

    printSection('Surgical Edits: TOOLS.md')
    await updateToolsFile(ctx)
    process.stdout.write('\n')

    printSection('Surgical Edits: BOOT.md')
    await updateBootFile(ctx)
    process.stdout.write('\n')

    printSection('Cleanup')
    await cleanupReferenceWorkspace(ctx.refDir)
    info(`Removed reference workspace: ${ctx.refDir}`)
    process.stdout.write('\n')

    if (dryRun) {
      printSection('Dry Run Complete')
      process.stdout.write('No files were modified. Run without --dry-run to perform the migration.\n')
      return
    }

    await validateMigration(ctx)
    await commitMigration(ctx)
    printSummary(ctx)
  } catch (err: unknown) {
    if (err instanceof MigrationError) {
      process.stderr.write(`Error: ${err.message}\n`)
      process.exit(1)
    }
    throw err
  } finally {
    await cleanupReferenceWorkspace(refDir)
  }
}

async function runPreflight(
  workspaceDir: string,
): Promise<{ agentName: string; userName: string }> {
  printSection('Migration: Pre-flight Checks')

  if (!(await directoryExists(join(workspaceDir, '.git')))) {
    fail(`Not a git repository: ${workspaceDir}`)
  }
  info(`Workspace is a git repo: ${workspaceDir}`)

  ensureTrackedWorkingTreeClean(workspaceDir)
  info('Working tree is clean')

  const prefsPath = join(workspaceDir, 'preferences.json')
  if (!(await fileExists(prefsPath))) {
    fail('No preferences.json found at workspace root')
  }

  const prefs = JSON.parse(await readFile(prefsPath, 'utf-8')) as {
    agent_name?: string
    user_name?: string
  }

  const agentName = prefs.agent_name?.trim()
  if (!agentName) {
    fail('No agent_name in preferences.json')
  }
  info(`Agent name: ${agentName}`)

  const agentScript = join(workspaceDir, 'scripts', `${agentName}.js`)
  if (!(await fileExists(agentScript))) {
    fail(`Agent script not found: ${agentScript}`)
  }

  const scriptContent = await readFile(agentScript, 'utf-8')
  const agentLines = scriptContent.split('\n').length
  if (agentLines <= 500) {
    fail(
      `Agent script is only ${agentLines} lines (expected > 500 for old monolith structure)`,
    )
  }
  info(`Agent script: ${agentScript} (${agentLines} lines - old monolith detected)`)

  if (await directoryExists(join(workspaceDir, 'skills'))) {
    fail('skills/ directory already exists - workspace may already be migrated')
  }
  info('No skills/ directory - eligible for migration')

  const userName = readGitConfig(workspaceDir, 'user.name') || prefs.user_name?.trim() || 'User'
  info(`User name: ${userName}`)

  process.stdout.write('\n')
  info('Pre-flight checks passed')
  process.stdout.write('\n')

  return { agentName, userName }
}

async function scaffoldReferenceWorkspace(ctx: MigrationContext): Promise<void> {
  const originalXdg = process.env.XDG_CONFIG_HOME
  const tempConfigHome = join(ctx.refDir, '.straper-config')

  try {
    process.env.XDG_CONFIG_HOME = tempConfigHome
    await init({
      name: ctx.agentName,
      dir: ctx.refDir,
      user: ctx.userName,
    })
  } finally {
    if (originalXdg === undefined) {
      delete process.env.XDG_CONFIG_HOME
    } else {
      process.env.XDG_CONFIG_HOME = originalXdg
    }
  }

  if (!(await directoryExists(join(ctx.refDir, 'skills')))) {
    fail('Reference scaffold failed - no skills/ directory created')
  }
}

async function copyStructuralFiles(ctx: MigrationContext): Promise<void> {
  await copyDir(ctx, join(ctx.refDir, 'skills'), join(ctx.workspaceDir, 'skills'), 'skills/')
  await copyFile(
    ctx,
    join(ctx.refDir, 'scripts', 'lib', 'skills.sh'),
    join(ctx.workspaceDir, 'scripts', 'lib', 'skills.sh'),
    'scripts/lib/skills.sh',
  )
  await copyFile(
    ctx,
    join(ctx.refDir, 'scripts', 'lib', 'cli-utils.js'),
    join(ctx.workspaceDir, 'scripts', 'lib', 'cli-utils.js'),
    'scripts/lib/cli-utils.js',
  )
  await copyFile(
    ctx,
    join(ctx.refDir, 'scripts', `${ctx.agentName}.js`),
    join(ctx.workspaceDir, 'scripts', `${ctx.agentName}.js`),
    `scripts/${ctx.agentName}.js (thin router)`,
  )
  await copyFile(
    ctx,
    join(ctx.refDir, 'scripts', 'session-start.sh'),
    join(ctx.workspaceDir, 'scripts', 'session-start.sh'),
    'scripts/session-start.sh',
  )
  await copyFile(
    ctx,
    join(ctx.refDir, 'scripts', 'session-end.sh'),
    join(ctx.workspaceDir, 'scripts', 'session-end.sh'),
    'scripts/session-end.sh',
  )
  await copyFile(
    ctx,
    join(ctx.refDir, 'scripts', 'task'),
    join(ctx.workspaceDir, 'scripts', 'task'),
    'scripts/task',
  )
  await copyFile(
    ctx,
    join(ctx.refDir, 'scripts', 'validate-tasks.sh'),
    join(ctx.workspaceDir, 'scripts', 'validate-tasks.sh'),
    'scripts/validate-tasks.sh',
  )

  await replaceClaudeCommands(ctx)

  if (await directoryExists(join(ctx.refDir, 'completions'))) {
    await copyDir(
      ctx,
      join(ctx.refDir, 'completions'),
      join(ctx.workspaceDir, 'completions'),
      'completions/',
    )
  }

  if (await directoryExists(join(ctx.refDir, 'prompts'))) {
    await copyDir(ctx, join(ctx.refDir, 'prompts'), join(ctx.workspaceDir, 'prompts'), 'prompts/')
  }
}

async function replaceClaudeCommands(ctx: MigrationContext): Promise<void> {
  const workspaceCommandsDir = join(ctx.workspaceDir, '.claude', 'commands')
  const refCommandsDir = join(ctx.refDir, '.claude', 'commands')

  const workspaceEntries = (await directoryExists(workspaceCommandsDir))
    ? await readdir(workspaceCommandsDir)
    : []

  const refEntries = (await directoryExists(refCommandsDir)) ? await readdir(refCommandsDir) : []

  const workspaceMdFiles = workspaceEntries.filter((entry) => entry.endsWith('.md'))
  const refMdFiles = refEntries.filter((entry) => entry.endsWith('.md'))

  if (ctx.dryRun) {
    for (const entry of workspaceMdFiles) {
      dry('[REMOVE]', `.claude/commands/${entry}`)
    }
    for (const entry of refMdFiles) {
      dry('[ADD]', `.claude/commands/${entry} (thin pointer)`)
    }
    return
  }

  await mkdir(workspaceCommandsDir, { recursive: true })

  for (const entry of workspaceMdFiles) {
    await rm(join(workspaceCommandsDir, entry), { force: true })
    ctx.counts.removed += 1
  }
  if (workspaceMdFiles.length > 0) {
    info('Removed old .claude/commands/*.md files')
  }

  for (const entry of refMdFiles) {
    await cp(join(refCommandsDir, entry), join(workspaceCommandsDir, entry), { force: true })
    ctx.counts.added += 1
  }
  if (refMdFiles.length > 0) {
    info('Copied new .claude/commands/ thin pointers')
  }
}

async function removeDeprecatedFiles(ctx: MigrationContext): Promise<void> {
  await removeFile(
    ctx,
    join(ctx.workspaceDir, 'scripts', 'auto-commit.sh'),
    'scripts/auto-commit.sh (-> skills/auto-commit/)',
  )
  await removeFile(
    ctx,
    join(ctx.workspaceDir, 'scripts', 'task.js'),
    'scripts/task.js (-> skills/task/)',
  )
  await removeFile(
    ctx,
    join(ctx.workspaceDir, 'scripts', 'validate-tasks.js'),
    'scripts/validate-tasks.js (-> skills/task/)',
  )
  await removeFile(
    ctx,
    join(ctx.workspaceDir, 'scripts', 'lib', 'designs.js'),
    'scripts/lib/designs.js (-> skills/fd/)',
  )
}

async function makeScriptsExecutable(ctx: MigrationContext): Promise<void> {
  await chmodMatching(join(ctx.workspaceDir, 'scripts'))
  await chmodMatching(join(ctx.workspaceDir, 'skills'))

  const wrapperPath = join(ctx.workspaceDir, 'scripts', ctx.agentName)
  if (await fileExists(wrapperPath)) {
    await chmod(wrapperPath, 0o755)
  }

  const taskPath = join(ctx.workspaceDir, 'scripts', 'task')
  if (await fileExists(taskPath)) {
    await chmod(taskPath, 0o755)
  }
}

async function updateToolsFile(ctx: MigrationContext): Promise<void> {
  const toolsPath = join(ctx.workspaceDir, 'TOOLS.md')
  if (!(await fileExists(toolsPath))) {
    warn('TOOLS.md not found - skipping')
    return
  }

  const original = await readFile(toolsPath, 'utf-8')
  if (original.includes('skills/INDEX.md')) {
    info('TOOLS.md already mentions skills/INDEX.md - skipping')
    return
  }

  if (ctx.dryRun) {
    dry('[EDIT]', "TOOLS.md - add Skills section before '## Workflow Skills'")
    dry('[EDIT]', 'TOOLS.md - add skills CLI commands to CLI Commands section')
    return
  }

  let next = original
  let changed = false

  const skillsSection = [
    '## Skills',
    '',
    'See `skills/INDEX.md` for the auto-generated skill registry. Run ' +
      `\`${ctx.agentName} skills sync\` to regenerate.`,
    '',
    'Skill contract defined in `skills/SCHEMA.md`.',
    '',
  ].join('\n')

  if (next.includes('## Workflow Skills')) {
    next = next.replace('## Workflow Skills', `${skillsSection}## Workflow Skills`)
    ctx.counts.edited += 1
    changed = true
    info('TOOLS.md - added Skills section')
  } else {
    next = `${next.trimEnd()}\n\n${skillsSection.trimEnd()}\n`
    ctx.counts.edited += 1
    changed = true
    warn("TOOLS.md - '## Workflow Skills' not found, appended Skills section at end")
    info('TOOLS.md - appended Skills section')
  }

  const skillsCliLine = `./scripts/${ctx.agentName} skills list|validate|sync|export|import`
  if (!next.includes('skills list')) {
    const cliBlockPattern = /(### CLI Commands\s*\n```bash\n)([\s\S]*?)(\n```)/m
    if (cliBlockPattern.test(next)) {
      next = next.replace(cliBlockPattern, (_match, start: string, body: string, end: string) => {
        const normalizedBody = body.endsWith('\n') ? body : `${body}\n`
        return `${start}${normalizedBody}${skillsCliLine}${end}`
      })
      ctx.counts.edited += 1
      changed = true
      info('TOOLS.md - added skills CLI command')
    }
  }

  if (changed) {
    await writeFile(toolsPath, next, 'utf-8')
  }
}

async function updateBootFile(ctx: MigrationContext): Promise<void> {
  const bootPath = join(ctx.workspaceDir, 'BOOT.md')
  if (!(await fileExists(bootPath))) {
    warn('BOOT.md not found - skipping')
    return
  }

  const original = await readFile(bootPath, 'utf-8')
  if (/skills/i.test(original)) {
    info('BOOT.md already mentions skills - skipping')
    return
  }

  if (ctx.dryRun) {
    dry('[EDIT]', "BOOT.md - add 'Validate skills' step after 'Load context'")
    return
  }

  let next = original.replace(
    /^## 2\. Check workspace health$/m,
    [
      '## 2. Validate skills',
      '',
      '- Run `scripts/session-start.sh` skills validation (automatic)',
      '- Verify all skills pass schema validation',
      '',
      '## 3. Check workspace health',
    ].join('\n'),
  )
  next = next.replace(/^## 3\. Greet$/m, '## 4. Greet')

  if (next !== original) {
    await writeFile(bootPath, next, 'utf-8')
    ctx.counts.edited += 1
    info("BOOT.md - added 'Validate skills' step")
  }
}

async function validateMigration(ctx: MigrationContext): Promise<void> {
  if (ctx.skipValidate) {
    printSection('Validation: Skipped (--skip-validate)')
    return
  }

  printSection('Post-Migration Validation')

  let failed = 0
  if (runWorkspaceCommand(ctx.workspaceDir, './scripts/session-start.sh')) {
    info('PASS: session-start.sh')
  } else {
    warn('FAIL: session-start.sh')
    failed += 1
  }

  if (runWorkspaceCommand(ctx.workspaceDir, `./scripts/${ctx.agentName} fd-status`)) {
    info('PASS: fd-status')
  } else {
    warn('FAIL: fd-status')
    failed += 1
  }

  if (runWorkspaceCommand(ctx.workspaceDir, `./scripts/${ctx.agentName} session-review`)) {
    info('PASS: session-review')
  } else {
    warn('FAIL: session-review')
    failed += 1
  }

  process.stdout.write('\n')
  if (failed > 0) {
    warn(`${failed} validation(s) failed. Review the migration before merging.`)
  } else {
    info('All validations passed')
  }
  process.stdout.write('\n')
}

async function commitMigration(ctx: MigrationContext): Promise<void> {
  printSection('Committing Migration')

  runGit(ctx.workspaceDir, ['add', '-A', '--', 'skills/', 'scripts/', '.claude/commands/', 'completions/', 'prompts/', 'TOOLS.md', 'BOOT.md'])
  runGit(ctx.workspaceDir, ['-c', 'commit.gpgSign=false', 'commit', '-m', 'feat: migrate to skills architecture'])

  info(`Migration committed on branch: ${ctx.migrationBranch}`)
  process.stdout.write('\n')
}

function printSummary(ctx: MigrationContext): void {
  printSection('Migration Complete')
  process.stdout.write('Summary:\n')
  process.stdout.write(`  Added:    ${ctx.counts.added}\n`)
  process.stdout.write(`  Replaced: ${ctx.counts.replaced}\n`)
  process.stdout.write(`  Removed:  ${ctx.counts.removed}\n`)
  process.stdout.write(`  Edited:   ${ctx.counts.edited}\n`)
  process.stdout.write('\n')
  process.stdout.write('Next steps:\n')
  process.stdout.write(`  Review:   git diff main...${ctx.migrationBranch}\n`)
  process.stdout.write(
    `  Merge:    git checkout main && git merge ${ctx.migrationBranch}\n`,
  )
  process.stdout.write(
    `  Rollback: git checkout main && git branch -D ${ctx.migrationBranch}\n`,
  )
}

async function copyDir(
  ctx: MigrationContext,
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  const exists = await directoryExists(destination)

  if (ctx.dryRun) {
    dry(exists ? '[REPLACE]' : '[ADD]', label)
    return
  }

  if (exists) {
    await rm(destination, { recursive: true, force: true })
    ctx.counts.replaced += 1
  } else {
    ctx.counts.added += 1
  }

  await cp(source, destination, { recursive: true, force: true })
  info(`Copied: ${label}`)
}

async function copyFile(
  ctx: MigrationContext,
  source: string,
  destination: string,
  label: string,
): Promise<void> {
  const exists = await fileExists(destination)

  if (ctx.dryRun) {
    dry(exists ? '[REPLACE]' : '[ADD]', label)
    return
  }

  await mkdir(dirname(destination), { recursive: true })
  if (exists) {
    ctx.counts.replaced += 1
  } else {
    ctx.counts.added += 1
  }

  await cp(source, destination, { force: true })
  info(`Copied: ${label}`)
}

async function removeFile(ctx: MigrationContext, path: string, label: string): Promise<void> {
  const exists = await fileExists(path)

  if (ctx.dryRun) {
    if (exists) {
      dry('[REMOVE]', label)
    }
    return
  }

  if (exists) {
    await rm(path, { force: true })
    ctx.counts.removed += 1
    info(`Removed: ${label}`)
  }
}

async function chmodMatching(dir: string): Promise<void> {
  if (!(await directoryExists(dir))) {
    return
  }

  const entries = await readdir(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const info = await stat(fullPath)

    if (info.isDirectory()) {
      await chmodMatching(fullPath)
      continue
    }

    if (entry.endsWith('.sh') || entry.endsWith('.js')) {
      await chmod(fullPath, 0o755)
    }
  }
}

function ensureTrackedWorkingTreeClean(workspaceDir: string): void {
  try {
    const output = execFileSync('git', ['status', '--porcelain', '--untracked-files=no'], {
      cwd: workspaceDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()

    if (output.length > 0) {
      fail('Working tree is not clean. Commit or stash changes first.')
    }
  } catch (err: unknown) {
    if (isExecError(err)) {
      fail('Failed to inspect git working tree state')
    }
    throw err
  }
}

function ensureBranchDoesNotExist(workspaceDir: string, branch: string): void {
  try {
    execFileSync('git', ['rev-parse', '--verify', branch], {
      cwd: workspaceDir,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    fail(`Branch '${branch}' already exists. Delete it first or it was already attempted.`)
  } catch (err: unknown) {
    if (isExecError(err) && err.status !== 0) {
      return
    }
    throw err
  }
}

function runGit(workspaceDir: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: workspaceDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch (err: unknown) {
    if (isExecError(err)) {
      const stderr = err.stderr?.toString().trim()
      const message = stderr || `git ${args.join(' ')} failed`
      fail(message)
    }
    throw err
  }
}

function runWorkspaceCommand(workspaceDir: string, command: string): boolean {
  try {
    execFileSync('bash', ['-lc', command], {
      cwd: workspaceDir,
      stdio: ['ignore', 'ignore', 'ignore'],
    })
    return true
  } catch {
    return false
  }
}

function readGitConfig(workspaceDir: string, key: string): string {
  try {
    return execFileSync('git', ['config', key], {
      cwd: workspaceDir,
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim()
  } catch {
    return ''
  }
}

async function cleanupReferenceWorkspace(refDir: string): Promise<void> {
  await rm(refDir, { recursive: true, force: true })
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile()
  } catch {
    return false
  }
}

async function directoryExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isDirectory()
  } catch {
    return false
  }
}

function printSection(title: string): void {
  process.stdout.write(`== ${title} ==\n\n`)
}

function info(message: string): void {
  process.stdout.write(`[INFO]  ${message}\n`)
}

function warn(message: string): void {
  process.stdout.write(`[WARN]  ${message}\n`)
}

function dry(kind: string, label: string): void {
  process.stdout.write(`  ${kind} ${label}\n`)
}

function fail(message: string): never {
  throw new MigrationError(message)
}

class MigrationError extends Error {}

function isExecError(err: unknown): err is Error & { status?: number; stderr?: string | Buffer } {
  return err instanceof Error && 'status' in err
}
