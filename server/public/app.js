const $ = (sel, root = document) => root.querySelector(sel)
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)]
const esc = (s) =>
	String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

async function api(path, options = {}) {
	const res = await fetch(path, {
		...options,
		headers: { 'Content-Type': 'application/json', ...(options.headers ?? {}) },
		body: options.body ? JSON.stringify(options.body) : undefined,
	})
	const body = await res.json().catch(() => ({}))
	if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`)
	return body
}

let flashTimer = null
function flash(message, err = false) {
	const el = $('#flash')
	el.textContent = message
	el.className = `flash${err ? ' err' : ''}`
	clearTimeout(flashTimer)
	flashTimer = setTimeout(() => el.classList.add('out'), err ? 8000 : 3500)
}

// Estimated lengths are stored as minutes (42.5 = 42:30) and typed as minutes ("45"),
// m:ss ("5:30") or h:mm:ss ("1:05:00").
function parseEst(text) {
	const s = String(text ?? '').trim()
	if (!s) return null
	const m = s.match(/^(\d+)(?::([0-5]\d))?(?::([0-5]\d))?$/)
	if (!m) return NaN
	const [h, min, sec] = m[3] !== undefined ? [m[1], m[2], m[3]] : [0, m[1], m[2] ?? 0]
	const total = Number(h) * 60 + Number(min) + Number(sec) / 60
	return total > 0 ? total : NaN
}
const pad2 = (n) => String(n).padStart(2, '0')
const estParts = (min) => {
	const sec = Math.round(Number(min) * 60)
	return [Math.floor(sec / 3600), Math.floor(sec / 60) % 60, sec % 60]
}
/** For an input box: "45", "5:30" or "1:05:00". */
function estField(min) {
	if (min == null || min === '') return ''
	const [h, m, s] = estParts(min)
	if (h) return `${h}:${pad2(m)}:${pad2(s)}`
	return s ? `${m}:${pad2(s)}` : String(m)
}
/** For reading: "45 min", "5:30" or "1:05:00". */
function fmtEst(min) {
	const [h, m, s] = estParts(min)
	if (h) return `${h}:${pad2(m)}:${pad2(s)}`
	return s ? `${m}:${pad2(s)}` : `${m} min`
}

function fmtPos(sec) {
	if (sec === null || sec === undefined || !Number.isFinite(sec)) return ''
	const s = Math.max(0, Math.floor(sec))
	return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
}
function fmtAgo(iso) {
	const t = Date.parse(iso)
	if (!Number.isFinite(t)) return '—'
	const s = Math.round((Date.now() - t) / 1000)
	if (s < 60) return `${Math.max(0, s)}s ago`
	if (s < 3600) return `${Math.round(s / 60)} min ago`
	if (s < 86400) return `${Math.round(s / 3600)} h ago`
	return new Date(t).toLocaleDateString()
}
const fmtOffset = (sec) => `${sec > 0 ? '+' : sec < 0 ? '−' : '±'}${Math.abs(sec)}s`
const splitList = (v) => String(v ?? '').split(',').map((x) => x.trim()).filter(Boolean)
const typeLabel = (name) => `<b>${esc(name)}</b>`
const orList = (names) =>
	names.length <= 1 ? names.map(typeLabel).join('') : `${names.slice(0, -1).map(typeLabel).join(', ')} or ${typeLabel(names.at(-1))}`

const STATE = {
	offline: ['Offline', 'pending'],
	no_event: ['No event', 'pending'],
	no_cues: ['Loading cues', 'pending'],
	waiting: ['Waiting', ''],
	counting: ['Counting', ''],
	overtime: ['Over', 'urgent'],
	ended: ['Done', ''],
}

let settings = null
let campuses = []
let decoders = []

// ---------- views ----------
const VIEWS = ['live', 'companion', 'venues', 'show', 'settings', 'diagnostics']
// Pages that moved: old bookmarks still land in the right place.
const MOVED = { connection: 'settings', backup: 'settings', campuses: 'venues', countdown: 'show', cues: 'show' }
let currentView = null
function showView() {
	const asked = location.hash.slice(1)
	if (MOVED[asked]) return history.replaceState(null, '', `#${MOVED[asked]}`), showView()
	const name = VIEWS.includes(asked) ? asked : 'live'
	if (currentView === 'show' && name !== 'show' && cuesDirty) {
		if (!confirm('You have unsaved changes on Cues. Leave without saving them?')) {
			history.replaceState(null, '', '#show')
			return
		}
		cuesDirty = false
	}
	currentView = name
	$$('[data-page]').forEach((p) => (p.hidden = p.dataset.page !== name))
	$$('.view').forEach((a) => a.classList.toggle('on', a.dataset.view === name))
	if (name === 'companion') renderCompanion(lastTimers)
	if (name === 'venues') loadCampuses()
	if (['show', 'settings'].includes(name)) loadSettings()
	if (name === 'diagnostics') refreshDiagnostics()
	if (name === 'settings') loadBackup()
}
window.addEventListener('hashchange', showView)

// ---------- connection pill ----------
function setConn(ok, msg) {
	const el = $('#conn')
	el.className = `conn ${ok ? 'ok' : 'bad'}`
	el.title = msg
	el.firstElementChild.textContent = msg
}
async function pollStatus() {
	try {
		const s = await api('api/status')
		$('#version').textContent = s.version ? `v${s.version}` : ''
		setConn(s.ok, s.ok ? 'Connected to Resi' : `Resi: ${s.message}`)
		if (!$('[data-page="settings"]').hidden) await refreshDecoders()
		const tag = $('#login-tag')
		tag.className = `tag ${s.ok ? 'open' : 'urgent'}`
		tag.textContent = s.ok ? 'Connected' : 'Not connected'
		$('#login-detail').textContent = s.ok ? `${decoders.length} decoder${decoders.length === 1 ? '' : 's'} found` : s.message || ''
	} catch (err) {
		setConn(false, err.message)
	}
}
async function refreshDecoders() {
	try {
		decoders = (await api('api/diagnostics')).decoders
	} catch {
		// keep the last list
	}
}
const decoderName = (serial) => decoders.find((d) => d.serialNumber === serial)?.userName ?? serial

// ---------- live ----------
/** Known (a real cue) vs estimated (fallback length, no target cue yet). Only shown while counting. */
function sourceTag(t) {
	if (!['counting', 'overtime'].includes(t.state)) return ''
	return t.estimated ? '<span class="tag busy" title="No target cue yet: counting the fallback length">Estimate</span>' : '<span class="tag open" title="Counting to a real cue">Cue</span>'
}

