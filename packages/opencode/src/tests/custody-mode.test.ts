import { expect, test } from 'bun:test'
import {
  CustodyStateMismatchError,
  reconcileCustodyStartup,
} from '../custody-mode.ts'

test('committed native local and enrolled vault custody require inert activation', () => {
  expect(
    reconcileCustodyStartup({
      mode: 'L',
      main: 'T',
      fallbacks: 'R',
      evidence: 'V',
      authority: 'committed',
    }).verdict,
  ).toBe('LOCAL_SERVE')
  expect(
    reconcileCustodyStartup({
      mode: 'C',
      main: 'T',
      fallbacks: 'T',
      evidence: 'V',
      authority: 'retired',
    }).verdict,
  ).toBe('CLAUSTRUM_SERVE')
  for (const input of [
    { mode: 'C', main: 'T', fallbacks: 'M', evidence: 'V' },
    { mode: 'C', main: 'R', fallbacks: 'T', evidence: 'V' },
    { mode: 'C', main: 'T', fallbacks: 'T', evidence: 'N' },
    { mode: 'L', main: 'R', fallbacks: 'R', evidence: 'V' },
    { mode: 'L', main: 'T', fallbacks: 'R', evidence: 'N' },
  ] as const) {
    expect(() =>
      reconcileCustodyStartup({ ...input, authority: 'committed' }),
    ).toThrow(CustodyStateMismatchError)
  }
})

test('activation and roster cannot bypass the committed migration journal', () => {
  for (const input of [
    { mode: 'L', main: 'T', fallbacks: 'R', evidence: 'V' },
    { mode: 'C', main: 'T', fallbacks: 'T', evidence: 'V' },
  ] as const) {
    expect(() => reconcileCustodyStartup(input)).toThrow('MIGRATION_REQUIRED')
  }
})

test('separate local login requires servable native OAuth and completed authority for every fallback', () => {
  for (const authority of ['committed', 'retired'] as const) {
    for (const fallbacks of ['R', 'T', 'M'] as const) {
      const input = { mode: 'L', main: 'R', evidence: 'V', fallbacks } as const
      expect(
        reconcileCustodyStartup({
          ...input,
          authority,
          localOAuthServable: true,
        }).verdict,
      ).toBe('LOCAL_SERVE')
      for (const localOAuthServable of [false, undefined])
        expect(() =>
          reconcileCustodyStartup({ ...input, authority, localOAuthServable }),
        ).toThrow('FAIL_CLOSED')
      expect(() =>
        reconcileCustodyStartup({ ...input, localOAuthServable: true }),
      ).toThrow('MIGRATION_REQUIRED')
      for (const patch of [
        { mode: 'C' },
        { main: 'X' },
        { evidence: 'N' },
      ] as const)
        expect(() =>
          reconcileCustodyStartup({
            ...input,
            authority,
            localOAuthServable: true,
            ...patch,
          }),
        ).toThrow('FAIL_CLOSED')
    }
  }
})
