---
schema: '0.1'
type: puzzle
id: puzzle.ledger-proof
title: "ledger-proof"
status: draft
decisions: []
objective: "Verify that the ledger hides a concealed entry through documentary decoding or corroborated testimony"
clues: [authored-content.watermark-clue, authored-content.seal-clue]
solutions: [event.decode-ledger, event.request-testimony]
---

Players can notice a watermark or seal, infer either the cipher key or its custodian, and then choose a method. A mistaken guess yields a comparison prompt, with hints escalating from noticing the mark to matching its source and finally trying the cipher or testimony route.