function renderLive(timers, blackout) {
	renderBlackoutAll(blackout)
	$('#live-empty').hidden = timers.length > 0
	const grid = $('#live-grid')
	const ids = new Set(timers.map((t) => t.campusId))
	$$('.timer', grid).forEach((el) => !ids.has(el.dataset.id) && el.remove())

	for (const t of timers) {
		let el = $(`.timer[data-id="${t.campusId}"]`, grid)
		if (!el) {
			// The buttons live outside the parts re-rendered every tick, so clicks aren't lost.
			el = document.createElement('section')
			el.dataset.id = t.campusId
			el.innerHTML = `<div class="part top"></div>
				<div class="timer-foot">
					<div class="foot-row"><span class="foot-label">Offset <b class="offset-value"></b></span>
						<span class="actions"><button class="btn small" data-nudge="-1" data-campus="${esc(t.campusId)}" title="Add a second to the clock">−1s</button><button class="btn small" data-nudge="1" data-campus="${esc(t.campusId)}" title="Take a second off the clock">+1s</button></span></div>
					<div class="foot-row foot-buttons"><span class="actions"><button class="btn small" data-reload-venue data-slug="${esc(t.slug)}" title="Load the stage display page again on this venue's screens"><svg class="i"><use href="#i-sync"/></svg><span>Reload</span></button><button class="btn small blackout-btn" data-blackout data-campus="${esc(t.campusId)}"><svg class="i"><use href="#i-eye-off"/></svg><span></span></button></span></div>
				</div>
				<div class="part bottom"></div>`
			grid.appendChild(el)
		}
		el.className = `card timer ${t.state}${t.estimated ? ' estimated' : ''}${t.blackout ? ' blackout' : ''}`
		const own = !!blackout?.campuses?.includes(t.campusId)
		const all = !!blackout?.all
		// Lit while this screen is black; it switches between black out and show.
		const btn = $('[data-blackout]', el)
		$('span', btn).textContent = all ? 'All black' : own ? 'Show screen' : 'Black out'
		btn.dataset.on = own ? '0' : '1'
		btn.classList.toggle('on', !!t.blackout)
		btn.disabled = all
		btn.title = all ? 'Every screen is black. Use “Bring screens back” at the top.' : own ? 'Show the clock on this venue’s screens again' : 'Make this venue’s stage display black'
		btn.setAttribute('aria-pressed', String(!!t.blackout))
		const open = lastScreens[t.slug] ?? 0
		const [label, cls] = STATE[t.state] ?? [t.state, '']
		const target =
			t.targetSource === 'cue'
				? `${esc(t.targetCueName)} <span class="quiet">at ${fmtPos(t.targetPositionSec)}</span>`
				: t.targetSource === 'default'
					? `<span title="${esc(fmtEst(t.estimateMinutes ?? t.sermonMinutes))} after ${esc(t.estimateFrom || 'the start')}, no cue yet">${esc(t.targetType || 'target')} <span class="quiet">· estimate</span></span>`
					: `<span class="quiet">${t.endCues.map(esc).join(' / ') || '—'}</span>`
		// Every card shows the same five lines, so cards line up whatever state they're in.
		const row = (dt, dd, empty = '—') => `<div><dt>${dt}</dt><dd>${dd || `<span class="quiet">${empty}</span>`}</dd></div>`
		// Between services the last service's target is history, not what's next.
		const active = ['counting', 'overtime', 'ended'].includes(t.state)
		const next = t.state === 'waiting' ? `Next ${esc(t.startCue)} cue` : ''
		const set = (part, html) => {
			const node = $(`.part.${part}`, el)
			if (node.innerHTML !== html) node.innerHTML = html
		}
		$('.offset-value', el).textContent = fmtOffset(t.offsetSec ?? 0)
		set(
			'top',
			`<div class="timer-head"><h2>${esc(t.campusName)}</h2><span>${
				// One tag: what matters most right now. The clock itself shows it's counting.
				t.blackout ? '<span class="tag urgent">Screen black</span>' : t.state === 'counting' ? sourceTag(t) : `<span class="tag ${cls}">${label}</span>`
			}</span></div>
			<div class="clock${t.display ? '' : ' blank'}">${t.estimated ? '<span class="tilde">~</span>' : ''}${esc(t.display) || '–:––'}</div>
			<dl class="readout">
				${row(active ? 'Counting to' : 'Waiting for', active ? target : next)}
				${row('Into it', active ? esc(t.elapsedDisplay) : '', '–:––')}
				${row('Playhead', t.playheadDisplay ? `${esc(t.playheadDisplay)}${t.stale ? ' <span class="urgent-text">(stale)</span>' : ''}` : '', '–:––')}
				${row('Event', t.cueError ? `<span class="urgent-text" title="${esc(t.cueError)}">Cues: ${esc(t.cueError)}</span>` : t.eventName || t.eventId ? `<span title="${esc(t.eventId)}">${esc(t.eventName || t.eventId)}</span>` : '')}
				${row('Decoder', t.decoderSerial ? `${esc(decoderName(t.decoderSerial))} <span class="quiet">· ${esc(t.decoderStatus)}</span>` : '<span class="quiet">None assigned</span>')}
			</dl>`,
		)
		set(
			'bottom',
			`<span class="display-link"><a href="${esc(t.slug)}" target="_blank" rel="noopener">Stage display <span class="mono">/${esc(t.slug)}</span></a> <span class="screens">· ${open ? `${open} open` : 'not open'}</span></span>
			<a class="display-link" href="#companion">Companion variables</a>`,
		)
	}
}

