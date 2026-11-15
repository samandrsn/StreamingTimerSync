import { createReadStream, readFileSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { createServer } from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { CueMatcher, normalizeCueSettings, splitPrefix } from './cue-match.js'

const PUBLIC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../public')
export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' }

// Read-only timer output stays open so Companion/ProPresenter never need credentials.
const PUBLIC_ROUTES = [/^\/api\/timers(\/|$)/, /^\/api\/stream$/, /^\/api\/status$/, /^\/health$/, /^\/logo\.svg$/]

// Stage display: /{campus} or /{campus}/{target}, e.g. /north or /north/stream_end.
const DISPLAY_PATH = /^\/([a-z0-9_]+)(?:\/([a-z0-9_]+))?\/?$/

function displayCampus(p, campuses) {
	const m = p.match(DISPLAY_PATH)
	return m ? campuses.find((c) => c.slug === m[1]) : undefined
}

function sendJson(res, status, body) {
	res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
	res.end(JSON.stringify(body))
}

async function readBody(req) {
	let data = ''
	for await (const chunk of req) {
		data += chunk
		if (data.length > 1_000_000) throw new Error('Body too large')
	}
	return data ? JSON.parse(data) : {}
}

function authorized(req, adminPassword) {
	if (!adminPassword) return true
	const header = req.headers.authorization ?? ''
	if (!header.startsWith('Basic ')) return false
	const decoded = Buffer.from(header.slice(6), 'base64').toString()
	return decoded.slice(decoded.indexOf(':') + 1) === adminPassword
}

export function startHttp({ port, store, poller, client, pusher, cueWriter, logs, adminPassword }) {
	const streams = new Set()
	// Stage displays reload when this changes: on a new version, a restart, or the Live page's button.
	let reloadAt = Date.now()
	// One venue's screens can be reloaded on their own too.
	const venueReloads = {}
	// Open stage displays per venue, from the ?display= each display page connects with.
	const screenCounts = () => {
		const counts = {}
		for (const res of streams) if (res.display) counts[res.display] = (counts[res.display] ?? 0) + 1
		return counts
	}
	const message = (timers) =>
		JSON.stringify({ serverTime: Date.now(), blackout: store.config.blackout, reload: `${VERSION}:${reloadAt}`, reloads: venueReloads, screens: screenCounts(), timers })
	const broadcast = (timers) => {
		if (!streams.size) return
		const payload = `data: ${message(timers)}\n\n`
		for (const res of streams) res.write(payload)
	}
	poller.onTimers(broadcast)

	const server = createServer(async (req, res) => {
		const url = new URL(req.url, 'http://localhost')
		const p = url.pathname
		res.setHeader('Access-Control-Allow-Origin', '*')

		const isDisplay = req.method === 'GET' && !!displayCampus(p, store.config.campuses)
		if (!isDisplay && !PUBLIC_ROUTES.some((r) => r.test(p)) && !authorized(req, adminPassword)) {
			res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Streaming Timer Sync"' })
			res.end('Authentication required')
			return
		}

		try {
			if (p === '/health') return sendJson(res, 200, { ok: true, version: VERSION })

			if (p === '/api/timers' && req.method === 'GET') {
				return sendJson(res, 200, { serverTime: Date.now(), status: poller.status, timers: poller.timers })
			}
			// /api/timers/{campus}[/{target}][/text], e.g. /api/timers/north/stream_end/text
			const timerMatch = p.match(/^\/api\/timers\/([^/]+)(?:\/(?!text$)([^/]+))?(\/text)?$/)
			if (timerMatch && req.method === 'GET') {
				const key = decodeURIComponent(timerMatch[1])
				const timer = poller.timers.find((t) => t.slug === key || t.campusId === key)
				if (!timer) return sendJson(res, 404, { error: `No enabled venue "${key}"` })
				const targetKey = timerMatch[2] && decodeURIComponent(timerMatch[2])
				const entry = targetKey ? timer.targets.find((t) => t.key === targetKey) : timer
				if (!entry) return sendJson(res, 404, { error: `${timer.campusName} has no "${targetKey}" countdown` })
				if (timerMatch[3]) {
					res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' })
					return res.end(entry.display)
				}
				return sendJson(res, 200, entry)
			}

			if (p === '/api/stream') {
				res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
				res.display = url.searchParams.get('display') || null
				streams.add(res)
				res.write(`retry: 1000\ndata: ${message(poller.timers)}\n\n`)
				req.on('close', () => streams.delete(res))
				return
			}

			if (p === '/api/displays/reload' && req.method === 'POST') {
				// Body { slug } reloads one venue's screens; no body reloads them all.
				const { slug } = await readBody(req).catch(() => ({}))
				if (slug) venueReloads[slug] = Date.now()
				else reloadAt = Date.now()
				broadcast(poller.timers)
				const counts = screenCounts()
				return sendJson(res, 200, { ok: true, screens: slug ? (counts[slug] ?? 0) : Object.values(counts).reduce((a, b) => a + b, 0) })
			}

			if (p === '/api/status') {
				return sendJson(res, 200, { ...poller.status, version: VERSION, campuses: store.config.campuses.length })
			}

			if (p === '/api/settings') {
				if (req.method === 'GET') return sendJson(res, 200, store.publicSettings())
				if (req.method === 'PUT') {
					await store.updateSettings(await readBody(req))
					return sendJson(res, 200, store.publicSettings())
				}
			}

			if (p === '/api/campuses') {
				if (req.method === 'GET') {
					const push = Object.fromEntries(pusher.status)
					return sendJson(res, 200, store.config.campuses.map((c) => ({ ...c, pushStatus: push[c.id] ?? null })))
				}
				if (req.method === 'POST') return sendJson(res, 200, await store.upsertCampus(await readBody(req)))
			}
			if (p === '/api/campuses/order' && req.method === 'PUT') {
				const { ids } = await readBody(req)
				if (!Array.isArray(ids)) return sendJson(res, 400, { error: 'ids must be a list' })
				return sendJson(res, 200, await store.reorderCampuses(ids.map(String)))
			}
			const campusMatch = p.match(/^\/api\/campuses\/([^/]+)$/)
			if (campusMatch) {
				const id = decodeURIComponent(campusMatch[1])
				if (req.method === 'PUT') return sendJson(res, 200, await store.upsertCampus({ ...(await readBody(req)), id }))
				if (req.method === 'DELETE') {
					await store.deleteCampus(id)
					return sendJson(res, 200, { ok: true })
				}
			}

			if (p === '/api/blackout') {
				if (req.method === 'GET') return sendJson(res, 200, store.config.blackout)
				if (req.method === 'PUT') return sendJson(res, 200, await store.setBlackout(await readBody(req)))
			}

			if (p === '/api/config/export' && req.method === 'GET') {
				const stamp = new Date().toISOString().slice(0, 10)
				res.writeHead(200, {
					'Content-Type': 'application/json; charset=utf-8',
					'Content-Disposition': `attachment; filename="timer-sync-${stamp}.json"`,
					'Cache-Control': 'no-store',
				})
				return res.end(JSON.stringify(store.exportConfig(), null, '\t'))
			}
			if (p === '/api/config/import' && req.method === 'POST') {
				const { config, parts } = await readBody(req)
				try {
					return sendJson(res, 200, await store.importConfig(config, parts))
				} catch (err) {
					return sendJson(res, 400, { error: err.message })
				}
			}
			if (p === '/api/config/backup' && req.method === 'GET') {
				const backup = await store.readBackup()
				return sendJson(res, 200, backup ? { exportedAt: backup.exportedAt, campuses: backup.campuses.map((c) => c.name), config: backup } : null)
			}
			if (p === '/api/config/undo' && req.method === 'POST') {
				try {
					return sendJson(res, 200, await store.undoImport())
				} catch (err) {
					return sendJson(res, 400, { error: err.message })
				}
			}

			if (p === '/api/diagnostics' && req.method === 'GET') return sendJson(res, 200, poller.diagnostics())
			if (p === '/api/logs' && req.method === 'GET') return sendJson(res, 200, logs.slice(0, 300))

			// Setting cues in Resi. The event list and what would be used; ?mode=&pattern=&eventId= previews a choice.
			if (p === '/api/resi/events' && req.method === 'GET') {
				const q = url.searchParams
				const choice = q.has('mode') ? { mode: q.get('mode'), pattern: q.get('pattern') ?? '', eventId: q.get('eventId') ?? '' } : undefined
				const overview = await cueWriter.overview(choice)
				// Companion lists the cue names it can set.
				return sendJson(res, 200, { ...overview, cueTypes: store.config.cues.types.map((t) => t.name), servicePrefix: store.config.cueWriter.servicePrefix })
				// `prefix` is what a cue set now would get (time rule or default).
			}
			// Body { name, prefix?, eventId? }. Sets the cue at "now" in the live event.
			if (p === '/api/cues/set' && req.method === 'POST') {
				try {
					return sendJson(res, 200, await cueWriter.setCue(await readBody(req)))
				} catch (err) {
					return sendJson(res, 409, { error: err.message })
				}
			}
			if (p === '/api/cues/undo' && req.method === 'POST') {
				try {
					return sendJson(res, 200, await cueWriter.undo())
				} catch (err) {
					return sendJson(res, 409, { error: err.message })
				}
			}

			if (p === '/api/test-cue' && req.method === 'POST') {
				const { name, cues } = await readBody(req)
				const settings = cues ? normalizeCueSettings(cues) : store.config.cues
				const matcher = new CueMatcher(settings)
				return sendJson(res, 200, {
					...splitPrefix(name),
					matches: matcher.classify(name, settings.types),
				})
			}

			// Cues in the loaded events, classified with the given (unsaved) cue settings or the saved ones.
			if (p === '/api/cue-preview' && req.method === 'POST') {
				const { cues } = await readBody(req)
				await poller.rescanning
				return sendJson(res, 200, poller.cuePreview(cues ? normalizeCueSettings(cues) : store.config.cues))
			}

			if ((p === '/api/rescan' || p === '/api/rediscover') && req.method === 'POST') {
				await poller.rescan()
				return sendJson(res, 200, poller.cuePreview())
			}

			if (isDisplay) return serveStatic('/display.html', res)
			if (req.method === 'GET') return serveStatic(p, res)
			sendJson(res, 404, { error: 'Not found' })
		} catch (err) {
			sendJson(res, 500, { error: err.message })
		}
	})

	server.listen(port, () => console.log(`Streaming Timer Sync listening on http://0.0.0.0:${port}`))
	return server
}

async function serveStatic(p, res) {
	const rel = p === '/' ? 'index.html' : p.replace(/^\/+/, '')
	const file = path.resolve(PUBLIC_DIR, rel)
	if (!file.startsWith(PUBLIC_DIR)) return sendJson(res, 403, { error: 'Forbidden' })
	try {
		const s = await stat(file)
		if (!s.isFile()) throw new Error('not a file')
		res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-cache' })
		createReadStream(file).pipe(res)
	} catch {
		sendJson(res, 404, { error: 'Not found' })
	}
}
