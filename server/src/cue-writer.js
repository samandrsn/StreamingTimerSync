/**
 * Setting cues in Resi live: pick the event (a specific one, or automatically by name), work
 * out "now" in it, and add the cue the same way Studio does. Remembers what it set, for undo.
 */

const EVENTS_TTL_MS = 30_000
const UNDO_DEPTH = 20

/** "HH:MM:SS.mmm", the position format Resi uses for cues. */
export function formatCuePosition(seconds) {
	const ms = Math.max(0, Math.round(seconds * 1000))
	const pad = (n, w = 2) => String(n).padStart(w, '0')
	return `${pad(Math.floor(ms / 3_600_000))}:${pad(Math.floor(ms / 60_000) % 60)}:${pad(Math.floor(ms / 1000) % 60)}.${pad(ms % 1000, 3)}`
}

/** Is the event recording right now? Resi gives each event a start time and a planned stop. */
export function isLive(event, now = Date.now()) {
	const start = Date.parse(event?.startTime)
	const stop = Date.parse(event?.stopAfter)
	return Number.isFinite(start) && start <= now && (!Number.isFinite(stop) || now <= stop)
}

/**
 * Build a matcher from a name pattern. `*` and `{date}` (or `{MM}`, `{DD}`, `{YYYY}`...) match
 * anything, so "{date} // Sunday Live Stream" and plain "Sunday Live Stream" both find
 * "11/15/2026 // Sunday Live Stream" every week. Case and extra spaces don't matter.
 */
export function namePattern(pattern) {
	const text = String(pattern ?? '').trim()
	if (!text) return null
	// A run of date placeholders ("{MM}/{DD}/{YYYY}") is one wildcard, so any date format matches.
	const parts = text.replace(/\{[a-z]+\}([\s/.\-]*\{[a-z]+\})*/gi, '*').split('*').map((p) => p.trim().replace(/\s+/g, ' ').replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/ /g, '\\s+'))
	const re = new RegExp(parts.join('.*?'), 'i')
	return (name) => re.test(String(name ?? ''))
}

/**
 * The event to set cues on. `choice` is { mode: 'auto' | 'event', pattern, eventId }.
 * Auto: of the events whose name matches, the live one; else the next to start (within a day);
 * else the most recent. Returns { event, reason }.
 */
export function pickEvent(events, choice = {}, now = Date.now()) {
	if (choice.mode === 'event') {
		const event = events.find((e) => e.uuid === choice.eventId)
		return event ? { event } : { event: null, reason: choice.eventId ? 'The chosen event wasn’t found in Resi.' : 'No event is chosen.' }
	}
	const match = namePattern(choice.pattern)
	if (!match) return { event: null, reason: 'Enter the event name to look for.' }
	const named = events.filter((e) => match(e.name))
	if (!named.length) return { event: null, reason: 'No event’s name matches.' }
	const live = named.filter((e) => isLive(e, now)).sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
	if (live.length) return { event: live[0] }
	const soon = named.filter((e) => Date.parse(e.startTime) > now && Date.parse(e.startTime) - now < 24 * 3600_000).sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
	if (soon.length) return { event: soon[0] }
	const started = named.filter((e) => Date.parse(e.startTime) <= now).sort((a, b) => Date.parse(b.startTime) - Date.parse(a.startTime))
	if (started.length) return { event: started[0] }
	const upcoming = named.sort((a, b) => Date.parse(a.startTime) - Date.parse(b.startTime))
	return { event: upcoming[0] }
}

/** A cue's full name: "9AM // Message End" (or "9AM: Message End" with another separator), or just the name. */
export function cueName(name, prefix, separator = ' // ') {
	const n = String(name ?? '').trim()
	const p = String(prefix ?? '').trim()
	return p ? `${p}${separator || ' '}${n}` : n
}

const minutesOf = (hhmm) => {
	const m = String(hhmm ?? '').match(/^(\d{1,2}):(\d{2})/)
	return m ? Number(m[1]) * 60 + Number(m[2]) : null
}

/**
 * The prefix for this moment: the first time range that contains it (from inclusive, to exclusive,
 * in the server's local time; a range can run past midnight), else the default.
 */
