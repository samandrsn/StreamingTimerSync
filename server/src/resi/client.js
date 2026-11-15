import { randomUUID } from 'node:crypto'
import { positionToSeconds } from '../time.js'
import { BROWSER_USER_AGENT, ResiError, StudioSession } from './auth.js'

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * Talks to central.resi.io as Resi Studio does. Endpoints were taken from the
 * Studio web app:
 *   decoders:  /api/v3/customers/{cid}/monitors/decoders[?after=ISO]
 *   live cues: /api_v2.svc/streamprofiles/{profileId}/events/{eventId}/cues
 *   web cues:  /api/v3/customers/{cid}/contentdestinations/{mediaId}/cues
 *   event:     /api/v3/customers/{cid}/events/{eventId}
 */
export class ResiClient {
	constructor(getConfig, log) {
		this.getConfig = getConfig
		this.log = log
		this.session = new StudioSession(log)
		this.trackingId = `STUDIO_${randomUUID()}`
		// eventId -> { url, source, confirmed } — how to fetch that event's cues
		this.cueRoutes = new Map()
		// stream profile ids that have worked before; weekly events usually reuse them
		this.knownProfiles = new Set()
		this.discoveryLog = []
	}

	get resi() {
		return this.getConfig().resi
	}

	base() {
		return this.resi.centralBase.replace(/\/+$/, '')
	}

	noteDiscovery(eventId, message) {
		this.discoveryLog.unshift({ at: new Date().toISOString(), eventId, message })
		this.discoveryLog.length = Math.min(this.discoveryLog.length, 200)
	}

	async authHeaders() {
		const origin = this.resi.studioOrigin.replace(/\/+$/, '')
		const headers = {
			Accept: 'application/json, text/plain, */*',
			Origin: origin,
			Referer: `${origin}/`,
			'User-Agent': BROWSER_USER_AGENT,
			trackingid: this.trackingId,
		}
		const manual = this.resi.manualToken?.trim().replace(/^(x-)?bearer\s+/i, '')
		if (manual && !this.resi.password) {
			headers.Authorization = `X-Bearer ${manual}`
			return headers
		}
		const s = await this.session.get(this.resi)
		headers.Authorization = `X-Bearer ${s.accessToken}`
		if (s.cookies) headers.Cookie = s.cookies
		return headers
	}

	/** GET JSON with one re-login on 401/403. Returns { status, body }. */
	async getJson(url, { allowStatus = [] } = {}) {
		for (let attempt = 0; attempt < 2; attempt++) {
			const headers = await this.authHeaders()
			let response
			try {
				response = await fetch(url, { headers, signal: AbortSignal.timeout(15000) })
			} catch (err) {
				throw new ResiError(`Network error for ${url}: ${err.message}`)
			}
			if ((response.status === 401 || response.status === 403) && attempt === 0 && this.resi.password) {
				this.session.invalidate()
				continue
			}
			const text = await response.text()
			let body = null
			try {
				body = text ? JSON.parse(text) : null
			} catch {
				body = text
			}
			if (!response.ok && !allowStatus.includes(response.status)) {
				const detail = typeof body === 'string' ? body.slice(0, 200) : JSON.stringify(body)?.slice(0, 200)
				throw new ResiError(`HTTP ${response.status} for ${new URL(url).pathname}: ${detail ?? ''}`, response.status)
			}
			return { status: response.status, body }
		}
		throw new ResiError('Authentication failed after re-login', 401)
	}

	/** The configured customer ID, or the one the Studio login reported. */
	async requireCustomerId() {
		const configured = this.resi.customerId?.trim()
		if (configured) return configured
		if (this.resi.password) {
			const s = await this.session.get(this.resi)
			if (s.customerId) return s.customerId
		}
		throw new ResiError('Customer ID not found. Enter it on the Resi connection page.')
	}

	async fetchDecoders(afterIso) {
		const cid = await this.requireCustomerId()
		const url = new URL(`${this.base()}/api/v3/customers/${cid}/monitors/decoders`)
		if (afterIso) url.searchParams.set('after', afterIso)
		const { body } = await this.getJson(url.toString())
		if (!Array.isArray(body)) throw new ResiError('Unexpected decoder response (expected an array)')
		return body
	}

	async fetchEvent(eventId) {
		const cid = await this.requireCustomerId()
		const { status, body } = await this.getJson(`${this.base()}/api/v3/customers/${cid}/events/${eventId}`, {
			allowStatus: [400, 404],
		})
		return status === 200 ? body : null
	}

	async listProfileIds() {
		const cid = await this.requireCustomerId()
		const ids = new Set()
		for (const p of ['eventprofiles', 'encoderprofiles']) {
			try {
				const { status, body } = await this.getJson(`${this.base()}/api/v3/customers/${cid}/${p}`, {
					allowStatus: [400, 403, 404],
				})
				if (status === 200) collectUuids(body, ids, /^(uuid|id)$/i)
			} catch (err) {
				this.log('debug', `listProfileIds ${p}: ${err.message}`)
			}
		}
		return [...ids]
	}

	cueUrlForProfile(profileId, eventId) {
		return `${this.base()}/api_v2.svc/streamprofiles/${profileId}/events/${eventId}/cues`
	}

