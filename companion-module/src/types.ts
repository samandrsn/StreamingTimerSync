export type TimerState = 'offline' | 'no_event' | 'no_cues' | 'waiting' | 'counting' | 'overtime' | 'ended'

/** One countdown per "count down to" cue type. */
export interface TargetTimer {
	name: string
	key: string
	state: TimerState
	remainingSeconds: number | null
	display: string
	targetSource: 'cue' | 'default' | null
	targetCueName: string | null
	estimated?: boolean
}

/** Shape of one entry in GET /api/timers from the bridge. */
export interface CampusTimer {
	campusId: string
	campusName: string
	slug: string
	state: TimerState
	remainingSeconds: number | null
	display: string
	targetSource: 'cue' | 'default' | null
	targetCueName: string | null
	sermonMinutes: number
	estimated?: boolean
	elapsedSeconds: number | null
	elapsedDisplay: string
	playheadDisplay: string
	eventId: string | null
	eventName: string | null
	decoderSerial: string | null
	decoderStatus: string | null
	targets?: TargetTimer[]
}

export interface TimersResponse {
	serverTime: number
	status: { ok: boolean; message: string }
	timers: CampusTimer[]
}
