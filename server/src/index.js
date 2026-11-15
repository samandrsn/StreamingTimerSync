import path from 'node:path'
import { ConfigStore } from './config-store.js'
import { startHttp, VERSION } from './http.js'
import { Poller } from './poller.js'
import { CompanionPusher } from './push.js'
import { ResiClient } from './resi/client.js'

const DATA_DIR = path.resolve(process.env.DATA_DIR || './data')
const PORT = Number(process.env.PORT) || 7374
const LOG_DEBUG = process.env.LOG_LEVEL === 'debug'

const logs = []
function log(level, message) {
	if (level === 'debug' && !LOG_DEBUG) return
	const entry = { at: new Date().toISOString(), level, message }
	logs.unshift(entry)
	logs.length = Math.min(logs.length, 500)
	console.log(`${entry.at} [${level}] ${message}`)
}

const store = new ConfigStore(DATA_DIR)
await store.load()

const client = new ResiClient(() => store.config, log)
const poller = new Poller({ store, client, log })
const pusher = new CompanionPusher(store, log)
poller.onTimers((timers) => pusher.push(timers))

let lastResi = JSON.stringify(store.config.resi)
let lastCues = JSON.stringify(store.config.cues)
store.onChange((config) => {
	const cues = JSON.stringify(config.cues)
	if (cues !== lastCues) {
		lastCues = cues
		log('info', 'Cue names changed — rescanning loaded events')
		poller.rescan().catch((err) => log('warn', `Rescan failed: ${err.message}`))
	}
	const resi = JSON.stringify(config.resi)
	if (resi !== lastResi) {
		lastResi = resi
		log('info', 'Resi settings changed — reconnecting')
		poller.reset()
	}
})

poller.start()
log('info', `Streaming Timer Sync ${VERSION}`)
startHttp({ port: PORT, store, poller, client, pusher, logs, adminPassword: process.env.ADMIN_PASSWORD || '' })

for (const sig of ['SIGINT', 'SIGTERM']) {
	process.on(sig, () => {
		poller.stop()
		process.exit(0)
	})
}
