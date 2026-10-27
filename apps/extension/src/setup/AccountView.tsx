import { useEffect, useId, useRef, useState } from 'react'
import { LogOut, PenLine, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { AccountAvatar } from '@/components/AccountAvatar'
import { GoogleMark } from '@/components/GoogleMark'
import { CODE_LENGTH, normalEmail } from '../shared/account'
import type { Account } from './account'
import { CodeField } from './CodeField'
import { SettingsRow, ViewHeader } from './SettingsParts'

const RESEND_AFTER = 30_000

type Props = { account: Account; onBack(): void }
type Step = 'start' | 'code' | 'profile' | 'delete' | 'delete-code'

/** The Aha Labs account, in one view of Settings. Signed out, it signs in with
 * Google or an emailed code; signed in, it names the person, signs out and
 * deletes the account. The canvas never waits on any of it. */
export function AccountView({ account, onBack }: Props) {
  const user = account.state?.user ?? null, google = account.state?.google ?? null
  const [step, setStep] = useState<Step>(user ? 'profile' : 'start')
  const [email, setEmail] = useState(''), [code, setCode] = useState(''), [name, setName] = useState('')
  const [editingName, setEditingName] = useState(false)
  const [busy, setBusy] = useState<string | null>(null), [error, setError] = useState(''), [notice, setNotice] = useState('')
  const [sentAt, setSentAt] = useState(0), [now, setNow] = useState(Date.now())
  const ids = useId()
  const field = useRef<HTMLInputElement>(null), editTrigger = useRef<HTMLButtonElement>(null)
  const title = useRef<HTMLHeadingElement>(null)

  // Signing in or out anywhere (another Galta page, the Google tab) moves this view.
  const signedIn = Boolean(user)
  useEffect(() => {
    setStep(current => signedIn ? current === 'delete' || current === 'delete-code' ? current : 'profile' : current === 'code' ? current : 'start')
    setEditingName(false); setCode('')
  }, [signedIn])
  // A Google attempt reports how it ended once, when it ends; an old result
  // waiting in the background is not news.
  const [googleError, setGoogleError] = useState(''), lastGoogle = useRef(google)
  useEffect(() => {
    if (lastGoogle.current === 'waiting' && (google === 'cancelled' || google === 'failed')) setGoogleError(google === 'cancelled' ? 'Google sign-in was cancelled.' : 'Google sign-in didn’t finish. Try again.')
    if (google === 'waiting') setGoogleError('')
    lastGoogle.current = google
  }, [google])
  useEffect(() => {
    if (!sentAt) return
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [sentAt])
  // Each step lands on its field. preventScroll: the dialog must not jump.
  useEffect(() => { if (!busy) (field.current ?? title.current)?.focus({ preventScroll: true }) }, [step, editingName, busy, google])

  const run = async (label: string, work: () => Promise<{ ok: boolean; error?: string }>) => {
    setBusy(label); setError(''); setNotice('')
    const result = await work()
    setBusy(null)
    if (!result.ok) setError(result.error ?? 'Something went wrong. Try again.')
    return result.ok
  }
  const sendCode = (to: string, next: Step) => run('send', async () => {
    const response = await account.act({ action: 'send-code', email: to })
    if (response.ok) { setStep(next); setCode(''); setSentAt(Date.now()); setNow(Date.now()) }
    return response
  })
  const verify = (value: string) => run('verify', () => account.act({ action: 'verify-code', email, code: value }))
  const startEmail = () => {
    const address = normalEmail(email)
    if (!address) { setError(email.trim() ? 'Enter a valid email address.' : 'Enter your email address.'); field.current?.focus({ preventScroll: true }); return }
    setEmail(address)
    void sendCode(address, 'code')
  }
  const remove = () => run('delete', async () => {
    const response = await account.act({ action: 'delete', code })
    if (response.ok) { setStep('start'); setNotice('Your Aha Labs account was deleted.') }
    return response
  })
  const foldName = () => { setEditingName(false); setError('') }
  // A folded name editor returns focus to its row once the fold is committed,
  // not on a frame callback a hidden or busy page may never run.
  const wasEditing = useRef(false)
  useEffect(() => {
    if (wasEditing.current && !editingName) editTrigger.current?.focus({ preventScroll: true })
    wasEditing.current = editingName
  }, [editingName])
  const rename = () => run('rename', async () => {
    const response = await account.act({ action: 'rename', name })
    if (response.ok) foldName()
    return response
  })
  const signOut = () => run('sign-out', async () => {
    const response = await account.act({ action: 'sign-out' })
    if (response.ok) setNotice('You’re signed out.')
    return response
  })

  const wait = Math.max(0, Math.ceil((sentAt + RESEND_AFTER - now) / 1000))
  const failureMessage = error || account.unavailable
  const failure = failureMessage ? <p id={`${ids}-error`} role="alert" className="settings-error">{failureMessage}</p> : null
  const codeAside = (resendTo: string, back?: { label: string; onClick(): void }) => <div className="settings-aside">
    {back ? <Button type="button" variant="ghost" size="compact" className="settings-quiet" disabled={Boolean(busy)} onClick={back.onClick}>{back.label}</Button> : <span />}
    <Button type="button" variant="ghost" size="compact" className="settings-quiet" disabled={Boolean(busy) || wait > 0} onClick={() => void sendCode(resendTo, step)}>
      {wait > 0 ? <>Resend in <span className="tabular-nums">0:{String(wait).padStart(2, '0')}</span></> : 'Resend code'}</Button>
  </div>

  if (user && step !== 'delete' && step !== 'delete-code') return <>
    <ViewHeader titleRef={title} back={{ label: 'Settings', onClick: onBack }} lead={<AccountAvatar user={user} className="account-avatar-hero" />} title={user.name.trim() || 'Your account'} description={user.email} />
    <div className="settings-list settings-body">
      <SettingsRow buttonRef={editTrigger} lead={<PenLine aria-hidden="true" />} label="Name" opens={false} className="settings-row-editable"
        disabled={Boolean(busy)} state={editingName ? undefined : <><span className="settings-name-value">{user.name.trim() || 'Not set'}</span><span className="settings-row-hint">Edit</span></>}
        onClick={() => { if (editingName) return; setName(user.name); setEditingName(true); setError('') }} />
      <div className="settings-reveal" data-open={editingName} inert={!editingName}><div>
        <form className="settings-inline-form" data-folds-on-escape onSubmit={event => { event.preventDefault(); if (!busy) void rename() }}
          onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); foldName() } }}>
          <label htmlFor={`${ids}-name`} className="sr-only">Name</label>
          <Input ref={editingName ? field : undefined} id={`${ids}-name`} value={name} maxLength={80} autoComplete="name" disabled={Boolean(busy)} className="settings-field settings-field-compact"
            onChange={event => { setName(event.target.value); setError('') }} />
          <Button type="button" variant="ghost" size="compact" className="settings-quiet" disabled={Boolean(busy)} onClick={foldName}>Cancel</Button>
          <Button type="submit" size="compact" disabled={Boolean(busy) || name.trim() === user.name.trim()}>{busy === 'rename' ? 'Saving…' : 'Save'}</Button>
        </form>
      </div></div>
      <SettingsRow lead={<LogOut aria-hidden="true" />} label={busy === 'sign-out' ? 'Signing out…' : 'Sign out'} opens={false} disabled={Boolean(busy)} onClick={() => void signOut()} />
      <SettingsRow lead={<Trash2 aria-hidden="true" />} label="Delete account" disabled={Boolean(busy)} onClick={() => { setStep('delete'); setError(''); setCode('') }} className="settings-row-danger" />
    </div>
    {failure}
  </>

  if (user) return <>
    <ViewHeader titleRef={title} back={{ label: 'Your account', onClick: () => { setStep('profile'); setError('') } }} title="Delete account"
      description="This deletes your Aha Labs account and signs you out of every Aha Labs app. Your canvases stay on this Mac." />
    {step === 'delete' ? <div className="settings-body settings-stack">
      {failure}
      <p className="settings-hint">We’ll send a confirmation code to {user.email}.</p>
      <Button variant="secondary" className="settings-action" disabled={Boolean(busy)} onClick={() => void sendCode(user.email, 'delete-code')}>{busy === 'send' ? 'Sending…' : 'Send verification code'}</Button>
    </div> : <form className="settings-body settings-stack" onSubmit={event => { event.preventDefault(); if (code.length === CODE_LENGTH && !busy) void remove() }}>
      <p className="settings-hint">Enter the code sent to {user.email}.</p>
      <CodeField inputRef={field} value={code} length={CODE_LENGTH} label={`${CODE_LENGTH}-digit code`} invalid={Boolean(error)} disabled={Boolean(busy)} describedBy={error ? `${ids}-error` : undefined}
        onChange={value => { setCode(value); setError('') }} />
      {failure}
      <Button type="submit" variant="destructive" className="settings-action" disabled={Boolean(busy) || code.length !== CODE_LENGTH}>{busy === 'delete' ? 'Deleting…' : 'Delete account'}</Button>
      {codeAside(user.email)}
    </form>}
  </>

  if (google === 'waiting') return <>
    <ViewHeader titleRef={title} back={{ label: 'Settings', onClick: onBack }} title="Continue in the new tab" description="Choose your Google account there. Galta signs you in as soon as you’re done." />
    <div className="settings-body settings-stack">
      <p className="settings-waiting" role="status"><span aria-hidden="true" />Waiting for Google</p>
      {failure}
      <Button variant="secondary" className="settings-action" disabled={Boolean(busy)} onClick={() => void run('show', () => account.act({ action: 'google-show' }))}>Show the Google tab</Button>
      <Button variant="ghost" className="settings-action settings-quiet" disabled={Boolean(busy)} onClick={() => void run('cancel', () => account.act({ action: 'google-cancel' }))}>Cancel</Button>
    </div>
  </>

  if (step === 'code') return <>
    <ViewHeader titleRef={title} back={{ label: 'Sign in', onClick: () => { setStep('start'); setError(''); setCode('') } }} title="Check your email" description={`We sent a ${CODE_LENGTH}-digit code to ${email}.`} />
    <form className="settings-body settings-stack" onSubmit={event => { event.preventDefault(); if (code.length === CODE_LENGTH && !busy) void verify(code) }}>
      <CodeField inputRef={field} value={code} length={CODE_LENGTH} label={`${CODE_LENGTH}-digit code`} invalid={Boolean(error)} disabled={Boolean(busy)} describedBy={error ? `${ids}-error` : undefined}
        onChange={value => { setCode(value); setError(''); if (value.length === CODE_LENGTH) void verify(value) }} />
      {busy === 'verify' ? <p className="settings-hint" role="status">Signing in…</p> : failure}
      {codeAside(email, { label: 'Use another email', onClick: () => { setStep('start'); setError(''); setCode('') } })}
    </form>
  </>

  return <>
    <ViewHeader titleRef={title} back={{ label: 'Settings', onClick: onBack }} title="Sign in"
      description={account.state?.ended ? 'Your session ended. Sign in again to continue.' : 'One Aha Labs account for Galta and our other apps. Your canvases stay on this Mac.'} />
    <div className="settings-body settings-stack">
      {notice && <p role="status" className="settings-notice">{notice}</p>}
      <Button variant="secondary" className="settings-action" disabled={Boolean(busy)} onClick={() => { setGoogleError(''); void run('google', () => account.act({ action: 'google' })) }}><GoogleMark />Continue with Google</Button>
      {googleError && <p role="alert" className="settings-error">{googleError}</p>}
      <p className="settings-or"><span>or</span></p>
      <form className="settings-stack" noValidate onSubmit={event => { event.preventDefault(); if (!busy) startEmail() }}>
        <label htmlFor={`${ids}-email`} className="sr-only">Email address</label>
        <Input ref={field} id={`${ids}-email`} type="email" value={email} placeholder="you@example.com" autoComplete="email" spellCheck={false} disabled={Boolean(busy)} className="settings-field"
          aria-invalid={Boolean(error) || undefined} aria-describedby={error ? `${ids}-error` : undefined} onChange={event => { setEmail(event.target.value); setError('') }} />
        {failure}
        <Button type="submit" className="settings-action" disabled={Boolean(busy)}>{busy === 'send' ? 'Sending code…' : 'Continue with email'}</Button>
      </form>
    </div>
  </>
}
