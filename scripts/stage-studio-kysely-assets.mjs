/**
 * Keep immutable Studio migration inputs available to the bundled Nitro SSR
 * runtime. Vite relocates import.meta.url from src/db to .output/server/_ssr;
 * existing checksum-bearing migration sources must not be edited to compensate.
 * These are byte-for-byte build copies, never regenerated migration SQL.
 */
import { copyFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { resolve, join, dirname } from 'node:path'

const web = resolve(import.meta.dirname, '../web')
const output = join(web, '.output')
function stage(source, destinations) {
  const bytes = readFileSync(join(web, source))
  for (const target of destinations) {
    const destination = join(output, target)
    mkdirSync(dirname(destination), { recursive: true })
    copyFileSync(join(web, source), destination)
    if (!readFileSync(destination).equals(bytes))
      throw new Error('Staged migration source changed bytes: ' + source)
  }
}
stage('kysely-schema/0000_studio_baseline.sql', ['kysely-schema/0000_studio_baseline.sql'])
for (const filename of readdirSync(join(web, 'kysely-schema/migrations'))) {
  if (!/^\d{4}_[a-z0-9_]+\.ts$/.test(filename)) continue
  stage('kysely-schema/migrations/' + filename, ['kysely-schema/migrations/' + filename])
}
for (const filename of ['kysely-baseline.ts', 'trusted-catalog-definition.ts']) {
  stage('src/db/' + filename, ['src/db/' + filename, 'server/_ssr/' + filename])
}
console.log('PASS immutable Kysely migration assets staged for Nitro SSR without source edits')
