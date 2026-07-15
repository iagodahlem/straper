import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { createRequire } from 'node:module'
import { execFileSync } from 'node:child_process'
import { mkdtemp, rm, copyFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const scaffoldCliUtils = fileURLToPath(
  new URL('../../scaffold/scripts/lib/cli-utils.js', import.meta.url),
)

// The bundled task@0.1.1 / ship@0.1.1 registry modules require these helpers
// from the scaffolded runtime baseline; a fresh workspace breaks without them.
const REQUIRED_EXPORTS = ['parseGitHubSlug', 'resolveRepoSlug'] as const

function gitInitWithOrigin(dir: string, originUrl: string): void {
  execFileSync('git', ['init', '-q'], { cwd: dir })
  execFileSync('git', ['remote', 'add', 'origin', originUrl], { cwd: dir })
}

describe('scaffold cli-utils github slug helpers', () => {
  // The scaffold copy is CommonJS; load it the way a generated workspace does
  // (as CJS) by requiring a .cjs copy, sidestepping this repo's type:module.
  let loadDir: string
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let cliUtils: any

  beforeAll(async () => {
    loadDir = await mkdtemp(join(tmpdir(), 'straper-cliutils-'))
    const cjsPath = join(loadDir, 'cli-utils.cjs')
    await copyFile(scaffoldCliUtils, cjsPath)
    cliUtils = createRequire(import.meta.url)(cjsPath)
  })

  afterAll(async () => {
    await rm(loadDir, { recursive: true, force: true })
  })

  it('exports the helpers the bundled task/ship modules require', () => {
    for (const name of REQUIRED_EXPORTS) {
      expect(typeof cliUtils[name], `cli-utils must export ${name}`).toBe('function')
    }
  })

  it('parses ssh, https, and scp-style GitHub remotes into owner/repo', () => {
    const { parseGitHubSlug } = cliUtils
    expect(parseGitHubSlug('git@github.com:acme/widgets.git')).toBe('acme/widgets')
    expect(parseGitHubSlug('https://github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(parseGitHubSlug('https://github.com/acme/widgets')).toBe('acme/widgets')
    expect(parseGitHubSlug('ssh://git@github.com/acme/widgets.git')).toBe('acme/widgets')
    expect(parseGitHubSlug('git@gitlab.com:acme/widgets.git')).toBeNull()
    expect(parseGitHubSlug('')).toBeNull()
    expect(parseGitHubSlug(null)).toBeNull()
  })

  describe('resolveRepoSlug', () => {
    let base: string
    let sshDir: string
    let httpsDir: string
    let noRemoteDir: string

    beforeAll(async () => {
      base = await mkdtemp(join(tmpdir(), 'straper-slug-'))
      sshDir = join(base, 'ssh')
      httpsDir = join(base, 'https')
      noRemoteDir = join(base, 'bare')
      for (const dir of [sshDir, httpsDir, noRemoteDir]) {
        execFileSync('mkdir', ['-p', dir])
      }
      gitInitWithOrigin(sshDir, 'git@github.com:acme/webapp.git')
      gitInitWithOrigin(httpsDir, 'https://github.com/acme/webapp.git')
      execFileSync('git', ['init', '-q'], { cwd: noRemoteDir })
    })

    afterAll(async () => {
      await rm(base, { recursive: true, force: true })
    })

    it('returns a slug as-is without probing remotes', () => {
      expect(cliUtils.resolveRepoSlug('acme/task', [])).toBe('acme/task')
    })

    it('derives owner from an ssh origin remote', () => {
      expect(cliUtils.resolveRepoSlug('task', [sshDir])).toBe('acme/task')
    })

    it('derives owner from an https origin remote', () => {
      expect(cliUtils.resolveRepoSlug('ship', [httpsDir])).toBe('acme/ship')
    })

    it('falls back to the next candidate when a checkout has no github origin', () => {
      expect(cliUtils.resolveRepoSlug('task', [noRemoteDir, httpsDir])).toBe('acme/task')
    })

    it('returns null when no candidate yields a github owner', () => {
      expect(cliUtils.resolveRepoSlug('task', [noRemoteDir])).toBeNull()
      expect(cliUtils.resolveRepoSlug('task', [])).toBeNull()
      expect(cliUtils.resolveRepoSlug('', [sshDir])).toBeNull()
    })
  })
})
