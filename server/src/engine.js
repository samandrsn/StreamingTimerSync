import { CueMatcher, findCueType, splitPrefix } from './cue-match.js'
import { formatClock, formatPosition } from './time.js'

/**
 * Pure timer computation. Given one campus's config, the decoder it is watching
 * (with an interpolated playhead) and the cues of that decoder's event, work out
 * how long is left in the current message.
 *
 * Positions are seconds from the start of the event — the same reference Resi
 * uses for both decoder `position` and cue `position` — so a campus watching a
 * delayed or older service lines up against the cues automatically.
 */

export const STATES = {
	OFFLINE: 'offline', // no decoder assigned / decoder offline
	NO_EVENT: 'no_event', // decoder has no event loaded
	NO_CUES: 'no_cues', // event loaded but cues not fetched (yet)
	WAITING: 'waiting', // no start cue at or before the playhead
	COUNTING: 'counting',
	OVERTIME: 'overtime', // past the target and no end cue reached yet
	ENDED: 'ended', // playhead passed the end cue
}

/** The cue type that starts this campus's countdown (campus override, else global). */
export function effectiveStartRule(campus, settings) {
	return findCueType(settings.cues, campus.startCue) ?? findCueType(settings.cues, settings.cues.start) ?? settings.cues.types[0]
}

/** Cue types this campus counts down to (campus override, else global targets). */
export function effectiveEndRules(campus, settings) {
	const override = Array.isArray(campus.endCues) ? campus.endCues.filter(Boolean) : []
	const names = override.length ? override : (settings.cues.targets ?? [])
	return names.map((name) => findCueType(settings.cues, name) ?? { name, aliases: [name], exclude: [] })
}

/** "9 AM", "9am", "9:00 AM" all compare equal-ish: digits+letters only, leading zeros dropped. */
function prefixKey(cueName) {
	return splitPrefix(cueName)
		.prefix.toUpperCase()
		.replace(/[^A-Z0-9]/g, '')
		.replace(/^0+/, '')
		.replace(/00(AM|PM)$/, '$1')
}

/** "STREAM END" -> "stream_end", for per-target variable names. */
export function targetKey(name) {
	return String(name ?? '').toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'target'
}

export function effectiveEndCues(campus, settings) {
	return effectiveEndRules(campus, settings).map((r) => r.name)
}

/**
 * Clock offset in seconds, added to the playhead (campus value, else global). Resi
 * reports positions a little late, so +2 takes 2 seconds off the clock.
 */
export function effectiveOffsetSec(campus, settings) {
	const own = campus.positionOffsetSec
	if (own !== null && own !== undefined && own !== '' && Number.isFinite(Number(own))) return Number(own)
	return Number(settings.positionOffsetSec) || 0
}

export function effectiveSermonMinutes(campus, settings) {
	const v = Number(campus.sermonMinutes)
	if (Number.isFinite(v) && v > 0) return v
	return Number(settings.defaultSermonMinutes) || 45
}

/**
 * Pick which of a campus's decoders to follow: playing > paused > anything with an
 * event, newest telemetry wins ties. Campuses often have a backup decoder.
 */
export function pickDecoder(decoders) {
	const rank = (d) => {
		if (!d) return -1
		if (d.status === 'playing') return 3
		if (d.status === 'paused' && d.eventId) return 2
		if (d.status !== 'offline' && d.eventId) return 1
		return 0
	}
	return [...decoders].filter(Boolean).sort((a, b) => {
		const r = rank(b) - rank(a)
		if (r !== 0) return r
		return String(b.lastUpdate ?? '').localeCompare(String(a.lastUpdate ?? ''))
	})[0]
}

/**
 * @param {object} args
 * @param {object} args.campus      campus config
 * @param {object} args.settings    global settings
 * @param {object|undefined} args.decoder  { serialNumber, status, eventId, eventName, playheadSec, stale }
 * @param {Array|undefined} args.cues      [{ id, name, positionSec }]
 */
