---
schema: '0.1'
type: event
id: event.aftermath
title: "aftermath"
status: draft
decisions: []
participants: [character.ada, character.neri]
arcs: [arc.truth]
consequences: ["A choice changes how Ada and Neri collaborate afterward"]
after: []
prerequisites:
  any_of:
    - completed: [event.disclose-ledger]
      not_completed: []
steps:
  - id: consequence
    branches:
      - id: protect-response
        conditions:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: protect
        effects:
          - kind: relationship
            relationship: relationship.ada-neri
            value: trusting
      - id: challenge-response
        conditions:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: challenge
        effects:
          - kind: relationship
            relationship: relationship.ada-neri
            value: estranged
---

If Ada protects Neri, they continue investigating as trusted collaborators. If she challenges Neri, the confrontation leaves their alliance damaged.
