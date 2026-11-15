import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, test } from 'node:test'
import { ConfigStore } from '../src/config-store.js'

let dir
let store
beforeEach(async () => {
	dir = await mkdtemp(path.join(tmpdir(), 'timer-sync-'))
	store = new ConfigStore(dir)
	await store.load()
	store.config.resi.password = 'secret'
	await store.upsertCampus({ name: 'North', decoders: ['A1'] })
})
afterEach(() => rm(dir, { recursive: true, force: true }))

test('export leaves out the Resi login and blackout', () => {
	const out = store.exportConfig()
	assert.equal(out.format, 'streaming-timer-sync-config')
	assert.equal(JSON.stringify(out).includes('secret'), false)
	assert.equal('resi' in out.settings, false)
	assert.equal('blackout' in out.settings, false)
	assert.deepEqual(out.campuses.map((c) => c.name), ['North'])
})

test('import replaces cue names and campuses, keeps the login, and can be undone', async () => {
	const normal = store.exportConfig()
	const special = structuredClone(normal)
	special.settings.cues.types.push({ name: 'BAPTISM', aliases: ['BAPTISM'], exclude: [] })
	special.settings.cues.targets = ['BAPTISM']
	special.settings.defaultSermonMinutes = 30
	special.campuses.push({ name: 'South', decoders: ['B2'] })

	await store.importConfig(special)
	assert.deepEqual(store.config.cues.targets, ['BAPTISM'])
	assert.equal(store.config.defaultSermonMinutes, 30)
	assert.deepEqual(store.config.campuses.map((c) => c.name), ['North', 'South'])
	assert.equal(store.config.resi.password, 'secret')

	await store.undoImport()
	assert.deepEqual(store.config.cues.targets, normal.settings.cues.targets)
	assert.equal(store.config.defaultSermonMinutes, 45)
	assert.deepEqual(store.config.campuses.map((c) => c.name), ['North'])
	await assert.rejects(store.undoImport(), /Nothing to undo/)
})

test('import can take only the settings, and rejects other files untouched', async () => {
	const file = store.exportConfig()
	file.settings.defaultSermonMinutes = 20
	file.campuses = []
	await store.importConfig(file, ['settings'])
	assert.equal(store.config.defaultSermonMinutes, 20)
	assert.equal(store.config.campuses.length, 1)

	await assert.rejects(store.importConfig({ hello: 1 }), /not a Streaming Timer Sync export/)
	assert.equal(store.config.defaultSermonMinutes, 20)
})

test('blackout: all, per campus, and survives settings saves', async () => {
	const id = store.config.campuses[0].id
	assert.equal(store.isBlackedOut(id), false)
	await store.setBlackout({ campusId: id, on: true })
	assert.equal(store.isBlackedOut(id), true)
	await store.updateSettings({ defaultSermonMinutes: 40, blackout: { all: false, campuses: [] } })
	assert.equal(store.isBlackedOut(id), true)
	await store.setBlackout({ campusId: id, on: false })
	await store.setBlackout({ all: true })
	assert.equal(store.isBlackedOut(id), true)
	await store.importConfig(store.exportConfig())
	assert.equal(store.config.blackout.all, true)
	await store.deleteCampus(id)
	assert.deepEqual(store.config.blackout.campuses, [])
})

test('reorder campuses; unknown ids ignored, unlisted ones kept at the end', async () => {
	await store.upsertCampus({ name: 'South' })
	await store.upsertCampus({ name: 'East' })
	const [f, c, d] = store.config.campuses.map((x) => x.id)
	await store.reorderCampuses([d, 'nope', f])
	assert.deepEqual(store.config.campuses.map((x) => x.id), [d, f, c])
})
