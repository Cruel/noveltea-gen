import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const compose = readFileSync(new URL('../../compose.yaml', import.meta.url), 'utf8')

function service(name: string): string {
  const marker = '\n  ' + name + ':\n'
  const start = compose.indexOf(marker)
  assert.notEqual(start, -1, 'missing Compose service ' + name)
  const remaining = compose.slice(start + marker.length)
  const end = remaining.search(/\n  [a-z][a-z-]*:\n/)
  return end < 0 ? remaining : remaining.slice(0, end)
}

function env(block: string, name: string): string | null {
  const line = block.split('\n').find(row => row.trimStart().startsWith(name + ':'))
  return line?.split(':').slice(1).join(':').trim() ?? null
}

test('Compose web and agent share the same durable skills snapshot cache and state volume', () => {
  const web = service('web')
  const agent = service('agent')
  const cache = '/var/lib/noveltea/state/skill-snapshots'
  assert.equal(env(web, 'NT_SKILL_CACHE_DIR'), cache)
  assert.equal(env(agent, 'NT_SKILL_CACHE_DIR'), cache)
  assert.equal(env(web, 'NT_STATE_DIR'), env(agent, 'NT_STATE_DIR'))
  assert.match(web, /noveltea-state:\/var\/lib\/noveltea\/state/)
  assert.match(agent, /noveltea-state:\/var\/lib\/noveltea\/state/)
  assert.match(service('web-dev'), /extends: web/,
    'dev server must inherit the same skill snapshot cache as production web')
})
