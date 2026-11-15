/**
 * Cue names are typed by hand, so they vary: "9AM // Message Start",
 * "9AM: Sermon Beginning", "11:15 - msg start", "MESAGE START". Matching:
 *
 *   1. Split off the service prefix ("9AM", "11:15") — kept for display only.
 *   2. Tokenize the rest (uppercase, punctuation → spaces).
 *   3. A rule matches when every token of one of its aliases is found in the
 *      cue, where tokens are equal if they're in the same synonym group or
 *      within a small typo distance, and none of the rule's exclude words appear.
 */

export const DEFAULT_SYNONYMS = [
	['START', 'STARTS', 'STARTING', 'STARTED', 'BEGIN', 'BEGINS', 'BEGINNING', 'BEG', 'STRT'],
	['MESSAGE', 'MSG', 'MESS', 'SERMON', 'TEACHING', 'PREACHING'],
	['END', 'ENDS', 'ENDING', 'ENDED', 'STOP', 'STOPS', 'FINISH', 'FINISHED', 'OVER', 'DONE'],
	['STREAM', 'BROADCAST', 'FEED', 'LIVESTREAM'],
	['RESPONSE', 'INVITATION', 'ALTAR'],
]

const PREFIX_SEPARATORS = ['//', '||', '|', ' - ', ' – ', ' — ', '>>', '>', '/']

// A leading service time: "8AM", "9:30AM", "11:15", "5 pm", then a separator.
const LEADING_TIME = /^(\d{1,2}(?::\d{2})?\s*(?:[AP]\.?M\.?|[AP])?)\s*(?:\/\/|\|\||[\/|:>\-–—]+)\s*(?=\S)/i

/**
 * "9AM // Message Start"          -> { prefix: "9AM", body: "Message Start" }
 * "- 11AM / STREAM END - Outro"    -> { prefix: "11AM", body: "STREAM END - Outro" }
 *
 * A prefix must contain a digit, so a trailing descriptor ("STREAM END - Outro")
 * is never mistaken for one.
 */
export function splitPrefix(name) {
	const raw = String(name ?? '')
		.trim()
		.replace(/^[^A-Za-z0-9]+/, '')
	const time = raw.match(LEADING_TIME)
	if (time) return { prefix: time[1].trim(), body: raw.slice(time[0].length).trim() }

	const isPrefix = (p) => /\d/.test(p) && tokenize(p).length <= 4
	for (const sep of PREFIX_SEPARATORS) {
		const i = raw.indexOf(sep)
		if (i > 0 && i < raw.length - sep.length && isPrefix(raw.slice(0, i))) {
			return { prefix: raw.slice(0, i).trim(), body: raw.slice(i + sep.length).trim() }
		}
	}
	// A colon not followed by a digit, so "Sun 9:00AM: Worship" splits after AM, not inside 9:00.
	const colon = raw.search(/:(?!\d)/)
	if (colon > 0 && colon < raw.length - 1 && isPrefix(raw.slice(0, colon))) {
		return { prefix: raw.slice(0, colon).trim(), body: raw.slice(colon + 1).trim() }
	}
	return { prefix: '', body: raw }
}

export function tokenize(text) {
	return String(text ?? '')
		.toUpperCase()
		.replace(/[^A-Z0-9]+/g, ' ')
		.trim()
		.split(' ')
		.filter(Boolean)
}

/** Optimal string alignment distance (Levenshtein + adjacent transpositions). */
function editDistance(a, b, max) {
	if (Math.abs(a.length - b.length) > max) return max + 1
	const d = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array(b.length).fill(0)])
	for (let j = 1; j <= b.length; j++) d[0][j] = j
	for (let i = 1; i <= a.length; i++) {
		let rowMin = Infinity
		for (let j = 1; j <= b.length; j++) {
			const cost = a[i - 1] === b[j - 1] ? 0 : 1
			d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost)
			if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1)
			rowMin = Math.min(rowMin, d[i][j])
		}
		if (rowMin > max) return max + 1
	}
	return d[a.length][b.length]
}

function typoBudget(len) {
	if (len >= 8) return 2
	if (len >= 5) return 1
	return 0
}

export class CueMatcher {
	constructor(cueSettings) {
		this.settings = cueSettings
		this.mode = cueSettings.matchMode || 'smart'
		this.groups = new Map() // token -> group index
		const synonyms = cueSettings.synonyms?.length ? cueSettings.synonyms : DEFAULT_SYNONYMS
		synonyms.forEach((group, gi) => {
			for (const t of group.flatMap(tokenize)) if (!this.groups.has(t)) this.groups.set(t, gi)
		})
	}

	tokenEq(a, b) {
		if (a === b) return true
		const ga = this.canonGroup(a)
		const gb = this.canonGroup(b)
		if (ga !== undefined && ga === gb) return true
		// Typos are only forgiven for longer words, so short tokens like "US"/"END" stay strict.
		return editDistance(a, b, typoBudget(Math.min(a.length, b.length))) <= typoBudget(Math.min(a.length, b.length))
	}

	/** Synonym group of a token, tolerating typos against group members ("BEGINING"). */
	canonGroup(token) {
		if (this.groups.has(token)) return this.groups.get(token)
		const budget = typoBudget(token.length)
		if (!budget) return undefined
		for (const [member, gi] of this.groups) {
			if (member.length >= 5 && editDistance(token, member, budget) <= budget) return gi
		}
		return undefined
	}

	hasToken(tokens, wanted) {
		return tokens.some((t) => this.tokenEq(t, wanted))
	}

