import type { SomeCompanionConfigField } from '@companion-module/base'

export interface ModuleConfig {
	serverUrl: string
	campus: string
	pollIntervalMs: number
}

export function GetConfigFields(): SomeCompanionConfigField[] {
	return [
		{
			type: 'static-text',
			id: 'info',
			label: 'About',
			width: 12,
			value:
				'Reads per-venue countdowns from the Streaming Timer Sync server. Venues, cue names and what to count are configured on the server web page.',
		},
		{
			type: 'textinput',
			id: 'serverUrl',
			label: 'Server URL',
			width: 8,
			default: 'http://localhost:7374',
			regex: '/^https?:\\/\\/.+/',
		},
		{
			type: 'textinput',
			id: 'campus',
			label: 'This venue (variable key from the server, e.g. north)',
			tooltip: 'Fills the short variables like $(streaming-timer-sync:remaining). Per-venue variables are always available too.',
			width: 8,
			default: '',
		},
		{
			type: 'number',
			id: 'pollIntervalMs',
			label: 'Poll interval (ms)',
			width: 4,
			default: 500,
			min: 200,
			max: 10000,
		},
	]
}