// ---------- companion ----------
function renderCompanion(timers) {
	if ($('[data-page="companion"]').hidden) return
	$('#companion-empty').hidden = timers.length > 0
	const v = (slug, name) => `<code>$(streaming-timer-sync:${esc(slug)}_${name})</code>`
	const row = (label, value, code, est) => `<div class="var-row${est ? ' estimated' : ''}"><span>${label}</span><b>${value}</b>${code}</div>`
	const html = timers
		.map(
			(t) => `<section class="card timer"><div class="timer-head"><h2>${esc(t.campusName)}</h2><span class="tag">${esc(t.slug)}</span></div>
			<div class="vars">
				${row('Next target', `${t.estimated ? '~' : ''}${esc(t.display) || '–'}`, v(t.slug, 'remaining'), t.estimated)}
				${row('State', esc(t.state), v(t.slug, 'state'))}
				${row('Estimated (1/0)', t.estimated ? '1' : '0', v(t.slug, 'estimated'))}
				${(t.targets ?? []).map((x) => row(`${esc(x.name)} ${sourceTag(x)}`, `${x.estimated ? '~' : ''}${esc(x.display) || '–'}`, v(t.slug, `${x.key}_remaining`), x.estimated)).join('')}
			</div></section>`,
		)
		.join('')
	const grid = $('#companion-grid')
	if (grid.innerHTML !== html) grid.innerHTML = html
}

$('#live-grid').addEventListener('click', async (e) => {
	const btn = e.target.closest('[data-reload-venue]')
	if (!btn) return
	btn.disabled = true
	try {
		const r = await api('api/displays/reload', { method: 'POST', body: { slug: btn.dataset.slug } })
		const name = lastTimers.find((t) => t.slug === btn.dataset.slug)?.campusName ?? 'Venue'
		flash(r.screens ? `Reloading ${name}: ${r.screens} screen${r.screens === 1 ? '' : 's'}` : `${name} has no screens open`)
	} catch (err) {
		flash(err.message, true)
	} finally {
		setTimeout(() => (btn.disabled = false), 2000)
	}
})
$('#reload-screens').addEventListener('click', async (e) => {
	e.currentTarget.disabled = true
	try {
		const r = await api('api/displays/reload', { method: 'POST' })
		flash(r.screens ? `Reloading ${r.screens} screen${r.screens === 1 ? '' : 's'}` : 'No stage displays are open')
	} catch (err) {
		flash(err.message, true)
	} finally {
		setTimeout(() => ($('#reload-screens').disabled = false), 3000)
	}
})

// −1s / +1s on a Live card: adjust that venue's offset while comparing against Studio.
$('#live-grid').addEventListener('click', async (e) => {
	const btn = e.target.closest('[data-nudge]')
	if (!btn) return
	btn.disabled = true
	try {
		const all = await api('api/campuses')
		const c = all.find((x) => x.id === btn.dataset.campus)
		const t = lastTimers.find((x) => x.campusId === c.id)
		const offsetSec = Math.round(((t?.offsetSec ?? 0) + Number(btn.dataset.nudge)) * 10) / 10
		await api(`api/campuses/${c.id}`, { method: 'PUT', body: { ...c, positionOffsetSec: offsetSec } })
		flash(`${c.name} clock offset ${fmtOffset(offsetSec)}`)
	} catch (err) {
		flash(err.message, true)
	} finally {
		btn.disabled = false
	}
})

// ---------- blackout ----------
let lastBlackout = null
function renderBlackoutAll(blackout) {
	lastBlackout = blackout
	const on = !!blackout?.all
	$('#blackout-banner').hidden = !on
	$('#blackout-all').hidden = on
}
async function setBlackout(body, message) {
	try {
		renderLive(lastTimers, await api('api/blackout', { method: 'PUT', body }))
		flash(message)
	} catch (err) {
		flash(err.message, true)
	}
}
$('#blackout-all').addEventListener('click', () => setBlackout({ all: true }, 'All stage displays are black'))
$('#blackout-all-off').addEventListener('click', () => setBlackout({ all: false }, 'Stage displays are back'))
$('#live-grid').addEventListener('click', (e) => {
	const btn = e.target.closest('[data-blackout]')
	if (!btn) return
	const on = btn.dataset.on === '1'
	const name = lastTimers.find((t) => t.campusId === btn.dataset.campus)?.campusName ?? 'Venue'
	setBlackout({ campusId: btn.dataset.campus, on }, on ? `${name} stage display is black` : `${name} stage display is back`)
})

let lastTimers = []
let lastScreens = {}
function connectStream() {
	const es = new EventSource('api/stream')
	es.onmessage = (e) => {
		const data = JSON.parse(e.data)
		lastScreens = data.screens ?? {}
		renderLive((lastTimers = data.timers), data.blackout)
		renderCompanion(lastTimers)
	}
	es.onerror = () => setConn(false, 'Lost connection to the server')
}

// ---------- campuses ----------
async function loadCampuses() {
	;[campuses, settings] = await Promise.all([api('api/campuses'), api('api/settings'), refreshDecoders()])
	const c = settings.cues
	$('#campus-rows').innerHTML =
		campuses
			.map((x, i) => {
				const start = x.startCue || c.start
				const targets = x.endCues.length ? x.endCues : c.targets
				const custom = x.startCue || x.endCues.length || x.sermonMinutes
				const out = x.companion?.url
					? `Push to ${esc(x.companion.url)}${x.pushStatus ? (x.pushStatus.ok ? '' : ` <span class="urgent-text" title="${esc(x.pushStatus.message)}">failing</span>`) : ''}`
					: 'Companion module'
				return `<tr${x.enabled ? '' : ' class="inactive"'}>
					<td class="order-cell"><span class="move"><button class="btn small" data-move="-1" data-campus="${x.id}" aria-label="Move ${esc(x.name)} up" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn small" data-move="1" data-campus="${x.id}" aria-label="Move ${esc(x.name)} down" ${i === campuses.length - 1 ? 'disabled' : ''}>▼</button></span></td>
					<td><b>${esc(x.name)}</b>${x.enabled ? '' : ' <span class="tag pending">Off</span>'}<span class="sub"><a href="${esc(x.slug)}" target="_blank" rel="noopener" class="mono">/${esc(x.slug)}</a></span></td>
					<td>${x.decoders.map((s) => `${esc(decoderName(s))}<span class="sub mono">${esc(s)}</span>`).join('') || '<span class="quiet">None</span>'}</td>
					<td>${esc(start)} → ${targets.map(esc).join(' / ') || '<span class="quiet">no target</span>'}
						<span class="sub">${fmtEst(x.sermonMinutes ?? settings.defaultSermonMinutes)} if no target${custom ? '' : ' · default'} · offset ${fmtOffset(x.positionOffsetSec ?? settings.positionOffsetSec ?? 0)}</span></td>
					<td>${out}</td>
					<td class="actions-cell"><button class="btn small" data-edit="${x.id}">Edit</button></td>
				</tr>`
			})
			.join('') || `<tr><td colspan="6" class="quiet">No venues yet. Use “Add venue” to set up the first one.</td></tr>`
}

