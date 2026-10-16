/** Explicit sign-in to the native Claude account pool creates this OAuth connection. Startup leaves existing OpenCode connections unchanged. */
export const CLAUDE_POOL_LOGIN_METHOD_ID = 'native-claude-oauth'
export const CLAUDE_POOL_LOGIN_METHOD_LABEL =
  'Claude Pro / Max (native account pool)'
export const CLAUDE_POOL_LOGIN_STEP = `In OpenCode, sign in to Anthropic with "${CLAUDE_POOL_LOGIN_METHOD_LABEL}".`

/**
 * Connects OpenCode to the Claude accounts held in the vault. It signs in to
 * nothing and stores no local account; only the host's placeholder is written.
 */
export const CLAUDE_VAULT_ACTIVATION_METHOD_ID = 'native-claude-vault'
