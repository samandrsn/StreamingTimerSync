import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONFIG } from '../src/config-store.js'
import { normalizeCueSettings } from '../src/cue-match.js'
import { computeTimer, pickDecoder } from '../src/engine.js'
import { formatClock, positionToSeconds } from '../src/time.js'

const settings = structuredClone(DEFAULT_CONFIG)
const campus = { id: 'c', name: 'North', slug: 'north', decoders: ['D1'], endCues: [], sermonMinutes: null }
const cue = (name, position) => ({ id: name + position, name, positionSec: positionToSeconds(position) })
const decoder = (playheadSec, extra = {}) => ({ serialNumber: 'D1', status: 'playing', eventId: 'E', playheadSec, ...extra })

const sunday = [
	cue('MESSAGE START', '00:40:00.000'),
	cue('Message End', '01:22:30.000'),
	cue('STREAM END', '01:30:00.000'),
	cue('MESSAGE START', '02:10:00.000'),
]

test('parses Resi positions', () => {
	assert.equal(positionToSeconds('01:02:03.500'), 3723.5)
	assert.equal(positionToSeconds('02:57:47'), 10667)
	assert.equal(positionToSeconds(1500), 1.5)
	assert.ok(Number.isNaN(positionToSeconds('')))
})

test('formats clock', () => {
	assert.equal(formatClock(2063), '34:23')
	assert.equal(formatClock(3725), '1:02:05')
	assert.equal(formatClock(-65), '-1:05')
})

test('waiting before message start', () => {
	const t = computeTimer({ campus, settings, decoder: decoder(30 * 60), cues: sunday })
	assert.equal(t.state, 'waiting')
	assert.equal(t.display, '')
})

test('counts to message end cue (case-insensitive)', () => {
	const t = computeTimer({ campus, settings, decoder: decoder(3600 + 15 * 60), cues: sunday })
	assert.equal(t.state, 'counting')
	assert.equal(t.targetSource, 'cue')
	assert.equal(t.targetCueName, 'Message End')
	assert.equal(t.remainingSeconds, 7 * 60 + 30)
	assert.equal(t.display, '7:30')
	assert.equal(t.elapsedDisplay, '35:00')
})

test('campus can count to STREAM END instead', () => {
	const t = computeTimer({ campus: { ...campus, endCues: ['STREAM END'] }, settings, decoder: decoder(3600 + 15 * 60), cues: sunday })
	assert.equal(t.targetCueName, 'STREAM END')
	assert.equal(t.remainingSeconds, 15 * 60)
})

test('falls back to default sermon length when no end cue yet (live service)', () => {
	const t = computeTimer({ campus, settings, decoder: decoder(2 * 3600 + 15 * 60), cues: sunday })
	assert.equal(t.targetSource, 'default')
	assert.equal(t.remainingSeconds, 40 * 60) // 45 min from 2:10:00, playhead 2:15:00
})

test('campus sermon override', () => {
	const t = computeTimer({ campus: { ...campus, sermonMinutes: 35 }, settings, decoder: decoder(2 * 3600 + 15 * 60), cues: sunday })
	assert.equal(t.remainingSeconds, 30 * 60)
})

test('end cue arriving later re-targets the clock', () => {
	const withEnd = [...sunday, cue('MESSAGE END', '02:52:00.000')]
	const t = computeTimer({ campus, settings, decoder: decoder(2 * 3600 + 15 * 60), cues: withEnd })
	assert.equal(t.targetSource, 'cue')
	assert.equal(t.remainingSeconds, 37 * 60)
})

test('overtime past default target shows negative', () => {
	const t = computeTimer({ campus, settings, decoder: decoder(2 * 3600 + 56 * 60 + 5), cues: sunday })
	assert.equal(t.state, 'overtime')
	assert.equal(t.display, '-1:05')
})

test('rolls to the next target, ended after the last, then idle after hold', () => {
	let t = computeTimer({ campus, settings, decoder: decoder(3600 + 23 * 60), cues: sunday })
	assert.equal(t.state, 'counting')
	assert.equal(t.targetCueName, 'STREAM END')
	assert.equal(t.display, '7:00')
	t = computeTimer({ campus, settings, decoder: decoder(3600 + 31 * 60), cues: sunday })
	assert.equal(t.state, 'ended')
	assert.equal(t.display, '0:00')
	t = computeTimer({ campus, settings, decoder: decoder(3600 + 40 * 60), cues: sunday })
	assert.equal(t.state, 'waiting')
})