function renderCampusTargets(selected) {
	const f = $('#campus-form')
	const start = f.startCue.value || settings.cues.start
	const names = settings.cues.types.map((t) => t.name).filter((n) => n !== start)
	for (const s of selected) if (!names.includes(s) && s !== start) names.push(s)
	$('#target-choices').innerHTML = names
		.map((n) => `<label class="check"><input type="checkbox" name="target" value="${esc(n)}" ${selected.includes(n) ? 'checked' : ''}>${esc(n)}</label>`)
		.join('')
	$('#target-choices').nextElementSibling.textContent = `None ticked uses the default: ${settings.cues.targets.join(' or ') || 'none'}.`
}

function openCampusForm(campus) {
	const f = $('#campus-form')
	f.hidden = false
	$('#campus-form-title').textContent = campus ? campus.name : 'New venue'
	$('#delete-campus').hidden = !campus
	f.campusId.value = campus?.id ?? ''
	f.campusName.value = campus?.name ?? ''
	f.slug.value = campus?.slug ?? ''
	f.enabled.checked = campus?.enabled ?? true
	f.sermonMinutes.value = estField(campus?.sermonMinutes)
	f.sermonMinutes.placeholder = `Default (${estField(settings.defaultSermonMinutes)})`
	f.positionOffsetSec.value = campus?.positionOffsetSec ?? ''
	f.positionOffsetSec.placeholder = `Default (${fmtOffset(settings.positionOffsetSec || 0)})`
	f.companionUrl.value = campus?.companion?.url ?? ''
	f.variablePrefix.value = campus?.companion?.variablePrefix ?? ''

	const types = settings.cues.types.map((t) => t.name)
	if (campus?.startCue && !types.includes(campus.startCue)) types.push(campus.startCue)
	f.startCue.innerHTML =
		`<option value="">Default (${esc(settings.cues.start)})</option>` + types.map((n) => `<option value="${esc(n)}">${esc(n)}</option>`).join('')
	f.startCue.value = campus?.startCue ?? ''
	renderCampusTargets(campus?.endCues ?? [])

	const selected = new Set(campus?.decoders ?? [])
	const all = [...new Set([...decoders.map((d) => d.serialNumber), ...selected])]
	const taken = new Map(campuses.filter((c) => c.id !== campus?.id).flatMap((c) => c.decoders.map((s) => [s, c.name])))
	$('#decoder-choices').innerHTML =
		all
			.map((s) => {
				const d = decoders.find((x) => x.serialNumber === s)
				const note = [s, d?.status ?? 'not seen', taken.has(s) ? `also ${taken.get(s)}` : ''].filter(Boolean).join(' · ')
				return `<label class="check"><input type="checkbox" name="decoder" value="${esc(s)}" ${selected.has(s) ? 'checked' : ''}><span>${esc(d?.userName ?? s)}<span class="sub">${esc(note)}</span></span></label>`
			})
			.join('') || '<span class="quiet">No decoders found yet. Check the Resi login in <a href="#settings">Settings</a>.</span>'
	updateCampusHints()
	f.campusName.focus()
	f.scrollIntoView({ behavior: 'smooth', block: 'start' })
}

const targetKey = (name) => String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'target'
function slugify(v) {
	return String(v ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}
function updateCampusHints() {
	const f = $('#campus-form')
	$('#slug-preview').textContent = `$(streaming-timer-sync:${slugify(f.slug.value || f.campusName.value) || 'venue'}_remaining)`
	const prefix = slugify(f.variablePrefix.value) || 'resi_timer'
	const targets = $$('input[name=target]:checked', f).map((i) => i.value)
	const keys = (targets.length ? targets : settings.cues.targets).map(targetKey)
	const names = [
		...['remaining', 'remaining_seconds', 'state', 'target', 'elapsed', 'event'].map((v) => `${prefix}_${v}`),
		...keys.flatMap((k) => ['remaining', 'remaining_seconds', 'state'].map((v) => `${prefix}_${k}_${v}`)),
	]
	$('#push-vars').textContent = `Variables: ${names.join(', ')}`
}
$('#campus-form').addEventListener('input', (e) => {
	if (['campusName', 'slug', 'variablePrefix'].includes(e.target.name)) updateCampusHints()
})
$('#campus-form').startCue.addEventListener('change', () => {
	renderCampusTargets($$('input[name=target]:checked').map((i) => i.value))
	updateCampusHints()
})
$('#target-choices').addEventListener('change', updateCampusHints)

$('#add-campus').addEventListener('click', async () => {
	await loadCampuses()
	openCampusForm(null)
})
$('#cancel-campus').addEventListener('click', () => ($('#campus-form').hidden = true))
$('#campus-rows').addEventListener('click', async (e) => {
	const edit = e.target.closest('[data-edit]')
	if (edit) openCampusForm(campuses.find((c) => c.id === edit.dataset.edit))
	const move = e.target.closest('[data-move]')
	if (!move) return
	const ids = campuses.map((c) => c.id)
	const from = ids.indexOf(move.dataset.campus)
	const to = from + Number(move.dataset.move)
	if (to < 0 || to >= ids.length) return
	;[ids[from], ids[to]] = [ids[to], ids[from]]
	try {
		await api('api/campuses/order', { method: 'PUT', body: { ids } })
		await loadCampuses()
		$(`[data-move="${move.dataset.move}"][data-campus="${move.dataset.campus}"]`)?.focus()
	} catch (err) {
		flash(err.message, true)
	}
})
$('#delete-campus').addEventListener('click', async () => {
	const f = $('#campus-form')
	const c = campuses.find((x) => x.id === f.campusId.value)
	if (!c || !confirm(`Delete ${c.name}? Its Companion variables stop updating.`)) return
	await api(`api/campuses/${c.id}`, { method: 'DELETE' })
	f.hidden = true
	flash(`${c.name} deleted`)
	loadCampuses()
})
$('#campus-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	const f = e.target
	const body = {
		id: f.campusId.value || undefined,
		name: f.campusName.value,
		slug: f.slug.value,
		enabled: f.enabled.checked,
		decoders: $$('input[name=decoder]:checked', f).map((i) => i.value),
		startCue: f.startCue.value || null,
		endCues: $$('input[name=target]:checked', f).map((i) => i.value),
		sermonMinutes: parseEst(f.sermonMinutes.value) || null,
		positionOffsetSec: f.positionOffsetSec.value === '' ? null : Number(f.positionOffsetSec.value),
		companion: { url: f.companionUrl.value, variablePrefix: f.variablePrefix.value },
	}
	try {
		await api(body.id ? `api/campuses/${body.id}` : 'api/campuses', { method: body.id ? 'PUT' : 'POST', body })
		f.hidden = true
		flash(`${body.name} saved`)
		loadCampuses()
	} catch (err) {
		flash(err.message, true)
	}
})

