import { Button } from '@/components/ui/button'
import type { CreativeMode } from '../../../src/creative-policy'

export function ThreadChatHeader({ title, mode, status, modeDisabled, showReview, onModeChange, onReview }: {
  title: string
  mode: CreativeMode | null
  status?: string | null
  modeDisabled: boolean
  showReview: boolean
  onModeChange: (mode: CreativeMode) => void
  onReview: () => void
}) {
  return <header className="story-chat-header flex min-h-11 min-w-0 shrink-0 items-center gap-3 border-b border-border/50 px-4 py-2">
    <h2 className="m-0 min-w-0 flex-1 truncate text-sm font-semibold" title={title}>{title}</h2>
    {mode !== null && <label className="inline-flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
      <span className="hidden sm:inline">Mode</span>
      <select aria-label="Thread default creative mode" value={mode} disabled={modeDisabled}
        onChange={event => onModeChange(event.target.value as CreativeMode)}
        className="h-7 rounded-md border border-input bg-background px-2 text-xs text-foreground">
        <option value="autonomous">Autonomous</option>
        <option value="collaborative">Collaborative</option>
      </select>
    </label>}
    {status && <span className="hidden shrink-0 text-xs capitalize text-muted-foreground sm:inline"
      aria-label="Latest run status">{status.replaceAll('-', ' ')}</span>}
    {showReview && <Button type="button" size="sm" variant="outline"
      className="h-7 shrink-0 text-xs" onClick={onReview}>Review changes</Button>}
  </header>
}
