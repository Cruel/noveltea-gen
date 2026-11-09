import Database from 'better-sqlite3'

// The lock must be held by another process: better-sqlite3 blocks this process's
// event loop while waiting, so a local timer cannot release a competing lock.
const path = process.argv[2]!
const holdMs = Number(process.argv[3])
const sqlite = new Database(path)
sqlite.exec('BEGIN IMMEDIATE')
process.send?.('locked')
setTimeout(() => {
  try {
    sqlite.exec('COMMIT')
  } finally {
    sqlite.close()
    process.disconnect?.()
  }
}, holdMs)