test('three targets: message end, then response, then stream end on the main clock', () => {
	const feed = [
		cue('- 8AM / Message Start', '01:49:05.481'),
		cue('- 8AM / Message End', '02:27:02.437'),
		cue('- 8AM / Response', '02:30:27.434'),
		cue('- 8AM / STREAM END - Outro', '02:31:54.433'),
	]
	const three = { ...campus, endCues: ['MESSAGE END', 'RESPONSE', 'STREAM END'] }
	const at = (pos) => computeTimer({ campus: three, settings, decoder: decoder(positionToSeconds(pos)), cues: feed })
	let t = at('02:20:00')
	assert.equal(t.targetType, 'MESSAGE END')
	assert.deepEqual(t.thenTargets, ['RESPONSE', 'STREAM END'])
	assert.equal(t.display, '7:03')
	t = at('02:28:00')
	assert.equal(t.targetType, 'RESPONSE')
	assert.equal(t.display, '2:28')
	assert.deepEqual(t.thenTargets, ['STREAM END'])
	t = at('02:31:00')
	assert.equal(t.targetType, 'STREAM END')
	assert.equal(t.display, '0:55')
	t = at('02:33:00')
	assert.equal(t.state, 'ended')
	assert.equal(t.targetType, 'STREAM END')
	// Each type still has its own countdown.
	assert.deepEqual(at('02:28:00').targets.map((x) => x.state), ['ended', 'counting', 'counting'])
})

test('after a cue passes, the next one is estimated from it', () => {
	const feed = [cue('9AM // Message Start', '00:40:00'), cue('9AM // Message End', '01:10:00')]
	const t = computeTimer({ campus, settings, decoder: decoder(positionToSeconds('01:11:00')), cues: feed })
	assert.equal(t.targetType, 'STREAM END')
	assert.equal(t.estimated, true)
	assert.equal(t.display, '44:00', 'MESSAGE END ran 1:10:00, plus the default 45 min')
})

test('end cue of a later service is not used for an earlier one', () => {
	const cues = [cue('MESSAGE START', '00:40:00'), cue('MESSAGE START', '02:10:00'), cue('MESSAGE END', '02:50:00')]
	const t = computeTimer({ campus, settings, decoder: decoder(3600), cues })
	assert.equal(t.targetSource, 'default')
	assert.equal(t.remainingSeconds, 25 * 60)
})

test('states without data', () => {
	assert.equal(computeTimer({ campus, settings, decoder: undefined }).state, 'offline')
	assert.equal(computeTimer({ campus, settings, decoder: decoder(0, { status: 'offline' }) }).state, 'offline')
	assert.equal(computeTimer({ campus, settings, decoder: decoder(0, { eventId: null }) }).state, 'no_event')
	assert.equal(computeTimer({ campus, settings, decoder: decoder(0), cues: undefined }).state, 'no_cues')
})

test('pickDecoder prefers playing, then paused with event', () => {
	const d = pickDecoder([
		{ serialNumber: 'A', status: 'offline', lastUpdate: '2026-01-02' },
		{ serialNumber: 'B', status: 'paused', eventId: 'E', lastUpdate: '2026-01-01' },
		{ serialNumber: 'C', status: 'playing', eventId: 'E', lastUpdate: '2025-01-01' },
	])
	assert.equal(d.serialNumber, 'C')
	assert.equal(pickDecoder([{ serialNumber: 'A', status: 'offline' }, { serialNumber: 'B', status: 'paused', eventId: 'E' }]).serialNumber, 'B')
})

test('handles hand-typed prefixed cues and pairs by service prefix', () => {
	const cues = [
		cue('9AM // Message Start', '00:40:00'),
		cue('11AM: message over', '01:21:00'), // mis-entered later, wrong service
		cue('9AM: Message Over', '01:22:30'),
	]
	const t = computeTimer({ campus, settings, decoder: decoder(3600 + 15 * 60), cues })
	assert.equal(t.service, '9AM')
	assert.equal(t.targetCueName, '9AM: Message Over')
	assert.equal(t.remainingSeconds, 7 * 60 + 30)
})

