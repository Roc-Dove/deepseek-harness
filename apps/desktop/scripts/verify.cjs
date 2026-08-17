'use strict'

const { readFile } = require('node:fs/promises')
const { join } = require('node:path')
const {
  ARTIFACT_ROOT,
  resolveBuildRequest,
  verifyBuildMetadata,
  verifyPackagedApplication,
} = require('./packaging.cjs')
const { runRuntimeSmoke } = require('./verify-runtime.cjs')

async function main() {
  const host = resolveBuildRequest('host')
  const outputDirectory = join(ARTIFACT_ROOT, host.outputName)
  const manifest = JSON.parse(await readFile(join(outputDirectory, 'build-manifest.json'), 'utf8'))
  if (manifest.target?.platform !== host.platform || manifest.target?.arch !== host.arch) {
    throw new Error(
      `desktop-package: artifact target ${manifest.target?.platform}-${manifest.target?.arch} does not match host ${host.platform}-${host.arch}.`,
    )
  }
  const request = { ...host, mode: manifest.target.mode }
  if (request.mode !== 'dir' && request.mode !== 'dist') {
    throw new Error(`desktop-package: artifact has invalid build mode ${JSON.stringify(request.mode)}.`)
  }
  const packaged = await verifyPackagedApplication(outputDirectory, request)
  await verifyBuildMetadata(outputDirectory)
  await runRuntimeSmoke(packaged, request)
  console.log(`desktop-package: verified ${request.builderPlatform}-${request.arch} products in ${outputDirectory}`)
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
})
