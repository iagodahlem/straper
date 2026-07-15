import { execSync } from 'node:child_process'
import {
  chmod,
  copyFile,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises'
import { join, resolve } from 'node:path'

import {
  createDefaultConfig,
  listSharedFiles,
  readConfig,
  registerWorkspace,
  resolveCliInstallTarget,
  writeConfig,
} from '../config.js'
import { SCAFFOLD_DIR } from '../constants.js'
import { type TemplateVariables, copyWithRename, processScaffoldDir } from '../scaffold.js'
import { adoptWorkspace } from './adopt.js'

export interface InitArgs {
  name: string
  dir?: string
  user?: string
  role?: string
  project?: string
  description?: string
  adopt?: boolean
  registry?: string
}

/**
 * Scaffold a new agent workspace.
 */
export async function init(args: InitArgs): Promise<void> {
  // --adopt onboards an existing workspace; it never scaffolds, so it short-circuits
  // before any directory creation, templating, or git init.
  if (args.adopt) {
    await adoptWorkspace({ dir: args.dir, registry: args.registry })
    return
  }

  const { name } = args

  // ---- 1. Validate agent name ----
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    error(
      `Invalid agent name "${name}". Must be lowercase, start with a letter, and contain only letters, digits, hyphens, or underscores.`,
    )
  }

  // ---- 2. Resolve workspace directory ----
  const workspaceDir = resolve(args.dir ?? join(process.cwd(), name))

  // Check target directory
  try {
    const dirStat = await stat(workspaceDir)
    if (dirStat.isDirectory()) {
      const entries = await readdir(workspaceDir)
      if (entries.length > 0) {
        error(
          `Directory ${workspaceDir} already exists and is not empty. Use an empty directory or a new path.`,
        )
      }
      // Directory exists but is empty — proceed
    } else {
      error(`${workspaceDir} exists but is not a directory.`)
    }
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'ENOENT') {
      // Does not exist — will create later
    } else {
      throw err
    }
  }

  // ---- 3. Read global config ----
  const existingConfig = await readConfig()

  // ---- 4. Resolve values: flags > config > defaults ----
  const userName = args.user ?? existingConfig?.user.name ?? null
  const userRole = args.role ?? existingConfig?.user.role ?? 'Software Engineer'
  const projectName = args.project ?? capitalize(name)
  const projectDescription = args.description ?? ''

  if (!userName) {
    error(
      'User name is required. Provide --user "Your Name" or set up global config first.\n' +
        'Usage: straper init <name> --user "Your Name" [--project "Project"] [--description "..."]',
    )
  }

  // ---- 5. Build template variables ----
  const vars: TemplateVariables = {
    agent_name: name,
    agent_display_name: capitalize(name),
    user_name: userName,
    user_role: userRole,
    project_name: projectName,
    project_description: projectDescription,
    workspace_dir: workspaceDir,
    year: new Date().getFullYear().toString(),
  }

  // ---- 6. Create workspace directory ----
  await mkdir(workspaceDir, { recursive: true })

  // ---- 7. Initialize git repo ----
  try {
    execSync('git init --initial-branch=main', {
      cwd: workspaceDir,
      stdio: 'pipe',
    })
  } catch {
    // Fallback for older git versions without --initial-branch
    try {
      execSync('git init', { cwd: workspaceDir, stdio: 'pipe' })
      execSync('git symbolic-ref HEAD refs/heads/main', {
        cwd: workspaceDir,
        stdio: 'pipe',
      })
    } catch {
      error('Failed to initialize git repository. Is git installed?')
    }
  }

  // ---- 8. Process scaffold/templates/ ----
  const templatesDir = join(SCAFFOLD_DIR, 'templates')
  await processScaffoldDir(templatesDir, workspaceDir, vars)

  // ---- 9. Process scaffold/claude/ -> .claude/ ----
  const claudeDir = join(SCAFFOLD_DIR, 'claude')
  const dotClaudeDir = join(workspaceDir, '.claude')
  await processScaffoldDir(claudeDir, dotClaudeDir, vars)

  // ---- 10. Copy scaffold/scripts/ -> scripts/ ----
  const scriptsSource = join(SCAFFOLD_DIR, 'scripts')
  const scriptsDest = join(workspaceDir, 'scripts')
  await copyWithRename(scriptsSource, scriptsDest, vars)

  // ---- 11. Copy scaffold/schemas/ -> tasks/ ----
  const schemasSource = join(SCAFFOLD_DIR, 'schemas')
  const tasksDest = join(workspaceDir, 'tasks')
  await mkdir(tasksDest, { recursive: true })
  const schemaEntries = await readdir(schemasSource)
  for (const entry of schemaEntries) {
    const srcPath = join(schemasSource, entry)
    const destName = entry === 'task-schema.json' ? 'schema.json' : entry
    await copyFile(srcPath, join(tasksDest, destName))
  }

  // ---- 12. Copy scaffold/designs/ -> designs/ ----
  const designsSource = join(SCAFFOLD_DIR, 'designs')
  const designsDest = join(workspaceDir, 'designs')
  await copyWithRename(designsSource, designsDest, vars)

  // ---- 13. Process scaffold/config/ -> config/ ----
  const configSource = join(SCAFFOLD_DIR, 'config')
  const configDest = join(workspaceDir, 'config')
  await processScaffoldDir(configSource, configDest, vars)

  // ---- 13b. Copy scaffold/prompts/ -> prompts/ (agent-name substitution only) ----
  const promptsSource = join(SCAFFOLD_DIR, 'prompts')
  const promptsDest = join(workspaceDir, 'prompts')
  await copyWithAgentSubstitution(promptsSource, promptsDest, vars)

  // ---- 14. Create empty directories ----
  const emptyDirs = ['memory', 'plans', 'repos', 'workspaces', 'agents', 'patches']
  for (const dir of emptyDirs) {
    const dirPath = join(workspaceDir, dir)
    await mkdir(dirPath, { recursive: true })
    // Add .gitkeep to keep empty dirs in git
    await writeFile(join(dirPath, '.gitkeep'), '', 'utf-8')
  }

  // ---- 14b. Write empty straper.lock (add-ready) ----
  await writeFile(
    join(workspaceDir, 'straper.lock'),
    JSON.stringify({ lockfileVersion: 1, modules: {} }, null, 2) + '\n',
    'utf-8',
  )

  // ---- 15. Create .githooks/pre-commit ----
  const githooksDir = join(workspaceDir, '.githooks')
  await mkdir(githooksDir, { recursive: true })
  const preCommitContent = `#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "\${BASH_SOURCE[0]}")/.." && pwd)"

"$ROOT_DIR/scripts/validate-tasks.sh"
`
  await writeFile(join(githooksDir, 'pre-commit'), preCommitContent, { mode: 0o755 })

  // ---- 16. Configure git hooks path ----
  try {
    execSync('git config core.hooksPath .githooks', {
      cwd: workspaceDir,
      stdio: 'pipe',
    })
  } catch {
    // Non-fatal — print warning but continue
    process.stdout.write('Warning: Could not configure git hooks path.\n')
  }

  // ---- 17. Create CLAUDE.md symlink ----
  try {
    await symlink('AGENTS.md', join(workspaceDir, 'CLAUDE.md'))
  } catch (err: unknown) {
    if (isNodeError(err) && err.code === 'EEXIST') {
      // Already exists — fine
    } else {
      throw err
    }
  }

  // ---- 18. Make scripts executable ----
  await makeExecutable(scriptsDest)

  // ---- 19. Save/update global config ----
  if (!existingConfig) {
    const newConfig = createDefaultConfig({
      name: userName,
      role: userRole,
    })
    await writeConfig(newConfig)
  }

  // Copy shared files from global config if they exist
  const sharedFiles = await listSharedFiles()
  for (const { relativePath, absolutePath } of sharedFiles) {
    const destPath = join(workspaceDir, relativePath)
    await mkdir(join(destPath, '..'), { recursive: true })
    await copyFile(absolutePath, destPath)
  }

  // ---- 20. Register workspace ----
  await registerWorkspace({
    name,
    path: workspaceDir,
    agent: name,
    created_at: new Date().toISOString().split('T')[0],
  })

  // ---- 21. Run install-cli.sh ----
  const installCliPath = join(scriptsDest, 'install-cli.sh')
  let cliInstalled = false

  // STRAPER_SKIP_CLI_INSTALL=1 no-ops the install so a test/sandbox run never symlinks into a real bin dir.
  if (process.env.STRAPER_SKIP_CLI_INSTALL === '1') {
    process.stdout.write('CLI install skipped (STRAPER_SKIP_CLI_INSTALL=1).\n')
  } else {
    const cliInstallTarget = await resolveCliInstallTarget(existingConfig)
    if (cliInstallTarget) {
      try {
        execSync(`bash "${installCliPath}" "${cliInstallTarget}"`, {
          cwd: workspaceDir,
          stdio: 'pipe',
        })
        cliInstalled = true
      } catch {
        // Non-fatal — will print manual instructions
      }
    }
  }

  // ---- 22. Initial git commit ----
  try {
    execSync('git add -A', { cwd: workspaceDir, stdio: 'pipe' })
    execSync(`git -c commit.gpgSign=false commit -m "feat: initialize ${vars.agent_display_name} workspace"`, {
      cwd: workspaceDir,
      stdio: 'pipe',
      env: { ...process.env, GIT_AUTHOR_NAME: userName, GIT_COMMITTER_NAME: userName },
    })
  } catch {
    // May fail if git user.email is not configured — non-fatal
    process.stdout.write(
      'Warning: Could not create initial commit. Run "git add -A && git commit" manually.\n',
    )
  }

  // ---- 23. Print getting-started guide ----
  printGettingStarted({
    name,
    displayName: vars.agent_display_name,
    workspaceDir,
    cliInstalled,
  })
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function capitalize(s: string): string {
  if (s.length === 0) return s
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function error(message: string): never {
  process.stderr.write(`Error: ${message}\n`)
  process.exit(1)
}

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err
}