	/**
	 * @param {string} cueName
	 * @param {{ aliases: string[], exclude?: string[] }} rule
	 */
	matches(cueName, rule) {
		// The type's own name always counts as one of its phrases.
		const aliases = [...new Set([rule.name, ...(rule.aliases ?? [])].filter(Boolean))]
		if (!aliases.length) return false
		const { body } = splitPrefix(cueName)

		if (this.mode === 'exact') {
			const b = tokenize(body).join(' ')
			return aliases.some((a) => tokenize(a).join(' ') === b)
		}
		if (this.mode === 'contains') {
			const b = tokenize(cueName).join(' ')
			return aliases.some((a) => b.includes(tokenize(a).join(' ')))
		}

		const tokens = tokenize(body)
		if (!tokens.length) return false
		if ((rule.exclude ?? []).flatMap(tokenize).some((x) => this.hasToken(tokens, x))) return false

		const squashed = tokens.join('')
		return aliases.some((alias) => {
			const want = tokenize(alias)
			if (!want.length) return false
			if (want.every((w) => this.hasToken(tokens, w))) return true
			// "MESSAGESTART" / "STREAMEND" typed without a space.
			return want.length > 1 && squashed.includes(want.join(''))
		})
	}

	/** Which rule names a cue matches — for diagnostics and the settings tester. */
	classify(cueName, rules) {
		return rules.filter((r) => this.matches(cueName, r)).map((r) => r.name)
	}
}

// The cue type library. A countdown runs from a start type to the first target type after it.
// A type's name is always one of its phrases, so aliases only list the other ways it's typed.
export const DEFAULT_CUE_TYPES = [
	{ name: 'SERVICE START', aliases: ['SERVICE START'], exclude: ['END', 'MESSAGE'] },
	{ name: 'MESSAGE START', aliases: ['MESSAGE START'], exclude: ['END'] },
	{ name: 'MESSAGE END', aliases: ['MESSAGE END'], exclude: ['START'] },
	{ name: 'RESPONSE', aliases: ['RESPONSE', 'PRAYER'], exclude: ['END'] },
	{ name: 'STREAM END', aliases: ['STREAM END', 'END OF STREAM', 'SIGN OFF'], exclude: ['MESSAGE', 'START'] },
]
const DEFAULT_START = 'MESSAGE START'
const DEFAULT_TARGETS = ['MESSAGE END', 'STREAM END']

const list = (v) =>
	(Array.isArray(v) ? v : String(v ?? '').split(','))
		.map((s) => String(s).trim())
		.filter(Boolean)

/** Find a cue type by name, ignoring case. */
export function findCueType(cues, name) {
	const want = String(name ?? '').trim().toUpperCase()
	return want ? cues.types.find((t) => t.name.toUpperCase() === want) : undefined
}

/** Normalize cue settings to { matchMode, types, start, targets, estimates, synonyms }. */
export function normalizeCueSettings(cues = {}) {
	let types = Array.isArray(cues.types) ? cues.types : DEFAULT_CUE_TYPES
	const start = cues.start
	let targets = cues.targets

	const seen = new Set()
	types = types
		.map((t) => {
			const name = String(t.name ?? '').trim()
			const aliases = list(t.aliases)
			return { name, aliases: aliases.length ? aliases : [name], exclude: list(t.exclude) }
		})
		.filter((t) => t.name && !seen.has(t.name.toUpperCase()) && seen.add(t.name.toUpperCase()))
	if (!types.length) types = structuredClone(DEFAULT_CUE_TYPES)

	const lib = { types }
	const startType = findCueType(lib, start ?? DEFAULT_START) ?? types[0]
	targets = list(targets ?? DEFAULT_TARGETS)
		.map((n) => findCueType(lib, n)?.name)
		.filter((n, i, a) => n && n !== startType.name && a.indexOf(n) === i)

	const synonyms = Array.isArray(cues.synonyms) && cues.synonyms.length
		? cues.synonyms.map((g) => list(g).map((s) => s.toUpperCase())).filter((g) => g.length > 1)
		: DEFAULT_SYNONYMS.map((g) => [...g])

	// Optional times per cue type, in minutes, used until a target's cue exists. With
	// estimateFrom 'start' a target's time is how long after the start cue it lands; with
	// 'lengths' (run of show) each type's time is how long that element runs, start included.
	let estimates = {}
	for (const [name, min] of Object.entries(cues.estimates ?? {})) {
		const type = findCueType(lib, name)
		if (type && Number(min) > 0) estimates[type.name] = Number(min)
	}

	// Times are always lengths now: how long each element runs, in service order.
	const estimateFrom = 'lengths'
	// 1.1.2 stored run of show as the gap before each target ('previous'). The same timing
	// as lengths: each gap is the length of the element before it, so move each up a row.
	if (cues.estimateFrom === 'previous') {
		const order = [startType.name, ...targets]
		const moved = {}
		order.forEach((name, i) => {
			const gap = estimates[order[i + 1]]
			if (gap) moved[name] = gap
		})
		estimates = moved
	} else if (cues.estimateFrom !== 'lengths') {
		// Before 1.2 a target's time could be how long after the start cue it lands. Same timing as
		// lengths: take the timed targets in time order, and each gap is the length of the cue before it.
		const timed = targets.filter((n) => estimates[n]).sort((a, b) => estimates[a] - estimates[b])
		if (timed.length) {
			const lengths = {}
			let prev = startType.name
			let at = 0
			for (const name of timed) {
				if (estimates[name] > at) lengths[prev] = estimates[name] - at
				prev = name
				at = estimates[name]
			}
			estimates = lengths
			targets = [...timed, ...targets.filter((n) => !timed.includes(n))]
		}
	}

	const mode = ['smart', 'contains', 'exact'].includes(cues.matchMode) ? cues.matchMode : 'smart'
	return { matchMode: mode, types, start: startType.name, targets, estimates, estimateFrom, synonyms }
}
