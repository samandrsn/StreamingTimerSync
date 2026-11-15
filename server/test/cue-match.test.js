import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CueMatcher, findCueType, normalizeCueSettings, splitPrefix } from '../src/cue-match.js'

const cues = normalizeCueSettings({})
const m = new CueMatcher(cues)
const START = findCueType(cues, 'MESSAGE START')
const MESSAGE_END = findCueType(cues, 'MESSAGE END')
const RESPONSE = findCueType(cues, 'RESPONSE')
const STREAM_END = findCueType(cues, 'STREAM END')

test('splits service prefixes', () => {
	assert.deepEqual(splitPrefix('9AM // Message Start'), { prefix: '9AM', body: 'Message Start' })
	assert.deepEqual(splitPrefix('9AM: Sermon Beginning'), { prefix: '9AM', body: 'Sermon Beginning' })
	assert.deepEqual(splitPrefix('9:00 AM: Message Start'), { prefix: '9:00 AM', body: 'Message Start' })
	assert.deepEqual(splitPrefix('11:15 - msg start'), { prefix: '11:15', body: 'msg start' })
	assert.deepEqual(splitPrefix('SAT 5PM | STREAM END'), { prefix: 'SAT 5PM', body: 'STREAM END' })
	assert.deepEqual(splitPrefix('- 11AM / STREAM END - Outro'), { prefix: '11AM', body: 'STREAM END - Outro' })
	assert.deepEqual(splitPrefix('- 10:30AM / Response'), { prefix: '10:30AM', body: 'Response' })
	assert.deepEqual(splitPrefix('STREAM END - Outro'), { prefix: '', body: 'STREAM END - Outro' })
	assert.deepEqual(splitPrefix('WALK IN'), { prefix: '', body: 'WALK IN' })
})

for (const name of [
	'9AM // Message Start',
	'9AM: MESSAGE BEGINNING',
	'11AM // Msg Start',
	'11:15 - sermon start',
	'9AM // Start Message',
	'9AM // Mesage Strat', // typos
	'9AM: Message Begining',
	'9AM // MESSAGESTART',
	'- 10AM / Teaching Begins',
]) {
	test(`message start: "${name}"`, () => assert.ok(m.matches(name, START)))
}

for (const name of ['9AM // Message End', '9AM: Sermon Over', '11AM // msg ends', '5PM: MESSAGE FINISHED', '9AM//MESSAGEEND']) {
	test(`message end: "${name}"`, () => assert.ok(m.matches(name, MESSAGE_END)))
}

for (const name of ['9AM // Response', '9AM: Prayer', '11AM // Invitation', '5PM - Altar Response']) {
	test(`response: "${name}"`, () => assert.ok(m.matches(name, RESPONSE)))
}

for (const name of ['9AM // Stream End', '9AM: END OF STREAM', '11AM // Broadcast End', '5PM: stream stop', '9AM // Stream Ending', '- 11AM / STREAM END - Outro', '9AM // Sign Off']) {
	test(`stream end: "${name}"`, () => assert.ok(m.matches(name, STREAM_END)))
}

test('does not confuse cue types', () => {
	assert.ok(!m.matches('9AM // Message End', START))
	assert.ok(!m.matches('9AM // Message Start', MESSAGE_END))
	assert.ok(!m.matches('9AM // Message End', STREAM_END))
	assert.ok(!m.matches('9AM // Stream Start', STREAM_END))
	assert.ok(!m.matches('9AM // Pre-message video', START))
	assert.ok(!m.matches('9AM // Prayer End', RESPONSE))
	assert.ok(!m.matches('9AM // Prayer End', STREAM_END))
	assert.ok(!m.matches('9AM // Walk in', RESPONSE))
	assert.ok(!m.matches('9AM // Worship Start', START))
})

test('classify returns matching rule names', () => {
	assert.deepEqual(m.classify('9AM: Sermon Beginning', cues.types), ['MESSAGE START'])
	assert.deepEqual(m.classify('9AM // Service Start', cues.types), ['SERVICE START'])
	assert.deepEqual(m.classify('Rehearsal', cues.types), [])
})

test("a type's name always counts as one of its phrases", () => {
	const custom = normalizeCueSettings({ types: [...cues.types, { name: 'VIDEO START', aliases: ['FILM START'], exclude: ['END'] }] })
	const cm = new CueMatcher(custom)
	const video = findCueType(custom, 'VIDEO START')
	assert.ok(cm.matches('- 9:30AM / Video Start', video))
	assert.ok(cm.matches('9AM // Film Start', video))
	assert.ok(!cm.matches('9AM // Video End', video))
})

test('custom aliases and exact mode', () => {
	const custom = normalizeCueSettings({ types: [...cues.types, { name: 'WRAP', aliases: ['WRAP UP', 'LANDING'] }], targets: ['WRAP'] })
	const cm = new CueMatcher(custom)
	assert.deepEqual(custom.targets, ['WRAP'])
	assert.ok(cm.matches('9AM // Landing', findCueType(custom, 'wrap')))
	assert.ok(cm.matches('9AM // wrap-up', findCueType(custom, 'WRAP')))
	const exact = new CueMatcher({ ...cues, matchMode: 'exact' })
	assert.ok(exact.matches('9AM // Response', RESPONSE))
	assert.ok(!exact.matches('9AM // Response Begins', RESPONSE))
})

test('defaults and target validation', () => {
	assert.equal(cues.start, 'MESSAGE START')
	assert.deepEqual(cues.targets, ['MESSAGE END', 'STREAM END'])
	const odd = normalizeCueSettings({ types: cues.types, start: 'nope', targets: ['MESSAGE START', 'missing', 'stream end'] })
	assert.equal(odd.start, 'SERVICE START', 'falls back to the first type')
	assert.deepEqual(odd.targets, ['MESSAGE START', 'STREAM END'])
})
