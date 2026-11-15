import { CueMatcher, splitPrefix } from './cue-match.js'
import { computeTimer, pickDecoder } from './engine.js'
import { positionToSeconds } from './time.js'

const MAX_INTERPOLATE_SEC = 10 * 60
const STALE_AFTER_SEC = 30
const RESYNC_THRESHOLD_SEC = 2

/**
 * Keeps a smoothed playhead per decoder. Telemetry only arrives every few
 * seconds with 1s resolution, so between reports a playing decoder's playhead
 * is advanced by wall-clock time and small corrections are blended in, which
 * keeps the stage clock from jittering.
 */
export class PlayheadClock {
	constructor() {
		this.basePos = 0
		this.baseAt = 0
		this.playing = false
		this.lastReportAt = 0
		this.eventId = null
		this.stoppedAt = null // wall time playback stopped; 0 = already stopped when first seen
	}

	/** Seconds since playback stopped (0 while playing, Infinity if never seen playing). */
	stoppedForSec(now) {
		if (this.playing || this.stoppedAt === null) return 0
		return this.stoppedAt === 0 ? Infinity : (now - this.stoppedAt) / 1000
	}

	predict(now) {
		if (!this.playing) return this.basePos
		const dt = Math.min((now - this.baseAt) / 1000, MAX_INTERPOLATE_SEC)
		return this.basePos + Math.max(0, dt)
	}

	report(decoder, now) {
		const pos = positionToSeconds(decoder.position)
		if (!Number.isFinite(pos)) return
		const playing = decoder.status === 'playing'
		// lastUpdate is when Resi received the report; use it as the anchor when it is sane.
		const reportedAt = Date.parse(decoder.lastUpdate)
		const anchor = Number.isFinite(reportedAt) && reportedAt <= now + 2000 && now - reportedAt < 60_000 ? reportedAt : now
		const reportedNow = playing ? pos + (now - anchor) / 1000 : pos

		const predicted = this.predict(now)
		const jump = Math.abs(reportedNow - predicted)
		if (!this.baseAt || playing !== this.playing || decoder.eventId !== this.eventId || jump > RESYNC_THRESHOLD_SEC) {
			this.basePos = reportedNow
		} else {
			this.basePos = predicted + (reportedNow - predicted) * 0.3
		}
		if (playing) this.stoppedAt = null
		else if (this.stoppedAt === null) this.stoppedAt = this.baseAt && this.playing ? now : 0
		this.baseAt = now
		this.playing = playing
		this.eventId = decoder.eventId
		this.lastReportAt = now
	}
}

export class Poller {
	constructor({ store, client, log }) {
		this.store = store
		this.client = client
		this.log = log
		this.decoders = new Map() // serial -> decoder
		this.clocks = new Map() // serial -> PlayheadClock
		this.cues = new Map() // eventId -> { cues, source, fetchedAt, error }
		this.eventNames = new Map() // eventId -> last known name
		this.timers = []
		this.listeners = new Set()
		this.status = { ok: false, message: 'Starting', lastDecoderPollAt: null, lastError: null, decoderPolls: 0 }
		this.afterCursor = null
		this.lastFullAt = 0
		this.stopped = false
		this.timeouts = []
	}

	get config() {
		return this.store.config
	}

	onTimers(fn) {
		this.listeners.add(fn)
		return () => this.listeners.delete(fn)
	}

	start() {
		this.stopped = false
		this.loop('decoders', () => this.pollDecoders(), () => this.config.polling.decoderIntervalMs)
		this.loop('cues', () => this.pollCues(), () => this.config.polling.cueIntervalMs)
		this.tickTimer = setInterval(() => this.tick(), 250)
	}

	stop() {
		this.stopped = true
		for (const t of this.timeouts) clearTimeout(t)
		clearInterval(this.tickTimer)
	}

	/** Called when settings change: drop session + caches that depend on them. */
	reset() {
		this.client.session.reset()
		this.client.cueRoutes.clear()
		this.afterCursor = null
		this.lastFullAt = 0
		this.cues.clear()
	}

