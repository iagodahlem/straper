import { VERSION } from './constants.js'
import { add } from './commands/add.js'
import { doctor } from './commands/doctor.js'
import { drift } from './commands/drift.js'
import { init } from './commands/init.js'
import { migrate } from './commands/migrate.js'
import { publish } from './commands/publish.js'
import { status } from './commands/status.js'
import { update } from './commands/update.js'
import { use } from './commands/use.js'

function parseFlag(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  if (index === -1 || index + 1 >= args.length) return undefined
  return args[index + 1]
}

function hasFlag(args: string[], ...flags: string[]): boolean {
  return flags.some((flag) => args.includes(flag))
}

/**
 * Collect positional (non-flag) arguments, skipping the value that follows any
 * flag that takes one.
 */
function collectPositionals(args: string[], valueFlags: string[]): string[] {
  const positionals: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--')) {
      if (valueFlags.includes(arg)) i++
      continue
    }
    positionals.push(arg)
  }
  return positionals
}

function printHelp(): void {
  console.log(`straper v${VERSION}

The agent that keeps the harness in place.
Scaffold, configure, and maintain AI agent workspaces.

Usage:
  straper init <name> [options]      Scaffold a new agent workspace
  straper init --adopt [options]     Adopt an existing workspace into module management
  straper add <module...> [opts]     Vendor registry modules into a workspace
  straper use <module> [opts]        Print a skill for one-off session use (nothing installed)
  straper update [module...] [opts]  Update vendored modules, merging local edits
  straper doctor [options]           Check vendored module health
  straper drift [options]            Report published skills that drifted from the ledger
  straper publish <module> [opts]    Publish a workspace skill into a registry checkout
  straper migrate [options]          Migrate a pre-registry workspace onto the registry model
  straper status                     Show workspace status
  straper --version                  Print version
  straper --help                     Show this help

Init options:
  --dir <path>          Target directory (default: ./<name>)
  --user <name>         User name for workspace config
  --role <role>         User role (default: "Software Engineer")
  --project <name>      Project name
  --description <desc>  Project description
  --adopt               Adopt an existing workspace into module management (no scaffolding)
  --registry <dir>      Registry directory for --adopt (default: STRAPER_REGISTRY_DIR or bundled)

Add options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)
  --no-agents-dir       Skip the universal .agents/skills/<name>/SKILL.md pointer (or STRAPER_NO_AGENTS_DIR=1)

Use options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)

Update options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)

Doctor options:
  --dir <path>          Workspace directory (default: current directory)

Drift options:
  --dir <path>          Workspace directory (default: current directory)
  --quiet               Silent when clean; print a one-line warning only on drift (used at boot)

Publish options:
  --dir <path>          Workspace directory (default: current directory)
  --registry-repo <path>  Registry repo checkout to publish into (or STRAPER_REGISTRY_REPO)

Migrate options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)
  --dry-run             Show planned changes without modifying files`)
}

function printVersion(): void {
  console.log(VERSION)
}

function printInitHelp(): void {
  console.log(`straper init <name> [options]

Scaffold a new agent workspace.

Options:
  --dir <path>          Target directory (default: ./<name>)
  --user <name>         User name for workspace config
  --role <role>         User role (default: "Software Engineer")
  --project <name>      Project name
  --description <desc>  Project description

See also: straper init --adopt --help`)
}

function printInitAdoptHelp(): void {
  console.log(`straper init --adopt [options]

Adopt an existing workspace into module management (no scaffolding).

Options:
  --dir <path>          Target directory (default: current directory)
  --registry <dir>      Registry directory for --adopt (default: STRAPER_REGISTRY_DIR or bundled)`)
}

function printAddHelp(): void {
  console.log(`straper add <module...> [options]

Vendor registry modules into a workspace.

Options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)
  --no-agents-dir       Skip the universal .agents/skills/<name>/SKILL.md pointer (or STRAPER_NO_AGENTS_DIR=1)`)
}

function printUseHelp(): void {
  console.log(`straper use <module> [options]

Print a skill for one-off session use (nothing installed).

Options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)`)
}

function printUpdateHelp(): void {
  console.log(`straper update [module...] [options]

Update vendored modules, merging local edits.

Options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)`)
}

function printDoctorHelp(): void {
  console.log(`straper doctor [options]

Check vendored module health.

Options:
  --dir <path>          Workspace directory (default: current directory)`)
}

function printDriftHelp(): void {
  console.log(`straper drift [options]

Report published skills that drifted from the ledger.

Options:
  --dir <path>          Workspace directory (default: current directory)
  --quiet               Silent when clean; print a one-line warning only on drift (used at boot)`)
}