/**
 * Recursively make all .sh files and the agent-named CLI wrapper executable.
 */
async function makeExecutable(dir: string): Promise<void> {
  const entries = await readdir(dir)
  for (const entry of entries) {
    const fullPath = join(dir, entry)
    const info = await stat(fullPath)
    if (info.isDirectory()) {
      await makeExecutable(fullPath)
    } else if (
      entry.endsWith('.sh') ||
      entry.endsWith('.js') ||
      // The agent-named wrapper (no extension) — executable bash scripts
      (!entry.includes('.') && info.size > 0)
    ) {
      await chmod(fullPath, 0o755)
    }
  }
}

/**
 * Copy files with agent_name substitution in both filenames and content.
 * Replaces only {{agent_name}} and {{agent_display_name}}.
 * Other {{placeholders}} are runtime variables and must be preserved.
 */
async function copyWithAgentSubstitution(source: string, dest: string, vars: TemplateVariables): Promise<void> {
  await mkdir(dest, { recursive: true })
  const entries = await readdir(source)
  for (const entry of entries) {
    const srcPath = join(source, entry)
    const destName = entry.replaceAll('{{agent_name}}', vars.agent_name)
    const info = await stat(srcPath)
    if (info.isDirectory()) {
      await copyWithAgentSubstitution(srcPath, join(dest, destName), vars)
    } else {
      let content = await readFile(srcPath, 'utf-8')
      content = content.replaceAll('{{agent_name}}', vars.agent_name)
      content = content.replaceAll('{{agent_display_name}}', vars.agent_display_name)
      await writeFile(join(dest, destName), content, 'utf-8')
    }
  }
}

