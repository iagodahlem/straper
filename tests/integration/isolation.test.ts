import { describe, it, expect, inject } from 'vitest'
import { homedir, tmpdir } from 'node:os'
import { mkdtemp, rm, lstat } from 'node:fs/promises'
import { join } from 'node:path'
import { init } from '../../src/commands/init.js'

// Fails loudly if suite-wide home isolation is ever lost: proves os.homedir()
// resolves inside the per-run temp home, that the STRAPER_SKIP_CLI_INSTALL guard
// is active, and that a real init contains its CLI symlink to the FAKE home.
const fakeHome = inject('fakeHome')

describe('test isolation — home is faked and CLI install is contained', () => {
  it('os.homedir() resolves inside the per-run temp home', () => {
    expect(process.env.HOME).toBe(fakeHome)
    expect(homedir()).toBe(fakeHome)
    expect(fakeHome).toContain('straper-test-home-')
  })

  it('STRAPER_SKIP_CLI_INSTALL=1 makes the CLI-install step a no-op', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'straper-iso-skip-'))
    try {
      await init({ name: 'skipbot', dir: join(tmp, 'skipbot'), user: 'Test User' })
      await expect(lstat(join(fakeHome, '.local', 'bin', 'skipbot'))).rejects.toThrow()
    } finally {
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })

  it('with the guard cleared, the install symlink lands in the FAKE home', async () => {
    const tmp = await mkdtemp(join(tmpdir(), 'straper-iso-install-'))
    const prev = process.env.STRAPER_SKIP_CLI_INSTALL
    delete process.env.STRAPER_SKIP_CLI_INSTALL
    try {
      await init({ name: 'containbot', dir: join(tmp, 'containbot'), user: 'Test User' })
      const info = await lstat(join(fakeHome, '.local', 'bin', 'containbot'))
      expect(info.isSymbolicLink()).toBe(true)
    } finally {
      if (prev === undefined) delete process.env.STRAPER_SKIP_CLI_INSTALL
      else process.env.STRAPER_SKIP_CLI_INSTALL = prev
      await rm(tmp, { recursive: true, force: true, maxRetries: 3 })
    }
  })
})
