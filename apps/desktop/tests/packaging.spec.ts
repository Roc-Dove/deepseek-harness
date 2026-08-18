import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import packagingModule from '../scripts/packaging.cjs'

interface BuildRequest {
  arch: string
  builderPlatform: 'mac' | 'win'
  mode: 'dir' | 'dist'
  outputName: string
  platform: 'darwin' | 'win32'
}

interface PackagingModule {
  ARTIFACT_ROOT: string
  SHELL_FILES: string[]
  assertNoSymbolicLinks: (directory: string) => Promise<void>
  assertPayloadHygiene: (
    directory: string,
    label: string,
    identity?: { names: string[]; paths: string[] },
  ) => Promise<void>
  assertRuntimeClosure: (directory: string) => Promise<number>
  createBuilderConfiguration: (options: {
    backendStage: string
    legalStage: string
    notarize: boolean
    outputDirectory: string
    request: BuildRequest
    requireSigning: boolean
    shellStage: string
  }) => Record<string, unknown>
  createShellManifest: (source: Record<string, unknown>) => Record<string, unknown>
  deploymentArguments: (backendStage: string) => string[]
  ensureArtifactRoot: () => Promise<void>
  pnpmCommandSpec: (options?: {
    environment?: Record<string, string | undefined>
    nodeExecPath?: string
    platform?: NodeJS.Platform
  }) => { command: string; prefixArgs: string[] }
  promoteBackendPackage: (directory: string) => Promise<void>
  resolveBuildRequest: (target: string, platform?: NodeJS.Platform, arch?: string) => BuildRequest
  sanitizeGeneratedSourcePaths: (
    directory: string,
    identity?: { names: string[]; paths: string[] },
  ) => Promise<void>
  shippedAgentPresetIds: () => Promise<string[]>
  verifyBuildMetadata: (outputDirectory: string) => Promise<Record<string, unknown>>
  verifyShippedAgentPresets: (backend: string) => Promise<void>
  writeBuildMetadata: (options: {
    outputDirectory: string
    packaged: {
      appAsar: string
      application: string
      backendEntry: string
      backendManifest: Record<string, unknown>
      legal: string
    }
    request: BuildRequest
    shellManifest: Record<string, unknown>
    source: { commit: string; dirty: boolean }
  }) => Promise<Record<string, unknown>>
}

const {
  ARTIFACT_ROOT,
  SHELL_FILES,
  assertNoSymbolicLinks,
  assertPayloadHygiene,
  assertRuntimeClosure,
  createBuilderConfiguration,
  createShellManifest,
  deploymentArguments,
  ensureArtifactRoot,
  pnpmCommandSpec,
  promoteBackendPackage,
  resolveBuildRequest,
  sanitizeGeneratedSourcePaths,
  shippedAgentPresetIds,
  verifyBuildMetadata,
  verifyShippedAgentPresets,
  writeBuildMetadata,
} = packagingModule as PackagingModule
const temporaryDirectories: string[] = []

