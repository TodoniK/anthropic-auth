/**
 * Read the credential OpenCode attached to this request: the bearer token, or
 * else the API key. When a user signs in through this plugin (Claude pool
 * login or vault activation), OpenCode stores a fixed, non-secret placeholder
 * string instead of a real token: placeholderSecret('anthropic') from
 * @cortexkit/common-auth. The request hooks that installOpenCode2Auth installs
 * serve a request from the plugin's own accounts only when this value equals
 * that placeholder exactly. Any real token or key, whether from OpenCode's own
 * login, a configured API key or an environment variable, is left untouched.
 */
export function preparedAnthropicCredential(
  headers: Headers,
): string | undefined {
  const authorization = headers.get('authorization')
  const bearer = authorization?.match(/^Bearer ([^\s]+)$/i)
  return bearer?.[1] ?? headers.get('x-api-key') ?? undefined
}
