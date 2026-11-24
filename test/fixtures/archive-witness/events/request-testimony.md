---
schema: '0.1'
type: event
id: event.request-testimony
title: "request-testimony"
status: draft
decisions: []
participants: [character.ada]
arcs: [arc.truth]
consequences:
  - "Ada confronts the custodian with the seal and obtains witness testimony"
after: []
prerequisites:
  any_of:
    - completed: [event.discover-seal]
      not_completed: [event.decode-ledger]
steps:
  - id: verify
    branches:
      - id: testimony
        conditions: []
        effects:
          - kind: revealed
            revelation: revelation.puzzle-evidence
            value: true
          - kind: relationship
            relationship: relationship.ada-neri
            value: wary
---

The seal gives Ada leverage to question the custodian. The verbal confirmation exposes the concealment but leaves the relationship tense.
