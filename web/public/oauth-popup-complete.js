// Runs only on the code-free completion page, on Studio's configured origin.
// The original tab can refresh immediately rather than waiting for polling.
const channel = typeof BroadcastChannel === 'undefined'
  ? null : new BroadcastChannel('noveltea-pi-oauth')
channel?.postMessage('callback-received')
channel?.close()
// Script-opened popups can close themselves. Manually opened tabs keep the
// visible fallback link if their browser disallows programmatic closing.
window.close()
