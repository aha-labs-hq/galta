import { expect, test } from 'bun:test'
import { createVerify, generateKeyPairSync } from 'node:crypto'
import { ChromeWebStore } from '../scripts/distribution/chrome-web-store.ts'

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const account = { client_email: 'release@galta-test.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }) }
const item = 'publishers/publisher/items/abcdefghijklmnopabcdefghijklmnop'

/** A store that answers API calls in order and records what each asked. */
function fakeStore(answers) {
  const calls = [], tokens = []
  const request = async (url, init) => {
    if (url === 'https://oauth2.googleapis.com/token') { tokens.push(init.body.get('assertion')); return Response.json({ access_token: 'token', expires_in: 3600 }) }
    calls.push({ url, method: init.method, auth: init.headers.Authorization, body: init.body })
    const [status, body] = answers.shift()
    return Response.json(body, { status })
  }
  return { calls, tokens, store: new ChromeWebStore(account, item, request, async () => {}) }
}

test('the service account signs its own token request, once per hour', async () => {
  const { calls, tokens, store } = fakeStore([[200, {}], [200, {}], [200, {}], [200, {}]])
  await store.status(); await store.status()
  expect(tokens).toHaveLength(1)
  const [header, claims, signature] = tokens[0].split('.')
  expect(JSON.parse(Buffer.from(claims, 'base64url'))).toMatchObject({ iss: account.client_email, scope: 'https://www.googleapis.com/auth/chromewebstore', aud: 'https://oauth2.googleapis.com/token' })
  expect(createVerify('RSA-SHA256').update(`${header}.${claims}`).verify(publicKey, signature, 'base64url')).toBe(true)
  expect(calls[0]).toMatchObject({ url: `https://chromewebstore.googleapis.com/v2/${item}:fetchStatus`, method: 'GET', auth: 'Bearer token' })
})

test('status names the stored, submitted and published versions', async () => {
  const { calls, store } = fakeStore([[200, {
    publishedItemRevisionStatus: { state: 'PUBLISHED', distributionChannels: [{ crxVersion: '0.1.2', deployPercentage: 100 }] },
    submittedItemRevisionStatus: { state: 'PENDING_REVIEW', distributionChannels: [{ crxVersion: '0.1.3' }] }, warned: true,
  }], [200, { crxVersion: '0.1.3', uploadState: 'NOT_FOUND' }]])
  expect(await store.status()).toEqual({ uploaded: '0.1.3', published: { state: 'PUBLISHED', version: '0.1.2' }, submitted: { state: 'PENDING_REVIEW', version: '0.1.3' }, takenDown: false, warned: true })
  expect(calls[1].url).toBe('https://www.googleapis.com/chromewebstore/v1.1/items/abcdefghijklmnopabcdefghijklmnop?projection=DRAFT')
})

test('an upload the store is still processing is awaited', async () => {
  const { calls, store } = fakeStore([[200, { uploadState: 'IN_PROGRESS' }], [200, { lastAsyncUploadState: 'IN_PROGRESS' }], [200, { lastAsyncUploadState: 'SUCCEEDED' }]])
  await store.upload(new Uint8Array([1, 2, 3]))
  expect(calls.map(call => call.url.slice(call.url.lastIndexOf(':') + 1))).toEqual(['upload', 'fetchStatus', 'fetchStatus'])
  expect(calls[0].url).toBe(`https://chromewebstore.googleapis.com/upload/v2/${item}:upload`)
})

test('a refused or failed upload stops with the store\'s reason', async () => {
  await expect(fakeStore([[400, { error: { message: 'The version must be greater' } }]]).store.upload(new Uint8Array([1]))).rejects.toThrow('The version must be greater')
  await expect(fakeStore([[200, { uploadState: 'FAILED' }]]).store.upload(new Uint8Array([1]))).rejects.toThrow('did not accept the package: FAILED')
})

test('submission asks for staging, and release publishes what was staged', async () => {
  const { calls, store } = fakeStore([[200, { state: 'PENDING_REVIEW' }], [200, { state: 'PUBLISHED' }]])
  expect(await store.submit()).toBe('PENDING_REVIEW')
  expect(await store.release()).toBe('PUBLISHED')
  expect(JSON.parse(calls[0].body)).toEqual({ publishType: 'STAGED_PUBLISH' })
  expect(calls[1].body).toBeNull()
})
