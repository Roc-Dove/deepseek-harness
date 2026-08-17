import { describe, expect, it } from 'vitest'
import runtimeSmokeModule from '../scripts/verify-runtime.cjs'

interface RuntimeSmokeModule {
  packagedExecutable: (
    packaged: { application: string },
    request: { builderPlatform: 'mac' | 'win' },
  ) => string
  readyUrl: (message: unknown) => string | undefined
  smokeEnvironment: (environment: NodeJS.ProcessEnv, dshHome: string) => NodeJS.ProcessEnv
}

const {
  packagedExecutable,
  readyUrl,
  smokeEnvironment,
} = runtimeSmokeModule as RuntimeSmokeModule

describe('packaged desktop runtime smoke', () => {
  it('launches the branded executable from the unpacked native application', () => {
    expect(packagedExecutable(
      { application: '/release/mac-arm64/DeepSeek Harness.app' },
      { builderPlatform: 'mac' },
    )).toBe('/release/mac-arm64/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness')
    expect(packagedExecutable(
      { application: 'C:\\release\\win-unpacked' },
      { builderPlatform: 'win' },
    )).toMatch(/DeepSeek Harness\.exe$/)
  })

  it('sanitizes Node injection and credential-bearing variables before launch', () => {
    expect(smokeEnvironment({
      PATH: '/usr/bin:/bin',
      NODE_OPTIONS: '--require=/tmp/injected.cjs',
      node_path: '/tmp/modules',
      Dsh_Home: '/tmp/inherited-home',
      electron_run_as_node: '0',
      dsh_desktop_deployment: 'source',
      DSH_DESKTOP_PATCHES: '["/tmp/private.yml"]',
      DSH_REPO_ROOT: '/checkout',
      DEEPSEEK_API_KEY: 'private',
      SERVICE_TOKEN: 'private',
    }, '/tmp/fresh-home')).toEqual({
      PATH: '/usr/bin:/bin',
      DSH_DESKTOP_DEPLOYMENT: 'packaged',
      DSH_HOME: '/tmp/fresh-home',
      ELECTRON_RUN_AS_NODE: '1',
      NO_COLOR: '1',
    })
  })

  it('accepts only an exact loopback IPC readiness origin', () => {
    expect(readyUrl({
      type: 'dsh:desktop-ready',
      url: 'http://127.0.0.1:51904',
    })).toBe('http://127.0.0.1:51904')
    expect(readyUrl({
      type: 'dsh:desktop-ready',
      url: 'http://localhost:51904',
    })).toBeUndefined()
    expect(readyUrl({
      type: 'dsh:desktop-ready',
      url: 'http://127.0.0.1:51904/private',
    })).toBeUndefined()
  })
})
