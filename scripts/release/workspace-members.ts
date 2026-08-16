/** Central ownership of workspace directories intentionally excluded from npm release sets. */

/** Private applications that are runnable from source but never packed or published to npm. */
const LOCAL_ONLY_APPLICATION_DIRECTORIES = ['apps/desktop'] as const

const localOnlyApplications = new Set<string>(LOCAL_ONLY_APPLICATION_DIRECTORIES)
const npmReleaseDirectory = /^(?:packages\/[^/]+\/[^/]+|apps\/[^/]+|vendor\/[^/]+)$/

/**
 * Normalize a repository-relative directory for cross-platform release checks.
 * @param directory - Repository-relative workspace directory.
 * @returns Slash-separated directory without a leading `./` or trailing slash.
 */
function normalizeDirectory(directory: string): string {
  return directory.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '')
}

/**
 * Return whether a workspace directory is a private source-only application.
 * @param directory - Repository-relative workspace directory.
 * @returns True for an application excluded from every npm release path.
 */
export function isLocalOnlyApplication(directory: string): boolean {
  return localOnlyApplications.has(normalizeDirectory(directory))
}

/**
 * Return whether a workspace directory belongs to the repository's npm release sets.
 * @param directory - Repository-relative workspace directory.
 * @returns True for publishable package, application, or vendored-package directories.
 */
export function isNpmReleaseDirectory(directory: string): boolean {
  const normalized = normalizeDirectory(directory)
  return npmReleaseDirectory.test(normalized) && !localOnlyApplications.has(normalized)
}

/**
 * Build pnpm recursive filters for the complete legacy npm baseline release set.
 * @returns Inclusive workspace filters followed by explicit source-only exclusions.
 */
export function npmReleaseWorkspaceFilters(): string[] {
  return [
    './vendor/**',
    './packages/**',
    './apps/**',
    ...LOCAL_ONLY_APPLICATION_DIRECTORIES.map(directory => `!./${directory}`),
  ]
}
