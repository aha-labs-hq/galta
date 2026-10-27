import { useState, type CSSProperties, type ReactNode } from 'react'
import { AppWindow, Images, MessagesSquare, UserRound } from 'lucide-react'
import type { MediaProviderId } from '@galta/canvas'
import { Dialog, DialogContent } from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { AccountAvatar } from '@/components/AccountAvatar'
import { accountName } from '../shared/account'
import type { Account } from './account'
import { AccountView } from './AccountView'
import { ConnectionView, type CodexStatus } from './ConnectionView'
import { GenerationProviders, generationSummary, useMediaProviders } from './GenerationProviders'
import { SettingsRow, ViewHeader, ViewStack } from './SettingsParts'
import { VIEW_ORDER, type SettingsView } from './settings'
import './settings.css'

type Props = {
  view: SettingsView; onViewChange(view: SettingsView): void
  account: Account
  canvasId: string | undefined; canvasProblem: string | null; onCheckCanvas(): void; externalConnected: boolean
  status: CodexStatus; plan: string; error: string | null; onConnect(): Promise<void>; onSignIn(): Promise<void>
}

/** Every setting lives in this one dialog over the canvas, opened from the
 * canvas's bottom-left corner or from wherever a connection is needed. It
 * grows out of whatever opened it. */
export function SettingsDialog(p: Props) {
  const media = useMediaProviders(p.view !== null)
  const [editing, setEditing] = useState<MediaProviderId | null>(null)
  // The direction is decided once per change, so later renders keep the motion.
  const [motion, setMotion] = useState<{ view: SettingsView; from?: string; direction?: 'forward' | 'back'; origin?: CSSProperties | undefined }>({ view: p.view })
  if (motion.view !== p.view) {
    setMotion({ view: p.view, origin: motion.view ? motion.origin : openingOrigin(), ...(motion.view && p.view ? { from: motion.view, direction: VIEW_ORDER.indexOf(p.view) > VIEW_ORDER.indexOf(motion.view) ? 'forward' : 'back' } : {}) })
    if (editing) setEditing(null)
  }
  const open = p.view !== null
  const close = () => p.onViewChange(null)
  const toSettings = () => p.onViewChange('settings')
  const user = p.account.state?.user ?? null
  const chat = p.status === 'connected' ? ['ChatGPT', p.plan && p.plan.charAt(0).toUpperCase() + p.plan.slice(1)].filter(Boolean).join(' · ')
    : p.status === 'connecting' ? 'Connecting…' : p.status === 'sign-in-required' ? 'Sign in' : p.status === 'error' ? 'Needs attention' : 'Set up'

  let content: ReactNode
  if (p.view === 'account') content = <AccountView account={p.account} onBack={toSettings} />
  else if (p.view === 'connect' || p.view === 'chat') content = <ConnectionView view={p.view} onViewChange={p.onViewChange} onClose={close} canvasId={p.canvasId} canvasProblem={p.canvasProblem} onCheckCanvas={p.onCheckCanvas} externalConnected={p.externalConnected} status={p.status} error={p.error} onConnect={p.onConnect} onSignIn={p.onSignIn} />
  else if (p.view === 'generation') content = <>
    <ViewHeader back={{ label: 'Settings', onClick: toSettings }} title="Generation" description="Prompts and reference media go to the provider you connect, which bills you. Keys stay on this Mac." />
    <div className="settings-body"><GenerationProviders state={media} editing={editing} onEdit={setEditing} /></div>
  </>
  else content = <>
    <ViewHeader title="Settings" />
    <nav className="settings-body settings-list" aria-label="Settings">
      {user ? <SettingsRow hero destination="account" lead={<AccountAvatar user={user} className="account-avatar-row" />} label={accountName(user)} detail={p.account.unavailable ?? (user.name.trim() ? user.email : 'Aha Labs account')} onClick={() => p.onViewChange('account')} />
        : <SettingsRow hero destination="account" lead={<span className="settings-lead-mark"><UserRound aria-hidden="true" /></span>} label="Sign in" detail={p.account.unavailable ?? (p.account.state ? 'One Aha Labs account for every app' : 'Checking…')} onClick={() => p.onViewChange('account')} />}
      <SettingsRow destination="chat" lead={<MessagesSquare aria-hidden="true" />} label="Chat in Galta" state={chat} onClick={() => p.onViewChange('chat')} />
      <SettingsRow destination="connect" lead={<AppWindow aria-hidden="true" />} label="Work in Codex or Claude Code" state={p.externalConnected ? 'Connected' : undefined} onClick={() => p.onViewChange('connect')} />
      <SettingsRow destination="generation" lead={<Images aria-hidden="true" />} label="Generation" state={generationSummary(media)} onClick={() => p.onViewChange('generation')} />
    </nav>
    <nav className="settings-aside settings-body" aria-label="Help and privacy">
      <Button asChild variant="ghost" size="compact" className="settings-quiet"><a href="https://galta.art/help/" target="_blank" rel="noopener noreferrer">Help</a></Button>
      <Button asChild variant="ghost" size="compact" className="settings-quiet"><a href="https://galta.art/privacy/" target="_blank" rel="noopener noreferrer">Privacy</a></Button>
    </nav>
  </>

  return <Dialog open={open} onOpenChange={next => { if (!next) close() }}><DialogContent className="settings-panel" style={motion.origin} closeLabel="Close settings"
    onEscapeKeyDown={event => {
      // An open field folds first; the next Escape closes Settings.
      if (editing) { event.preventDefault(); setEditing(null); return }
      if (event.target instanceof Element && event.target.closest('[data-folds-on-escape]')) event.preventDefault()
    }}
    onOpenAutoFocus={event => {
      // Opening lands on the next step, not on the first row before it.
      const next = (event.currentTarget as HTMLElement).querySelector<HTMLElement>('.settings-action[data-variant=default]:not(:disabled)')
      if (next) { event.preventDefault(); next.focus() }
    }}>
    <ViewStack view={p.view ?? 'closed'} returnTo={motion.from} direction={motion.direction}>{content}</ViewStack>
  </DialogContent></Dialog>
}

/** Where the dialog grows from: the control that opened it, still focused
 * when the dialog is about to mount. The dialog is centred in the window, so
 * the offset from the window's centre is the offset from the dialog's. Read
 * before mount, so the first frame already has it. */
function openingOrigin(): CSSProperties | undefined {
  const source = document.activeElement
  if (!(source instanceof HTMLElement) || source === document.body) return undefined
  const box = source.getBoundingClientRect()
  if (!box.width) return undefined
  const dx = box.left + box.width / 2 - innerWidth / 2, dy = box.top + box.height / 2 - innerHeight / 2
  return { '--settings-origin': `calc(50% + ${dx}px) calc(50% + ${dy}px)`, '--settings-from-x': `${dx * .08}px`, '--settings-from-y': `${dy * .08}px` } as CSSProperties
}
