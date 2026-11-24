---
schema: '0.1'
type: event
id: event.disclose-ledger
title: "disclose-ledger"
status: draft
decisions: []
participants: [character.ada, character.neri]
arcs: [arc.truth]
consequences: ["Neri discloses the ledger, changing Ada's belief and their relationship"]
after: []
prerequisites:
  any_of:
    - completed: []
      not_completed: []
      conditions:
        - kind: knowledge
          character: character.neri
          fact: fact.evidence-concealed
          value: knows
steps:
  - id: admit
    branches:
      - id: disclose
        conditions: []
        effects:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: protect
          - kind: relationship
            relationship: relationship.ada-neri
            value: trusting
          - kind: knowledge
            character: character.ada
            fact: fact.evidence-concealed
            value: knows
      - id: challenge
        conditions: []
        effects:
          - kind: outcome
            choice_point: choice-point.loyalty
            value: challenge
          - kind: relationship
            relationship: relationship.ada-neri
            value: wary
          - kind: knowledge
            character: character.ada
            fact: fact.evidence-concealed
            value: knows
          - kind: revealed
            revelation: revelation.ledger-secret
            value: true
---

Neri admits concealing the ledger and explains the reason. Ada learns that the concealment is real, while the confession begins repairing their trust. These are typed effects at the disclosure step.
