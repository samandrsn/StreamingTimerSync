/**
 * Resi Studio session login, the same flow as the Studio web app: password_cookie
 * token, then /login?newToken=true for session cookies, refresh via refresh_token_cookie.
 */

const TOKEN_TTL_MS = 55 * 60 * 1000
const REFRESH_BUFFER_MS = 5 * 60 * 1000

export const BROWSER_USER_AGENT =
	'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36'

export class ResiError extends Error {
	constructor(message, statusCode) {
		super(message)
		this.name = 'ResiError'
		this.statusCode = statusCode
	}
}

function mergeSetCookies(existing, response) {
	const map = new Map()
	for (const pair of existing.split(';')) {
		const t = pair.trim()
		const eq = t.indexOf('=')
		if (eq > 0) map.set(t.slice(0, eq), t.slice(eq + 1))
	}
	for (const sc of response.headers.getSetCookie?.() ?? []) {
		const nv = sc.split(';')[0]?.trim() ?? ''
		const eq = nv.indexOf('=')
		if (eq > 0) map.set(nv.slice(0, eq), nv.slice(eq + 1))
	}
	return [...map.entries()].map(([k, v]) => `${k}=${v}`).join('; ')
}

function describeBody(body) {
	if (!body) return ''
	if (typeof body === 'string') return body.slice(0, 300)
	return body.message || body.error_description || body.error || JSON.stringify(body).slice(0, 300)
}

async function post(url, origin, body, cookies) {
	const response = await fetch(url, {
		method: 'POST',
		headers: {
			Accept: 'application/json, text/plain, */*',
			'Content-Type': 'application/json',
			Origin: origin,
			Referer: `${origin}/`,
			'User-Agent': BROWSER_USER_AGENT,
			...(cookies ? { Cookie: cookies } : {}),
		},
		body: JSON.stringify(body),
	})
	const text = await response.text()
	let parsed = null
	try {
		parsed = text ? JSON.parse(text) : null
	} catch {
		parsed = text
	}
	return { response, body: parsed, cookies: mergeSetCookies(cookies, response) }
}

export class StudioSession {
	constructor(log) {
		this.log = log
		this.cache = null // { accessToken, cookies, obtainedAt, customerId, customerName }
		this.blockedUntil = 0
		this.blockedReason = ''
	}

	reset() {
		this.cache = null
		this.blockedUntil = 0
		this.blockedReason = ''
	}

	isValid() {
		return !!this.cache?.accessToken && Date.now() < this.cache.obtainedAt + TOKEN_TTL_MS - REFRESH_BUFFER_MS
	}

	invalidate() {
		if (this.cache) this.cache.obtainedAt = 0
	}

	async get(resiConfig) {
		if (this.isValid()) return this.cache
		if (Date.now() < this.blockedUntil) {
			// Stable text (no countdown) so the poll loop logs it once, not every 2s.
			throw new ResiError(`Studio login paused after: ${this.blockedReason}`)
		}
		if (!resiConfig.email.trim() || !resiConfig.password) throw new ResiError('Resi email and password are not configured')

		const base = resiConfig.centralBase.replace(/\/+$/, '')
		const origin = resiConfig.studioOrigin.replace(/\/+$/, '')

		if (this.cache?.cookies) {
			try {
				const r = await post(`${base}/api/v3/auth/token`, origin, { grant_type: 'refresh_token_cookie' }, this.cache.cookies)
				if (r.response.ok && r.body?.access_token) {
					this.cache = { ...this.cache, accessToken: r.body.access_token, cookies: r.cookies, obtainedAt: Date.now() }
					this.log('debug', 'Resi session refreshed')
					return this.cache
				}
			} catch {
				// fall through to password login
			}
		}

		try {
			this.cache = await this.login(resiConfig, base, origin)
			this.blockedUntil = 0
			return this.cache
		} catch (err) {
			const rateLimited = /rate limit/i.test(err.message)
			const delay = rateLimited ? 15 * 60_000 : err.statusCode === 401 || err.statusCode === 403 ? 2 * 60_000 : 30_000
			this.blockedUntil = Date.now() + delay
			this.blockedReason = err.message
			throw err
		}
	}

	async login(resiConfig, base, origin) {
		const username = resiConfig.email.trim()
		const password = resiConfig.password
		if (!username || !password) throw new ResiError('Resi email and password are not configured')

		const t = await post(`${base}/api/v3/auth/token`, origin, { username, password, grant_type: 'password_cookie' }, '')
		if (!t.response.ok || !t.body?.access_token) {
			throw new ResiError(`Resi login failed: ${describeBody(t.body) || `HTTP ${t.response.status}`}`, t.response.status)
		}

		const loginBody = { userName: username, password }
		if (resiConfig.customerId) loginBody.sudoCustomer = resiConfig.customerId
		const l = await post(`${base}/api/v3/login?newToken=true`, origin, loginBody, t.cookies)
		if (!l.response.ok) {
			this.log('warn', `Resi session login returned HTTP ${l.response.status}: ${describeBody(l.body)}`)
		}

		// The login answer names the organization, so the customer ID doesn't have to be typed in.
		const customerId = l.body?.customerId ?? null
		const customerName = l.body?.customerName ?? null
		this.log('info', `Logged in to Resi Studio${customerName ? ` (${customerName})` : ''}`)
		return { accessToken: t.body.access_token, cookies: l.cookies, obtainedAt: Date.now(), customerId, customerName }
	}
}