test('several services in one event: the 9:30 service counts to its own message end', () => {
	const feed = [
		cue('8:00AM // Service Start', '01:29:37.036'),
		cue('- 8AM / Message Start', '01:49:05.481'),
		cue('- 8AM / Message End', '02:27:02.437'),
		cue('- 8AM / STREAM END - Outro', '02:31:54.433'),
		cue('9:30AM // Service Start', '02:59:37.210'),
		cue('- 9:30AM / Message Start', '03:19:04.481'),
		cue('- 9:30AM / Message End', '03:57:44.259'),
		cue('- 9:30AM / STREAM END - Outro', '04:02:28.981'),
	]
	const t = computeTimer({ campus, settings, decoder: decoder(positionToSeconds('03:30:00')), cues: feed })
	assert.equal(t.state, 'counting')
	assert.equal(t.service, '9:30AM')
	assert.equal(t.targetSource, 'cue')
	assert.equal(t.targetCueName, '- 9:30AM / Message End')
	assert.equal(t.display, '27:45')
	const before = computeTimer({ campus, settings, decoder: decoder(positionToSeconds('03:10:00')), cues: feed })
	assert.equal(before.state, 'waiting')
})

test('paused just after the end cue: 0:00, then blank after the hold time', () => {
	const paused = (stoppedForSec) => decoder(positionToSeconds('01:30:04'), { status: 'paused', stoppedForSec })
	assert.equal(computeTimer({ campus, settings, decoder: paused(60), cues: sunday }).state, 'ended')
	const later = computeTimer({ campus, settings, decoder: paused(6 * 60), cues: sunday })
	assert.equal(later.state, 'waiting')
	assert.equal(later.display, '')
	assert.equal(computeTimer({ campus, settings, decoder: paused(Infinity), cues: sunday }).state, 'waiting')
})

test('generic countdown: service start to message start', () => {
	const feed = [cue('9AM // Service Start', '00:20:00'), cue('9AM // Message Start', '00:40:00'), cue('9AM // Message End', '01:20:00')]
	const custom = { ...campus, startCue: 'SERVICE START', endCues: ['MESSAGE START'] }
	const t = computeTimer({ campus: custom, settings, decoder: decoder(positionToSeconds('00:30:00')), cues: feed })
	assert.equal(t.state, 'counting')
	assert.equal(t.startCue, 'SERVICE START')
	assert.equal(t.targetCueName, '9AM // Message Start')
	assert.equal(t.display, '10:00')
})

test('one countdown per target type', () => {
	const feed = [cue('9AM // Message Start', '00:40:00'), cue('9AM // Message End', '01:20:00')]
	const t = computeTimer({ campus, settings, decoder: decoder(positionToSeconds('01:00:00')), cues: feed })
	assert.deepEqual(t.targets.map((x) => x.key), ['message_end', 'stream_end'])
	const [messageEnd, streamEnd] = t.targets
	assert.equal(t.display, '20:00')
	assert.equal(messageEnd.display, '20:00')
	assert.equal(messageEnd.targetSource, 'cue')
	// No STREAM END cue yet, so it's expected the default 45 min after the Message End cue.
	assert.equal(streamEnd.targetSource, 'default')
	assert.equal(streamEnd.display, '1:05:00')
	assert.equal(messageEnd.estimated, false)
	assert.equal(streamEnd.estimated, true)
	assert.equal(t.estimated, false)

	const after = computeTimer({ campus, settings, decoder: decoder(positionToSeconds('01:21:00')), cues: feed })
	assert.equal(after.targets[0].state, 'ended')
	assert.equal(after.targets[1].state, 'counting')

	const waiting = computeTimer({ campus, settings, decoder: decoder(60), cues: feed })
	assert.deepEqual(waiting.targets.map((x) => x.state), ['waiting', 'waiting'])
	assert.equal(waiting.estimated, false)
})

test('clock offset: campus value wins, blank uses the global one', () => {
	const at = (c, g = 0) => computeTimer({ campus: c, settings: { ...settings, positionOffsetSec: g }, decoder: decoder(3600 + 15 * 60), cues: sunday })
	assert.equal(at(campus).display, '7:30')
	assert.equal(at({ ...campus, positionOffsetSec: 2 }).display, '7:28')
	assert.equal(at({ ...campus, positionOffsetSec: -2 }).display, '7:32')
	assert.equal(at({ ...campus, positionOffsetSec: null }, 3).display, '7:27')
	assert.equal(at({ ...campus, positionOffsetSec: 0 }, 3).display, '7:30', 'explicit 0 overrides the global offset')
	assert.equal(at({ ...campus, positionOffsetSec: 2 }).offsetSec, 2)
})

