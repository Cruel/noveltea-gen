import { useState } from 'react'
import { ChevronDown, ChevronRight, FolderPlus, MoreHorizontal, Pencil, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ThreadList } from './thread-list'
import type { StoryThread } from '@/lib/threads.server'
import type { StoryCollection } from '@/persistence/collection-contracts'

type Props = {
  threads: StoryThread[]
  collections: StoryCollection[]
  view: 'tree' | 'flat'
  expandedIds: string[]
  collapsedCollectionIds: string[]
  selectedThreadId?: string
  archivedView: boolean
  busyThreadId?: string | null
  showAll: boolean
  onShowAll: (next: boolean) => void
  onToggleCollection: (id: string) => void
  onCreateCollection: (name: string) => Promise<void>
  onRenameCollection: (collection: StoryCollection, name: string) => Promise<void>
  onRemoveCollection: (collection: StoryCollection) => void
  onMoveThread: (thread: StoryThread, collectionId: string | null) => void
  onExpand: (id: string) => void
  onRenameThread: (thread: StoryThread) => void
  onArchiveChange: (thread: StoryThread, archive: boolean) => void
  onDelete: (thread: StoryThread) => void
  onOpen: (thread: StoryThread) => void
}

/** Grouping is only a view over optional membership. A true fork tree is
 * always available as "All Threads"; grouped roots from other Collections
 * retain their external fork-parent labels instead of being reparented. */
