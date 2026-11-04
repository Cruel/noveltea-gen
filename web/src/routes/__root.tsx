import { HeadContent, Outlet, Scripts, createRootRouteWithContext } from '@tanstack/react-router'
import type { QueryClient } from '@tanstack/react-query'
import { TooltipProvider } from '@/components/ui/tooltip'
import type { ReactNode } from 'react'
import '../style.css'

export const Route = createRootRouteWithContext<{ queryClient: QueryClient }>()({
  head: () => ({ meta: [
    { charSet: 'utf-8' },
    { name: 'viewport', content: 'width=device-width, initial-scale=1' },
    { title: 'NovelTea Studio' },
  ] }),
  component: Root,
})

function Root() { return <Document><Outlet /></Document> }
function Document({ children }: { children: ReactNode }) {
  return <html lang="en" className="dark"><head><HeadContent /></head><body><TooltipProvider>{children}</TooltipProvider><Scripts /></body></html>
}
