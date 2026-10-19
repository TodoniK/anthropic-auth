import { expect, test } from 'bun:test'
import {
  createProviderErrorResponseScope,
  PROVIDER_ERROR_MAX_BODY_BYTES,
  summarizePrewarmProviderError,
} from '../provider-error.ts'

const prompt = 'FAKE PROMPT LINE: private summary fixture'
const credential = 'synthetic-summary-credential-8150'

test('prewarm summary classifies a disposed response scope as withheld', async () => {
  const scope = createProviderErrorResponseScope([credential], 'http')
  const response = scope.redactResponse(
    new Response(
      JSON.stringify({
        type: 'error',
        error: {
          type: 'invalid_request_error',
          message: `${prompt} ${credential}`,
        },
      }),
      { status: 400 },
    ),
  )
  scope.dispose()
  const summary = summarizePrewarmProviderError({
    status: response.status,
    body: await response.text(),
  })
  expect(summary).toEqual({
    status: 400,
    provider_error: {
      type: 'invalid_request_error',
      reason: 'withheld',
      message: 'Provider prewarm error details were withheld',
    },
  })
})

test('prewarm summary independently bounds UTF-8 input before parsing', () => {
  const summary = summarizePrewarmProviderError({
    status: 400,
    body: JSON.stringify({
      error: {
        type: 'invalid_request_error',
        message: 'é'.repeat(PROVIDER_ERROR_MAX_BODY_BYTES / 2),
      },
    }),
  })
  expect(summary.provider_error).toEqual({
    type: 'unknown',
    reason: 'withheld',
    message: 'Provider prewarm error details were withheld',
  })
})

for (const body of ['', 'not JSON', 'null', '[]', '{"error":null}']) {
  test(`prewarm summary rejects an unparseable error envelope: ${JSON.stringify(body)}`, () => {
    expect(
      summarizePrewarmProviderError({ status: 400, body }).provider_error,
    ).toEqual({
      type: 'unknown',
      reason: 'parse_failure',
      message: 'Provider prewarm error response could not be parsed',
    })
  })
}

test('prewarm summary represents unavailable credentials without provider data', () => {
  expect(
    summarizePrewarmProviderError({ failure: 'credential_unavailable' }),
  ).toEqual({
    provider_error: {
      type: 'unknown',
      reason: 'credential_unavailable',
      message: 'OAuth cache prewarm credential is unavailable',
    },
  })
})