	loop(name, fn, intervalFn) {
		let lastError = ''
		const run = async () => {
			if (this.stopped) return
			const started = Date.now()
			try {
				await fn()
				if (lastError) this.log('info', `${name} poll recovered`)
				lastError = ''
			} catch (err) {
				// Log each distinct failure once, not every interval.
				if (err.message !== lastError) this.log('warn', `${name} poll failed: ${err.message}`)
				lastError = err.message
			}
			const wait = Math.max(250, intervalFn() - (Date.now() - started))
			this.timeouts.push(setTimeout(run, wait))
			if (this.timeouts.length > 10) this.timeouts.splice(0, this.timeouts.length - 10)
		}
		run()
	}

	async pollDecoders() {
		const now = Date.now()
		const full = !this.afterCursor || now - this.lastFullAt > this.config.polling.fullDecoderRefreshMs
		try {
			const list = await this.client.fetchDecoders(full ? undefined : this.afterCursor)
			const prevSnapshot = full ? new Map(this.decoders) : new Map()
			if (full) {
				this.decoders.clear()
				this.lastFullAt = now
			}
			for (const d of list) {
				const prev = this.decoders.get(d.serialNumber) ?? prevSnapshot.get(d.serialNumber)
				const merged = { ...(prev ?? {}), ...d }
				this.decoders.set(d.serialNumber, merged)
				if (merged.eventId && merged.eventName) this.eventNames.set(merged.eventId, merged.eventName)
				let clock = this.clocks.get(d.serialNumber)
				if (!clock) this.clocks.set(d.serialNumber, (clock = new PlayheadClock()))
				// Full refreshes repeat old reports; only feed the clock genuinely new telemetry.
				const isNew =
					!prev ||
					prev.lastUpdate !== merged.lastUpdate ||
					prev.status !== merged.status ||
					prev.eventId !== merged.eventId ||
					prev.position !== merged.position
				if (isNew || !clock.baseAt) clock.report(merged, now)
			}
			// Resi server time as cursor, never our clock, so no deltas are skipped.
			for (const d of list) {
				if (d.lastUpdate && (!this.afterCursor || d.lastUpdate > this.afterCursor)) this.afterCursor = d.lastUpdate
			}
			this.afterCursor ??= new Date(now).toISOString()
			this.status = {
				...this.status,
				ok: true,
				message: 'Connected',
				lastDecoderPollAt: new Date().toISOString(),
				decoderPolls: this.status.decoderPolls + 1,
			}
		} catch (err) {
			this.status = { ...this.status, ok: false, message: err.message, lastError: { at: new Date().toISOString(), message: err.message } }
			throw err
		}
	}

	/** Event ids currently loaded on any decoder (campus or not — handy for diagnostics). */
	activeEventIds() {
		const ids = new Set()
		for (const d of this.decoders.values()) if (d.eventId && d.status !== 'offline') ids.add(d.eventId)
		for (const c of this.config.campuses) {
			for (const s of c.decoders) {
				const d = this.decoders.get(s)
				if (d?.eventId) ids.add(d.eventId)
			}
		}
		return ids
	}

	async pollCues() {
		if (!this.status.ok) return
		const active = this.activeEventIds()
		for (const eventId of this.cues.keys()) {
			if (!active.has(eventId)) {
				this.cues.delete(eventId)
				this.client.forgetEvent(eventId)
			}
		}
		await Promise.all(
			[...active].map(async (eventId) => {
				try {
					const result = await this.client.fetchCues(eventId)
					const prev = this.cues.get(eventId)
					if (result) {
						this.cues.set(eventId, { cues: result.cues, source: result.source, fetchedAt: Date.now(), error: null })
					} else {
						this.cues.set(eventId, { cues: prev?.cues ?? null, source: null, fetchedAt: Date.now(), error: 'No cue endpoint found' })
					}
				} catch (err) {
					const prev = this.cues.get(eventId)
					// Keep last good cues through transient errors so clocks don't blank out.
					this.cues.set(eventId, { ...(prev ?? { cues: null, source: null }), fetchedAt: Date.now(), error: err.message })
				}
			}),
		)
	}

	decoderView(serial, now) {
		const d = this.decoders.get(serial)
		if (!d) return undefined
		const clock = this.clocks.get(serial)
		return {
			serialNumber: d.serialNumber,
			userName: d.userName,
			status: d.status,
			eventId: d.eventId,
			eventName: d.eventName ?? this.eventNames.get(d.eventId) ?? null,
			lastUpdate: d.lastUpdate,
			position: d.position,
			buffer: d.buffer,
			playheadSec: clock ? clock.predict(now) : positionToSeconds(d.position),
			stoppedForSec: clock ? clock.stoppedForSec(now) : 0,
			stale: d.status === 'playing' && clock ? (now - clock.lastReportAt) / 1000 > STALE_AFTER_SEC : false,
		}
	}