function printPublishHelp(): void {
  console.log(`straper publish <module> [options]

Publish a workspace skill into a registry checkout.

Options:
  --dir <path>          Workspace directory (default: current directory)
  --registry-repo <path>  Registry repo checkout to publish into (or STRAPER_REGISTRY_REPO)`)
}

function printMigrateHelp(): void {
  console.log(`straper migrate [options]

Migrate a pre-registry workspace onto the registry model.

Options:
  --dir <path>          Workspace directory (default: current directory)
  --registry <dir>      Registry directory (default: STRAPER_REGISTRY_DIR or bundled registry)
  --dry-run             Show planned changes without modifying files`)
}

function printStatusHelp(): void {
  console.log(`straper status

Show workspace status. Reads ~/.config/straper/workspaces.json, a machine-global registry, not scoped to the current project.`)
}

const COMMAND_HELP: Record<string, () => void> = {
  init: printInitHelp,
  add: printAddHelp,
  use: printUseHelp,
  update: printUpdateHelp,
  doctor: printDoctorHelp,
  drift: printDriftHelp,
  publish: printPublishHelp,
  migrate: printMigrateHelp,
  status: printStatusHelp,
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = argv

  if (args.length === 0) {
    printHelp()
    return
  }

  const command = args[0]

  if (hasFlag(args, '--help', '-h')) {
    if (command === 'init' && hasFlag(args, '--adopt')) {
      printInitAdoptHelp()
    } else if (Object.prototype.hasOwnProperty.call(COMMAND_HELP, command)) {
      COMMAND_HELP[command]()
    } else {
      printHelp()
    }
    return
  }

  if (hasFlag(args, '--version', '-v')) {
    printVersion()
    return
  }

  switch (command) {
    case 'init': {
      const adopt = hasFlag(args, '--adopt')
      const name = adopt ? '' : args[1]
      if (!adopt && (!name || name.startsWith('--'))) {
        console.error('Error: straper init requires a <name> argument.')
        console.error('Usage: straper init <name> [--dir <path>] [--user <name>] [--project <name>] [--description <desc>]')
        console.error('   or: straper init --adopt [--dir <path>] [--registry <dir>]')
        process.exit(1)
      }
      await init({
        name,
        adopt,
        dir: parseFlag(args, '--dir'),
        registry: parseFlag(args, '--registry'),
        user: parseFlag(args, '--user'),
        role: parseFlag(args, '--role'),
        project: parseFlag(args, '--project'),
        description: parseFlag(args, '--description'),
      })
      break
    }
    case 'add': {
      const modules = collectPositionals(args.slice(1), ['--dir', '--registry'])
      if (modules.length === 0) {
        console.error('Error: straper add requires at least one <module> argument.')
        console.error('Usage: straper add <module...> [--dir <path>] [--registry <dir>]')
        process.exit(1)
      }
      await add({
        modules,
        dir: parseFlag(args, '--dir'),
        registry: parseFlag(args, '--registry'),
        noAgentsDir: hasFlag(args, '--no-agents-dir'),
      })
      break
    }
    case 'use': {
      const positionals = collectPositionals(args.slice(1), ['--dir', '--registry'])
      const module = positionals[0]
      if (!module) {
        console.error('Error: straper use requires a <module> argument.')
        console.error('Usage: straper use <module> [--dir <path>] [--registry <dir>]')
        process.exit(1)
      }
      await use({
        module,
        dir: parseFlag(args, '--dir'),
        registry: parseFlag(args, '--registry'),
      })
      break
    }
    case 'update': {
      const modules = collectPositionals(args.slice(1), ['--dir', '--registry'])
      await update({
        modules,
        dir: parseFlag(args, '--dir'),
        registry: parseFlag(args, '--registry'),
      })
      break
    }
    case 'doctor': {
      await doctor({ dir: parseFlag(args, '--dir') })
      break
    }
    case 'drift': {
      await drift({ dir: parseFlag(args, '--dir'), quiet: hasFlag(args, '--quiet') })
      break
    }
    case 'status': {
      await status()
      break
    }
    case 'publish': {
      const positionals = collectPositionals(args.slice(1), ['--dir', '--registry-repo'])
      const module = positionals[0]
      if (!module) {
        console.error('Error: straper publish requires a <module> argument.')
        console.error('Usage: straper publish <module> [--dir <path>] [--registry-repo <path>]')
        process.exit(1)
      }
      await publish({
        module,
        dir: parseFlag(args, '--dir'),
        registryRepo: parseFlag(args, '--registry-repo'),
      })
      break
    }
    case 'migrate': {
      await migrate({
        dir: parseFlag(args, '--dir'),
        registry: parseFlag(args, '--registry'),
        dryRun: hasFlag(args, '--dry-run'),
      })
      break
    }
    default: {
      console.error(`Unknown command: ${command}`)
      console.error('Run "straper --help" for usage.')
      process.exit(1)
    }
  }
}
