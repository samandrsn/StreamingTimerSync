import assert from 'node:assert/strict'
import { test } from 'node:test'
import { normalizeCueSettings } from '../src/cue-match.js'
import { Poller } from '../src/poller.js'

const cue = (name, positionSec) => ({ id: name, name, positionSec })

test('cue preview lists each cue name once, in service order, with what it matches', () => {
	const cues = normalizeCueSettings({})
	const poller = new Poller({ store: { config: { cues, campuses: [] } }, client: { cueRoutes: new Map() }, log: () => {} })
	poller.cues.set('ev', {
		cues: [
			cue('REHEARSAL', 10),
			cue('Walk In', 20),
			cue('8:00AM // Service Start', 100),
			cue('- 8AM / Message Begins', 200),
			cue('- 8AM / Message End', 300),
			cue('- 8AM / Response', 400),
			cue('- 8AM / STREAM END', 500),
			cue('9:30AM // Service Start', 1000),
			cue('- 9:30AM / Message Start', 1100),
			cue('- 9:30AM / Message End', 1200),
			cue('- 9:30AM / STREAM END', 1300),
		],
	})
	const p = poller.cuePreview()
	assert.equal(p.events.length, 1)
	const byName = Object.fromEntries(p.cues.map((c) => [c.name, c]))
	assert.equal(byName['Service Start'].count, 2)
	assert.deepEqual(byName['Message Begins'].matches, ['MESSAGE START'])
	assert.deepEqual(byName['REHEARSAL'].matches, [])
	assert.deepEqual(p.order.slice(0, 4), ['SERVICE START', 'MESSAGE START', 'MESSAGE END', 'RESPONSE'])
	assert.equal(p.order.at(-1), 'STREAM END')

	// Unsaved settings: a new phrase makes an unmatched cue match.
	assert.deepEqual(byName['Walk In'].matches, [])
	const edited = normalizeCueSettings({ ...cues, types: cues.types.map((t) => (t.name === 'SERVICE START' ? { ...t, aliases: [...t.aliases, 'WALK IN'] } : t)) })
	assert.deepEqual(poller.cuePreview(edited).cues.find((c) => c.name === 'Walk In').matches, ['SERVICE START'])
})
