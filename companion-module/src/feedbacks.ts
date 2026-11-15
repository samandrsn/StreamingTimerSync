import { combineRgb, type CompanionFeedbackBooleanEvent } from '@companion-module/base'
import type { ModuleInstance } from './main.js'
import type { CampusTimer } from './types.js'
import { localTimer } from './variables.js'

const LOCAL = '__local'

function campusChoices(self: ModuleInstance) {
	return [{ id: LOCAL, label: 'This venue (module config)' }, ...self.timers.map((t) => ({ id: t.slug, label: t.campusName }))]
}

function timerFor(self: ModuleInstance, feedback: CompanionFeedbackBooleanEvent): CampusTimer | undefined {
	const id = feedback.options.campus as string
	return id === LOCAL || !id ? localTimer(self) : self.timers.find((t) => t.slug === id)
}

export function UpdateFeedbacks(self: ModuleInstance): void {
	const choices = campusChoices(self)
	const campusOption = {
		id: 'campus',
		type: 'dropdown' as const,
		label: 'Venue',
		default: LOCAL,
		choices,
	}

	self.setFeedbackDefinitions({
		remaining_below: {
			name: 'Remaining at or below (minutes)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(240, 165, 42), color: combineRgb(0, 0, 0) },
			options: [campusOption, { id: 'minutes', type: 'number', label: 'Minutes', default: 5, min: 0, max: 240 }],
			callback: (feedback) => {
				const t = timerFor(self, feedback)
				if (!t || t.state !== 'counting' || t.remainingSeconds === null) return false
				return t.remainingSeconds <= Number(feedback.options.minutes) * 60
			},
		},
		overtime: {
			name: 'Overtime or ended',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(220, 40, 40), color: combineRgb(255, 255, 255) },
			options: [campusOption],
			callback: (feedback) => {
				const t = timerFor(self, feedback)
				return t?.state === 'overtime' || t?.state === 'ended'
			},
		},
		state_is: {
			name: 'Timer state is',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(0, 150, 60), color: combineRgb(255, 255, 255) },
			options: [
				campusOption,
				{
					id: 'state',
					type: 'dropdown',
					label: 'State',
					default: 'counting',
					choices: [
						{ id: 'counting', label: 'Counting' },
						{ id: 'overtime', label: 'Overtime' },
						{ id: 'ended', label: 'Ended' },
						{ id: 'waiting', label: 'Waiting for MESSAGE START' },
						{ id: 'no_event', label: 'No event loaded' },
						{ id: 'offline', label: 'Offline' },
					],
				},
			],
			callback: (feedback) => timerFor(self, feedback)?.state === feedback.options.state,
		},
		using_default: {
			name: 'Counting to default length (no end cue yet)',
			type: 'boolean',
			defaultStyle: { bgcolor: combineRgb(60, 60, 140), color: combineRgb(255, 255, 255) },
			options: [campusOption],
			callback: (feedback) => timerFor(self, feedback)?.targetSource === 'default',
		},
	})
}
