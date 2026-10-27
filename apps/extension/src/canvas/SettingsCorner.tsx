import { useEffect, useRef, useState } from 'react'
import { Settings } from 'lucide-react'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { AccountAvatar } from '@/components/AccountAvatar'
import { accountName } from '../shared/account'
import type { Account } from '../setup/account'
import { CanvasChromeButton, CanvasChromeSurface } from './CanvasChrome'

/** The bottom-left corner: who is signed in, and the way into Settings. A
 * person who signs in lands here, so their picture arrives with a small spring. */
export function SettingsCorner({ account, onOpen, inert }: { account: Account; onOpen(): void; inert?: boolean }) {
  const user = account.state?.user ?? null
  const previous = useRef(user?.id), [arrival, setArrival] = useState(0)
  useEffect(() => {
    if (user && previous.current !== user.id && account.state) setArrival(value => value + 1)
    previous.current = user?.id
  }, [user, account.state])
  return <CanvasChromeSurface className="settings-corner" inert={inert}>
    <Tooltip><TooltipTrigger asChild><CanvasChromeButton type="button" aria-label="Settings" aria-description={user ? `Signed in as ${accountName(user)}` : undefined} aria-haspopup="dialog" onClick={onOpen} className="settings-corner-button">
      {user ? <AccountAvatar key={arrival} user={user} className={arrival ? 'settings-corner-avatar is-arriving' : 'settings-corner-avatar'} /> : <Settings aria-hidden="true" />}
    </CanvasChromeButton></TooltipTrigger><TooltipContent side="right">{user ? accountName(user) : 'Settings'}</TooltipContent></Tooltip>
  </CanvasChromeSurface>
}
