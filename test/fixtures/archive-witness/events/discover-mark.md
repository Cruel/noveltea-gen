---
schema: '0.1'
type: event
id: event.discover-mark
title: "discover-mark"
status: draft
decisions: []
participants: [character.ada]
arcs: [arc.truth]
consequences:
  - "Ada notices a distinctive watermark in an earlier archive note"
after: []
prerequisites:
  any_of:
    - completed: [event.aftermath]
      not_completed: []
steps: []
---

Ada can inspect a faded margin without solving the cipher. A visible watermark provides a clue to the document's origin.