// ---------- settings forms ----------
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj)
function setPath(obj, path, value) {
	const keys = path.split('.')
	let o = obj
	for (const k of keys.slice(0, -1)) o = o[k] ??= {}
	o[keys.at(-1)] = value
}

async function loadSettings() {
	settings = await api('api/settings')
	for (const form of $$('form[data-settings]')) {
		for (const el of form.elements) {
			if (!el.name || el.name === 'target' || el.name === 'est' || el.name === 'estimate-from') continue
			const v = getPath(settings, el.name)
			if (el.type === 'checkbox') el.checked = !!v
			else if (el.type === 'password') {
				el.value = ''
				const has = el.name === 'resi.password' ? settings.resi.hasPassword : settings.resi.hasManualToken
				el.placeholder = has ? 'Saved. Leave blank to keep it.' : 'Not set'
			} else if ('duration' in el.dataset) el.value = estField(v)
			else if (el.tagName !== 'SELECT' || el.name !== 'cues.start') el.value = v ?? ''
		}
	}
	renderShow(rowsFromSettings())
	$('#synonyms').value = settings.cues.synonyms.map((g) => g.join(', ')).join('\n')
	runCueTest()
	if (!$('[data-page="show"]').hidden) refreshPreview()
}

/** Collect a settings form's named fields into a patch object. */
function formPatch(form) {
	const patch = {}
	for (const el of form.elements) {
		if (!el.name || el.name === 'target' || el.name === 'est' || el.name === 'estimate-from') continue
		let v = el.type === 'checkbox' ? el.checked : el.value
		if (el.type === 'number') v = Number(v)
		if ('duration' in el.dataset) v = parseEst(v)
		if (el.type === 'password' && !v) continue
		setPath(patch, el.name, v)
	}
	return patch
}

async function saveSettings(patch, label) {
	try {
		settings = await api('api/settings', { method: 'PUT', body: patch })
		flash(`${label} saved`)
		await loadSettings()
	} catch (err) {
		flash(err.message, true)
	}
}

// ---------- run of show ----------
// One list in service order. Each row is a cue type: its name, what it does in the countdown
// (starts the clock, is counted down to, or is only recognised), its length, and the phrases
// that match it. Rows keep the name they were saved under (`orig`, '' for new rows) so a rename
// carries through to venue overrides.
const ROLES = [
	['start', 'Starts the clock'],
	['target', 'Count down to'],
	['skip', "Don't count"],
]
const durationAttrs = `inputmode="decimal" autocomplete="off" pattern="\\d+(:[0-5]\\d){0,2}" title="Estimated length: minutes (45), minutes:seconds (5:30) or hours:minutes:seconds (1:05:00)"`

function typeUses(name) {
	const local = campuses.filter((c) => c.startCue === name || c.endCues.includes(name)).map((c) => c.name)
	return local.length ? `Changed for ${local.join(', ')}` : ''
}

function rowHtml(t) {
	const lengthOff = t.role === 'skip' || t.before || t.last
	return `<div class="show-row role-${t.role}${t.before ? ' before' : ''}" role="listitem" data-orig="${esc(t.orig)}">
		<button type="button" class="grip" aria-label="Move ${esc(t.name || 'this cue')}. Drag, or use the up and down arrow keys." title="Drag to reorder"></button>
		<div class="show-main">
			<div class="show-line">
				<input class="t-name" value="${esc(t.name)}" placeholder="Cue name, e.g. VIDEO START" aria-label="Cue name">
				<select class="t-role" aria-label="${esc(t.name || 'Cue')} role">${ROLES.map(([v, l]) => `<option value="${v}"${v === t.role ? ' selected' : ''}>${l}</option>`).join('')}</select>
				<label class="len"><span>Est. length</span><input class="t-len" ${durationAttrs} value="${esc(estField(t.length))}" placeholder="${t.last ? '–' : esc(estField(settings.defaultSermonMinutes))}" title="${t.last ? 'The last cue counted: nothing comes after it, so it needs no length' : ''}" aria-label="${esc(t.name || 'Cue')} estimated length: minutes, m:ss or h:mm:ss" ${lengthOff ? 'disabled' : ''}></label>
				<button type="button" class="btn ghost danger small t-del" aria-label="Remove ${esc(t.name || 'this cue')}" title="Remove this cue" ${t.role === 'start' ? 'disabled' : ''}><svg class="i"><use href="#i-x"/></svg></button>
			</div>
			<div class="show-match">
				<label><span>Also matches</span><input class="t-aliases" value="${esc(t.aliases.join(', '))}" placeholder="Other ways it's typed, comma-separated" aria-label="${esc(t.name || 'Cue')} phrases"></label>
				<label><span>Unless it contains</span><input class="t-exclude" value="${esc(t.exclude.join(', '))}" placeholder="Words that rule it out" aria-label="${esc(t.name || 'Cue')} exclude words"></label>
			</div>
			${t.before ? '<p class="show-note">Before the start cue, so it isn’t counted.</p>' : t.orig && typeUses(t.orig) ? `<p class="show-note">${esc(typeUses(t.orig))}</p>` : ''}
		</div>
	</div>`
}

/** Mark rows above the start cue (they happen before the countdown begins) and the last counted cue (nothing follows it, so its length isn't used). */
function withBefore(rows) {
	const startAt = rows.findIndex((r) => r.role === 'start')
	const marked = rows.map((r, i) => ({ ...r, before: startAt >= 0 && i < startAt }))
	const last = marked.findLastIndex((r) => r.role === 'target' && !r.before)
	if (last >= 0) marked[last].last = true
	return marked
}

function renderShow(rows) {
	$('#type-list').innerHTML = withBefore(rows).map(rowHtml).join('')
	updateShowSummary()
}

function rowsFromSettings() {
	const c = settings.cues
	return c.types.map((t) => ({
		orig: t.name,
		name: t.name,
		aliases: t.aliases,
		exclude: t.exclude,
		role: t.name === c.start ? 'start' : c.targets.includes(t.name) ? 'target' : 'skip',
		length: c.estimates?.[t.name] ?? null,
	}))
}

