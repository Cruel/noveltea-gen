import { createContext, useContext, useId, useState, type ComponentProps } from 'react'
import { cn } from 'cn'

/** Minimal shadcn-style Trace for durable controller progress. */
export function Trace({ className, ...props }: ComponentProps<'ol'>) {
  return <ol data-slot="trace" className={cn('m-0 grid gap-2 p-0', className)} {...props} />
}

export function TraceLine({ className, status, ...props }:
  ComponentProps<'li'> & { status?: 'running' | 'error' | 'pending' }) {
  return <li data-slot="trace-line" data-status={status}
    className={cn('relative grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] gap-2 border-0 p-0 text-sm', className)}
    {...props} />
}

export function TraceIcon({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="trace-icon" aria-hidden="true"
    className={cn('mt-0.5 flex size-4 shrink-0 items-center justify-center text-muted-foreground', className)}
    {...props} />
}

export function TraceTitle({ className, ...props }: ComponentProps<'span'>) {
  return <span data-slot="trace-title" className={cn('block text-sm leading-5 text-foreground', className)}
    {...props} />
}

export function TraceDescription({ className, ...props }: ComponentProps<'div'>) {
  return <div data-slot="trace-description" className={cn('mt-1 min-w-0 text-xs text-muted-foreground', className)}
    {...props} />
}

type TraceDisclosureContext = {
  open: boolean
  contentId: string
  toggle: () => void
}

const DisclosureContext = createContext<TraceDisclosureContext | null>(null)

function useDisclosure() {
  const context = useContext(DisclosureContext)
  if (!context) throw new Error('Trace disclosure parts must be inside TraceCollapsible.')
  return context
}

type TraceCollapsibleProps = ComponentProps<'div'> & {
  open?: boolean
  defaultOpen?: boolean
  onOpenChange?: (open: boolean) => void
}

/** Keep content mounted so closing an outer trace doesn't reset nested rows.
 * Both levels use the same height transition and honor reduced motion. */
export function TraceCollapsible({ className, open, defaultOpen = false, onOpenChange,
  children, ...props }: TraceCollapsibleProps) {
  const [localOpen, setLocalOpen] = useState(defaultOpen)
  const contentId = useId()
  const expanded = open ?? localOpen
  const toggle = () => {
    const next = !expanded
    if (open === undefined) setLocalOpen(next)
    onOpenChange?.(next)
  }
  return <DisclosureContext.Provider value={{ open: expanded, contentId, toggle }}>
    <div data-slot="trace-collapsible" data-state={expanded ? 'open' : 'closed'}
      className={cn('min-w-0', className)} {...props}>
      {children}
    </div>
  </DisclosureContext.Provider>
}

export function TraceCollapsibleTrigger({ className, onClick, ...props }: ComponentProps<'button'>) {
  const { open, contentId, toggle } = useDisclosure()
  return <button type="button" data-slot="trace-collapsible-trigger"
    aria-expanded={open} aria-controls={contentId}
    className={cn('flex min-w-0 cursor-pointer items-start gap-2 rounded-sm text-left outline-offset-2 hover:text-foreground focus-visible:outline-2',
      className)}
    onClick={event => {
      onClick?.(event)
      if (!event.defaultPrevented) toggle()
    }} {...props} />
}

export function TraceCollapsibleContent({ className, children, ...props }: ComponentProps<'div'>) {
  const { open, contentId } = useDisclosure()
  return <div id={contentId} data-slot="trace-collapsible-content"
    data-state={open ? 'open' : 'closed'} aria-hidden={!open} inert={!open}
    className="grid min-w-0 grid-rows-[0fr] transition-[grid-template-rows] duration-200 ease-out data-[state=open]:grid-rows-[1fr] motion-reduce:transition-none"
    {...props}>
    <div className="min-h-0 overflow-hidden">
      <div className={cn('min-w-0', className)}>{children}</div>
    </div>
  </div>
}
