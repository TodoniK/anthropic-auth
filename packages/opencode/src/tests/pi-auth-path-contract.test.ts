import { expect } from 'bun:test'
import { createTestLifetimeSuite } from '../../../core/src/tests/test-lifetime.ts'

const { test, gate } = createTestLifetimeSuite()

for (const sdk of ['@earendil-works/pi-coding-agent', 'pi-coding-agent-1']) {
  for (const value of [
    undefined,
    '/tmp/synthetic-pi-agent',
    '~/synthetic-pi-agent',
    '~',
    ' ',
    'file:///tmp/synthetic-pi-agent',
  ]) {
    test(`offline Pi auth path matches ${sdk} with directory ${JSON.stringify(value)}`, async () => {
      const script = `
        import { getAgentDir } from ${JSON.stringify(sdk)};
        import { join } from 'node:path';
        import { getPiAuthPath } from './src/setup/paths.ts';
        console.log(JSON.stringify({ sdk: join(getAgentDir(), 'auth.json'), setup: getPiAuthPath(process.env) }));
      `
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        PI_AGENT_DIR: '/tmp/synthetic-extension-only-storage',
      }
      if (value === undefined) delete env.PI_CODING_AGENT_DIR
      else env.PI_CODING_AGENT_DIR = value
      // Both path implementations run in the same fresh Node process. This
      // compares default home and tilde expansion without Bun's cached home.
      const child = Bun.spawn(
        ['node', '--input-type=module', '--eval', script],
        {
          cwd: new URL('../..', import.meta.url).pathname,
          env,
          stdout: 'pipe',
          stderr: 'pipe',
        },
      )
      const closing = gate()
      void closing.wait.then(() => {
        if (child.exitCode === null) child.kill()
      })
      const [exit, output, errors] = await Promise.allSettled([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      if (
        exit.status === 'rejected' ||
        output.status === 'rejected' ||
        errors.status === 'rejected'
      )
        throw new Error(
          'Pi path-contract child did not complete its process and pipe joins',
        )
      expect({ exit: exit.value, stderr: errors.value }).toEqual({
        exit: 0,
        stderr: '',
      })
      const paths = JSON.parse(output.value)
      expect(paths.setup).toBe(paths.sdk)
    })
  }
}