const readTypes = () =>
	$$('#type-list .show-row').map((row) => ({
		orig: row.dataset.orig,
		name: $('.t-name', row).value.trim(),
		aliases: splitList($('.t-aliases', row).value),
		exclude: splitList($('.t-exclude', row).value),
		role: $('.t-role', row).value,
		length: parseEst($('.t-len', row).value),
	}))

function updateShowSummary() {
	const rows = withBefore(readTypes().filter((r) => r.name))
	const start = rows.find((r) => r.role === 'start')
	const fallback = parseEst($('#show-form').defaultSermonMinutes.value) || settings?.defaultSermonMinutes || 45
	const targets = rows.filter((r) => r.role === 'target' && !r.before)
	if (!start) return ($('#show-summary').innerHTML = '<span class="urgent-text">Choose a cue that starts the clock.</span>')
	if (!targets.length) return ($('#show-summary').innerHTML = `The clock starts at ${typeLabel(start.name)} but no cue after it is counted down to.`)
	const len = (r) => `<span class="len-chip">${fmtEst(r.length || fallback)}</span>`
	$('#show-summary').innerHTML = `${typeLabel(start.name)} ${len(start)} → ${targets
		.map((r, i) => `${typeLabel(r.name)}${i < targets.length - 1 ? ` ${len(r)}` : ''}`)
		.join(' → ')}`
}

// Picking "Starts the clock" on one row makes the old start a counted cue.
$('#type-list').addEventListener('change', (e) => {
	if (!e.target.matches('.t-role')) return
	const rows = readTypes()
	const at = $$('#type-list .show-row').indexOf(e.target.closest('.show-row'))
	if (rows[at].role === 'start') rows.forEach((r, i) => i !== at && r.role === 'start' && (r.role = 'target'))
	renderShow(rows)
	$$('#type-list .t-role')[at]?.focus()
})

$('#add-type').addEventListener('click', () => {
	renderShow([...readTypes(), { orig: '', name: '', aliases: [], exclude: [], role: 'target', length: null }])
	cuesDirty = true
	$('#type-list .show-row:last-child .t-name').focus()
})

$('#type-list').addEventListener('click', (e) => {
	const del = e.target.closest('.t-del')
	if (!del) return
	const row = del.closest('.show-row')
	const name = $('.t-name', row).value.trim() || row.dataset.orig
	// A row that was never saved just goes; a saved one is removed for good, right away.
	if (row.dataset.orig && !confirm(`Remove ${name}? Its phrases are deleted and it stops being counted.`)) return
	const at = $$('#type-list .show-row').indexOf(row)
	renderShow(readTypes().filter((_, i) => i !== at))
	runCueTest()
	if (row.dataset.orig) saveShow(`Removed ${name}`)
})

// ---- drag to reorder (mouse, touch and pen), arrow keys on the handle ----
let drag = null
$('#type-list').addEventListener('pointerdown', (e) => {
	const grip = e.target.closest('.grip')
	if (!grip || e.button > 0) return
	e.preventDefault()
	const row = grip.closest('.show-row')
	const box = row.getBoundingClientRect()
	drag = { row, pointer: e.pointerId, offset: e.clientY - box.top, startY: e.clientY }
	grip.setPointerCapture(e.pointerId)
	row.classList.add('dragging')
	$('#type-list').classList.add('sorting')
})
$('#type-list').addEventListener('pointermove', (e) => {
	if (!drag || e.pointerId !== drag.pointer) return
	const list = $('#type-list')
	const others = $$('.show-row', list).filter((r) => r !== drag.row)
	// Drop before the first row whose middle is below the pointer.
	const next = others.find((r) => {
		const b = r.getBoundingClientRect()
		return e.clientY < b.top + b.height / 2
	})
	if (next !== drag.row.nextElementSibling) {
		const before = new Map($$('.show-row', list).map((r) => [r, r.getBoundingClientRect().top]))
		list.insertBefore(drag.row, next ?? null)
		// Slide the rows that moved, so the reorder is easy to follow.
		for (const r of others) {
			const dy = before.get(r) - r.getBoundingClientRect().top
			if (dy) r.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: 160, easing: 'cubic-bezier(.2,.8,.2,1)' })
		}
	}
})
function endDrag() {
	if (!drag) return
	drag.row.classList.remove('dragging')
	$('#type-list').classList.remove('sorting')
	drag = null
	cuesDirty = true
	renderShow(readTypes())
}
$('#type-list').addEventListener('pointerup', endDrag)
$('#type-list').addEventListener('pointercancel', endDrag)
$('#type-list').addEventListener('keydown', (e) => {
	const grip = e.target.closest('.grip')
	const step = e.key === 'ArrowUp' ? -1 : e.key === 'ArrowDown' ? 1 : 0
	if (!grip || !step) return
	e.preventDefault()
	const rows = readTypes()
	const from = $$('#type-list .show-row').indexOf(grip.closest('.show-row'))
	const to = from + step
	if (to < 0 || to >= rows.length) return
	;[rows[from], rows[to]] = [rows[to], rows[from]]
	cuesDirty = true
	renderShow(rows)
	$$('#type-list .grip')[to].focus()
})

function readCueForm() {
	return {
		matchMode: $('#show-form [name="cues.matchMode"]').value,
		types: readTypes().filter((t) => t.name).map(({ name, aliases, exclude }) => ({ name, aliases, exclude })),
		synonyms: $('#synonyms').value.split('\n').map(splitList).filter((g) => g.length > 1),
	}
}

