import assert from 'node:assert/strict'
import { test } from 'node:test'
import { PlayheadClock } from '../src/poller.js'

const report = (clock, status, now) => clock.report({ status, position: '01:00:00', eventId: 'E', lastUpdate: new Date(now).toISOString() }, now)

test('stop time: known after playing, Infinity if never seen playing', () => {
	const t0 = Date.now()
	const c = new PlayheadClock()
	report(c, 'playing', t0)
	assert.equal(c.stoppedForSec(t0 + 5000), 0)
	report(c, 'paused', t0 + 10_000)
	report(c, 'paused', t0 + 20_000)
	assert.equal(c.stoppedForSec(t0 + 70_000), 60)
	report(c, 'playing', t0 + 80_000)
	assert.equal(c.stoppedForSec(t0 + 90_000), 0)

	const cold = new PlayheadClock()
	report(cold, 'paused', t0)
	assert.equal(cold.stoppedForSec(t0 + 1000), Infinity)
})
