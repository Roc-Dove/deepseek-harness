'use strict'

const { join } = require('node:path')
const {
  ARTIFACT_ROOT,
  ELECTRON_BUILDER_VERSION,
  ELECTRON_VERSION,
  REPOSITORY_ROOT,
  clearOutputDirectory,
  createBuilderConfiguration,
  createLegalStage,
  createShellStage,
  createTemporaryStage,
  deploymentArguments,
  parseBuildCli,
  pnpmCommandSpec,
  prepareBackend,
  removeTemporaryDirectory,
  resolveSourceState,
  runCommand,
  usage,
  verifyBuildMetadata,
  verifyPackagedApplication,
  writeBuildMetadata,
} = require('./packaging.cjs')

function environmentFlag(name) {
  const value = process.env[name]
  if (value === undefined || value === '0') return false
  if (value === '1') return true
  throw new Error(`desktop-package: ${name} must be 0 or 1; got ${JSON.stringify(value)}.`)
}

function loadElectronBuilder() {
  const electronVersion = require('electron/package.json').version
  if (electronVersion !== ELECTRON_VERSION) {
    throw new Error(`desktop-package: expected electron ${ELECTRON_VERSION}, installed ${electronVersion}.`)
  }
  const builderVersion = require('electron-builder/package.json').version
  if (builderVersion !== ELECTRON_BUILDER_VERSION) {
    throw new Error(`desktop-package: expected electron-builder ${ELECTRON_BUILDER_VERSION}, installed ${builderVersion}.`)
  }
  return require('electron-builder')
}

function createBuilderTargets(electronBuilder, request) {
  const arch = request.arch === 'arm64' ? electronBuilder.Arch.arm64 : electronBuilder.Arch.x64
  const targetNames = request.mode === 'dir'
    ? ['dir']
    : request.builderPlatform === 'mac' ? ['dmg', 'zip'] : ['nsis', 'zip']
  const platform = request.builderPlatform === 'mac'
    ? electronBuilder.Platform.MAC
    : electronBuilder.Platform.WINDOWS
  return platform.createTarget(targetNames, arch)
}

async function main() {
  let cli
  try {
    cli = parseBuildCli(process.argv.slice(2))
  } catch (error) {
    console.error(`${error instanceof Error ? error.message : String(error)}\n`)
    console.error(usage())
    process.exitCode = 1
    return
  }
  if (cli.help) {
    console.log(usage())
    return
  }

  const request = cli.request
  process.env.ELECTRON_BUILDER_CACHE ??= join(ARTIFACT_ROOT, '.electron-builder-cache')
  const requireSigning = environmentFlag('DSH_DESKTOP_REQUIRE_SIGNING')
  const notarize = environmentFlag('DSH_DESKTOP_NOTARIZE')
  if (notarize && request.builderPlatform !== 'mac') {
    throw new Error('desktop-package: DSH_DESKTOP_NOTARIZE=1 is valid only for a macOS build.')
  }
  if (notarize && !requireSigning) {
    throw new Error('desktop-package: notarization requires DSH_DESKTOP_REQUIRE_SIGNING=1.')
  }

  const electronBuilder = loadElectronBuilder()
  const targets = createBuilderTargets(electronBuilder, request)
  const source = await resolveSourceState()
  const temporaryDirectory = await createTemporaryStage(request)
  const shellStage = join(temporaryDirectory, 'shell')
  const backendStage = join(temporaryDirectory, 'backend')
  const legalStage = join(temporaryDirectory, 'legal')
  const outputDirectory = join(ARTIFACT_ROOT, request.outputName)

  console.log(`desktop-package: target ${request.builderPlatform}-${request.arch} (${request.mode})`)
  console.log(`desktop-package: temporary stage ${temporaryDirectory}`)
  try {
    const shellManifest = await createShellStage(shellStage)
    await createLegalStage(legalStage)
    const pnpm = pnpmCommandSpec()
    await runCommand(
      'deploy production backend',
      pnpm.command,
      [...pnpm.prefixArgs, ...deploymentArguments(backendStage)],
      REPOSITORY_ROOT,
    )
    await prepareBackend(backendStage, request)
    await clearOutputDirectory(outputDirectory)
    const config = createBuilderConfiguration({
      backendStage,
      legalStage,
      notarize,
      outputDirectory,
      request,
      requireSigning,
      shellStage,
    })
    await electronBuilder.build({
      config,
      // The shell has no runtime dependencies of its own. Its isolated staging
      // project and the beforeBuild hook keep electron-builder from collecting
      // the source workspace's dependencies into app.asar.
      projectDir: shellStage,
      publish: 'never',
      targets,
    })
    const packaged = await verifyPackagedApplication(outputDirectory, request)
    await writeBuildMetadata({ outputDirectory, packaged, request, shellManifest, source })
    await verifyBuildMetadata(outputDirectory)
    console.log(`desktop-package: verified products in ${outputDirectory}`)
  } finally {
    await removeTemporaryDirectory(temporaryDirectory)
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
