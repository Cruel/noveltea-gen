---
schema: '0.1'
type: event
id: event.decode-ledger
title: "decode-ledger"
status: draft
decisions: []
participants: [character.ada]
arcs: [arc.truth]
consequences:
  - "Ada uses the watermark key to decode the concealed ledger entry"
after: []
prerequisites:
  any_of:
    - completed: [event.discover-mark]
      not_completed: [event.request-testimony]
steps:
  - id: decipher
    branches:
      - id: decode
        conditions: []
        effects:
          - kind: revealed
            revelation: revelation.puzzle-evidence
            value: true
          - kind: relationship
            relationship: relationship.ada-neri
            value: trusting
---

The watermark identifies a cipher key. Ada decodes the record and gains documentary proof, drawing Neri back toward cooperation.
