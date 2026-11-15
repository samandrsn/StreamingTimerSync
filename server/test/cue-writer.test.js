import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CueWriter, cueName, formatCuePosition, isLive, namePattern, pickEvent, prefixFor, resolvePrefix } from '../src/cue-writer.js'

const H = 3600_000
const now = Date.parse('2026-11-15T15:00:00Z')
const ev = (id, name, startOffsetH, hours = 8) => ({
	uuid: id,
	name,
	eventProfileId: `p-${id}`,
	startTime: new Date(now + startOffsetH * H).toISOString(),
	stopAfter: new Date(now + (startOffsetH + hours) * H).toISOString(),
})
const events = [
	ev('last-week', '11/08/2026 // Sunday Live Stream', -7 * 24),
	ev('today', '11/15/2026 // Sunday Live Stream', -2),
	ev('backup', '11/15/2026 // Backup Live Stream', -2),
	ev('next-week', '11/22/2026 // Sunday Live Stream', 7 * 24),
]

test('cue positions use Resi’s HH:MM:SS.mmm', () => {
	assert.equal(formatCuePosition(0), '00:00:00.000')
	assert.equal(formatCuePosition(3723.5), '01:02:03.500')
	assert.equal(formatCuePosition(-5), '00:00:00.000')
})

test('an event is live between its start and planned stop', () => {
	assert.equal(isLive(events[1], now), true)
	assert.equal(isLive(events[0], now), false)
	assert.equal(isLive(events[3], now), false)
})

test('name patterns ignore dates, case and spacing', () => {
	for (const pattern of ['Sunday Live Stream', '{date} // sunday live stream', '*//  Sunday   Live Stream', '{MM}/{DD}/{YYYY} // Sunday Live Stream']) {
		const m = namePattern(pattern)
		assert.ok(m('11/15/2026 // Sunday Live Stream'), pattern)
		assert.ok(m('12-06-2026 // Sunday Live Stream'), `${pattern} with another date format`)
		assert.ok(!m('11/15/2026 // Backup Live Stream'), pattern)
	}
	assert.equal(namePattern('  '), null)
})

test('auto picks this week’s live event by name', () => {
	assert.equal(pickEvent(events, { mode: 'auto', pattern: 'Sunday Live Stream' }, now).event.uuid, 'today')
	assert.equal(pickEvent(events, { mode: 'auto', pattern: 'Backup' }, now).event.uuid, 'backup')
	// Before it goes live, the next one to start within a day.
	const early = now - 3 * H
	assert.equal(pickEvent(events, { mode: 'auto', pattern: 'Sunday Live Stream' }, early).event.uuid, 'today')
	// Mid-week, the most recent.
	assert.equal(pickEvent(events, { mode: 'auto', pattern: 'Sunday Live Stream' }, now + 2 * 24 * H).event.uuid, 'today')
	assert.match(pickEvent(events, { mode: 'auto', pattern: 'Nothing like it' }, now).reason, /No event/)
	assert.equal(pickEvent(events, { mode: 'event', eventId: 'backup' }, now).event.uuid, 'backup')
})

test('cue names carry the service prefix when there is one', () => {
	assert.equal(cueName('MESSAGE END', '9AM'), '9AM // MESSAGE END')
	assert.equal(cueName('MESSAGE END', ''), 'MESSAGE END')
})

function fakeWriter(list = events, settings = {}) {
	const calls = []
	const cues = []
	const client = {
		listEvents: async () => list,
		createCue: async (event, cue) => {
			calls.push(['create', event.uuid, cue])
			const made = { ...cue, uuid: `c${cues.length + 1}` }
			cues.push(made)
			return made
		},
		deleteCue: async (event, id) => calls.push(['delete', event.uuid, id]),
	}
	const store = { config: { cueWriter: { mode: 'auto', pattern: 'Sunday Live Stream', eventId: '', servicePrefix: '', offsetSec: 0, ...settings } } }
	return { writer: new CueWriter(store, client, () => {}), calls }
}

test('sets a cue at “now” in the live event, and undoes it', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now })
	const { writer, calls } = fakeWriter(events, { offsetSec: -2 })
	const r = await writer.setCue({ name: 'MESSAGE END', prefix: '9AM' })
	assert.equal(r.name, '9AM // MESSAGE END')
	assert.equal(r.position, '01:59:58.000', 'two hours in, minus the 2-second offset')
	assert.deepEqual(calls[0], ['create', 'today', { name: '9AM // MESSAGE END', position: '01:59:58.000' }])

	const u = await writer.undo()
	assert.equal(u.name, '9AM // MESSAGE END')
	assert.deepEqual(calls[1], ['delete', 'today', 'c1'])
	await assert.rejects(writer.undo(), /No cue to undo/)
})

test('a button can name its own event, and events that aren’t live are refused', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now })
	const { writer, calls } = fakeWriter()
	await writer.setCue({ name: 'STREAM END', eventId: 'backup' })
	assert.equal(calls[0][1], 'backup')
	await assert.rejects(writer.setCue({ name: 'STREAM END', eventId: 'next-week' }), /isn’t live/)
	await assert.rejects(writer.setCue({ name: '  ' }), /name/)
	assert.equal(calls.length, 1)
})

test('prefixes by time of day', () => {
	const settings = {
		servicePrefix: '',
		prefixRules: [
			{ from: '07:55', to: '09:15', prefix: '8AM' },
			{ from: '09:25', to: '11:00', prefix: '9:30AM' },
			{ from: '23:00', to: '01:00', prefix: 'LATE' },
		],
	}
	const at = (h, m) => new Date(2026, 10, 15, h, m)
	assert.equal(prefixFor(settings, at(7, 55)), '8AM', 'from is included')
	assert.equal(prefixFor(settings, at(8, 10)), '8AM')
	assert.equal(prefixFor(settings, at(9, 15)), '', 'to is not included')
	assert.equal(prefixFor(settings, at(9, 20)), '', 'between ranges')
	assert.equal(prefixFor(settings, at(9, 40)), '9:30AM')
	assert.equal(prefixFor({ ...settings, servicePrefix: '11AM' }, at(11, 30)), '11AM', 'outside every range: the default')
	assert.equal(prefixFor(settings, at(0, 30)), 'LATE', 'a range can run past midnight')
	// One given with the cue wins; "-" means none.
	assert.equal(resolvePrefix('5PM', settings, at(8, 10)), '5PM')
	assert.equal(resolvePrefix('-', settings, at(8, 10)), '')
	assert.equal(resolvePrefix('', settings, at(8, 10)), '8AM')
	assert.equal(cueName('MESSAGE END', '8AM', ': '), '8AM: MESSAGE END')
})

test('a cue set in a time range gets that range’s prefix', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now })
	const hhmm = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
	const start = new Date(now - 60_000)
	const end = new Date(now + 60_000)
	const { writer, calls } = fakeWriter(events, { prefixRules: [{ from: hhmm(start), to: hhmm(end), prefix: '8AM' }], separator: ': ' })
	const r = await writer.setCue({ name: 'MESSAGE END' })
	assert.equal(r.name, '8AM: MESSAGE END')
	await writer.setCue({ name: 'MESSAGE END', prefix: '-' })
	assert.equal(calls[1][2].name, 'MESSAGE END')
})
