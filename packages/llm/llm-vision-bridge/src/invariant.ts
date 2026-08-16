/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-llm-vision-bridge`.
 * @module @deepseek-ai/dsh-llm-vision-bridge/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-llm-vision-bridge'

/** Cordis companion plugin name. */
export const name = 'llm-vision-bridge-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/**
 * No runtime invariant: the bridge service and `describe_image` tool are
 * effect-scoped registrations whose disposal the registry owns; request and
 * result validation is delegated to the LLM and attachment services, and the
 * plugin retains no independent mutable state.
 */
const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the installed registration's disposer after setup succeeds.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