	/** Try one candidate URL; returns parsed cue list or null. */
	async tryCueUrl(url) {
		try {
			const { status, body } = await this.getJson(url, { allowStatus: [400, 403, 404, 405, 500] })
			if (status !== 200) return null
			const list = extractCueArray(body)
			return list ? list.map(normalizeCue).filter(Boolean) : null
		} catch (err) {
			if (err.statusCode) return null
			throw err
		}
	}

	/**
	 * Find how to read cues for an event. Order:
	 *   1. manual URL template from settings
	 *   2. stream profiles that worked for earlier events
	 *   3. profile ids referenced by the event record
	 *   4. every event/encoder profile on the account
	 *   5. web-event content destination cues
	 * A route returning [] is kept tentatively and re-discovered later, since a
	 * wrong profile might answer with an empty list.
	 */
	async discoverCueRoute(eventId) {
		const cid = await this.requireCustomerId()
		const tried = new Set()
		let emptyFallback = null

		const attempt = async (url, source) => {
			if (tried.has(url)) return null
			tried.add(url)
			const cues = await this.tryCueUrl(url)
			if (!cues) return null
			if (cues.length > 0) {
				this.noteDiscovery(eventId, `cues found via ${source} (${cues.length})`)
				return { route: { url, source, confirmed: true }, cues }
			}
			emptyFallback ??= { route: { url, source, confirmed: false }, cues }
			return null
		}

		const template = this.resi.cueUrlTemplate?.trim()
		if (template) {
			const url = template.replaceAll('{eventId}', eventId).replaceAll('{customerId}', cid)
			const r = await attempt(url, 'manual template')
			if (r) return r
		}

		for (const pid of this.knownProfiles) {
			const r = await attempt(this.cueUrlForProfile(pid, eventId), `stream profile ${pid}`)
			if (r) return r
		}

		const event = await this.fetchEvent(eventId).catch(() => null)
		if (event) {
			const ids = new Set()
			collectUuids(event, ids, /profile/i)
			for (const pid of ids) {
				const r = await attempt(this.cueUrlForProfile(pid, eventId), `event profile ${pid}`)
				if (r) return r
			}
		}

		for (const pid of await this.listProfileIds()) {
			const r = await attempt(this.cueUrlForProfile(pid, eventId), `account profile ${pid}`)
			if (r) return r
		}

		const r = await attempt(`${this.base()}/api/v3/customers/${cid}/contentdestinations/${eventId}/cues`, 'content destination')
		if (r) return r

		if (emptyFallback) {
			this.noteDiscovery(eventId, `no cues yet; tentatively using ${emptyFallback.route.source}`)
			return emptyFallback
		}
		this.noteDiscovery(eventId, `no cue endpoint answered (${tried.size} tried)`)
		return null
	}

	/**
	 * Fetch cues for an event, discovering the route on first use.
	 * Returns { cues, source } or null when no route could be found.
	 */
	async fetchCues(eventId) {
		let route = this.cueRoutes.get(eventId)
		if (route && !route.confirmed && Date.now() - (route.discoveredAt ?? 0) > 60_000) route = null

		if (route) {
			const cues = await this.tryCueUrl(route.url)
			if (cues) {
				if (cues.length && !route.confirmed) route.confirmed = true
				this.rememberProfile(route.url)
				return { cues, source: route.source }
			}
			this.cueRoutes.delete(eventId)
		}

		const found = await this.discoverCueRoute(eventId)
		if (!found) return null
		this.cueRoutes.set(eventId, { ...found.route, discoveredAt: Date.now() })
		if (found.route.confirmed) this.rememberProfile(found.route.url)
		return { cues: found.cues, source: found.route.source }
	}

	rememberProfile(url) {
		const m = url.match(/streamprofiles\/([0-9a-f-]{36})\//i)
		if (m) this.knownProfiles.add(m[1])
	}

	forgetEvent(eventId) {
		this.cueRoutes.delete(eventId)
	}
}

function collectUuids(value, out, keyPattern, key = '') {
	if (value === null || value === undefined) return
	if (typeof value === 'string') {
		if (UUID_RE.test(value) && keyPattern.test(key)) out.add(value)
		return
	}
	if (Array.isArray(value)) {
		for (const v of value) collectUuids(v, out, keyPattern, key)
		return
	}
	if (typeof value === 'object') {
		for (const [k, v] of Object.entries(value)) collectUuids(v, out, keyPattern, k)
	}
}

function extractCueArray(body) {
	if (Array.isArray(body)) return body
	if (body && typeof body === 'object') {
		for (const k of ['cues', 'items', 'data', 'results']) if (Array.isArray(body[k])) return body[k]
	}
	return null
}

export function normalizeCue(raw) {
	if (!raw || typeof raw !== 'object') return null
	const positionSec = positionToSeconds(raw.position ?? raw.offset ?? raw.time)
	if (!Number.isFinite(positionSec)) return null
	return {
		id: raw.uuid ?? raw.id ?? `${raw.name}@${raw.position}`,
		name: String(raw.name ?? raw.label ?? raw.title ?? ''),
		position: raw.position,
		positionSec,
		private: raw.privateCue === true || raw.visibility === 'PRIVATE',
		user: raw.user ?? raw.userName ?? null,
	}
}
