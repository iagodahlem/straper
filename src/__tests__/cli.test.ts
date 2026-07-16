import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  addMock,
  doctorMock,
  driftMock,
  initMock,
  migrateMock,
  publishMock,
  statusMock,
  updateMock,
  useMock,
} = vi.hoisted(() => ({
  addMock: vi.fn(),
  doctorMock: vi.fn(),
  driftMock: vi.fn(),
  initMock: vi.fn(),
  migrateMock: vi.fn(),
  publishMock: vi.fn(),
  statusMock: vi.fn(),
  updateMock: vi.fn(),
  useMock: vi.fn(),
}))

vi.mock('../commands/add.js', () => ({
  add: addMock,
}))

vi.mock('../commands/use.js', () => ({
  use: useMock,
}))

vi.mock('../commands/doctor.js', () => ({
  doctor: doctorMock,
}))

vi.mock('../commands/drift.js', () => ({
  drift: driftMock,
}))

vi.mock('../commands/init.js', () => ({
  init: initMock,
}))

vi.mock('../commands/migrate.js', () => ({
  migrate: migrateMock,
}))

vi.mock('../commands/publish.js', () => ({
  publish: publishMock,
}))

vi.mock('../commands/status.js', () => ({
  status: statusMock,
}))

vi.mock('../commands/update.js', () => ({
  update: updateMock,
}))

import { main } from '../cli.js'

describe('cli', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('prints help including migrate usage', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'])

    expect(logSpy).toHaveBeenCalledTimes(1)
    expect(logSpy.mock.calls[0][0]).toContain('straper migrate [options]')
  })

  it('routes migrate flags to the migrate command', async () => {
    await main(['migrate', '--dir', '/tmp/old-workspace', '--dry-run'])

    expect(migrateMock).toHaveBeenCalledWith({
      dir: '/tmp/old-workspace',
      dryRun: true,
      skipValidate: false,
    })
  })

  it('prints help including add usage', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'])

    expect(logSpy.mock.calls[0][0]).toContain('straper add <module...>')
  })

  it('routes add module names and flags to the add command', async () => {
    await main(['add', 'session-review', 'task', '--dir', '/tmp/ws', '--registry', '/tmp/reg'])

    expect(addMock).toHaveBeenCalledWith({
      modules: ['session-review', 'task'],
      dir: '/tmp/ws',
      registry: '/tmp/reg',
      noAgentsDir: false,
    })
  })

  it('routes the --no-agents-dir flag to the add command', async () => {
    await main(['add', 'session-review', '--no-agents-dir'])

    expect(addMock).toHaveBeenCalledWith({
      modules: ['session-review'],
      dir: undefined,
      registry: undefined,
      noAgentsDir: true,
    })
  })

  it('prints help including use usage', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'])

    expect(logSpy.mock.calls[0][0]).toContain('straper use <module>')
  })

  it('routes use module and flags to the use command', async () => {
    await main(['use', 'session-review', '--dir', '/tmp/ws', '--registry', '/tmp/reg'])

    expect(useMock).toHaveBeenCalledWith({
      module: 'session-review',
      dir: '/tmp/ws',
      registry: '/tmp/reg',
    })
  })

  it('errors when use is called without a module', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    try {
      await expect(main(['use'])).rejects.toThrow('process.exit(1)')
      expect(errSpy.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
        'requires a <module> argument',
      )
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
    expect(useMock).not.toHaveBeenCalled()
  })

  it('prints help including update and doctor usage', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'])

    expect(logSpy.mock.calls[0][0]).toContain('straper update [module...]')
    expect(logSpy.mock.calls[0][0]).toContain('straper doctor [options]')
  })

  it('routes update module names and flags to the update command', async () => {
    await main(['update', 'session-review', '--dir', '/tmp/ws', '--registry', '/tmp/reg'])

    expect(updateMock).toHaveBeenCalledWith({
      modules: ['session-review'],
      dir: '/tmp/ws',
      registry: '/tmp/reg',
    })
  })

  it('routes update with no module names as an update-all', async () => {
    await main(['update'])

    expect(updateMock).toHaveBeenCalledWith({
      modules: [],
      dir: undefined,
      registry: undefined,
    })
  })

  it('routes doctor flags to the doctor command', async () => {
    await main(['doctor', '--dir', '/tmp/ws'])

    expect(doctorMock).toHaveBeenCalledWith({ dir: '/tmp/ws' })
  })

  it('routes drift flags to the drift command', async () => {
    await main(['drift', '--dir', '/tmp/ws', '--quiet'])

    expect(driftMock).toHaveBeenCalledWith({ dir: '/tmp/ws', quiet: true })
  })

  it('defaults drift --quiet to false', async () => {
    await main(['drift'])

    expect(driftMock).toHaveBeenCalledWith({ dir: undefined, quiet: false })
  })

  it('prints help including publish usage', async () => {
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

    await main(['--help'])

    expect(logSpy.mock.calls[0][0]).toContain('straper publish <module>')
  })

  it('routes publish module and flags to the publish command', async () => {
    await main(['publish', 'session-review', '--dir', '/tmp/ws', '--registry-repo', '/tmp/reg'])

    expect(publishMock).toHaveBeenCalledWith({
      module: 'session-review',
      dir: '/tmp/ws',
      registryRepo: '/tmp/reg',
    })
  })

  it('errors when publish is called without a module', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((code) => {
      throw new Error(`process.exit(${code})`)
    })
    try {
      await expect(main(['publish'])).rejects.toThrow('process.exit(1)')
      expect(errSpy.mock.calls.map(([m]) => String(m)).join('\n')).toContain(
        'requires a <module> argument',
      )
    } finally {
      exitSpy.mockRestore()
      errSpy.mockRestore()
    }
    expect(publishMock).not.toHaveBeenCalled()
  })
})