	computeAll(now = Date.now()) {
		const settings = this.config
		return settings.campuses
			.filter((c) => c.enabled)
			.map((campus) => {
				const decoder = pickDecoder(campus.decoders.map((s) => this.decoderView(s, now)))
				const entry = decoder?.eventId ? this.cues.get(decoder.eventId) : undefined
				const timer = computeTimer({ campus, settings, decoder, cues: entry?.cues ?? undefined })
				timer.cueSource = entry?.source ?? null
				timer.cueError = entry?.error ?? null
				timer.blackout = this.store.isBlackedOut(campus.id)
				return timer
			})
	}

	tick() {
		this.timers = this.computeAll()
		for (const fn of this.listeners) {
			try {
				fn(this.timers)
			} catch (err) {
				this.log('warn', `timer listener failed: ${err.message}`)
			}
		}
	}

	/** Re-read every loaded event's cues now, finding each route again (after cue names change). */
	rescan() {
		this.client.cueRoutes.clear()
		this.rescanning = this.pollCues().finally(() => (this.rescanning = null))
		return this.rescanning
	}

	/**
	 * Every distinct cue in the loaded events (service prefix set aside), classified with
	 * `cueSettings`, in the order they usually happen in a service. `order` is the cue
	 * types sorted the same way, for laying out the Cue names page.
	 */
	cuePreview(cueSettings = this.config.cues) {
		const matcher = new CueMatcher(cueSettings)
		const bodies = new Map() // BODY -> { name, count, ranks[] }
		const events = []
		for (const [eventId, e] of this.cues) {
			if (!e.cues?.length) continue
			events.push({ eventId, eventName: this.eventNames.get(eventId) ?? null, cues: e.cues.length })
			const groups = new Map() // service prefix -> cues in time order
			for (const c of [...e.cues].sort((a, b) => a.positionSec - b.positionSec)) {
				const { prefix, body } = splitPrefix(c.name)
				const key = prefix.toLowerCase().replace(/:00|[\s.]/g, '')
				if (!groups.has(key)) groups.set(key, [])
				groups.get(key).push(body)
			}
			for (const list of groups.values()) {
				list.forEach((body, rank) => {
					const k = body.toUpperCase()
					if (!bodies.has(k)) bodies.set(k, { name: body, count: 0, ranks: [] })
					const b = bodies.get(k)
					b.count++
					b.ranks.push(rank)
				})
			}
		}
		const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length
		const cues = [...bodies.values()]
			.map((b) => ({ name: b.name, count: b.count, rank: mean(b.ranks), matches: matcher.classify(b.name, cueSettings.types) }))
			.sort((a, b) => a.rank - b.rank)
		const typeRanks = new Map()
		for (const c of cues) for (const m of c.matches) typeRanks.set(m, [...(typeRanks.get(m) ?? []), c.rank])
		const order = cueSettings.types
			.map((t, i) => ({ name: t.name, rank: typeRanks.has(t.name) ? mean(typeRanks.get(t.name)) : Infinity, i }))
			.sort((a, b) => a.rank - b.rank || a.i - b.i)
			.map((t) => t.name)
		return { events, cues: cues.map(({ rank: _r, ...c }) => c), order }
	}

	diagnostics() {
		const now = Date.now()
		const { cues: cueSettings } = this.config
		const matcher = new CueMatcher(cueSettings)
		const rules = cueSettings.types
		const label = (cues) => cues?.map((c) => ({ ...c, matchedAs: matcher.classify(c.name, rules) })) ?? null
		return {
			status: this.status,
			afterCursor: this.afterCursor,
			decoders: [...this.decoders.keys()].sort().map((s) => this.decoderView(s, now)),
			events: [...this.cues.entries()].map(([eventId, e]) => ({
				eventId,
				eventName: this.eventNames.get(eventId) ?? null,
				source: e.source,
				error: e.error,
				fetchedAt: e.fetchedAt ? new Date(e.fetchedAt).toISOString() : null,
				cues: label(e.cues),
			})),
			knownProfiles: [...this.client.knownProfiles],
			discoveryLog: this.client.discoveryLog.slice(0, 50),
		}
	}
}