export function prefixFor(settings = {}, date = new Date()) {
	const now = date.getHours() * 60 + date.getMinutes()
	for (const rule of settings.prefixRules ?? []) {
		const from = minutesOf(rule.from)
		const to = minutesOf(rule.to)
		if (from === null || to === null || !String(rule.prefix ?? '').trim()) continue
		const inside = from <= to ? now >= from && now < to : now >= from || now < to
		if (inside) return String(rule.prefix).trim()
	}
	return String(settings.servicePrefix ?? '').trim()
}

/** The prefix a cue gets: one given with it ("-" for none) wins, else the time rule or default. */
export function resolvePrefix(given, settings, date = new Date()) {
	const g = given === undefined || given === null ? '' : String(given).trim()
	if (g === '-') return ''
	return g || prefixFor(settings, date)
}

export const summarizeEvent = (e, now = Date.now()) =>
	e && { id: e.uuid, name: e.name ?? '', startTime: e.startTime ?? null, stopAfter: e.stopAfter ?? null, encoderName: e.encoderName ?? '', live: isLive(e, now) }

export class CueWriter {
	constructor(store, client, log) {
		this.store = store
		this.client = client
		this.log = log
		this.events = []
		this.eventsAt = 0
		this.history = [] // { event, cue: { uuid, name, position }, at }
	}

	get settings() {
		return this.store.config.cueWriter
	}

	async refreshEvents(force = false) {
		if (!force && Date.now() - this.eventsAt < EVENTS_TTL_MS) return this.events
		this.events = await this.client.listEvents()
		this.eventsAt = Date.now()
		return this.events
	}

	/** The event list for pickers (live and upcoming first, then recent) and the one that would be used. */
	async overview(choice = this.settings) {
		const events = await this.refreshEvents()
		const now = Date.now()
		const { event, reason } = pickEvent(events, choice, now)
		const order = (e) => (isLive(e, now) ? 0 : Date.parse(e.startTime) > now ? 1 : 2)
		const list = [...events].sort((a, b) => order(a) - order(b) || Math.abs(Date.parse(a.startTime) - now) - Math.abs(Date.parse(b.startTime) - now))
		return {
			selected: summarizeEvent(event, now),
			reason: reason ?? (event && !isLive(event, now) ? 'This event isn’t live right now.' : null),
			events: list.slice(0, 40).map((e) => summarizeEvent(e, now)),
			prefix: prefixFor(this.settings),
			separator: this.settings.separator ?? ' // ',
			last: this.history.at(-1) ? { name: this.history.at(-1).cue.name, position: this.history.at(-1).cue.position, eventName: this.history.at(-1).event.name ?? '' } : null,
		}
	}

	/**
	 * Add a cue now. `eventId` overrides the saved choice (a Companion button can name its own event).
	 * Only a live event can take a cue at "now"; anything else is refused rather than guessed.
	 */
	async setCue({ name, prefix, eventId } = {}) {
		const full = cueName(name, resolvePrefix(prefix, this.settings), this.settings.separator)
		if (!full) throw new Error('Give the cue a name.')
		const events = await this.refreshEvents(true)
		const choice = eventId ? { mode: 'event', eventId } : this.settings
		const { event, reason } = pickEvent(events, choice)
		if (!event) throw new Error(reason)
		if (!isLive(event)) throw new Error(`${event.name || 'That event'} isn’t live, so there’s no “now” to put a cue at.`)
		const seconds = (Date.now() - Date.parse(event.startTime)) / 1000 + (Number(this.settings.offsetSec) || 0)
		const position = formatCuePosition(seconds)
		const cue = (await this.client.createCue(event, { name: full, position })) ?? { name: full, position, uuid: null }
		this.history.push({ event, cue, at: Date.now() })
		this.history.splice(0, Math.max(0, this.history.length - UNDO_DEPTH))
		this.log('info', `Cue set: "${full}" at ${position} in ${event.name || event.uuid}`)
		return { name: full, position, event: summarizeEvent(event) }
	}

	/** Remove the last cue this server set. */
	async undo() {
		const last = this.history.at(-1)
		if (!last) throw new Error('No cue to undo.')
		if (!last.cue.uuid) throw new Error(`“${last.cue.name}” was set, but Resi didn’t say its ID, so remove it in Studio.`)
		await this.client.deleteCue(last.event, last.cue.uuid)
		this.history.pop()
		this.log('info', `Cue removed: "${last.cue.name}" at ${last.cue.position}`)
		return { name: last.cue.name, position: last.cue.position, eventName: last.event.name ?? '' }
	}
}
