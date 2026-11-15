/**
 * Optional push into Companion custom variables (Companion 3+ HTTP API):
 *   POST {url}/api/custom-variable/{name}/value?value=...
 * Lets a campus skip installing the Companion module. The custom variables must
 * already exist in Companion (Variables → Custom Variables).
 * Only changed values are sent.
 */

/** 42 → "42 min", 42.5 → "42:30", 65 → "1:05:00". */
function fmtMinutes(min) {
	const sec = Math.round(Number(min) * 60)
	const pad = (n) => String(n).padStart(2, '0')
	if (sec >= 3600) return `${Math.floor(sec / 3600)}:${pad(Math.floor(sec / 60) % 60)}:${pad(sec % 60)}`
	return sec % 60 ? `${Math.floor(sec / 60)}:${pad(sec % 60)}` : `${sec / 60} min`
}

const FIELDS = {
	remaining: (t) => t.display,
	remaining_seconds: (t) => (t.remainingSeconds ?? '').toString(),
	state: (t) => t.state,
	target: (t) => (t.targetSource === 'cue' ? t.targetCueName : t.targetSource === 'default' ? `${fmtMinutes(t.estimateMinutes ?? t.sermonMinutes)} default` : ''),
	elapsed: (t) => t.elapsedDisplay,
	event: (t) => t.eventName ?? '',
	estimated: (t) => (t.estimated ? '1' : '0'),
}

/** Sent once per target type, as {prefix}_{target}_{field}, e.g. resi_timer_stream_end_remaining. */
export const TARGET_FIELDS = {
	remaining: (t) => t.display,
	remaining_seconds: (t) => (t.remainingSeconds ?? '').toString(),
	state: (t) => t.state,
	estimated: (t) => (t.estimated ? '1' : '0'),
}

export class CompanionPusher {
	constructor(store, log) {
		this.store = store
		this.log = log
		this.sent = new Map() // `${url}|${name}` -> value
		this.inFlight = new Set()
		this.lastErrorAt = new Map()
		this.status = new Map() // campusId -> { ok, message, at }
	}

	push(timers) {
		const campuses = new Map(this.store.config.campuses.map((c) => [c.id, c]))
		for (const timer of timers) {
			const campus = campuses.get(timer.campusId)
			const url = campus?.companion?.url?.replace(/\/+$/, '')
			if (!url) continue
			const prefix = campus.companion.variablePrefix || 'resi_timer'
			for (const [field, get] of Object.entries(FIELDS)) {
				this.send(campus.id, url, `${prefix}_${field}`, get(timer) ?? '')
			}
			for (const target of timer.targets ?? []) {
				for (const [field, get] of Object.entries(TARGET_FIELDS)) {
					this.send(campus.id, url, `${prefix}_${target.key}_${field}`, get(target) ?? '')
				}
			}
		}
	}

	send(campusId, url, name, value) {
		const key = `${url}|${name}`
		if (this.sent.get(key) === value || this.inFlight.has(key)) return
		// Back off for 10s after a failure so an unreachable Companion doesn't spam.
		if (Date.now() - (this.lastErrorAt.get(url) ?? 0) < 10_000) return
		this.inFlight.add(key)
		const target = `${url}/api/custom-variable/${encodeURIComponent(name)}/value?value=${encodeURIComponent(value)}`
		fetch(target, { method: 'POST', signal: AbortSignal.timeout(3000) })
			.then((r) => {
				if (!r.ok) throw new Error(`HTTP ${r.status}`)
				this.sent.set(key, value)
				this.status.set(campusId, { ok: true, message: 'OK', at: new Date().toISOString() })
			})
			.catch((err) => {
				this.lastErrorAt.set(url, Date.now())
				const message = `Companion push to ${url} failed: ${err.message}`
				const prev = this.status.get(campusId)
				if (prev?.message !== message) this.log('warn', message)
				this.status.set(campusId, { ok: false, message, at: new Date().toISOString() })
			})
			.finally(() => this.inFlight.delete(key))
	}
}
