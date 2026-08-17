'use strict'

const { createHash } = require('node:crypto')
const { spawn } = require('node:child_process')
const { createReadStream } = require('node:fs')
const {
  copyFile,
  chmod,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  stat,
  unlink,
  writeFile,
} = require('node:fs/promises')
const { dirname, isAbsolute, join, relative, resolve, sep } = require('node:path')
const { homedir } = require('node:os')
const { parseArgs } = require('node:util')

const DESKTOP_ROOT = resolve(__dirname, '..')
const REPOSITORY_ROOT = resolve(DESKTOP_ROOT, '../..')
const ARTIFACT_ROOT = join(REPOSITORY_ROOT, '.artifacts', 'desktop')
const CLI_MANIFEST = join(REPOSITORY_ROOT, 'apps', 'cli', 'package.json')
const BACKEND_PACKAGE = '@deepseek-ai/dsh'
const DEPLOY_PACKAGE = '@deepseek-ai/dsh-desktop'
const ELECTRON_VERSION = '39.8.10'
const ELECTRON_BUILDER_VERSION = '26.15.3'
const PRODUCT_NAME = 'DeepSeek Harness'
const SHELL_FILES = ['assets', 'main.cjs', 'package.json', 'runtime.cjs']
const FORBIDDEN_PAYLOAD_NAMES = new Set([
  '.computer-use',
  '.git',
  '.modules.yaml',
  '.npmrc',
  '.pnpm-debug.log',
  'coverage',
  'pnpm-debug.log',
])
const TEXT_PAYLOAD_EXTENSIONS = [
  '.cjs', '.css', '.html', '.js', '.json', '.md', '.mjs', '.svg', '.toml', '.txt', '.xml', '.yaml', '.yml',
]

function toPosix(path) {
  return path.split(sep).join('/')
}

function pathInside(parent, candidate) {
  const nested = relative(parent, candidate)
  return nested !== '' && !nested.startsWith(`..${sep}`) && nested !== '..' && !isAbsolute(nested)
}

function assertManagedChild(parent, candidate, label) {
  if (!pathInside(resolve(parent), resolve(candidate))) {
    throw new Error(`desktop-package: refusing ${label} outside ${parent}: ${candidate}`)
  }
}

async function lstatIfPresent(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error !== null && typeof error === 'object' && error.code === 'ENOENT') return undefined
    throw error
  }
}

async function requireRegularFile(path, label) {
  const metadata = await lstatIfPresent(path)
  if (metadata === undefined || !metadata.isFile()) {
    throw new Error(`desktop-package: ${label} is missing or is not a regular file: ${path}`)
  }
}

async function ensureArtifactRoot() {
  await mkdir(join(REPOSITORY_ROOT, '.artifacts'), { recursive: true })
  for (const path of [join(REPOSITORY_ROOT, '.artifacts'), ARTIFACT_ROOT]) {
    const metadata = await lstatIfPresent(path)
    if (metadata?.isSymbolicLink()) {
      throw new Error(`desktop-package: refusing artifact directory symlink: ${path}`)
    }
    if (metadata !== undefined && !metadata.isDirectory()) {
      throw new Error(`desktop-package: artifact path is not a directory: ${path}`)
    }
    if (metadata === undefined) await mkdir(path)
  }
}

async function clearOutputDirectory(outputDirectory) {
  assertManagedChild(ARTIFACT_ROOT, outputDirectory, 'to clear an output directory')
  const metadata = await lstatIfPresent(outputDirectory)
  if (metadata?.isSymbolicLink()) {
    throw new Error(`desktop-package: refusing to clear output directory symlink: ${outputDirectory}`)
  }
  if (metadata !== undefined && !metadata.isDirectory()) {
    throw new Error(`desktop-package: output path is not a directory: ${outputDirectory}`)
  }
  if (metadata !== undefined) await rm(outputDirectory, { recursive: true })
  await mkdir(outputDirectory)
}

async function removeTemporaryDirectory(temporaryDirectory) {
  assertManagedChild(ARTIFACT_ROOT, temporaryDirectory, 'to remove a temporary directory')
  if (!temporaryDirectory.startsWith(join(ARTIFACT_ROOT, '.stage-'))) {
    throw new Error(`desktop-package: refusing unexpected temporary directory: ${temporaryDirectory}`)
  }
  const metadata = await lstatIfPresent(temporaryDirectory)
  if (metadata === undefined) return
  if (metadata.isSymbolicLink()) {
    await unlink(temporaryDirectory)
    return
  }
  if (!metadata.isDirectory()) {
    throw new Error(`desktop-package: temporary path is not a directory: ${temporaryDirectory}`)
  }
  await rm(temporaryDirectory, { recursive: true })
}