export function StoryCollectionsPanel(props: Props) {
  const [creating, setCreating] = useState(false)
  const [editing, setEditing] = useState<string | null>(null)
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const list = (items: StoryThread[]) => (
    <ThreadList
      threads={items}
      allThreads={props.threads}
      collections={props.collections}
      view={props.view}
      expandedIds={props.expandedIds}
      selectedThreadId={props.selectedThreadId}
      archivedView={props.archivedView}
      busyThreadId={props.busyThreadId}
      onMoveCollection={props.collections.length ? props.onMoveThread : undefined}
      onExpand={props.onExpand}
      onRename={props.onRenameThread}
      onArchiveChange={props.onArchiveChange}
      onDelete={props.onDelete}
      onOpen={props.onOpen}
    />
  )
  const save = async () => {
    if (!name.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      if (editing) {
        const collection = props.collections.find((item) => item.id === editing)
        if (collection) await props.onRenameCollection(collection, name)
      } else await props.onCreateCollection(name)
      setCreating(false)
      setEditing(null)
      setName('')
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Collection could not be saved.')
    } finally {
      setBusy(false)
    }
  }
  const groups: Array<{ id: string; name: string; collection?: StoryCollection; items: StoryThread[] }> = [
    ...props.collections.map((collection) => ({
      id: collection.id,
      name: collection.name,
      collection,
      items: props.threads.filter((thread) => thread.collectionId === collection.id),
    })),
    { id: 'ungrouped', name: 'Ungrouped', items: props.threads.filter((thread) => !thread.collectionId) },
  ]
  if (!props.collections.length)
    return (
      <div className="min-h-0 min-w-0">
        <div className="mb-1 flex items-center justify-between px-1">
          <span className="text-xs text-muted-foreground">Collections</span>
          <Button
            size="icon-xs"
            variant="ghost"
            title="Create Collection"
            aria-label="Create Collection"
            onClick={() => {
              setCreating(true)
              setEditing(null)
              setName('')
            }}
          >
            <FolderPlus className="size-3.5" />
          </Button>
        </div>
        {creating && (
          <form
            className="mb-2 flex items-center gap-1"
            onSubmit={(event) => {
              event.preventDefault()
              void save()
            }}
          >
            <Input
              autoFocus
              aria-label="New Collection name"
              maxLength={80}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
            <Button type="submit" size="sm" disabled={busy || !name.trim()}>
              Add
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setCreating(false)}>
              Cancel
            </Button>
          </form>
        )}
        {error && (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}
        {props.threads.length ? (
          list(props.threads)
        ) : (
          <p className="px-2 text-xs text-muted-foreground">
            {props.archivedView ? 'No archived Threads.' : 'No Threads yet.'}
          </p>
        )}
      </div>
    )

  return (
    <section aria-label="Story Collections" className="grid min-w-0 gap-1">
      <div className="flex items-center justify-between px-1">
        <span className="text-xs font-medium text-muted-foreground">Collections</span>
        <Button
          size="icon-xs"
          variant="ghost"
          title="Create Collection"
          aria-label="Create Collection"
          onClick={() => {
            setCreating(true)
            setEditing(null)
            setName('')
          }}
        >
          <FolderPlus className="size-3.5" />
        </Button>
      </div>
      {(creating || editing) && (
        <form
          className="mb-1 flex items-center gap-1"
          onSubmit={(event) => {
            event.preventDefault()
            void save()
          }}
        >
          <Input
            autoFocus
            aria-label={editing ? 'Rename Collection' : 'New Collection name'}
            maxLength={80}
            value={name}
            disabled={busy}
            onChange={(event) => setName(event.target.value)}
          />
          <Button type="submit" size="sm" disabled={busy || !name.trim()}>
            Save
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            disabled={busy}
            onClick={() => {
              setCreating(false)
              setEditing(null)
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <Button
        type="button"
        size="sm"
        variant={props.showAll ? 'secondary' : 'ghost'}
        aria-pressed={props.showAll}
        className="justify-start"
        onClick={() => props.onShowAll(!props.showAll)}
      >
        All Threads · {props.threads.length}
      </Button>
      {props.showAll
        ? list(props.threads)
        : groups.map((group) => {
            const selectedHere = group.items.some((thread) => thread.id === props.selectedThreadId)
            const collapsed = props.collapsedCollectionIds.includes(group.id) && !selectedHere
            return (
              <section key={group.id} aria-label={group.name + ' Collection'} className="min-w-0">
                <div className="flex items-center gap-1 rounded-md hover:bg-muted/50">
                  <button
                    type="button"
                    className="flex min-w-0 flex-1 items-center gap-1 px-1 py-1 text-left text-xs"
                    aria-expanded={!collapsed}
                    aria-label={(collapsed ? 'Expand ' : 'Collapse ') + group.name + ' Collection'}
                    onClick={() => props.onToggleCollection(group.id)}
                  >
                    {collapsed ? (
                      <ChevronRight aria-hidden="true" className="size-3.5 shrink-0" />
                    ) : (
                      <ChevronDown aria-hidden="true" className="size-3.5 shrink-0" />
                    )}
                    <span className="truncate font-medium">{group.name}</span>
                    <span className="text-muted-foreground">({group.items.length})</span>
                  </button>
                  {group.collection && (
                    <DropdownMenu>
                      <DropdownMenuTrigger
                        className="rounded p-1 text-muted-foreground focus-visible:outline-2"
                        aria-label={'Collection actions for ' + group.name}
                      >
                        <MoreHorizontal aria-hidden="true" className="size-3.5" />
                      </DropdownMenuTrigger>
                      <DropdownMenuContent align="end">
                        <DropdownMenuItem
                          onClick={() => {
                            setName(group.name)
                            setEditing(group.id)
                            setCreating(false)
                          }}
                        >
                          <Pencil className="size-3.5" />
                          Rename
                        </DropdownMenuItem>
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => props.onRemoveCollection(group.collection!)}
                        >
                          <Trash2 className="size-3.5" />
                          Remove Collection
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  )}
                </div>
                {!collapsed &&
                  (group.items.length ? (
                    list(group.items)
                  ) : (
                    <p className="m-0 px-5 py-1 text-xs text-muted-foreground">No Threads.</p>
                  ))}
              </section>
            )
          })}
    </section>
  )
}
