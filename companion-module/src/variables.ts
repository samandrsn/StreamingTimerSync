import type { ModuleInstance } from './main.js'
import type { CampusTimer, TargetTimer } from './types.js'

const STATE_LABELS: Record<string, string> = {
	offline: 'Offline',
	no_event: 'No event',
	no_cues: 'Loading cues',
	waiting: 'Waiting',
	counting: 'Counting',
	overtime: 'Overtime',
	ended: 'Ended',
}

const FIELDS: Array<{ suffix: string; label: string; getValue: (t: CampusTimer | undefined) => string }> = [
	{ suffix: 'remaining', label: 'Remaining (display)', getValue: (t) => t?.display ?? '' },
	{
		suffix: 'remaining_seconds',
		label: 'Remaining (seconds)',
		getValue: (t) => (t?.remainingSeconds === null || t?.remainingSeconds === undefined ? '' : String(t.remainingSeconds)),
	},
	{ suffix: 'state', label: 'State', getValue: (t) => t?.state ?? 'offline' },
	{ suffix: 'state_label', label: 'State (label)', getValue: (t) => STATE_LABELS[t?.state ?? 'offline'] ?? '' },
	{
		suffix: 'target',
		label: 'Counting to',
		getValue: (t) =>
			t?.targetSource === 'cue'
				? (t.targetCueName ?? '')
				: t?.targetSource === 'default'
					? `${t.sermonMinutes} min default`
					: '',
	},
	{ suffix: 'estimated', label: 'Estimated, no target cue yet (1/0)', getValue: (t) => (t?.estimated ? '1' : '0') },
	{ suffix: 'elapsed', label: 'Elapsed in message', getValue: (t) => t?.elapsedDisplay ?? '' },
	{ suffix: 'playhead', label: 'Decoder playhead', getValue: (t) => t?.playheadDisplay ?? '' },
	{ suffix: 'event', label: 'Event name', getValue: (t) => t?.eventName ?? '' },
	{ suffix: 'decoder', label: 'Decoder serial', getValue: (t) => t?.decoderSerial ?? '' },
]

// Per target cue type: {slug}_{target}_remaining, e.g. north_stream_end_remaining.
const TARGET_FIELDS: Array<{ suffix: string; label: string; getValue: (t: TargetTimer | undefined) => string }> = [
	{ suffix: 'remaining', label: 'remaining', getValue: (t) => t?.display ?? '' },
	{
		suffix: 'remaining_seconds',
		label: 'remaining (seconds)',
		getValue: (t) => (t?.remainingSeconds === null || t?.remainingSeconds === undefined ? '' : String(t.remainingSeconds)),
	},
	{ suffix: 'state', label: 'state', getValue: (t) => t?.state ?? 'offline' },
	{ suffix: 'estimated', label: 'estimated (1/0)', getValue: (t) => (t?.estimated ? '1' : '0') },
]

export function localTimer(self: ModuleInstance): CampusTimer | undefined {
	const key = self.config.campus?.trim().toLowerCase()
	if (!key) return undefined
	return self.timers.find((t) => t.slug === key || t.campusName.toLowerCase() === key)
}

export function UpdateVariableDefinitions(self: ModuleInstance): void {
	const defs: Array<{ variableId: string; name: string }> = [
		{ variableId: 'connected', name: 'Bridge connected (1/0)' },
		{ variableId: 'resi_status', name: 'Bridge → Resi status' },
		{ variableId: 'campus', name: 'This campus name' },
	]
	for (const f of FIELDS) defs.push({ variableId: f.suffix, name: `This campus - ${f.label}` })
	for (const target of localTimer(self)?.targets ?? []) {
		for (const f of TARGET_FIELDS) defs.push({ variableId: `${target.key}_${f.suffix}`, name: `This campus - ${target.name} ${f.label}` })
	}
	for (const t of self.timers) {
		for (const f of FIELDS) defs.push({ variableId: `${t.slug}_${f.suffix}`, name: `${t.campusName} - ${f.label}` })
		for (const target of t.targets ?? []) {
			for (const f of TARGET_FIELDS) {
				defs.push({ variableId: `${t.slug}_${target.key}_${f.suffix}`, name: `${t.campusName} - ${target.name} ${f.label}` })
			}
		}
	}
	self.setVariableDefinitions(defs)
}

export function UpdateVariableValues(self: ModuleInstance): void {
	const local = localTimer(self)
	const values: Record<string, string> = {
		connected: self.connected ? '1' : '0',
		resi_status: self.resiStatus,
		campus: local?.campusName ?? '',
	}
	for (const f of FIELDS) values[f.suffix] = f.getValue(local)
	for (const target of local?.targets ?? []) {
		for (const f of TARGET_FIELDS) values[`${target.key}_${f.suffix}`] = f.getValue(target)
	}
	for (const t of self.timers) {
		for (const f of FIELDS) values[`${t.slug}_${f.suffix}`] = f.getValue(t)
		for (const target of t.targets ?? []) {
			for (const f of TARGET_FIELDS) values[`${t.slug}_${target.key}_${f.suffix}`] = f.getValue(target)
		}
	}
	self.setVariableValues(values)
}