async function artifactTemporaryDirectory(): Promise<string> {
  await ensureArtifactRoot()
  const directory = await mkdtemp(join(ARTIFACT_ROOT, '.packaging-test-'))
  temporaryDirectories.push(directory)
  return directory
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('desktop native target selection', () => {
  it('selects only native macOS and Windows architectures', () => {
    expect(resolveBuildRequest('host', 'darwin', 'arm64')).toEqual({
      arch: 'arm64',
      builderPlatform: 'mac',
      mode: 'dist',
      outputName: 'mac-arm64',
      platform: 'darwin',
    })
    expect(resolveBuildRequest('dir', 'win32', 'x64')).toEqual({
      arch: 'x64',
      builderPlatform: 'win',
      mode: 'dir',
      outputName: 'win-x64',
      platform: 'win32',
    })
  })

  it.each([
    ['mac', 'win32', 'x64', /native macOS host/],
    ['win', 'darwin', 'arm64', /native Windows x64 host/],
    ['host', 'linux', 'x64', /built natively/],
    ['host', 'win32', 'arm64', /Windows builds require a native x64 host/],
  ])('rejects unsupported target %s on %s-%s', (target, platform, arch, message) => {
    expect(() => resolveBuildRequest(target, platform as NodeJS.Platform, arch)).toThrow(message)
  })

  it('redacts build-machine paths only from generated region comments', async () => {
    const directory = await artifactTemporaryDirectory()
    const bundle = join(directory, 'client.js')
    await writeFile(bundle, '//#region \\0dsh-css:/Users/local/private/src/client.css\nexport {}\n')

    await sanitizeGeneratedSourcePaths(directory, {
      names: ['private-user-name'],
      paths: ['/Users/local/private'],
    })

    expect(await readFile(bundle, 'utf8')).toBe('//#region \\0dsh-css:<source-root>/src/client.css\nexport {}\n')
    await expect(assertPayloadHygiene(directory, 'test payload', {
      names: ['private-user-name'],
      paths: ['/Users/local/private'],
    })).resolves.toBeUndefined()
  })
})

describe('desktop packaging inputs', () => {
  it('stages only the runtime shell manifest fields', () => {
    expect(createShellManifest({
      name: '@deepseek-ai/dsh-desktop',
      version: '0.1.0',
      description: 'Desktop application',
      license: 'MIT',
      private: true,
      main: 'main.cjs',
      scripts: { postinstall: 'unexpected-side-effect' },
      dependencies: { secret: 'file:/checkout/secret' },
      devDependencies: { electron: '39.8.10' },
    })).toEqual({
      name: '@deepseek-ai/dsh-desktop',
      version: '0.1.0',
      description: 'Desktop application',
      license: 'MIT',
      private: true,
      main: 'main.cjs',
    })
    expect(SHELL_FILES).toEqual(['assets', 'main.cjs', 'package.json', 'runtime.cjs'])
  })

  it('uses a hoisted production deploy with no shell command composition', () => {
    expect(deploymentArguments('/private/stage/backend')).toEqual([
      '--trust-lockfile',
      '--filter',
      '@deepseek-ai/dsh-desktop',
      'deploy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.inject-workspace-packages=true',
      '--config.strict-dep-builds=false',
      '/private/stage/backend',
    ])
  })

  it('keeps the non-Windows pnpm command unchanged', () => {
    expect(pnpmCommandSpec({
      environment: { npm_execpath: '/ignored/pnpm.cjs' },
      nodeExecPath: '/ignored/node',
      platform: 'darwin',
    })).toEqual({ command: 'pnpm', prefixArgs: [] })
  })

  it.each(['pnpm.cjs', 'pnpm.js', 'pnpm.mjs'])('runs the Windows %s CLI through Node with discrete deployment argv', (filename) => {
    const npmExecPath = `C:\\Program Files\\CI & package\\node_modules\\pnpm\\bin\\${filename}`
    const nodeExecPath = 'C:\\Program Files\\nodejs\\node.exe'
    const backendStage = 'C:\\checkout & stage\\backend'
    const spec = pnpmCommandSpec({
      environment: { npm_execpath: npmExecPath },
      nodeExecPath,
      platform: 'win32',
    })

    expect(spec).toEqual({ command: nodeExecPath, prefixArgs: [npmExecPath] })
    expect([...spec.prefixArgs, ...deploymentArguments(backendStage)]).toEqual([
      npmExecPath,
      '--trust-lockfile',
      '--filter',
      '@deepseek-ai/dsh-desktop',
      'deploy',
      '--prod',
      '--config.node-linker=hoisted',
      '--config.inject-workspace-packages=true',
      '--config.strict-dep-builds=false',
      backendStage,
    ])
  })

  it('accepts an absolute Windows UNC path for the pnpm CLI', () => {
    const npmExecPath = '\\\\build-server\\pnpm\\bin\\pnpm.mjs'
    expect(pnpmCommandSpec({
      environment: { npm_execpath: npmExecPath },
      nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      platform: 'win32',
    })).toEqual({
      command: 'C:\\Program Files\\nodejs\\node.exe',
      prefixArgs: [npmExecPath],
    })
  })

  it.each([
    [{}, /requires npm_execpath/],
    [{ npm_execpath: '' }, /requires npm_execpath/],
    [{ npm_execpath: 'node_modules\\pnpm\\bin\\pnpm.cjs' }, /absolute pnpm\.cjs, pnpm\.js, or pnpm\.mjs path/],
    [{ npm_execpath: 'C:relative\\pnpm.mjs' }, /absolute pnpm\.cjs, pnpm\.js, or pnpm\.mjs path/],
    [{ npm_execpath: 'C:\\tools\\pnpm.cmd' }, /absolute pnpm\.cjs, pnpm\.js, or pnpm\.mjs path/],
    [{ npm_execpath: 'C:\\tools\\npm.cjs' }, /absolute pnpm\.cjs, pnpm\.js, or pnpm\.mjs path/],
  ])('fails closed for an invalid Windows pnpm environment', (environment, message) => {
    expect(() => pnpmCommandSpec({
      environment,
      nodeExecPath: 'C:\\Program Files\\nodejs\\node.exe',
      platform: 'win32',
    })).toThrow(message)
  })

  it('promotes the deployed CLI package over the private closure root', async () => {
    const directory = await artifactTemporaryDirectory()
    const source = join(directory, 'deployed-cli')
    const installed = join(directory, 'backend', 'node_modules', '@deepseek-ai', 'dsh')
    await Promise.all([
      mkdir(join(source, 'lib'), { recursive: true }),
      mkdir(join(directory, 'backend', 'node_modules', '@deepseek-ai'), { recursive: true }),
    ])
    await Promise.all([
      writeFile(join(source, 'package.json'), '{"name":"@deepseek-ai/dsh","version":"1.0.0"}\n'),
      writeFile(join(source, 'lib', 'bin.js'), 'entry'),
      writeFile(join(directory, 'backend', 'main.cjs'), 'desktop-only'),
      writeFile(join(directory, 'backend', 'package.json'), '{"name":"@deepseek-ai/dsh-desktop"}\n'),
    ])
    await symlink(source, installed)

    await promoteBackendPackage(join(directory, 'backend'))

    expect(JSON.parse(await readFile(join(directory, 'backend', 'package.json'), 'utf8'))).toMatchObject({
      name: '@deepseek-ai/dsh',
    })
    expect(await readFile(join(directory, 'backend', 'lib', 'bin.js'), 'utf8')).toBe('entry')
    await expect(readFile(join(directory, 'backend', 'main.cjs'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    await expect(readFile(installed, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
  })

  it('keeps the backend outside app.asar and disables native dependency rebuilding', () => {
    const request = resolveBuildRequest('host', 'darwin', 'arm64')
    const config = createBuilderConfiguration({
      backendStage: '/stage/backend',
      legalStage: '/stage/legal',
      notarize: false,
      outputDirectory: '/output',
      request,
      requireSigning: false,
      shellStage: '/stage/shell',
    }) as {
      asar: boolean
      beforeBuild: () => boolean
      electronDist: string
      electronVersion: string
      electronFuses: Record<string, boolean>
      extraResources: Array<{ from: string; to: string }>
      files: Array<{ filter: string[] }>
      forceCodeSigning: boolean
      mac: { identity: '-'; minimumSystemVersion: string; notarize: boolean }
      nodeGypRebuild: boolean
      npmRebuild: boolean
    }

    expect(config).toMatchObject({
      asar: true,
      electronVersion: '39.8.10',
      forceCodeSigning: false,
      nodeGypRebuild: false,
      npmRebuild: true,
    })
    expect(config.beforeBuild()).toBe(false)
    expect(config.electronDist).toMatch(/apps[\\/]desktop[\\/]node_modules[\\/]electron[\\/]dist$/)
    expect(config.files).toEqual([{
      from: '.',
      to: '.',
      filter: ['main.cjs', 'runtime.cjs', 'package.json', 'assets/**/*'],
    }])
    expect(config.extraResources).toEqual([
      { from: '/stage/backend', to: 'backend', filter: ['**/*', '!node_modules{,/**/*}'] },
      { from: '/stage/backend/node_modules', to: 'backend/node_modules', filter: ['**/*'] },
      { from: '/stage/legal', to: 'legal', filter: ['**/*'] },
    ])
    expect(config.electronFuses).toEqual({
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    })
    expect(config.mac.notarize).toBe(false)
    expect(config.mac.identity).toBe('-')
    expect(config.mac.minimumSystemVersion).toBe('12.0')
  })
})

describe('desktop artifact integrity', () => {
  it('requires the complete shipped agent-preset inventory in the backend', async () => {
    const directory = await artifactTemporaryDirectory()
    const backend = join(directory, 'backend')
    const presetIds = await shippedAgentPresetIds()
    expect(presetIds).toContain('computer-use')
    await Promise.all(presetIds.flatMap(id => [
      mkdir(join(backend, 'config', 'agent-presets', id), { recursive: true }).then(() =>
        writeFile(join(backend, 'config', 'agent-presets', id, 'agent.cordis.yml'), '- id: fixture\n')),
      mkdir(join(backend, 'config', 'agent-presets', id), { recursive: true }).then(() =>
        writeFile(join(backend, 'config', 'agent-presets', id, 'preset.yml'), `name: ${id}\n`)),
    ]))

    await expect(verifyShippedAgentPresets(backend)).resolves.toBeUndefined()
    await rm(join(backend, 'config', 'agent-presets', 'computer-use', 'preset.yml'))
    await expect(verifyShippedAgentPresets(backend)).rejects.toThrow(
      /packaged computer-use agent-preset metadata is missing/,
    )
  })

  it('requires every dependency and non-optional peer in the deployed runtime', async () => {
    const directory = await artifactTemporaryDirectory()
    const backend = join(directory, 'backend')
    const consumer = join(backend, 'node_modules', 'consumer')
    await mkdir(consumer, { recursive: true })
    await Promise.all([
      writeFile(join(backend, 'package.json'), '{"name":"backend","dependencies":{"consumer":"1"}}\n'),
      writeFile(join(consumer, 'package.json'), JSON.stringify({
        name: 'consumer',
        dependencies: { provider: '1' },
        peerDependencies: { peer: '1', optional: '1' },
        peerDependenciesMeta: { optional: { optional: true } },
      })),
    ])

    await expect(assertRuntimeClosure(backend)).rejects.toThrow(/consumer -> peer[\s\S]*consumer -> provider/)
    for (const name of ['peer', 'provider']) {
      const installed = join(backend, 'node_modules', name)
      await mkdir(installed)
      await writeFile(join(installed, 'package.json'), `${JSON.stringify({ name })}\n`)
    }
    await expect(assertRuntimeClosure(backend)).resolves.toBe(4)
  })

  it('rejects a backend link without following it into the checkout', async () => {
    const directory = await artifactTemporaryDirectory()
    const backend = join(directory, 'backend')
    await mkdir(backend)
    await writeFile(join(directory, 'outside.txt'), 'do not copy')
    await symlink(join(directory, 'outside.txt'), join(backend, 'checkout-link'))

    await expect(assertNoSymbolicLinks(backend)).rejects.toThrow(/contains a symbolic link/)
    expect(await readFile(join(directory, 'outside.txt'), 'utf8')).toBe('do not copy')
  })

  it.each([
    ['.env.local', 'DEEPSEEK_API_KEY=private', /environment file/],
    ['bundle.js.map', '{}', /source map/],
    ['bundle.js', 'const root = "/Users/local/private/checkout"', /absolute local path/],
    ['bundle.json', '{"owner":"private-user-name"}', /local username/],
  ])('rejects staged payload leakage in %s', async (name, content, message) => {
    const directory = await artifactTemporaryDirectory()
    await writeFile(join(directory, name), content)

    await expect(assertPayloadHygiene(directory, 'test payload', {
      names: ['private-user-name'],
      paths: ['/Users/local/private'],
    })).rejects.toThrow(message)
  })

  it('writes and verifies source-aware build metadata and SHA256SUMS', async () => {
    const outputDirectory = await artifactTemporaryDirectory()
    const application = join(outputDirectory, 'win-unpacked')
    const resources = join(application, 'resources')
    const backend = join(resources, 'backend')
    const legal = join(resources, 'legal')
    const appAsar = join(resources, 'app.asar')
    const backendEntry = join(backend, 'lib', 'bin.js')
    await Promise.all([
      mkdir(join(backend, 'lib'), { recursive: true }),
      mkdir(legal, { recursive: true }),
    ])
    await Promise.all([
      writeFile(appAsar, 'asar'),
      writeFile(backendEntry, 'backend'),
      writeFile(join(legal, 'LICENSE'), 'license'),
      writeFile(join(legal, 'THIRD_PARTY_NOTICES.md'), 'notices'),
    ])
    const request = resolveBuildRequest('dir', 'win32', 'x64')
    await writeBuildMetadata({
      outputDirectory,
      packaged: {
        appAsar,
        application,
        backendEntry,
        backendManifest: { name: '@deepseek-ai/dsh', version: '0.1.0-rc.5' },
        legal,
      },
      request,
      shellManifest: { version: '0.1.0' },
      source: { commit: 'a'.repeat(40), dirty: true },
    })

    const manifest = await verifyBuildMetadata(outputDirectory) as {
      artifacts: Array<{ path: string; sha256: string }>
      source: { commit: string; dirty: boolean }
    }
    expect(manifest.source).toEqual({ commit: 'a'.repeat(40), dirty: true })
    expect(manifest.artifacts.map(item => item.path)).toEqual([
      'win-unpacked/resources/app.asar',
      'win-unpacked/resources/backend/lib/bin.js',
      'win-unpacked/resources/legal/LICENSE',
      'win-unpacked/resources/legal/THIRD_PARTY_NOTICES.md',
    ])
    expect(await readFile(join(outputDirectory, 'SHA256SUMS'), 'utf8')).toMatch(/^[0-9a-f]{64}  /m)

    await writeFile(backendEntry, 'tampered')
    await expect(verifyBuildMetadata(outputDirectory)).rejects.toThrow(/checksum mismatch/)
  })
})
