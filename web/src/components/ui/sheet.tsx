"use client"

import * as React from 'react'
import { Dialog as DialogPrimitive } from '@base-ui/react/dialog'
import { XIcon } from 'lucide-react'
import { cn } from 'cn'

/** shadcn-style Sheet backed by the same accessible Base UI Dialog as Dialog.
 * The portal preserves focus trapping, Escape and outside-click dismissal. */
function Sheet(props: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="sheet" {...props} />
}

function SheetTrigger(props: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="sheet-trigger" {...props} />
}

function SheetClose(props: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="sheet-close" {...props} />
}

function SheetTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return <DialogPrimitive.Title data-slot="sheet-title"
    className={cn('text-sm font-semibold', className)} {...props} />
}

function SheetContent({ className, children, side = 'left', ...props }:
  DialogPrimitive.Popup.Props & { side?: 'left' | 'right' }) {
  return <DialogPrimitive.Portal>
    <DialogPrimitive.Backdrop data-slot="sheet-overlay"
      className="fixed inset-0 z-50 bg-black/60 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 motion-reduce:animate-none" />
    <DialogPrimitive.Popup data-slot="sheet-content"
      className={cn(
        'fixed inset-y-0 z-50 flex h-dvh min-h-0 w-[min(23rem,90vw)] flex-col overflow-hidden border-border bg-background p-3 shadow-lg outline-none',
        side === 'left' ? 'left-0 border-r' : 'right-0 border-l',
        className,
      )}
      {...props}>
      {children}
      <SheetClose aria-label="Close navigation"
        className="absolute right-3 top-3 rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:outline-2">
        <XIcon className="size-4" />
      </SheetClose>
    </DialogPrimitive.Popup>
  </DialogPrimitive.Portal>
}

export { Sheet, SheetTrigger, SheetClose, SheetContent, SheetTitle }
