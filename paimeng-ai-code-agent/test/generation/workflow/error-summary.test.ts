import { describe, expect, it } from 'vitest'
import { summarizeProviderError } from '../../../src/generation/workflow/index.js'

describe('summarizeProviderError', () => {
  it('records only bounded, non-sensitive provider metadata', () => {
    const error = Object.assign(new Error('Bearer secret-token response body'), {
      name: 'AI_APICallError',
      statusCode: 429,
      url: 'https://coding.example/v1/chat/completions?api_key=secret',
      data: { error: { code: 'rate_limited', message: 'sensitive upstream detail' } },
      responseHeaders: { 'x-request-id': 'request-123', authorization: 'Bearer secret-token' },
    })

    expect(summarizeProviderError(error)).toEqual({
      name: 'AI_APICallError',
      statusCode: 429,
      providerCode: 'rate_limited',
      endpoint: 'https://coding.example/v1/chat/completions',
      requestId: 'request-123',
    })
  })

  it('omits malformed and non-provider fields', () => {
    expect(summarizeProviderError(new Error('internal failure'))).toEqual({
      name: 'Error',
      statusCode: undefined,
      providerCode: undefined,
      endpoint: undefined,
      requestId: undefined,
    })
  })
})
