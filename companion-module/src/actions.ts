import type { CompanionActionDefinitions } from '@companion-module/base'
import type { ModuleInstance } from './main.js'

/** "" in the event option means: whatever event the server's Settings picks (by name each week, or chosen). */
const SERVER_EVENT = ''

export function UpdateActions(self: ModuleInstance): void {
	const cueChoices = self.cueTypes.map((name) => ({ id: name, label: name }))
	const eventChoices = [
		{ id: SERVER_EVENT, label: 'The server’s event (Cue setting page)' },
		...self.cueEvents.map((e) => ({ id: e.id, label: `${e.live ? '● LIVE · ' : ''}${e.name || 'Unnamed event'}` })),
	]

	const actions: CompanionActionDefinitions = {
		set_cue: {
			name: 'Set a cue in Resi now',
			description: 'Adds a cue at the live point of the event, the same way Studio does.',
			options: [
				{
					type: 'dropdown',
					id: 'cue',
					label: 'Cue',
					default: cueChoices[0]?.id ?? 'MESSAGE END',
					choices: cueChoices,
					allowCustom: true,
					tooltip: 'Pick one from the server’s Cues page, or type any name. Variables work too.',
				},
				{
					type: 'textinput',
					id: 'prefix',
					label: 'Prefix (blank: the server’s prefix for this time of day)',
					default: '',
					useVariables: true,
					tooltip: '“9AM” sets “9AM // MESSAGE END”. Type a single - for no prefix.',
				},
				{
					type: 'dropdown',
					id: 'event',
					label: 'Event',
					default: SERVER_EVENT,
					choices: eventChoices,
				},
			],
			callback: async (action, context) => {
				const name = await context.parseVariablesInString(String(action.options.cue ?? ''))
				const rawPrefix = (await context.parseVariablesInString(String(action.options.prefix ?? ''))).trim()
				const body: Record<string, string> = { name }
				// Blank: the server's default prefix. "-": none.
				if (rawPrefix === '-') body.prefix = ''
				else if (rawPrefix) body.prefix = rawPrefix
				if (action.options.event) body.eventId = String(action.options.event)
				try {
					const r = await self.serverPost('/api/cues/set', body)
					self.lastCue = `${r.name} at ${r.position}`
					self.log('info', `Cue set: ${self.lastCue}`)
				} catch (error) {
					self.log('warn', `Couldn't set the cue: ${error instanceof Error ? error.message : String(error)}`)
				}
				void self.pollCueEvents()
			},
		},
		undo_cue: {
			name: 'Undo the last cue set',
			description: 'Removes the last cue the server set (from any button or the dashboard).',
			options: [],
			callback: async () => {
				try {
					const r = await self.serverPost('/api/cues/undo', {})
					self.log('info', `Cue removed: ${r.name} at ${r.position}`)
				} catch (error) {
					self.log('warn', `Couldn't undo: ${error instanceof Error ? error.message : String(error)}`)
				}
				void self.pollCueEvents()
			},
		},
	}
	self.setActionDefinitions(actions)
}
