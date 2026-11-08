import { Link, useRouter } from '@tanstack/react-router'
import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { LogOut, Settings } from 'lucide-react'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuItem,
  DropdownMenuSeparator, DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { authClient } from '@/lib/auth-client'

type StudioHeaderProps = {
  user: { name: string; email: string }
}

export function StudioHeader({ user }: StudioHeaderProps) {
  const router = useRouter()
  const queryClient = useQueryClient()
  const [error, setError] = useState<string | null>(null)
  const [signingOut, setSigningOut] = useState(false)
  const initials = user.name?.trim().split(/\s+/).slice(0, 2)
    .map(part => part.charAt(0)).join('').toUpperCase() || user.email.charAt(0).toUpperCase()

  const signOut = async () => {
    if (signingOut) return
    setSigningOut(true)
    setError(null)
    try {
      const result = await authClient.signOut()
      if (result.error) throw new Error(result.error.message || 'Sign out failed')
      // A different person may sign in on this browser; no prior user data may remain.
      queryClient.clear()
      await router.navigate({ to: '/login' })
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Sign out failed')
    } finally {
      setSigningOut(false)
    }
  }

  return <>
    <header className="shrink-0 border-b border-border">
      <div className="mx-auto flex w-full max-w-[1280px] items-center justify-between gap-4 px-6 py-3">
        <Link to="/dashboard" className="flex min-w-0 items-center gap-2 no-underline" aria-label="NovelTea Studio dashboard">
          <span className="text-xs font-semibold uppercase tracking-widest text-muted-foreground">NovelTea</span>
          <span aria-hidden="true" className="text-muted-foreground/50">/</span>
          <span className="truncate text-sm font-semibold text-foreground">Story Studio</span>
        </Link>
        <DropdownMenu>
          <DropdownMenuTrigger aria-label="Account menu" title="Account menu" disabled={signingOut}
            className="rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background">
            <Avatar size="lg">
              <AvatarFallback className="bg-secondary font-medium text-secondary-foreground">{initials}</AvatarFallback>
            </Avatar>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            <div className="min-w-0 px-2 py-2">
              <p className="m-0 truncate text-sm font-medium text-popover-foreground">{user.name}</p>
              <p className="m-0 truncate text-xs text-muted-foreground" title={user.email}>{user.email}</p>
            </div>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => void router.navigate({ to: '/settings' })}>
              <Settings className="size-4" /> Settings
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem disabled={signingOut} variant="destructive" onClick={() => void signOut()}>
              <LogOut className="size-4" /> {signingOut ? 'Signing out…' : 'Sign out'}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </header>
    {error && <div role="alert" className="mx-auto max-w-[1280px] px-6 pt-3 text-sm text-destructive">{error}</div>}
  </>
}