test('run of show: lengths chain from the start cue, and the clock rolls through them', () => {
	const ros = { ...settings, cues: normalizeCueSettings({ ...settings.cues, estimates: { 'MESSAGE START': 30, 'MESSAGE END': 10 } }) }
	const feed = [cue('9AM // Message Start', '00:40:00')]
	const at = (pos, cues = feed) => computeTimer({ campus, settings: ros, decoder: decoder(positionToSeconds(pos)), cues })

	let t = at('00:50:00')
	assert.equal(t.targetType, 'MESSAGE END')
	assert.equal(t.display, '20:00')
	assert.equal(t.estimated, true)
	assert.deepEqual(t.thenTargets, ['STREAM END'])
	assert.deepEqual(t.targets.map((x) => [x.key, x.display, x.estimateMinutes]), [['message_end', '20:00', 30], ['stream_end', '30:00', 10]])

	// A real cue replaces its estimate, and moves the next one along.
	t = at('00:50:00', [...feed, cue('9AM // Message End', '01:05:00')])
	assert.equal(t.targetSource, 'cue')
	assert.equal(t.display, '15:00')
	assert.equal(t.targets[1].display, '25:00')
})

test('cues without their own length use the default (or the venue\'s)', () => {
	const ros = { ...settings, cues: normalizeCueSettings({ ...settings.cues, estimates: { 'MESSAGE END': 5, NOPE: 5, 'STREAM END': 0 } }) }
	assert.deepEqual(ros.cues.estimates, { 'MESSAGE END': 5 })
	const t = computeTimer({ campus: { ...campus, sermonMinutes: 35 }, settings: ros, decoder: decoder(positionToSeconds('00:50:00')), cues: [cue('9AM // Message Start', '00:40:00')] })
	assert.deepEqual(t.targets.map((x) => x.display), ['25:00', '30:00'], 'start 35 min (venue default), then MESSAGE END 5 min')
})

test('lengths can include seconds', () => {
	const ros = { ...settings, cues: normalizeCueSettings({ ...settings.cues, estimates: { 'MESSAGE START': 30.5 } }) }
	const t = computeTimer({ campus, settings: ros, decoder: decoder(positionToSeconds('00:50:00')), cues: [cue('9AM // Message Start', '00:40:00')] })
	assert.equal(t.display, '20:30')
	assert.equal(t.estimateMinutes, 30.5)
})

test('times saved as "minutes after the start cue" become lengths', () => {
	const old = normalizeCueSettings({ ...settings.cues, estimateFrom: 'start', estimates: { 'STREAM END': 40, 'MESSAGE END': 30 } })
	assert.equal(old.estimateFrom, 'lengths')
	assert.deepEqual(old.estimates, { 'MESSAGE START': 30, 'MESSAGE END': 10 })
	assert.deepEqual(old.targets, ['MESSAGE END', 'STREAM END'])
	assert.deepEqual(normalizeCueSettings(old).estimates, old.estimates, 'only converted once')
})

test('run of show: each time is how long that element runs', () => {
	// Message Start runs 30 min, then Message End 5:30, then Stream End.
	const ros = { ...settings, cues: normalizeCueSettings({ ...settings.cues, estimateFrom: 'lengths', estimates: { 'MESSAGE START': 30, 'MESSAGE END': 5.5 } }) }
	assert.equal(ros.cues.estimateFrom, 'lengths')
	const feed = [cue('9AM // Message Start', '00:40:00')]
	const at = (pos, cues = feed) => computeTimer({ campus, settings: ros, decoder: decoder(positionToSeconds(pos)), cues })

	let t = at('00:50:00')
	assert.equal(t.targetType, 'MESSAGE END')
	assert.equal(t.display, '20:00')
	assert.deepEqual(t.targets.map((x) => [x.display, x.estimateFrom]), [['20:00', 'MESSAGE START'], ['25:30', 'MESSAGE END']])

	t = at('01:12:00') // past Message End's estimate (1:10:00) with no cue: it runs over, and Stream End waits
	assert.equal(t.targetType, 'MESSAGE END')
	assert.equal(t.display, '-2:00')
	assert.equal(t.targets[1].display, '5:30', 'Stream End stays 5:30 after an overrunning Message End')

	t = at('01:15:00', [...feed, cue('9AM // Message End', '01:13:00')]) // its cue came 3 min late
	assert.equal(t.targetType, 'STREAM END')
	assert.equal(t.display, '3:30')
})

test('1.1.2 run-of-show times (gap before each target) become element lengths', () => {
	const old = normalizeCueSettings({ ...settings.cues, estimateFrom: 'previous', estimates: { 'MESSAGE END': 30, 'STREAM END': 5.5 } })
	assert.equal(old.estimateFrom, 'lengths')
	assert.deepEqual(old.estimates, { 'MESSAGE START': 30, 'MESSAGE END': 5.5 })
	assert.deepEqual(normalizeCueSettings(old).estimates, old.estimates, 'only moved once')
})