$('#show-form').addEventListener('submit', (e) => {
	e.preventDefault()
	saveShow()
})
async function saveShow(message = 'Cues') {
	const rows = withBefore(readTypes().filter((t) => t.name))
	const upper = rows.map((t) => t.name.toUpperCase())
	if (new Set(upper).size !== upper.length) return flash('Two cues have the same name.', true)
	const start = rows.find((r) => r.role === 'start')
	if (!start) return flash('Choose a cue that starts the clock.', true)
	// Carry renames and removals through to venue overrides.
	const renamed = new Map(rows.filter((t) => t.orig && t.orig !== t.name).map((t) => [t.orig, t.name]))
	const kept = new Set(rows.map((t) => t.orig).filter(Boolean))
	const map = (n) => renamed.get(n) ?? n
	const counted = rows.filter((r) => (r.role === 'start' || r.role === 'target') && !r.before)
	const cues = {
		...readCueForm(),
		start: start.name,
		targets: counted.filter((r) => r.role === 'target').map((r) => r.name),
		estimates: Object.fromEntries(counted.filter((r) => r.length > 0).map((r) => [r.name, r.length])),
		estimateFrom: 'lengths',
	}
	await saveSettings({ ...formPatch($('#show-form')), cues }, message)
	cuesDirty = false
	for (const c of campuses) {
		const startCue = c.startCue && kept.has(c.startCue) ? map(c.startCue) : null
		const endCues = c.endCues.filter((n) => kept.has(n)).map(map)
		if (startCue !== c.startCue || endCues.join() !== c.endCues.join()) {
			await api(`api/campuses/${c.id}`, { method: 'PUT', body: { ...c, startCue, endCues } })
		}
	}
	campuses = await api('api/campuses')
	await rescan()
}

// Leaving the page with unsaved edits would silently drop them, so ask first.
let cuesDirty = false
$('#show-form').addEventListener('input', () => (cuesDirty = true))
window.addEventListener('beforeunload', (e) => {
	if (cuesDirty) e.preventDefault()
})

let preview = null
function renderPreview() {
	if (!preview) return
	const events = preview.events
	const unmatched = preview.cues.filter((c) => !c.matches.length).length
	$('#cue-preview-sub').textContent = events.length
		? `${events.map((e) => e.eventName || 'Unnamed event').join(' · ')}: ${preview.cues.length} cue names, ${unmatched ? `${unmatched} not matched` : 'all matched'}. Updates as you type.`
		: 'No events with cues are loaded on a decoder.'
	$('#cue-preview').innerHTML = preview.cues
		.map(
			(c) => `<div class="row${c.matches.length ? '' : ' none'}"><span title="${esc(c.name)}">${esc(c.name)}${c.count > 1 ? `<span class="quiet">×${c.count}</span>` : ''}</span>
				<span class="tags">${c.matches.map((m) => `<span class="tag open">${esc(m)}</span>`).join('') || '<span class="tag">No match</span>'}</span></div>`,
		)
		.join('')
}
async function refreshPreview() {
	try {
		preview = await api('api/cue-preview', { method: 'POST', body: { cues: readCueForm() } })
		renderPreview()
	} catch (err) {
		$('#cue-preview-sub').textContent = err.message
	}
}
/** Re-read every loaded event from Resi, then show what the saved names match. */
async function rescan() {
	const btn = $('#rescan')
	btn.disabled = true
	try {
		preview = await api('api/rescan', { method: 'POST' })
		renderPreview()
		const unmatched = preview.cues.filter((c) => !c.matches.length).length
		flash(`Rescanned ${preview.events.length} event${preview.events.length === 1 ? '' : 's'}: ${preview.cues.length} cue names, ${unmatched ? `${unmatched} not matched` : 'all matched'}`)
	} catch (err) {
		flash(err.message, true)
	} finally {
		btn.disabled = false
	}
}
$('#rescan').addEventListener('click', rescan)
$('#sort-types').addEventListener('click', async () => {
	await refreshPreview()
	const rows = readTypes()
	const rank = new Map(preview.order.map((n, i) => [n, i]))
	const sorted = rows.map((t, i) => ({ t, i })).sort((a, b) => (rank.get(a.t.name) ?? 1e9 + a.i) - (rank.get(b.t.name) ?? 1e9 + b.i))
	renderShow(sorted.map((x) => x.t))
	cuesDirty = true
	flash(preview.events.length ? 'Ordered like the loaded service. Save to keep it.' : 'No loaded events to order by.')
})

let testTimer = null
async function runCueTest() {
	const name = $('#cue-test').value.trim()
	const out = $('#cue-test-result')
	if (!name) return (out.textContent = 'Type a cue name to see what it counts as.')
	try {
		const r = await api('api/test-cue', { method: 'POST', body: { name, cues: readCueForm() } })
		const service = r.prefix ? `Service <b>${esc(r.prefix)}</b> ·` : 'No service prefix ·'
		out.innerHTML = `${service} ${
			r.matches.length ? `counts as ${r.matches.map((m) => `<span class="tag open">${esc(m)}</span>`).join('')}` : '<span class="urgent-text">matches no cue, so it is ignored</span>'
		}`
	} catch (err) {
		out.textContent = err.message
	}
}
$('#show-form').addEventListener('input', (e) => {
	if (e.target.matches('.t-len, [name=defaultSermonMinutes], .t-name')) updateShowSummary()
	clearTimeout(testTimer)
	testTimer = setTimeout(() => {
		runCueTest()
		refreshPreview()
	}, 250)
})

// ---------- connection ----------
for (const [id, label] of [['#connection-form', 'Resi login'], ['#defaults-form', 'Stage displays'], ['#advanced-form', 'Advanced settings']]) {
	$(id).addEventListener('submit', (e) => {
		e.preventDefault()
		saveSettings(formPatch(e.target), label)
	})
}

