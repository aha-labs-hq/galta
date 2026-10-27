import { useCallback, useEffect, useRef, useState } from 'react'
import { ArrowUpRight, Check, ChevronDown, Copy, Monitor, RefreshCw } from 'lucide-react'
import type { SetupStatus } from '@galta/runtime'
import { Button } from '@/components/ui/button'
import { agentConnectionInstructions } from './connection'
import type { SettingsView } from './settings'
import { SettingsRow, ViewHeader } from './SettingsParts'

export type CodexStatus = 'disconnected' | 'connecting' | 'connected' | 'sign-in-required' | 'error'

type Props = {
  view: 'connect' | 'chat'; onViewChange(view: SettingsView): void; onClose(): void
  canvasId: string | undefined; canvasProblem: string | null; onCheckCanvas(): void; externalConnected: boolean
  status: CodexStatus; error: string | null; onConnect(): Promise<void>; onSignIn(): Promise<void>
}

/** Two optional ways to work with an agent, sharing the Mac runtime check. */
export function ConnectionView(p: Props) {
  const [installation, setInstallation] = useState<SetupStatus | null>(null)
  const [checking, setChecking] = useState(false)
  const [waitingForLogin, setWaitingForLogin] = useState(false)
  const [rechecked, setRechecked] = useState(false)
  const [copied, setCopied] = useState(false)
  const [copyError, setCopyError] = useState('')
  const request = useRef(0)
  const latest = useRef(p)
  latest.current = p
  const check = useCallback(async (manual = false) => {
    const view = latest.current.view
    const id = ++request.current
    if (manual) setRechecked(true)
    setChecking(true)
    try {
      const result: SetupStatus = typeof chrome === 'undefined' || !chrome.runtime?.id
        ? { state: 'absent', detail: 'Open Galta in your browser extension to connect an agent.' }
        : await chrome.runtime.sendMessage({ type: 'setup-status' })
      if (id !== request.current || latest.current.view !== view) return
      setInstallation(result)
      // A canvas opened before Galta for Mac was connected registers now.
      if ('health' in result) latest.current.onCheckCanvas()
      // Only the explicitly chosen built-in chat checks the provider account.
      if (view === 'chat' && result.state === 'ready' && latest.current.status !== 'connected' && latest.current.status !== 'connecting') await latest.current.onConnect()
    } catch {
      if (id === request.current) setInstallation({ state: 'unavailable', detail: 'Reload this canvas to reconnect to Galta.' })
    } finally { if (id === request.current) setChecking(false) }
  }, [])
  useEffect(() => {
    void check()
    const focus = () => { void check() }
    window.addEventListener('focus', focus)
    return () => { ++request.current; window.removeEventListener('focus', focus) }
  }, [p.view, check])
  useEffect(() => { if (p.status === 'connected' || p.error) setWaitingForLogin(false) }, [p.status, p.error])
  const chat = p.view === 'chat'
  const ready = chat ? p.status === 'connected' : p.externalConnected
  const macReady = installation?.state === 'ready' || !chat && installation?.state === 'runtime-unavailable'
  const canvasProblem = macReady && !ready && p.canvasProblem ? `This canvas couldn’t connect to Galta for Mac. ${p.canvasProblem}` : null
  const localReady = macReady && !canvasProblem
  const busy = checking || chat && p.status === 'connecting'
  // Galta for Mac is installed but cannot serve this view; its detail names the next step.
  const attention = Boolean(canvasProblem) || installation?.state === 'unavailable' || installation?.state === 'incompatible' || chat && installation?.state === 'runtime-unavailable'
  const command = installation && 'health' in installation ? installation.health.mcpCommand : undefined
  const instructions = agentConnectionInstructions(command, p.canvasId)
  const title = chat ? 'Chat in Galta' : 'Work in Codex or Claude Code'
  const description = ready ? chat ? 'You’re connected. Make something together.' : 'Your AI app is connected to this canvas.'
    : chat ? 'Use your ChatGPT account to work together, right here.' : 'Chat there. See changes on your canvas.'
  const preview = typeof chrome === 'undefined' || !chrome.runtime?.id
  const signIn = async () => { setWaitingForLogin(true); await p.onSignIn() }
  const copy = async () => {
    if (!instructions) return
    const id = request.current
    try {
      await navigator.clipboard.writeText(instructions.prompt)
      if (id === request.current) { setCopied(true); setCopyError('') }
    } catch { if (id === request.current) setCopyError('Couldn’t copy. Open Connection details to select and copy the instructions.') }
  }
  let instruction = 'Open Galta on your Mac and choose “Connect browser”. You only need to do this once.'
  if (ready) instruction = chat ? 'Start whenever you’re ready. Nothing is sent automatically.' : 'Continue in your AI app whenever you’re ready.'
  else if (chat && waitingForLogin) instruction = 'Finish signing in in the opened window. Your canvas can stay open.'
  else if (chat && localReady) instruction = 'Sign in to start a conversation on this canvas.'
  else if (localReady) instruction = instructions ? copied ? 'Paste into your AI app and follow its guidance to connect this canvas.' : 'Copy the instructions, then paste them into your AI app.'
    : 'In Galta for Mac, open “Other AI apps & updates” to get your connection configuration.'
  else if (canvasProblem) instruction = canvasProblem
  else if (attention && installation && 'detail' in installation) instruction = installation.detail
  else if (rechecked) instruction = preview ? 'This preview can’t connect. Open the Galta extension to connect an agent.' : 'Not connected yet. Open the Mac app and choose “Connect browser”.'

  const runtime = <SettingsRow lead={<Monitor aria-hidden="true" />} label="Galta for Mac" state={checking ? 'Checking…' : localReady ? <span className="settings-ok"><Check aria-hidden="true" />Ready</span> : attention ? 'Needs attention' : 'Not connected'} />

  return <>
    <ViewHeader back={{ label: 'Settings', onClick: () => p.onViewChange('settings') }} title={title} description={description} />
    <p className="settings-body settings-hint">Your request and canvas context go to your agent. It can read the whole canvas and any webpage you share.</p>
    {installation && !localReady && <div className="settings-body"><div className="settings-list">{runtime}</div></div>}
    <div className="settings-stack settings-next">
      <p className="settings-hint" aria-live="polite">{instruction}</p>
      {busy ? <Button className="settings-action" disabled><RefreshCw className="motion-safe:animate-spin" />{checking ? 'Checking connection…' : 'Connecting…'}</Button>
        : ready ? <Button className="settings-action" onClick={p.onClose}>Back to your canvas</Button>
        : localReady && !chat ? instructions ? <Button className="settings-action" onClick={() => void copy()}>{copied ? <Check /> : <Copy />}{copied ? 'Copy again' : 'Copy instructions'}</Button> : <Button className="settings-action" onClick={() => void check(true)}><RefreshCw />Check again</Button>
        : localReady ? <Button className="settings-action" onClick={() => void (p.status === 'sign-in-required' ? signIn() : p.onConnect())}>{waitingForLogin ? 'Return to sign-in' : p.status === 'sign-in-required' ? 'Sign in with ChatGPT' : 'Try connecting again'}</Button>
        : __GALTA_COMPANION_URL__ && !attention ? <Button asChild className="settings-action"><a href={__GALTA_COMPANION_URL__} target="_blank" rel="noopener noreferrer">Get Galta for Mac<ArrowUpRight /></a></Button>
        : <Button className="settings-action" onClick={() => void check(true)}>Check connection</Button>}
      {copied && !ready && !chat && <p className="settings-waiting" role="status"><span aria-hidden="true" />Waiting for your AI app</p>}
      {!busy && !localReady && !ready && !attention && __GALTA_COMPANION_URL__ && <Button variant="ghost" className="settings-action settings-quiet" onClick={() => void check(true)}>Already installed? Check connection</Button>}
      {((chat && p.error && localReady) || copyError) && <p role="alert" className="settings-error">{copyError || p.error}</p>}
    </div>
    <details className="settings-details"><summary>Connection details<ChevronDown aria-hidden="true" /></summary><div className="settings-details-content">
      {localReady && runtime}
      {instructions && !chat && <><p>For an agent with MCP settings, add this server:</p><pre className="settings-code-block" tabIndex={0} aria-label="MCP configuration">{instructions.configuration}</pre>
        {copyError && <pre className="settings-code-block" tabIndex={0} aria-label="Connection instructions">{instructions.prompt}</pre>}</>}
      {installation?.state === 'absent' && !__GALTA_COMPANION_URL__ && <p>Use the Mac app included with this build. A public download is not available yet.</p>}
      {localReady && installation && 'detail' in installation && <p>{installation.detail}</p>}
      {installation && 'health' in installation && <p>Galta {installation.health.version}{chat && ` · Codex ${installation.health.runtime.version ?? 'unavailable'}`}</p>}
      {__GALTA_BUILD__.mode === 'development' && chat && <Button variant="ghost" size="compact" className="settings-quiet" onClick={() => void p.onConnect()}>Use a developer bridge</Button>}
    </div></details>
  </>
}
