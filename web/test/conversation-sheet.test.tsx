import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createElement, type ReactElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { Sheet, SheetContent, SheetTitle, SheetTrigger } from '../src/components/ui/sheet'

test('responsive navigation Sheet uses an accessible dialog trigger', () => {
  const view = renderToStaticMarkup(createElement(Sheet, null,
    createElement(SheetTrigger, { 'aria-label': 'Open Conversations and Threads' }, 'Threads'),
    createElement(SheetContent, null,
      createElement(SheetTitle, null, 'Browse Story'),
      createElement('nav', { 'aria-label': 'Story Conversations' }, 'Story'))))
  assert.match(view, /data-slot="sheet-trigger"/)
  assert.match(view, /aria-haspopup="dialog"/)
  assert.match(view, /aria-label="Open Conversations and Threads"/)
  assert.match(view, /Threads/)
})

test('mobile Sheet has a viewport-bound panel and accessible close action', () => {
  // Base UI portals intentionally produce no server-rendered HTML. Inspect the
  // pure SheetContent element tree instead of expecting a portal during SSR.
  const portal = SheetContent({ children: createElement(SheetTitle, null, 'Browse Story') })
  const nodes = (portal.props as { children: ReactElement[] }).children
  const panel = nodes[1] as ReactElement<{
    className: string; children: ReactElement[]; 'data-slot': string
  }>
  assert.equal(panel.props['data-slot'], 'sheet-content')
  assert.match(panel.props.className, /h-dvh/)
  assert.match(panel.props.className, /overflow-hidden/)
  const close = panel.props.children.at(-1) as ReactElement<{ 'aria-label': string; 'data-slot'?: string }>
  assert.equal(close.props['aria-label'], 'Close navigation')
})