// ---------- save & restore ----------
let importFile = null
async function loadBackup() {
	const b = await api('api/config/backup').catch(() => null)
	$('#undo-card').hidden = !b
	if (!b) return
	$('#undo-text').textContent = `Puts back the setup from before the last import (saved ${new Date(b.exportedAt).toLocaleString()}), with ${b.campuses.length} venue${b.campuses.length === 1 ? '' : 's'}: ${b.campuses.join(', ') || 'none'}.`
	$('#undo-download').onclick = () => download(b.config, `timer-sync-before-import-${b.exportedAt.slice(0, 10)}.json`)
}
function download(obj, filename) {
	const a = document.createElement('a')
	a.href = URL.createObjectURL(new Blob([JSON.stringify(obj, null, '\t')], { type: 'application/json' }))
	a.download = filename
	a.click()
	setTimeout(() => URL.revokeObjectURL(a.href), 1000)
}
function resetImport() {
	importFile = null
	$('#import-go').disabled = true
	$('#import-parts').hidden = true
	$('#import-preview').hidden = true
}
$('#import-file').addEventListener('change', async (e) => {
	resetImport()
	const file = e.target.files[0]
	if (!file) return
	const preview = $('#import-preview')
	preview.hidden = false
	try {
		const data = JSON.parse(await file.text())
		if (data.format !== 'streaming-timer-sync-config') throw new Error('not an export')
		const cues = data.settings?.cues ?? {}
		preview.innerHTML = `Saved <b>${esc(new Date(data.exportedAt).toLocaleString())}</b>.
			${(cues.types ?? []).length} cue types, counting from ${typeLabel(cues.start ?? '')} to ${orList(cues.targets ?? []) || 'nothing'}.
			${data.campuses.length} venue${data.campuses.length === 1 ? '' : 's'}: ${data.campuses.map((c) => esc(c.name)).join(', ') || 'none'}.`
		importFile = data
		$('#import-parts').hidden = false
		$('#import-go').disabled = false
	} catch {
		preview.innerHTML = `<span class="urgent-text">This isn't a Streaming Timer Sync setup file.</span>`
	}
})
$('#import-form').addEventListener('submit', async (e) => {
	e.preventDefault()
	const parts = $$('input[name=part]:checked', e.target).map((i) => i.value)
	if (!importFile) return
	if (!parts.length) return flash('Tick at least one thing to import.', true)
	if (!confirm('Replace the current setup with this file? You can undo it afterwards.')) return
	try {
		const r = await api('api/config/import', { method: 'POST', body: { config: importFile, parts } })
		flash(`Imported ${r.cueTypes} cue types and ${r.campuses} venues`)
		e.target.reset()
		resetImport()
		;[campuses, settings] = await Promise.all([api('api/campuses'), api('api/settings')])
		loadBackup()
	} catch (err) {
		flash(err.message, true)
	}
})
$('#undo-go').addEventListener('click', async () => {
	if (!confirm('Put back the setup from before the last import?')) return
	try {
		await api('api/config/undo', { method: 'POST' })
		flash('Import undone')
		;[campuses, settings] = await Promise.all([api('api/campuses'), api('api/settings')])
		loadBackup()
	} catch (err) {
		flash(err.message, true)
	}
})

// ---------- diagnostics ----------
async function refreshDiagnostics() {
	if ($('[data-page="diagnostics"]').hidden) return
	const [d, logs] = await Promise.all([api('api/diagnostics'), api('api/logs')])
	decoders = d.decoders
	const s = d.status
	$('#diag-status').className = `card form${s.ok ? ' accent' : ' off'}`
	$('#diag-status').innerHTML = `
		<div class="card-head"><h2>${s.ok ? 'Connected to Resi' : 'Not connected'}</h2><span class="tag ${s.ok ? 'open' : 'urgent'}">${s.ok ? 'OK' : 'Problem'}</span></div>
		<dl class="facts">
			<div><dt>Last decoder check</dt><dd>${esc(fmtAgo(s.lastDecoderPollAt))}</dd></div>
			<div><dt>Decoders</dt><dd>${d.decoders.length}</dd></div>
			<div><dt>Events with cues</dt><dd>${d.events.filter((e) => e.cues).length} of ${d.events.length}</dd></div>
			<div><dt>Stream profiles found</dt><dd>${d.knownProfiles.length || 'None yet'}</dd></div>
		</dl>
		${s.ok ? '' : `<p class="urgent-text">${esc(s.message)}</p>`}
		${s.lastError ? `<p class="hint" style="margin:0">Last error ${esc(fmtAgo(s.lastError.at))}: ${esc(s.lastError.message)}</p>` : ''}`
	$('#diag-decoders').innerHTML =
		d.decoders
			.map(
				(x) => `<tr${x.status === 'offline' ? ' class="inactive"' : ''}><td><b>${esc(x.userName)}</b><span class="sub mono">${esc(x.serialNumber)}</span></td>
				<td><span class="tag ${x.status === 'playing' ? 'open' : x.status === 'offline' ? 'pending' : ''}">${esc(x.status)}</span></td>
				<td class="mono">${fmtPos(x.playheadSec)}</td>
				<td title="${esc(x.eventId)}">${esc(x.eventName || '—')}</td><td>${esc(fmtAgo(x.lastUpdate))}</td></tr>`,
			)
			.join('') || '<tr><td colspan="5" class="quiet">No decoders yet.</td></tr>'
	$('#diag-events').innerHTML = d.events
		.map((ev) => {
			const watchers = d.decoders.filter((x) => x.eventId === ev.eventId)
			return `<section class="card form">
				<div class="card-head"><div><h2>${esc(ev.eventName || 'Unnamed event')}</h2>
					<p class="hint" style="margin:2px 0 0">${watchers.map((w) => `${esc(w.userName)} at ${fmtPos(w.playheadSec)}`).join(' · ') || 'No decoder on it'}</p></div>
					${ev.error ? `<span class="tag urgent" title="${esc(ev.error)}">Cue error</span>` : `<span class="tag">${(ev.cues ?? []).length} cues</span>`}</div>
				${ev.error ? `<p class="urgent-text">${esc(ev.error)}</p>` : ''}
				<div class="table-wrap"><table class="table compact"><thead><tr><th>At</th><th>Cue</th><th>Counts as</th></tr></thead><tbody>
				${(ev.cues ?? []).map((c) => `<tr${c.matchedAs?.length ? '' : ' class="inactive"'}><td class="mono">${esc(String(c.position).replace(/\.\d+$/, ''))}</td><td>${esc(c.name)}</td><td>${(c.matchedAs ?? []).map((m) => `<span class="tag open">${esc(m)}</span>`).join('') || '—'}</td></tr>`).join('') || '<tr><td colspan="3" class="quiet">No cues</td></tr>'}
				</tbody></table></div></section>`
		})
		.join('')
	$('#diag-discovery').textContent = d.discoveryLog.map((l) => `${l.at}  ${l.eventId}  ${l.message}`).join('\n') || 'Nothing yet.'
	$('#diag-logs').textContent = logs.map((l) => `${l.at.slice(11, 19)}  ${l.level.padEnd(5)}  ${l.message}`).join('\n') || 'Nothing yet.'
}
setInterval(refreshDiagnostics, 3000)
$('#rediscover').addEventListener('click', async () => {
	await api('api/rescan', { method: 'POST' })
	flash('Rescanned cues from Resi')
	refreshDiagnostics()
})

// ---------- boot ----------
// Decoder names first, so the first timer cards don't flash serial numbers.
refreshDecoders().finally(connectStream)
pollStatus()
setInterval(pollStatus, 5000)
setInterval(refreshDecoders, 15000)
api('api/campuses').then((c) => (campuses = c))
showView()