function resolveBuildRequest(rawTarget, platform = process.platform, arch = process.arch) {
  if (!['host', 'dir', 'mac', 'win'].includes(rawTarget)) {
    throw new Error(`desktop-package: --target must be host, dir, mac, or win; got ${JSON.stringify(rawTarget)}.`)
  }
  if (platform !== 'darwin' && platform !== 'win32') {
    throw new Error(`desktop-package: installers must be built natively on macOS or Windows; got ${platform}-${arch}.`)
  }
  if (platform === 'darwin' && arch !== 'arm64' && arch !== 'x64') {
    throw new Error(`desktop-package: macOS builds require a native arm64 or x64 host; got ${arch}.`)
  }
  if (platform === 'win32' && arch !== 'x64') {
    throw new Error(`desktop-package: Windows builds require a native x64 host; got ${arch}.`)
  }
  if (rawTarget === 'mac' && platform !== 'darwin') {
    throw new Error('desktop-package: macOS installers must be built on a native macOS host.')
  }
  if (rawTarget === 'win' && platform !== 'win32') {
    throw new Error('desktop-package: Windows installers must be built on a native Windows x64 host.')
  }

  const builderPlatform = platform === 'darwin' ? 'mac' : 'win'
  return {
    arch,
    builderPlatform,
    mode: rawTarget === 'dir' ? 'dir' : 'dist',
    outputName: `${builderPlatform}-${arch}`,
    platform,
  }
}

function parseBuildCli(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      help: { type: 'boolean', default: false },
      target: { type: 'string', default: 'host' },
    },
    strict: true,
  })
  return {
    help: values.help,
    request: values.help ? undefined : resolveBuildRequest(values.target),
  }
}

function usage() {
  return [
    'Usage: node apps/desktop/scripts/build.cjs [--target=host|dir|mac|win]',
    '',
    '  host  build the native host installer targets (default)',
    '  dir   build only the native unpacked application',
    '  mac   build macOS DMG and ZIP on the native arm64 or x64 host',
    '  win   build Windows NSIS and ZIP on a native x64 host',
  ].join('\n')
}

function createShellManifest(sourceManifest) {
  for (const name of ['name', 'version', 'description', 'license', 'main']) {
    if (typeof sourceManifest[name] !== 'string' || sourceManifest[name] === '') {
      throw new Error(`desktop-package: desktop package.json has no valid ${name}.`)
    }
  }
  return {
    name: sourceManifest.name,
    version: sourceManifest.version,
    description: sourceManifest.description,
    license: sourceManifest.license,
    private: true,
    main: sourceManifest.main,
  }
}

async function createShellStage(shellStage) {
  await mkdir(shellStage)
  const sourceManifest = JSON.parse(await readFile(join(DESKTOP_ROOT, 'package.json'), 'utf8'))
  await Promise.all([
    copyFile(join(DESKTOP_ROOT, 'main.cjs'), join(shellStage, 'main.cjs')),
    copyFile(join(DESKTOP_ROOT, 'runtime.cjs'), join(shellStage, 'runtime.cjs')),
    cp(join(DESKTOP_ROOT, 'assets'), join(shellStage, 'assets'), { recursive: true, dereference: true }),
    writeFile(join(shellStage, 'package.json'), `${JSON.stringify(createShellManifest(sourceManifest), null, 2)}\n`),
  ])
  const entries = (await readdir(shellStage)).sort()
  if (JSON.stringify(entries) !== JSON.stringify(SHELL_FILES)) {
    throw new Error(`desktop-package: staged shell contains unexpected entries: ${entries.join(', ')}.`)
  }
  await assertPayloadHygiene(shellStage, 'staged shell')
  return sourceManifest
}

function deploymentArguments(backendStage) {
  return [
    '--trust-lockfile',
    '--filter',
    DEPLOY_PACKAGE,
    'deploy',
    '--prod',
    '--config.node-linker=hoisted',
    '--config.inject-workspace-packages=true',
    // The generated deployment rewrites a workspace package's allowBuilds key
    // to an absolute file URL. Keep reviewed third-party builds enabled while
    // treating that one skipped workspace chmod as a warning; the executable
    // bit is restored and verified explicitly below.
    '--config.strict-dep-builds=false',
    backendStage,
  ]
}

function pnpmBin(platform = process.platform) {
  return platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
}

function formatCommand(command, args) {
  return [command, ...args].map(part => (/\s/.test(part) ? JSON.stringify(part) : part)).join(' ')
}

