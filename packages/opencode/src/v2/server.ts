// Both OpenCode versions load the package's ./server export. Version 1 calls
// server; version 2 calls setup. Keep both methods on one plugin definition.
import { AnthropicAuthPlugin } from '../index'
import { ANTHROPIC_AUTH_PLUGIN_ID, createAnthropicAuthPlugin } from './setup'

export type { AnthropicAuthV2Options } from './setup'
export {
  ANTHROPIC_AUTH_PLUGIN_ID,
  createAnthropicAuthPlugin,
  setupAnthropicAuth,
} from './setup'

export default {
  id: ANTHROPIC_AUTH_PLUGIN_ID,
  setup: createAnthropicAuthPlugin().setup,
  server: AnthropicAuthPlugin,
}