function printGettingStarted(opts: {
  name: string
  displayName: string
  workspaceDir: string
  cliInstalled: boolean
}): void {
  const { name, displayName, workspaceDir, cliInstalled } = opts

  const lines = [
    '',
    `  Created ${displayName} workspace at ${workspaceDir}`,
    '',
    '  Workspace structure:',
    '    AGENTS.md          Main instructions',
    '    SOUL.md            Agent persona',
    '    preferences.json   Workspace conventions',
    `    scripts/${name}.js  CLI orchestrator`,
    '    tasks/             Task tracking',
    '    designs/           Feature designs',
    '',
    '  Customize your workspace:',
    '    Open preferences.json to configure:',
    '    - commits    — style, footer, co-authored-by',
    '    - branches   — prefix, format',
    '    - worktrees  — naming pattern',
    '    - subagents  — parallelism limits',
    '',
    '  Next steps:',
    `    cd ${workspaceDir}`,
  ]

  if (cliInstalled) {
    lines.push(`    ${name} --help                    # See available commands`)
  } else {
    lines.push(`    ./scripts/${name} --help           # See available commands`)
    lines.push(`    ./scripts/install-cli.sh           # Install CLI to PATH`)
  }

  lines.push('    ./scripts/task create "My first task"')
  lines.push('    # Start a session with your preferred AI assistant')
  lines.push('')

  process.stdout.write(lines.join('\n'))
}
