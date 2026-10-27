import { describe, expect, test } from 'bun:test'
import { parseCodeIdentity } from '../scripts/distribution/signing.ts'

describe('codesign metadata', () => {
  test('parses certificate-backed identities', () => {
    expect(parseCodeIdentity([
      'Identifier=com.galta.runtime.development',
      'TeamIdentifier=JTNGU8BR8D',
      'designated => identifier "com.galta.runtime.development" and anchor apple generic',
    ].join('\n'))).toEqual({
      identifier: 'com.galta.runtime.development',
      requirement: 'identifier "com.galta.runtime.development" and anchor apple generic',
      team: 'JTNGU8BR8D',
    })
  })

  test('parses ad-hoc identities whose requirement is cdhash-bound', () => {
    expect(parseCodeIdentity([
      'Identifier=galta-runtime-adhoc',
      'TeamIdentifier=not set',
      '# designated => cdhash H"deadbeef"',
    ].join('\n'))).toEqual({
      identifier: 'galta-runtime-adhoc',
      requirement: 'cdhash H"deadbeef"',
    })
  })

  test('rejects output without a designated requirement', () => {
    expect(() => parseCodeIdentity('Identifier=com.galta.runtime.development\nTeamIdentifier=JTNGU8BR8D')).toThrow('Code signature has no identity metadata')
  })
})