async function runCommand(label, command, args, cwd = REPOSITORY_ROOT) {
  const printable = formatCommand(command, args)
  console.log(`desktop-package: ${label}: ${printable}`)
  await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: 'inherit',
    })
    let settled = false
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(new Error(`desktop-package: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolvePromise()
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      reject(new Error(`desktop-package: ${label} failed (${cause}): ${printable}`))
    })
  })
}

async function captureCommand(label, command, args, cwd = REPOSITORY_ROOT) {
  const printable = formatCommand(command, args)
  return new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, CI: 'true' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    const stdout = []
    const stderr = []
    let outputBytes = 0
    let settled = false
    const append = (chunks, chunk) => {
      outputBytes += chunk.length
      if (outputBytes > 1024 * 1024) {
        child.kill()
        if (!settled) {
          settled = true
          reject(new Error(`desktop-package: ${label} exceeded the 1 MiB output limit (${printable}).`))
        }
        return
      }
      chunks.push(chunk)
    }
    child.stdout.on('data', chunk => append(stdout, chunk))
    child.stderr.on('data', chunk => append(stderr, chunk))
    child.once('error', (error) => {
      if (settled) return
      settled = true
      reject(new Error(`desktop-package: ${label} failed to spawn: ${error.message} (${printable})`))
    })
    child.once('exit', (code, signal) => {
      if (settled) return
      settled = true
      if (code === 0) {
        resolvePromise(Buffer.concat(stdout).toString('utf8'))
        return
      }
      const cause = code === null ? `signal ${signal ?? 'unknown'}` : `exit code ${code}`
      const detail = Buffer.concat(stderr).toString('utf8').trim()
      reject(new Error(`desktop-package: ${label} failed (${cause}): ${printable}${detail === '' ? '' : `: ${detail}`}`))
    })
  })
}

async function resolveSourceState(environment = process.env) {
  const githubSha = environment.GITHUB_SHA
  const commit = githubSha === undefined || githubSha === ''
    ? (await captureCommand('resolve source commit', 'git', ['rev-parse', 'HEAD'])).trim()
    : githubSha.trim()
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(commit)) {
    throw new Error(`desktop-package: source commit is not a full Git object id: ${JSON.stringify(commit)}.`)
  }
  const status = await captureCommand(
    'inspect source worktree',
    'git',
    ['status', '--porcelain=v1', '--untracked-files=normal'],
  )
  return { commit: commit.toLowerCase(), dirty: status !== '' }
}

async function copyPackageWithoutNodeModules(source, destination) {
  const nestedNodeModules = join(source, 'node_modules')
  await cp(source, destination, {
    recursive: true,
    dereference: true,
    filter: path => path !== nestedNodeModules && !path.startsWith(`${nestedNodeModules}${sep}`),
  })
}

async function findFirstSymbolicLink(directory) {
  const entries = await readdir(directory)
  entries.sort()
  for (const name of entries) {
    const path = join(directory, name)
    const metadata = await lstat(path)
    if (metadata.isSymbolicLink()) return path
    if (metadata.isDirectory()) {
      const nested = await findFirstSymbolicLink(path)
      if (nested !== undefined) return nested
    }
  }
  return undefined
}

async function removeLinkOrDirectory(path) {
  const metadata = await lstat(path)
  if (metadata.isSymbolicLink()) {
    await unlink(path)
    return
  }
  if (!metadata.isDirectory()) {
    throw new Error(`desktop-package: expected a link or directory while materializing: ${path}`)
  }
  await rm(path, { recursive: true })
}

async function materializeBackendLinks(backendStage) {
  const nodeModules = join(backendStage, 'node_modules')
  let link = await findFirstSymbolicLink(backendStage)
  while (link !== undefined) {
    const segments = relative(nodeModules, link).split(sep)
    const binIndex = segments.indexOf('.bin')
    if (pathInside(nodeModules, link) && binIndex >= 0) {
      await removeLinkOrDirectory(join(nodeModules, ...segments.slice(0, binIndex + 1)))
      link = await findFirstSymbolicLink(backendStage)
      continue
    }
    const source = await realpath(link)
    const sourceMetadata = await stat(source)
    await unlink(link)
    if (sourceMetadata.isDirectory()) await copyPackageWithoutNodeModules(source, link)
    else await copyFile(source, link)
    link = await findFirstSymbolicLink(backendStage)
  }
}

async function assertNoSymbolicLinks(directory, label = 'backend') {
  const link = await findFirstSymbolicLink(directory)
  if (link !== undefined) {
    throw new Error(`desktop-package: ${label} contains a symbolic link outside the copied payload: ${link}`)
  }
}

async function installedRuntimePackages(nodeModules, found = []) {
  const metadata = await lstatIfPresent(nodeModules)
  if (metadata === undefined) return found
  if (!metadata.isDirectory()) {
    throw new Error(`desktop-package: runtime node_modules is not a directory: ${nodeModules}`)
  }
  const addPackage = async (directory) => {
    const manifestPath = join(directory, 'package.json')
    const manifestMetadata = await lstatIfPresent(manifestPath)
    if (manifestMetadata === undefined || !manifestMetadata.isFile()) return
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
    found.push({ directory, manifest })
    await installedRuntimePackages(join(directory, 'node_modules'), found)
  }
  for (const entry of await readdir(nodeModules, { withFileTypes: true })) {
    if (entry.name === '.bin' || entry.name === '.pnpm' || !entry.isDirectory()) continue
    const directory = join(nodeModules, entry.name)
    if (entry.name.startsWith('@')) {
      for (const child of await readdir(directory, { withFileTypes: true })) {
        if (child.isDirectory()) await addPackage(join(directory, child.name))
      }
    } else {
      await addPackage(directory)
    }
  }
  return found
}

async function resolvesInstalledPackage(packageDirectory, backendStage, name) {
  let current = packageDirectory
  while (current === backendStage || pathInside(backendStage, current)) {
    const manifest = await lstatIfPresent(join(current, 'node_modules', name, 'package.json'))
    if (manifest?.isFile()) return true
    if (current === backendStage) break
    current = dirname(current)
  }
  return false
}

async function assertRuntimeClosure(backendStage) {
  const rootManifest = JSON.parse(await readFile(join(backendStage, 'package.json'), 'utf8'))
  const packages = [
    { directory: backendStage, manifest: rootManifest },
    ...await installedRuntimePackages(join(backendStage, 'node_modules')),
  ]
  const missing = []
  for (const { directory, manifest } of packages) {
    const requirements = { ...manifest.dependencies }
    for (const [name, range] of Object.entries(manifest.peerDependencies ?? {})) {
      if (manifest.peerDependenciesMeta?.[name]?.optional !== true) requirements[name] = range
    }
    for (const name of Object.keys(requirements).sort()) {
      if (!await resolvesInstalledPackage(directory, backendStage, name)) {
        missing.push(`${String(manifest.name ?? '<unnamed>')} -> ${name}`)
      }
    }
  }
  if (missing.length > 0) {
    throw new Error(`desktop-package: runtime dependency closure is incomplete:\n${missing.sort().join('\n')}`)
  }
  return packages.length
}

async function pruneSourceMaps(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) await pruneSourceMaps(path)
    else if (entry.isFile() && entry.name.endsWith('.map')) await rm(path)
  }
}

async function pruneDeployMetadata(backendStage) {
  await Promise.all([
    rm(join(backendStage, 'pnpm-lock.yaml'), { force: true }),
    rm(join(backendStage, 'pnpm-workspace.yaml'), { force: true }),
    rm(join(backendStage, 'node_modules', '.modules.yaml'), { force: true }),
    rm(join(backendStage, 'node_modules', '.pnpm-workspace-state-v1.json'), { force: true }),
    rm(join(backendStage, 'node_modules', '.pnpm'), { force: true, recursive: true }),
  ])
}

async function sanitizeBackendManifest(backendStage) {
  const [deployedManifest, sourceManifest] = await Promise.all([
    readFile(join(backendStage, 'package.json'), 'utf8').then(JSON.parse),
    readFile(CLI_MANIFEST, 'utf8').then(JSON.parse),
  ])
  if (deployedManifest.name !== BACKEND_PACKAGE || sourceManifest.name !== BACKEND_PACKAGE) {
    throw new Error('desktop-package: cannot sanitize a deployment manifest for an unexpected package.')
  }
  const deployedNames = Object.keys(deployedManifest.dependencies ?? {}).sort()
  const sourceNames = Object.keys(sourceManifest.dependencies ?? {}).sort()
  if (JSON.stringify(deployedNames) !== JSON.stringify(sourceNames)) {
    throw new Error('desktop-package: deployed backend dependencies differ from the source manifest.')
  }
  deployedManifest.dependencies = sourceManifest.dependencies
  deployedManifest.optionalDependencies = sourceManifest.optionalDependencies
  deployedManifest.peerDependencies = sourceManifest.peerDependencies
  // A production deployment does not install these packages. Modern deploy
  // rewrites workspace dev specs to machine-local file URLs even though they
  // are absent from the closure, so do not retain that misleading metadata.
  delete deployedManifest.devDependencies
  await writeFile(join(backendStage, 'package.json'), `${JSON.stringify(deployedManifest, null, 2)}\n`)
}

async function promoteBackendPackage(backendStage) {
  const installedBackend = join(backendStage, 'node_modules', BACKEND_PACKAGE)
  const source = await realpath(installedBackend)
  const sourceManifest = JSON.parse(await readFile(join(source, 'package.json'), 'utf8'))
  if (sourceManifest.name !== BACKEND_PACKAGE) {
    throw new Error(`desktop-package: deployed backend package has unexpected name ${JSON.stringify(sourceManifest.name)}.`)
  }
  for (const entry of await readdir(backendStage)) {
    if (entry === 'node_modules') continue
    await rm(join(backendStage, entry), { recursive: true, force: true })
  }
  for (const entry of await readdir(source)) {
    if (entry === 'node_modules') continue
    await cp(join(source, entry), join(backendStage, entry), { recursive: true, dereference: true })
  }
  await removeLinkOrDirectory(installedBackend)
}

async function ensureTargetNativePayload(backendStage, request) {
  const prebuild = join(backendStage, 'node_modules', 'node-pty', 'prebuilds', `${request.platform}-${request.arch}`)
  if (request.builderPlatform === 'mac') {
    const helper = join(prebuild, 'spawn-helper')
    await requireRegularFile(helper, `node-pty ${request.platform}-${request.arch} spawn helper`)
    await chmod(helper, 0o755)
    const metadata = await stat(helper)
    if ((metadata.mode & 0o111) === 0) {
      throw new Error(`desktop-package: node-pty spawn helper is not executable: ${helper}`)
    }
    await requireRegularFile(join(prebuild, 'pty.node'), `node-pty ${request.platform}-${request.arch} addon`)
    return
  }
  await Promise.all([
    requireRegularFile(join(prebuild, 'pty.node'), 'node-pty win32-x64 addon'),
    requireRegularFile(join(prebuild, 'winpty-agent.exe'), 'node-pty win32-x64 helper'),
  ])
}

async function sanitizeGeneratedSourcePaths(directory, identity = defaultLocalIdentityTokens()) {
  const pathTokens = [...identity.paths].sort((left, right) => right.length - left.length)
  let rewritten = 0
  async function visit(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const path = join(current, entry.name)
      if (entry.isDirectory()) {
        await visit(path)
        continue
      }
      if (!entry.isFile() || !['.cjs', '.js', '.mjs'].some(extension => entry.name.endsWith(extension))) continue
      const metadata = await stat(path)
      if (metadata.size > 16 * 1024 * 1024) continue
      const source = await readFile(path, 'utf8')
      if (!pathTokens.some(token => source.includes(token))) continue
      let changed = false
      const output = source.split('\n').map((line) => {
        if (!pathTokens.some(token => line.includes(token))) return line
        if (!/^\s*\/\/#region\b/.test(line)) return line
        changed = true
        let sanitized = line
        for (const token of pathTokens) sanitized = sanitized.split(token).join('<source-root>')
        return sanitized
      }).join('\n')
      if (changed) {
        await writeFile(path, output)
        rewritten += 1
      }
    }
  }
  await visit(directory)
  if (rewritten > 0) console.log(`desktop-package: sanitized generated source paths in ${rewritten} backend files`)
}

function defaultLocalIdentityTokens() {
  const paths = [REPOSITORY_ROOT, homedir(), process.env.USERPROFILE].filter(value => typeof value === 'string' && value !== '')
  const names = [process.env.USER, process.env.LOGNAME]
    .filter(value => typeof value === 'string' && value.length >= 8)
  return { names: [...new Set(names)], paths: [...new Set(paths)] }
}

function payloadNameProblem(name) {
  if (FORBIDDEN_PAYLOAD_NAMES.has(name)) return 'forbidden local or generated entry'
  if (name === '.env' || name.startsWith('.env.')) return 'environment file'
  if (name.endsWith('.map')) return 'source map'
  return undefined
}

function isSmallTextPayload(name, metadata) {
  return metadata.size <= 1024 * 1024 && TEXT_PAYLOAD_EXTENSIONS.some(extension => name.endsWith(extension))
}

async function assertPayloadHygiene(directory, label, identity = defaultLocalIdentityTokens()) {
  async function visit(current) {
    const entries = await readdir(current)
    entries.sort()
    for (const name of entries) {
      const path = join(current, name)
      const problem = payloadNameProblem(name)
      if (problem !== undefined) {
        throw new Error(`desktop-package: ${label} contains a ${problem}: ${path}`)
      }
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        throw new Error(`desktop-package: ${label} contains a symbolic link: ${path}`)
      }
      if (metadata.isDirectory()) {
        await visit(path)
        continue
      }
      if (!metadata.isFile() || !isSmallTextPayload(name, metadata)) continue
      const bytes = await readFile(path)
      if (bytes.includes(0)) continue
      const content = bytes.toString('utf8')
      if (identity.paths.some(token => content.includes(token))) {
        throw new Error(`desktop-package: ${label} contains an absolute local path in ${path}`)
      }
      const lower = content.toLowerCase()
      if (identity.names.some(token => lower.includes(token.toLowerCase()))) {
        throw new Error(`desktop-package: ${label} contains a local username in ${path}`)
      }
      if (/-----BEGIN [A-Z ]*PRIVATE KEY-----\s*\n[A-Za-z0-9+/=\r\n]{64,}\n-----END [A-Z ]*PRIVATE KEY-----/.test(content)) {
        throw new Error(`desktop-package: ${label} contains credential-like text in ${path}`)
      }
    }
  }
  await visit(directory)
}

async function prepareBackend(backendStage, request) {
  await promoteBackendPackage(backendStage)
  await sanitizeBackendManifest(backendStage)
  await materializeBackendLinks(backendStage)
  await assertRuntimeClosure(backendStage)
  await ensureTargetNativePayload(backendStage, request)
  await pruneSourceMaps(backendStage)
  await pruneDeployMetadata(backendStage)
  await sanitizeGeneratedSourcePaths(backendStage)
  await assertNoSymbolicLinks(backendStage)
  await assertPayloadHygiene(backendStage, 'staged backend')
  const manifest = JSON.parse(await readFile(join(backendStage, 'package.json'), 'utf8'))
  if (manifest.name !== BACKEND_PACKAGE) {
    throw new Error(`desktop-package: deployed backend must be ${BACKEND_PACKAGE}; got ${JSON.stringify(manifest.name)}.`)
  }
  await requireRegularFile(join(backendStage, 'lib', 'bin.js'), 'built backend entry')
  return manifest
}

async function createLegalStage(legalStage) {
  await mkdir(legalStage)
  const electronLegal = join(legalStage, 'electron')
  await mkdir(electronLegal)
  await Promise.all([
    copyFile(join(REPOSITORY_ROOT, 'LICENSE'), join(legalStage, 'LICENSE')),
    copyFile(join(REPOSITORY_ROOT, 'THIRD_PARTY_NOTICES.md'), join(legalStage, 'THIRD_PARTY_NOTICES.md')),
    copyFile(join(DESKTOP_ROOT, 'node_modules', 'electron', 'dist', 'LICENSE'), join(electronLegal, 'LICENSE')),
    copyFile(
      join(DESKTOP_ROOT, 'node_modules', 'electron', 'dist', 'LICENSES.chromium.html'),
      join(electronLegal, 'LICENSES.chromium.html'),
    ),
  ])
}

function createBuilderConfiguration(options) {
  const { backendStage, legalStage, outputDirectory, request, requireSigning, shellStage, notarize } = options
  return {
    appId: 'ai.deepseek.harness',
    productName: PRODUCT_NAME,
    electronVersion: ELECTRON_VERSION,
    // pnpm already installed and policy-checked this exact Electron version.
    // Reusing its native distribution avoids a second mutable network fetch.
    electronDist: join(DESKTOP_ROOT, 'node_modules', 'electron', 'dist'),
    asar: true,
    // The shell has no Node dependencies. The backend closure is deployed and
    // verified separately, so tell electron-builder not to collect or rebuild
    // the source workspace's node_modules.
    beforeBuild: () => false,
    npmRebuild: true,
    nodeGypRebuild: false,
    electronFuses: {
      runAsNode: true,
      enableCookieEncryption: true,
      enableNodeOptionsEnvironmentVariable: false,
      enableNodeCliInspectArguments: false,
      enableEmbeddedAsarIntegrityValidation: true,
      onlyLoadAppFromAsar: true,
      grantFileProtocolExtraPrivileges: false,
    },
    forceCodeSigning: requireSigning,
    compression: 'normal',
    artifactName: 'DeepSeek-Harness-${version}-${os}-${arch}.${ext}',
    directories: {
      app: shellStage,
      buildResources: join(shellStage, 'assets'),
      output: outputDirectory,
    },
    files: [
      {
        from: '.',
        to: '.',
        filter: ['main.cjs', 'runtime.cjs', 'package.json', 'assets/**/*'],
      },
    ],
    extraResources: [
      { from: backendStage, to: 'backend', filter: ['**/*', '!node_modules{,/**/*}'] },
      { from: join(backendStage, 'node_modules'), to: 'backend/node_modules', filter: ['**/*'] },
      { from: legalStage, to: 'legal', filter: ['**/*'] },
    ],
    mac: {
      category: 'public.app-category.developer-tools',
      hardenedRuntime: true,
      icon: join(shellStage, 'assets', 'icon.icns'),
      // Fuses mutate Electron's Mach-O binary. An ad-hoc signature keeps local
      // and PR artifacts executable; release jobs replace it with Developer ID.
      identity: requireSigning ? undefined : '-',
      minimumSystemVersion: '12.0',
      notarize,
    },
    win: {
      icon: join(shellStage, 'assets', 'icon.ico'),
    },
    nsis: {
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      oneClick: false,
      shortcutName: PRODUCT_NAME,
    },
    extraMetadata: {
      desktopTarget: `${request.builderPlatform}-${request.arch}`,
    },
  }
}

async function findNamedFiles(directory, name, found = []) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name)
    if (entry.isSymbolicLink()) continue
    if (entry.isDirectory()) await findNamedFiles(path, name, found)
    else if (entry.isFile() && entry.name === name) found.push(path)
  }
  return found
}

async function verifyPackagedApplication(outputDirectory, request) {
  const appAsars = await findNamedFiles(outputDirectory, 'app.asar')
  if (appAsars.length !== 1) {
    throw new Error(`desktop-package: expected one unpacked app.asar under ${outputDirectory}, found ${appAsars.length}.`)
  }
  const appAsar = appAsars[0]
  const resources = dirname(appAsar)
  const backend = join(resources, 'backend')
  const legal = join(resources, 'legal')
  const backendEntry = join(backend, 'lib', 'bin.js')
  const backendManifestPath = join(backend, 'package.json')
  const requiredBackendPackages = [
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-web-app',
    '@vscode/ripgrep',
    'koffi',
    'node-pty',
    'sharp',
  ]
  await Promise.all([
    requireRegularFile(appAsar, 'packaged app.asar'),
    requireRegularFile(backendEntry, 'packaged backend entry'),
    requireRegularFile(backendManifestPath, 'packaged backend manifest'),
    requireRegularFile(join(legal, 'LICENSE'), 'packaged license'),
    requireRegularFile(join(legal, 'THIRD_PARTY_NOTICES.md'), 'packaged third-party notices'),
    ...requiredBackendPackages.map(name => requireRegularFile(
      join(backend, 'node_modules', name, 'package.json'),
      `packaged backend dependency ${name}`,
    )),
  ])
  if (await lstatIfPresent(`${appAsar}.unpacked`) !== undefined) {
    throw new Error('desktop-package: the shell unexpectedly produced app.asar.unpacked; backend native code belongs in Resources/backend.')
  }
  await assertNoSymbolicLinks(backend, 'packaged backend')
  const backendManifest = JSON.parse(await readFile(backendManifestPath, 'utf8'))
  if (backendManifest.name !== BACKEND_PACKAGE) {
    throw new Error(`desktop-package: packaged backend must be ${BACKEND_PACKAGE}; got ${JSON.stringify(backendManifest.name)}.`)
  }
  for (const dependency of Object.keys(backendManifest.dependencies ?? {}).sort()) {
    const dependencyManifestPath = join(backend, 'node_modules', dependency, 'package.json')
    await requireRegularFile(dependencyManifestPath, `packaged direct backend dependency ${dependency}`)
    const dependencyManifest = JSON.parse(await readFile(dependencyManifestPath, 'utf8'))
    if (dependencyManifest.name !== dependency) {
      throw new Error(
        `desktop-package: packaged direct dependency ${dependency} has manifest name ${JSON.stringify(dependencyManifest.name)}.`,
      )
    }
  }
  await assertRuntimeClosure(backend)
  await ensureTargetNativePayload(backend, request)
  const application = request.builderPlatform === 'mac' ? resolve(resources, '../..') : dirname(resources)
  const electronLicenses = [
    join(legal, 'electron', 'LICENSE'),
    join(legal, 'electron', 'LICENSES.chromium.html'),
  ]
  for (const path of electronLicenses) {
    const metadata = await stat(path)
    if (!metadata.isFile() || metadata.size === 0) {
      throw new Error(`desktop-package: packaged Electron license is empty or invalid: ${path}`)
    }
  }
  return {
    appAsar,
    application,
    backend,
    backendEntry,
    backendManifest,
    electronLicenses,
    legal,
    resources,
  }
}

async function hashFile(path) {
  const hash = createHash('sha256')
  await new Promise((resolvePromise, reject) => {
    const stream = createReadStream(path)
    stream.on('data', chunk => hash.update(chunk))
    stream.once('error', reject)
    stream.once('end', resolvePromise)
  })
  return hash.digest('hex')
}

async function treeDigest(directory) {
  const entries = []
  async function visit(current) {
    const names = await readdir(current)
    names.sort()
    for (const name of names) {
      const path = join(current, name)
      const relativePath = toPosix(relative(directory, path))
      const metadata = await lstat(path)
      if (metadata.isSymbolicLink()) {
        entries.push({ kind: 'link', path: relativePath, target: await readlink(path) })
      } else if (metadata.isDirectory()) {
        entries.push({ kind: 'directory', path: relativePath })
        await visit(path)
      } else if (metadata.isFile()) {
        entries.push({
          bytes: metadata.size,
          kind: 'file',
          path: relativePath,
          sha256: await hashFile(path),
        })
      }
    }
  }
  await visit(directory)
  const hash = createHash('sha256')
  for (const entry of entries) hash.update(`${JSON.stringify(entry)}\n`)
  return {
    entries: entries.length,
    files: entries.filter(entry => entry.kind === 'file').length,
    sha256: hash.digest('hex'),
  }
}

async function collectDistributables(outputDirectory, request) {
  if (request.mode === 'dir') return []
  const extensions = request.builderPlatform === 'mac' ? ['.dmg', '.zip'] : ['.exe', '.zip']
  const entries = await readdir(outputDirectory, { withFileTypes: true })
  const paths = entries
    .filter(entry => entry.isFile() && extensions.some(extension => entry.name.endsWith(extension)))
    .map(entry => join(outputDirectory, entry.name))
    .sort()
  for (const extension of extensions) {
    if (!paths.some(path => path.endsWith(extension))) {
      throw new Error(`desktop-package: ${request.builderPlatform} build did not produce a ${extension} distributable.`)
    }
  }
  return paths
}

async function checksumRecord(path, outputDirectory) {
  const metadata = await stat(path)
  return {
    bytes: metadata.size,
    path: toPosix(relative(outputDirectory, path)),
    sha256: await hashFile(path),
  }
}

async function writeBuildMetadata(options) {
  const { outputDirectory, packaged, request, shellManifest, source } = options
  const distributablePaths = await collectDistributables(outputDirectory, request)
  const checksumPaths = request.mode === 'dist'
    ? distributablePaths
    : [
        packaged.appAsar,
        packaged.backendEntry,
        join(packaged.legal, 'LICENSE'),
        join(packaged.legal, 'THIRD_PARTY_NOTICES.md'),
      ]
  const checksums = []
  for (const path of checksumPaths) {
    assertManagedChild(outputDirectory, path, 'to checksum a packaged file')
    checksums.push(await checksumRecord(path, outputDirectory))
  }
  checksums.sort((left, right) => left.path.localeCompare(right.path))
  const applicationTree = await treeDigest(packaged.application)
  const manifest = {
    schemaVersion: 1,
    product: {
      name: PRODUCT_NAME,
      version: shellManifest.version,
      backendPackage: BACKEND_PACKAGE,
      backendVersion: packaged.backendManifest.version,
      electronVersion: ELECTRON_VERSION,
      electronBuilderVersion: ELECTRON_BUILDER_VERSION,
    },
    target: {
      platform: request.platform,
      arch: request.arch,
      mode: request.mode,
    },
    source,
    application: {
      path: toPosix(relative(outputDirectory, packaged.application)),
      ...applicationTree,
    },
    artifacts: checksums,
  }
  await writeFile(join(outputDirectory, 'build-manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)
  await writeFile(
    join(outputDirectory, 'SHA256SUMS'),
    `${checksums.map(item => `${item.sha256}  ${item.path}`).join('\n')}\n`,
  )
  return manifest
}

async function verifyBuildMetadata(outputDirectory) {
  const manifestPath = join(outputDirectory, 'build-manifest.json')
  const sumsPath = join(outputDirectory, 'SHA256SUMS')
  await Promise.all([
    requireRegularFile(manifestPath, 'build manifest'),
    requireRegularFile(sumsPath, 'SHA256SUMS'),
  ])
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
  if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(manifest.source?.commit)
    || typeof manifest.source?.dirty !== 'boolean') {
    throw new Error('desktop-package: build manifest has no valid source state.')
  }
  const expectedLines = []
  for (const item of manifest.artifacts ?? []) {
    if (typeof item.path !== 'string' || typeof item.sha256 !== 'string' || item.path.includes('\n')) {
      throw new Error('desktop-package: build manifest contains an invalid distributable record.')
    }
    const path = resolve(outputDirectory, item.path)
    assertManagedChild(outputDirectory, path, 'to verify a packaged file')
    const actual = await checksumRecord(path, outputDirectory)
    if (actual.bytes !== item.bytes || actual.sha256 !== item.sha256) {
      throw new Error(`desktop-package: checksum mismatch for ${item.path}.`)
    }
    expectedLines.push(`${item.sha256}  ${item.path}`)
  }
  expectedLines.sort()
  const actualLines = (await readFile(sumsPath, 'utf8')).trim().split('\n').filter(Boolean).sort()
  if (JSON.stringify(actualLines) !== JSON.stringify(expectedLines)) {
    throw new Error('desktop-package: SHA256SUMS does not match build-manifest.json.')
  }
  if (typeof manifest.application?.path !== 'string') {
    throw new Error('desktop-package: build manifest has no application path.')
  }
  const application = resolve(outputDirectory, manifest.application.path)
  assertManagedChild(outputDirectory, application, 'to verify the unpacked application')
  const actualTree = await treeDigest(application)
  if (actualTree.entries !== manifest.application.entries
    || actualTree.files !== manifest.application.files
    || actualTree.sha256 !== manifest.application.sha256) {
    throw new Error('desktop-package: unpacked application tree does not match build-manifest.json.')
  }
  return manifest
}

async function createTemporaryStage(request) {
  await ensureArtifactRoot()
  return mkdtemp(join(ARTIFACT_ROOT, `.stage-${request.builderPlatform}-${request.arch}-`))
}

module.exports = {
  ARTIFACT_ROOT,
  ELECTRON_BUILDER_VERSION,
  ELECTRON_VERSION,
  REPOSITORY_ROOT,
  SHELL_FILES,
  assertNoSymbolicLinks,
  assertPayloadHygiene,
  assertRuntimeClosure,
  clearOutputDirectory,
  createBuilderConfiguration,
  createLegalStage,
  createShellManifest,
  createShellStage,
  createTemporaryStage,
  deploymentArguments,
  ensureArtifactRoot,
  parseBuildCli,
  pnpmBin,
  prepareBackend,
  promoteBackendPackage,
  removeTemporaryDirectory,
  resolveSourceState,
  resolveBuildRequest,
  runCommand,
  sanitizeGeneratedSourcePaths,
  usage,
  verifyBuildMetadata,
  verifyPackagedApplication,
  writeBuildMetadata,
}
