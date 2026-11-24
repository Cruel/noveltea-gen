---
schema: '0.1'
type: event
id: event.discover-seal
title: "discover-seal"
status: draft
decisions: []
participants: [character.ada]
arcs: [arc.truth]
consequences:
  - "Ada finds the custodian's seal impressed in a separate record"
after: []
prerequisites:
  any_of:
    - completed: [event.aftermath]
      not_completed: []
steps: []
---

A comparison record reveals a seal that could authenticate the ledger independently of the watermark.
