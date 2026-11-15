import { randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { normalizeCueSettings } from './cue-match.js'

export const DEFAULT_CONFIG = {
	resi: {
		email: '',
		password: '',
		customerId: '',
		centralBase: 'https://central.resi.io',
		studioOrigin: 'https://studio.resi.io',
		// Optional manual override, e.g.
		// https://central.resi.io/api_v2.svc/streamprofiles/<profileId>/events/{eventId}/cues
		cueUrlTemplate: '',
		// Manual X-Bearer token (testing only — expires ~1h). Email/password is preferred.
		manualToken: '',
	},
	polling: {
		decoderIntervalMs: 2000,
		cueIntervalMs: 5000,
		fullDecoderRefreshMs: 5 * 60 * 1000,
	},
	defaultSermonMinutes: 45,
	positionOffsetSec: 0,
	// see cue-match.js: { matchMode, types: [{name, aliases, exclude}], start, targets, synonyms }
	cues: normalizeCueSettings({}),
	display: {
		idleText: '',
		endedText: '0:00',
		endedHoldMinutes: 5,
		showOvertime: true,
	},
	// Setting cues in Resi live (see cue-writer.js). Which event: 'auto' finds it by name each
	// week (pattern), 'event' uses one chosen event. offsetSec nudges where "now" lands.
	// prefixRules: [{ from: '07:55', to: '09:15', prefix: '8AM' }] picks the prefix by the time of day
	// (the server's time zone); servicePrefix is used outside every range. separator joins prefix and name.
	cueWriter: { mode: 'auto', pattern: '', eventId: '', servicePrefix: '', prefixRules: [], separator: ' // ', offsetSec: 0 },
	// Stage displays forced black: every campus, or by campus id. Not part of an export.
	blackout: { all: false, campuses: [] },
	campuses: [],
}

export const EXPORT_FORMAT = 'streaming-timer-sync-config'
// What an export carries. The Resi login, polling and blackout stay with the server.
const EXPORT_SETTINGS = ['defaultSermonMinutes', 'positionOffsetSec', 'cues', 'display']
export const IMPORT_PARTS = ['settings', 'campuses']

export function slugify(name) {
	return (
		String(name ?? '')
			.toLowerCase()
			.replace(/[^a-z0-9]+/g, '_')
			.replace(/^_+|_+$/g, '') || 'campus'
	)
}

function deepMerge(base, override) {
	if (Array.isArray(base) || typeof base !== 'object' || base === null) {
		return override === undefined ? base : override
	}
	const out = { ...base }
	for (const [k, v] of Object.entries(override ?? {})) {
		out[k] = k in base ? deepMerge(base[k], v) : v
	}
	return out
}

export function normalizeCampus(input, existing = []) {
	const name = String(input.name ?? '').trim() || 'Campus'
	let slug = slugify(input.slug || name)
	const taken = new Set(existing.filter((c) => c.id !== input.id).map((c) => c.slug))
	for (let i = 2; taken.has(slug); i++) slug = `${slugify(input.slug || name)}_${i}`

	const sermon = Number(input.sermonMinutes)
	return {
		id: input.id || randomUUID(),
		name,
		slug,
		enabled: input.enabled !== false,
		decoders: (Array.isArray(input.decoders) ? input.decoders : String(input.decoders ?? '').split(','))
			.map((s) => String(s).trim())
			.filter(Boolean),
		sermonMinutes: Number.isFinite(sermon) && sermon > 0 ? sermon : null,
		startCue: String(input.startCue ?? '').trim() || null,
		endCues: Array.isArray(input.endCues) ? input.endCues.map(String).filter(Boolean) : [],
		// null = use the global offset. Seconds added to the decoder playhead: +2 takes 2s off the clock.
		positionOffsetSec: input.positionOffsetSec === null || input.positionOffsetSec === '' || input.positionOffsetSec === undefined || !Number.isFinite(Number(input.positionOffsetSec))
			? null
			: Number(input.positionOffsetSec),
		companion: {
			url: String(input.companion?.url ?? '').trim(),
			variablePrefix: slugify(input.companion?.variablePrefix || 'resi_timer'),
		},
	}
}

export class ConfigStore {
	constructor(dataDir) {
		this.file = path.join(dataDir, 'config.json')
		this.backupFile = path.join(dataDir, 'before-import.json')
		this.dataDir = dataDir
		this.config = structuredClone(DEFAULT_CONFIG)
		this.listeners = new Set()
	}

	async load() {
		await mkdir(this.dataDir, { recursive: true })
		try {
			const raw = JSON.parse(await readFile(this.file, 'utf8'))
			const { cues, ...rest } = raw
			this.config = deepMerge(DEFAULT_CONFIG, rest)
			this.config.cues = normalizeCueSettings(cues ?? {})
		} catch (err) {
			if (err.code !== 'ENOENT') throw err
			this.applyEnvDefaults()
			await this.save()
		}
		return this.config
	}

	/** First boot only: let docker-compose seed credentials. */
	applyEnvDefaults() {
		const env = process.env
		if (env.RESI_EMAIL) this.config.resi.email = env.RESI_EMAIL
		if (env.RESI_PASSWORD) this.config.resi.password = env.RESI_PASSWORD
		if (env.RESI_CUSTOMER_ID) this.config.resi.customerId = env.RESI_CUSTOMER_ID
	}

	async save() {
		const tmp = `${this.file}.tmp`
		await writeFile(tmp, JSON.stringify(this.config, null, '\t'))
		await rename(tmp, this.file)
		for (const fn of this.listeners) fn(this.config)
	}

	onChange(fn) {
		this.listeners.add(fn)
	}

	/** Settings without secrets, for the web UI. */
	publicSettings() {
		const { campuses: _c, ...rest } = this.config
		const copy = structuredClone(rest)
		copy.resi.hasPassword = !!copy.resi.password
		copy.resi.hasManualToken = !!copy.resi.manualToken
		delete copy.resi.password
		delete copy.resi.manualToken
		return copy
	}

	async updateSettings(patch) {
		const { cues, ...rest } = patch ?? {}
		const next = deepMerge(this.config, { ...rest, campuses: undefined })
		next.cues = normalizeCueSettings(cues ? { ...this.config.cues, ...cues } : this.config.cues)
		next.campuses = this.config.campuses
		next.blackout = this.config.blackout
		// Blank secret fields mean "keep what's stored".
		if (!patch?.resi?.password) next.resi.password = this.config.resi.password
		if (!patch?.resi?.manualToken) next.resi.manualToken = this.config.resi.manualToken
		if (patch?.resi?.clearManualToken) next.resi.manualToken = ''
		delete next.resi.clearManualToken
		delete next.resi.hasPassword
		delete next.resi.hasManualToken
		this.config = next
		await this.save()
	}

	async upsertCampus(input) {
		const campus = normalizeCampus(input, this.config.campuses)
		const idx = this.config.campuses.findIndex((c) => c.id === campus.id)
		if (idx >= 0) this.config.campuses[idx] = campus
		else this.config.campuses.push(campus)
		await this.save()
		return campus
	}

	/** Put campuses in the order of `ids`; any not listed keep their place at the end. */
	async reorderCampuses(ids) {
		const pos = new Map(ids.map((id, i) => [id, i]))
		this.config.campuses = this.config.campuses
			.map((c, i) => ({ c, i }))
			.sort((a, b) => (pos.get(a.c.id) ?? ids.length + a.i) - (pos.get(b.c.id) ?? ids.length + b.i))
			.map((x) => x.c)
		await this.save()
		return this.config.campuses
	}

	async deleteCampus(id) {
		this.config.campuses = this.config.campuses.filter((c) => c.id !== id)
		this.config.blackout.campuses = this.config.blackout.campuses.filter((x) => x !== id)
		await this.save()
	}

	isBlackedOut(campusId) {
		return !!this.config.blackout.all || this.config.blackout.campuses.includes(campusId)
	}

	/** { all: true|false } or { campusId, on: true|false } */
	async setBlackout({ all, campusId, on }) {
		const b = this.config.blackout
		if (typeof all === 'boolean') b.all = all
		if (campusId) {
			if (!this.config.campuses.some((c) => c.id === campusId)) throw new Error('Unknown venue')
			b.campuses = b.campuses.filter((x) => x !== campusId)
			if (on) b.campuses.push(campusId)
		}
		await this.save()
		return structuredClone(b)
	}

	/** Cue names, countdown, display text and campuses, without secrets. */
	exportConfig() {
		const settings = Object.fromEntries(EXPORT_SETTINGS.map((k) => [k, structuredClone(this.config[k])]))
		return { format: EXPORT_FORMAT, version: 1, exportedAt: new Date().toISOString(), settings, campuses: structuredClone(this.config.campuses) }
	}

	/**
	 * Replace the chosen parts with an export's. Everything is validated before anything changes,
	 * and the current setup is saved first so the import can be undone.
	 */
	async importConfig(data, parts = IMPORT_PARTS) {
		if (data?.format !== EXPORT_FORMAT || typeof data.settings !== 'object' || !Array.isArray(data.campuses)) {
			throw new Error('This is not a Streaming Timer Sync export file.')
		}
		const want = IMPORT_PARTS.filter((p) => parts.includes(p))
		if (!want.length) throw new Error('Choose what to import.')

		const next = structuredClone(this.config)
		if (want.includes('settings')) {
			const { cues, ...rest } = Object.fromEntries(EXPORT_SETTINGS.filter((k) => k in data.settings).map((k) => [k, data.settings[k]]))
			Object.assign(next, deepMerge(Object.fromEntries(Object.keys(rest).map((k) => [k, DEFAULT_CONFIG[k]])), rest))
			if (cues) next.cues = normalizeCueSettings(cues)
			if (!(Number(next.defaultSermonMinutes) > 0)) next.defaultSermonMinutes = DEFAULT_CONFIG.defaultSermonMinutes
			if (!Number.isFinite(Number(next.positionOffsetSec))) next.positionOffsetSec = 0
		}
		if (want.includes('campuses')) {
			next.campuses = []
			for (const c of data.campuses) next.campuses.push(normalizeCampus(c, next.campuses))
			const ids = new Set(next.campuses.map((c) => c.id))
			next.blackout.campuses = next.blackout.campuses.filter((x) => ids.has(x))
		}

		const backup = this.exportConfig()
		await writeFile(this.backupFile, JSON.stringify(backup, null, '\t'))
		this.config = next
		await this.save()
		return { imported: want, campuses: next.campuses.length, cueTypes: next.cues.types.length }
	}

	async readBackup() {
		try {
			return JSON.parse(await readFile(this.backupFile, 'utf8'))
		} catch (err) {
			if (err.code === 'ENOENT') return null
			throw err
		}
	}

	/** Put back what was there before the last import. */
	async undoImport() {
		const backup = await this.readBackup()
		if (!backup) throw new Error('Nothing to undo.')
		const result = await this.importConfig(backup)
		await rm(this.backupFile, { force: true })
		return result
	}
}
