import { readFileSync } from 'node:fs'
import { request } from 'node:http'

// Health probe lives only in the trusted controller image. It never prints a
// credential and does not accept user-provided socket or bearer values.
const token = readFileSync('/run/noveltea-controller/token', 'utf8').trim()
const req = request({
  socketPath: '/run/noveltea-controller/controller.sock',
  path: '/health',
  headers: { authorization: 'Bearer ' + token },
  timeout: 3000,
}, res => {
  res.resume()
  res.on('end', () => {
    if (res.statusCode !== 200) console.error('Controller readiness returned HTTP', res.statusCode)
    process.exit(res.statusCode === 200 ? 0 : 1)
  })
})
req.on('timeout', () => req.destroy(Error('Controller readiness timed out')))
req.on('error', error => { console.error('Controller readiness socket error', error.message); process.exit(2) })
req.end()
