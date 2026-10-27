import { createSign } from 'node:crypto'

/** The Chrome Web Store API v2, signed in as the publisher's service account. */

export type ServiceAccount = { client_email: string; private_key: string }
export type ItemState = 'PENDING_REVIEW' | 'STAGED' | 'PUBLISHED' | 'PUBLISHED_TO_TESTERS' | 'REJECTED' | 'CANCELLED'
export type Revision = { state: ItemState; version: string }
/** `uploaded` is the package version the store holds. A submission made in the dashboard has no review state in the API. */
export type StoreStatus = { uploaded: string | undefined; published: Revision | undefined; submitted: Revision | undefined; takenDown: boolean; warned: boolean }

const API = 'https://chromewebstore.googleapis.com'
const TOKEN = 'https://oauth2.googleapis.com/token'
const SCOPE = 'https://www.googleapis.com/auth/chromewebstore'
export const KEYCHAIN_SERVICE = 'galta-chrome-web-store'

/** The service account's JSON key lives only in the login keychain, base64-encoded. */
export function keychainServiceAccount(): ServiceAccount {
  const child = Bun.spawnSync(['/usr/bin/security', 'find-generic-password', '-s', KEYCHAIN_SERVICE, '-w'], { stdout: 'pipe', stderr: 'pipe' })
  if (child.exitCode !== 0) throw new Error(`The keychain has no ${KEYCHAIN_SERVICE} entry; CHROMEWEBSTORE.md describes the service account`)
  const account = JSON.parse(Buffer.from(child.stdout.toString().trim(), 'base64').toString()) as Partial<ServiceAccount>
  if (!account.client_email || !account.private_key) throw new Error(`The ${KEYCHAIN_SERVICE} keychain entry is not a service account key`)
  return account as ServiceAccount
}

export class ChromeWebStore {
  private token?: { value: string; expires: number }

  /** `item` is `publishers/<publisher>/items/<extension id>`. */
  constructor(private account: ServiceAccount, private item: string, private request: typeof fetch = fetch, private pause = (ms: number) => Bun.sleep(ms)) {}

  async status(): Promise<StoreStatus> {
    const status = await this.call('GET', `${API}/v2/${this.item}:fetchStatus`)
    // v2 has no read of the stored package; v1.1's draft projection names its version.
    const draft = await this.call('GET', `https://www.googleapis.com/chromewebstore/v1.1/items/${this.item.slice(this.item.lastIndexOf('/') + 1)}?projection=DRAFT`)
    const revision = (value?: { state?: ItemState; distributionChannels?: { crxVersion?: string }[] }) =>
      value?.state ? { state: value.state, version: value.distributionChannels?.[0]?.crxVersion ?? '' } : undefined
    return {
      uploaded: draft.crxVersion, published: revision(status.publishedItemRevisionStatus), submitted: revision(status.submittedItemRevisionStatus),
      takenDown: Boolean(status.takenDown), warned: Boolean(status.warned),
    }
  }

  /** Uploads a package and waits, at most five minutes, until the store has processed it. */
  async upload(zip: Uint8Array) {
    const result = await this.call('POST', `${API}/upload/v2/${this.item}:upload`, zip)
    let state = result.uploadState as string
    for (let waited = 0; state === 'IN_PROGRESS' || state === 'UPLOAD_IN_PROGRESS'; waited += 5_000) {
      if (waited >= 300_000) throw new Error('The store was still processing the upload after five minutes')
      await this.pause(5_000)
      state = (await this.call('GET', `${API}/v2/${this.item}:fetchStatus`)).lastAsyncUploadState
    }
    if (state !== 'SUCCEEDED') throw new Error(`The store did not accept the package: ${state}`)
  }

  /** Asks for review of the uploaded package. Approval stages it; nothing becomes public. */
  submit() { return this.publish({ publishType: 'STAGED_PUBLISH' }) }

  /** Publishes the approved, staged package. */
  release() { return this.publish() }

  private async publish(body?: object): Promise<ItemState> {
    const result = await this.call('POST', `${API}/v2/${this.item}:publish`, body && JSON.stringify(body))
    for (const warning of result.warningInfo?.warnings ?? []) console.warn(`Store warning ${warning.reason}: ${warning.description}`)
    return result.state
  }

  private async call(method: string, url: string, body?: Uint8Array | string) {
    const headers: Record<string, string> = { Authorization: `Bearer ${await this.accessToken()}` }
    if (typeof body === 'string') headers['Content-Type'] = 'application/json'
    const response = await this.request(url, { method, headers, body: body ?? null })
    const text = await response.text()
    if (!response.ok) throw new Error(`Chrome Web Store ${url.slice(url.lastIndexOf(':') + 1)} failed (${response.status}): ${text.slice(0, 1500)}`)
    return text ? JSON.parse(text) : {}
  }

  private async accessToken() {
    if (this.token && this.token.expires > Date.now() + 60_000) return this.token.value
    const now = Math.floor(Date.now() / 1000), encode = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url')
    const unsigned = `${encode({ alg: 'RS256', typ: 'JWT' })}.${encode({ iss: this.account.client_email, scope: SCOPE, aud: TOKEN, iat: now, exp: now + 3600 })}`
    const assertion = `${unsigned}.${createSign('RSA-SHA256').update(unsigned).sign(this.account.private_key, 'base64url')}`
    const response = await this.request(TOKEN, { method: 'POST', body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }) })
    const result = await response.json() as { access_token?: string; expires_in?: number; error_description?: string; error?: string }
    if (!response.ok || !result.access_token) throw new Error(`Google refused the store service account: ${result.error_description ?? result.error ?? response.status}`)
    this.token = { value: result.access_token, expires: Date.now() + (result.expires_in ?? 3600) * 1000 }
    return this.token.value
  }
}
