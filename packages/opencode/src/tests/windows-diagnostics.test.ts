import { expect, test } from 'bun:test'
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { cliDiagnosticsDirectory, writeDiagnosticFile } from '../cli-failure.ts'

for (const allowed of [true, false]) {
  test(`win32 diagnostics ${allowed ? 'accepts' : 'refuses'} the directory ACL and uses native private creation`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'windows-diagnostics-'))
    try {
      const env = { XDG_STATE_HOME: root }
      const directory = cliDiagnosticsDirectory(env)
      if (!directory) throw new Error('Missing diagnostics directory')
      await mkdir(directory, { recursive: true })
      await chmod(directory, allowed ? 0o777 : 0o700)
      const checked: string[] = []
      const created: string[] = []
      const path = await writeDiagnosticFile(
        env,
        'cli-setup',
        'synthetic diagnostic',
        {
          platform: 'win32',
          privateFiles: {
            readPrivateFile: readFile,
            async verifyOwnerOnly(path) {
              checked.push(path)
              return allowed
                ? { ok: true }
                : {
                    ok: false,
                    refusal: { reason: 'null-dacl', message: 'refused' },
                  }
            },
            async createPrivateFile(path, bytes) {
              created.push(path)
              await writeFile(path, bytes ?? '')
            },
          },
        },
      )
      expect(checked).toEqual([directory])
      if (allowed) {
        expect(created).toEqual([path as string])
        expect(await readFile(path as string, 'utf8')).toBe(
          'synthetic diagnostic',
        )
      } else {
        expect(path).toBeUndefined()
        expect(created).toEqual([])
      }
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  })
}