export function computeTimer({ campus, settings, decoder, cues }) {
	const base = {
		campusId: campus.id,
		campusName: campus.name,
		slug: campus.slug,
		state: STATES.OFFLINE,
		remainingSeconds: null,
		display: settings.display.idleText ?? '',
		targetSource: null,
		targetCueName: null,
		targetType: null,
		thenTargets: [],
		estimateMinutes: null,
		// True while counting to start + fallback length because no target cue exists yet.
		estimated: false,
		service: '',
		messageStartCueName: null,
		targetPositionSec: null,
		messageStartSec: null,
		elapsedSeconds: null,
		elapsedDisplay: '',
		playheadSec: null,
		playheadDisplay: '',
		eventId: null,
		eventName: null,
		decoderSerial: null,
		decoderStatus: null,
		stale: false,
		sermonMinutes: effectiveSermonMinutes(campus, settings),
		startCue: effectiveStartRule(campus, settings)?.name ?? null,
		offsetSec: effectiveOffsetSec(campus, settings),
		endCues: effectiveEndCues(campus, settings),
	}

	// One entry per target type, so each can drive its own Companion variable.
	base.targets = effectiveEndRules(campus, settings).map((r) => ({
		name: r.name,
		key: targetKey(r.name),
		state: STATES.OFFLINE,
		display: base.display,
		remainingSeconds: null,
		targetSource: null,
		targetCueName: null,
		targetPositionSec: null,
		estimateMinutes: null,
		estimateFrom: null,
		estimated: false,
	}))
	const idle = (state) => ({ ...base, state, targets: base.targets.map((t) => ({ ...t, state })) })

	if (!decoder) return base

	Object.assign(base, {
		decoderSerial: decoder.serialNumber,
		decoderStatus: decoder.status,
		eventId: decoder.eventId ?? null,
		eventName: decoder.eventName ?? null,
		stale: !!decoder.stale,
	})

	if (decoder.status === 'offline') return base
	if (!decoder.eventId) return idle(STATES.NO_EVENT)
	if (!Array.isArray(cues)) return idle(STATES.NO_CUES)

	const offset = effectiveOffsetSec(campus, settings)
	const playhead = decoder.playheadSec + offset
	base.playheadSec = playhead
	base.playheadDisplay = formatPosition(playhead)

	const matcher = new CueMatcher(settings.cues)
	const endRules = effectiveEndRules(campus, settings)
	const tolerance = 0.5
	const sorted = [...cues].filter((c) => Number.isFinite(c.positionSec)).sort((a, b) => a.positionSec - b.positionSec)

	const startRule = effectiveStartRule(campus, settings)
	const starts = sorted.filter((c) => matcher.matches(c.name, startRule))
	const currentStart = starts.filter((c) => c.positionSec <= playhead + tolerance).at(-1)
	if (!currentStart) return idle(STATES.WAITING)

	const elapsed = playhead - currentStart.positionSec
	base.messageStartSec = currentStart.positionSec
	base.messageStartCueName = currentStart.name
	base.service = splitPrefix(currentStart.name).prefix
	base.elapsedSeconds = Math.floor(elapsed)
	base.elapsedDisplay = formatClock(elapsed)

	// The target is the first target cue after the start, but never past the next
	// start cue (a Sunday event carries several services). If the cues carry a
	// service prefix ("9AM // ..."), a target with the same prefix wins.
	const nextStart = starts.find((c) => c.positionSec > currentStart.positionSec)
	const servicePrefix = prefixKey(currentStart.name)
	const holdSec = (Number(settings.display.endedHoldMinutes) || 0) * 60
	// A decoder paused right after the end cue would otherwise hold 0:00 all week.
	const stoppedSec = decoder.status === 'playing' ? 0 : Number(decoder.stoppedForSec) || 0

	const withEstimate = (r) => ({ ...r, estimated: r.targetSource === 'default' && (r.state === STATES.COUNTING || r.state === STATES.OVERTIME) })

	/** This service's cue for one target type (same service prefix preferred), if it exists yet. */
	const cueFor = (rule) => {
		const candidates = sorted.filter(
			(c) =>
				c.positionSec > currentStart.positionSec &&
				(!nextStart || c.positionSec <= nextStart.positionSec) &&
				matcher.matches(c.name, rule),
		)
		return (servicePrefix && candidates.find((c) => prefixKey(c.name) === servicePrefix)) || candidates[0]
	}

	/** A target's own estimate in minutes, if one is set on the Countdown page. */
	const estimateFor = (rule) => settings.cues.estimates?.[rule.name] ?? null

	/**
	 * Count down to `endCue`, or with no cue to an estimate: `minutes` after `from`
	 * (the start cue, or in run-of-show mode the target before it).
	 */
	const countTo = (endCue, minutes = base.sermonMinutes, from = { at: currentStart.positionSec, name: null }) => {
		const target = endCue ? endCue.positionSec : from.at + minutes * 60
		const remaining = target - playhead
		const out = {
			targetSource: endCue ? 'cue' : 'default',
			targetCueName: endCue?.name ?? null,
			targetPositionSec: target,
			estimateMinutes: endCue ? null : minutes,
			estimateFrom: endCue ? null : from.name,
			// Ceil so the clock reads 0:00 exactly when the cue is hit, not a second early.
			remainingSeconds: Math.ceil(remaining),
		}
		if (endCue && remaining <= 0) {
			if (Math.max(-remaining, stoppedSec) > holdSec) {
				return withEstimate({ ...out, state: STATES.WAITING, display: settings.display.idleText ?? '', remainingSeconds: null })
			}
			return withEstimate({ ...out, state: STATES.ENDED, display: settings.display.endedText ?? '0:00', remainingSeconds: 0 })
		}
		if (remaining <= 0) {
			const display = settings.display.showOvertime === false ? '0:00' : formatClock(out.remainingSeconds)
			return withEstimate({ ...out, state: STATES.OVERTIME, display })
		}
		return withEstimate({ ...out, state: STATES.COUNTING, display: formatClock(out.remainingSeconds) })
	}

	// Where each target lands. A real cue wins. Without one:
	// - 'start': at its own time (or the default) after the start cue.
	// - 'lengths' (run of show): when the element before it ends, i.e. that element's cue
	//   (or estimate) plus that element's length, in Countdown-page order from the start cue.
	const chained = settings.cues.estimateFrom === 'lengths'
	const atStart = { at: currentStart.positionSec, name: null }
	let prev = { at: currentStart.positionSec, name: startRule.name, length: estimateFor(startRule) }
	const plan = endRules.map((rule) => {
		const cue = cueFor(rule)
		const own = chained ? prev.length : estimateFor(rule)
		const minutes = own ?? base.sermonMinutes
		const from = chained ? prev : atStart
		const at = cue ? cue.positionSec : from.at + minutes * 60
		const p = { rule, cue, minutes, own, from, at }
		// An element that's overrunning (time passed, no cue yet) pushes the ones after it back.
		prev = { at: cue ? at : Math.max(at, playhead), name: rule.name, length: estimateFor(rule) }
		return p
	})

	// The main clock rolls through the targets in order: it counts to the next target
	// not yet reached (Message End, then Response, then Stream End) and only shows "done"
	// after the last one. A target without its cue yet takes part at its estimate if it
	// has its own (in run-of-show mode, always). With nothing to go on, it estimates
	// from the fallback length.
	const found = plan.filter((p) => p.cue || chained || p.own).sort((a, b) => a.at - b.at)
	// It only moves past a target once that target's cue has happened: a passed estimate
	// with no cue yet runs over (-1:05) instead of skipping ahead. A later cue that has
	// happened means the earlier ones were skipped in the service.
	const lastDone = found.findLastIndex((x) => x.cue && x.cue.positionSec <= playhead)
	const upcoming = found.slice(lastDone + 1)
	const current = upcoming[0] ?? found.at(-1)
	const main = current ? countTo(current.cue, current.minutes, current.from) : countTo(null)

	return {
		...base,
		...main,
		targetType: current?.rule.name ?? null,
		// Target types still to come after the current one, for "then STREAM END".
		thenTargets: upcoming.slice(1).map((x) => x.rule.name),
		targets: plan.map((p) => ({ name: p.rule.name, key: targetKey(p.rule.name), ...countTo(p.cue, p.minutes, p.from) })),
	}
}
