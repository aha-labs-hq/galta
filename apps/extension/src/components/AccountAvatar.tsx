import { useState } from 'react'
import { cn } from '@/lib/utils'
import { accountName, type AccountUser } from '../shared/account'

/** The person's picture, or the first letter of their name on paper. */
export function AccountAvatar({ user, className }: { user: AccountUser; className?: string }) {
  const [failed, setFailed] = useState<string | null>(null)
  const picture = user.image && failed !== user.image ? user.image : null
  return <span className={cn('account-avatar', className)} aria-hidden="true">
    {picture ? <img src={picture} alt="" referrerPolicy="no-referrer" draggable={false} onError={() => setFailed(picture)} />
      : <span className="account-avatar-initial">{accountName(user).charAt(0).toUpperCase()}</span>}
  </span>
}
