import { LoaderCircle, Send } from 'lucide-react'
import { Button } from '@/components/ui/button'

/** A truthful empty canonical Story view until the Thread has verified
 * native-backed Outline/Graph evidence. */
export function EmptyStoryContext() {
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <section aria-label="Story Outline" className="rounded-lg bg-muted/30 p-3 text-sm">
        <h3 className="m-0 font-semibold">Outline</h3>
        <p className="mb-0 mt-1 text-xs text-muted-foreground">
          Creative Direction, Arcs, Milestones and Events will appear as verified Story work is saved.
        </p>
      </section>
      <section aria-label="Story Graph" className="rounded-lg bg-muted/30 p-3 text-sm">
        <h3 className="m-0 font-semibold">Graph</h3>
        <p className="mb-0 mt-1 text-xs text-muted-foreground">
          Relationships will appear from the selected Thread’s validated Story revision.
        </p>
      </section>
    </div>
  )
}

export function EmptyStoryWelcome() {
  return (
    <p className="m-0 text-sm text-muted-foreground">
      What would you like to create? Send a message to begin a new Thread. No generation Job needs to be
      configured first.
    </p>
  )
}

export function StoryChatPrompt({
  value,
  creativeMode,
  onCreativeModeChange,
  busy,
  sending,
  onChange,
  onSend,
}: {
  value: string
  creativeMode: 'autonomous' | 'collaborative'
  onCreativeModeChange: (mode: 'autonomous' | 'collaborative') => void
  busy: boolean
  sending: boolean
  onChange: (next: string) => void
  onSend: () => void
}) {
  return (
    <form
      aria-label="Start Story Chat"
      className="border-t border-border/50 px-4 py-3"
      onSubmit={(event) => {
        event.preventDefault()
        onSend()
      }}
    >
      <div className="mx-auto mb-2 flex max-w-3xl justify-end text-xs text-muted-foreground">
        <label className="inline-flex items-center gap-2">Creative mode
          <select aria-label="Initial Thread creative mode" value={creativeMode}
            disabled={busy}
            onChange={event => onCreativeModeChange(event.target.value as 'autonomous' | 'collaborative')}
            className="rounded border border-input bg-background px-2 py-1 text-foreground">
            <option value="autonomous">Autonomous</option>
            <option value="collaborative">Collaborative</option>
          </select>
        </label>
      </div>
      <div className="mx-auto flex max-w-3xl items-end gap-2">
        <textarea
          aria-label="Story message"
          rows={2}
          maxLength={4000}
          disabled={busy}
          className="min-w-0 flex-1 resize-y rounded-md border border-input bg-transparent px-3 py-2 text-sm disabled:opacity-50"
          placeholder="Write a branching mystery Story about an archivist…"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault()
              onSend()
            }
          }}
        />
        <Button type="submit" size="sm" disabled={busy || !value.trim()}>
          {sending ? (
            <LoaderCircle className="size-4 animate-spin motion-reduce:animate-none" />
          ) : (
            <Send className="size-4" />
          )}
          Send
        </Button>
      </div>
    </form>
  )
}
