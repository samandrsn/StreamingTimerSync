/**
 * Fake central.resi.io for local testing. Point Settings → Advanced → Central base
 * at http://localhost:9090 and use any email/password + customer id "mock".
 *
 * Add a cue live:  curl -X POST 'localhost:9090/mock/cue?event=E1&name=MESSAGE%20END&at=02:52:00'
 */
import { createServer } from 'node:http'

const PROFILE = '11111111-2222-3333-4444-555555555555'
const E1 = 'aaaaaaaa-0000-0000-0000-000000000001' // Sunday, 3 services
const E2 = 'aaaaaaaa-0000-0000-0000-000000000002' // Saturday

const cues = {
	[E1]: [
		{ uuid: 'c1', name: '9AM // Message Start', position: '00:40:00.000', privateCue: false, user: 'td' },
		{ uuid: 'c2', name: '9AM: Message End', position: '01:22:30.000', privateCue: false, user: 'td' },
		{ uuid: 'c3', name: '9am - stream end', position: '01:30:00.000', privateCue: false, user: 'td' },
		{ uuid: 'c3b', name: '11AM // Walk In', position: '01:50:00.000', privateCue: false, user: 'td' },
		{ uuid: 'c4', name: '11AM // Msg Begins', position: '02:10:00.000', privateCue: false, user: 'td' },
	],
	[E2]: [{ uuid: 'c5', name: '5PM: Mesage Start', position: '00:35:00.000', privateCue: false, user: 'td' }],
}

const startedAt = Date.now()
// serial -> [name, event, startPositionSec, status]
const decoders = [
	['D1', 'Main Campus', E1, 2 * 3600 + 15 * 60, 'playing'],
	['D2', 'North Campus', E1, 3600 + 15 * 60, 'playing'],
	['D3', 'North Campus Backup', null, 0, 'offline'],
	['D4', 'South Campus', E1, 30 * 60, 'playing'],
	['D5', 'East Campus', E2, 35 * 60 + 50 * 60, 'playing'],
	['D6', 'West Campus', E1, 50 * 60, 'paused'],
]

function hms(sec) {
	const s = Math.floor(sec)
	return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':')
}

function decoderList() {
	const elapsed = (Date.now() - startedAt) / 1000
	// Report like a real decoder: position is a few seconds old, lastUpdate whole seconds.
	const reportAt = Math.floor(Date.now() / 3000) * 3000
	const reportElapsed = (reportAt - startedAt) / 1000
	return decoders.map(([serialNumber, userName, eventId, start, status]) => ({
		serialNumber,
		userName,
		status,
		eventId,
		eventName: eventId === E1 ? 'Sunday Services' : eventId === E2 ? 'Saturday Service' : null,
		position: hms(status === 'playing' ? start + Math.max(0, reportElapsed) : start),
		buffer: hms(start + elapsed + 60),
		lastUpdate: new Date(status === 'playing' ? reportAt : startedAt).toISOString().replace(/\.\d+Z$/, 'Z'),
	}))
}

function json(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json' })
	res.end(JSON.stringify(body))
}

createServer(async (req, res) => {
	const url = new URL(req.url, 'http://x')
	const p = url.pathname
	const authed = (req.headers.authorization ?? '').startsWith('X-Bearer mock-token')

	if (p === '/api/v3/auth/token') {
		res.setHeader('Set-Cookie', 'refresh=abc; Path=/; HttpOnly')
		return json(res, 200, { access_token: 'mock-token', expires_in: 3600 })
	}
	if (p === '/api/v3/login') return json(res, 200, {})
	if (p === '/mock/cue' && req.method === 'POST') {
		const ev = url.searchParams.get('event') === 'E2' ? E2 : E1
		cues[ev].push({ uuid: `m${Date.now()}`, name: url.searchParams.get('name'), position: url.searchParams.get('at'), user: 'mock' })
		return json(res, 200, cues[ev])
	}
	if (!authed) return json(res, 401, { message: 'unauthorized' })

	if (/^\/api\/v3\/customers\/[^/]+\/monitors\/decoders$/.test(p)) return json(res, 200, decoderList())
	let m = p.match(/^\/api\/v3\/customers\/[^/]+\/events\/([^/]+)$/)
	if (m) return cues[m[1]] ? json(res, 200, { uuid: m[1], name: 'Event', eventProfileId: PROFILE }) : json(res, 404, {})
	m = p.match(/^\/api_v2\.svc\/streamprofiles\/([^/]+)\/events\/([^/]+)\/cues$/)
	if (m) return m[1] === PROFILE && cues[m[2]] ? json(res, 200, cues[m[2]]) : json(res, 404, { message: 'not found' })
	json(res, 404, { message: 'not found' })
}).listen(9090, () => console.log('Mock Resi on http://localhost:9090'))
