import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateActions } from './actions.js'
import { UpdateFeedbacks } from './feedbacks.js'
import type { CampusTimer, CueEvent, CueEventsResponse, TimersResponse } from './types.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig
	timers: CampusTimer[] = []
	connected = false
	resiStatus = ''
	pollTimer: NodeJS.Timeout | null = null
	lastSlugs = ''
	lastError = ''
	// Setting cues: the server's cue names and Resi events, refreshed every 30 seconds.
	cueTypes: string[] = []
	cueEvents: CueEvent[] = []
	cueEvent: CueEvent | null = null
	lastCue = ''
	cuePrefix = ''
	cueTimer: NodeJS.Timeout | null = null
	lastCueLists = ''

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		UpdateVariableDefinitions(this)
		UpdateFeedbacks(this)
		UpdateActions(this)
		this.updateStatus(InstanceStatus.Connecting)
		this.schedulePoll(0)
		void this.pollCueEvents()
	}

	async destroy(): Promise<void> {
		if (this.pollTimer) clearTimeout(this.pollTimer)
		this.pollTimer = null
		if (this.cueTimer) clearTimeout(this.cueTimer)
		this.cueTimer = null
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		this.lastSlugs = ''
		this.schedulePoll(0)
		void this.pollCueEvents()
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
	}

	baseUrl(): string {
		const base = (this.config.serverUrl || '').trim().replace(/\/+$/, '')
		if (!base) throw new Error('Server URL is not configured')
		return base
	}

	/** Headers for the server's protected API (setting cues), when it has an admin password. */
	authHeaders(): Record<string, string> {
		const pw = (this.config.password || '').trim()
		return pw ? { Authorization: `Basic ${Buffer.from(`admin:${pw}`).toString('base64')}` } : {}
	}

	async serverPost(path: string, body: unknown): Promise<any> {
		const response = await fetch(`${this.baseUrl()}${path}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
			body: JSON.stringify(body),
			signal: AbortSignal.timeout(15000),
		})
		const data: any = await response.json().catch(() => ({}))
		if (response.status === 401) throw new Error('The server needs its admin password (module settings).')
		if (!response.ok) throw new Error(data?.error || `Server returned HTTP ${response.status}`)
		return data
	}

	/** Cue names and events for the Set cue action, and the cue variables. */
	async pollCueEvents(): Promise<void> {
		if (this.cueTimer) clearTimeout(this.cueTimer)
		try {
			const response = await fetch(`${this.baseUrl()}/api/resi/events`, { headers: this.authHeaders(), signal: AbortSignal.timeout(15000) })
			if (response.ok) {
				const data = (await response.json()) as CueEventsResponse
				this.cueTypes = data.cueTypes ?? []
				this.cueEvents = data.events ?? []
				this.cueEvent = data.selected ?? null
				this.cuePrefix = data.prefix ?? ''
				if (data.last) this.lastCue = `${data.last.name} at ${data.last.position}`
				const lists = JSON.stringify([this.cueTypes, this.cueEvents.map((e) => [e.id, e.name, e.live])])
				if (lists !== this.lastCueLists) {
					this.lastCueLists = lists
					UpdateActions(this)
				}
				UpdateVariableValues(this)
			}
		} catch {
			// The countdown poll reports connection problems; keep the last lists.
		} finally {
			this.cueTimer = setTimeout(() => void this.pollCueEvents(), 30_000)
		}
	}

	schedulePoll(delayMs: number): void {
		if (this.pollTimer) clearTimeout(this.pollTimer)
		this.pollTimer = setTimeout(() => void this.poll(), delayMs)
	}

	async poll(): Promise<void> {
		const interval = Math.max(200, Number(this.config.pollIntervalMs) || 500)
		try {
			const base = (this.config.serverUrl || '').trim().replace(/\/+$/, '')
			if (!base) throw new Error('Bridge URL is not configured')
			const response = await fetch(`${base}/api/timers`, { signal: AbortSignal.timeout(3000) })
			if (!response.ok) throw new Error(`Bridge returned HTTP ${response.status}`)
			const data = (await response.json()) as TimersResponse
			this.timers = Array.isArray(data.timers) ? data.timers : []
			this.connected = true
			this.resiStatus = data.status?.message ?? ''

			// Rebuild definitions when campuses or their target cue types change.
			const slugs = this.timers.map((t) => `${t.slug}:${t.campusName}:${(t.targets ?? []).map((x) => x.key).join('+')}`).join(',')
			if (slugs !== this.lastSlugs) {
				this.lastSlugs = slugs
				UpdateVariableDefinitions(this)
				UpdateFeedbacks(this)
			}
			UpdateVariableValues(this)
			this.checkFeedbacks()

			if (data.status && !data.status.ok) {
				this.updateStatus(InstanceStatus.UnknownWarning, `Bridge can't reach Resi: ${data.status.message}`)
			} else if (this.config.campus && !this.timers.some((t) => t.slug === this.config.campus.trim().toLowerCase())) {
				this.updateStatus(InstanceStatus.BadConfig, `No venue "${this.config.campus}" on the server`)
			} else {
				this.updateStatus(InstanceStatus.Ok)
			}
			this.lastError = ''
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error)
			this.connected = false
			if (message !== this.lastError) this.log('warn', `Poll failed: ${message}`)
			this.lastError = message
			this.updateStatus(InstanceStatus.ConnectionFailure, message)
			UpdateVariableValues(this)
		} finally {
			this.schedulePoll(interval)
		}
	}
}

runEntrypoint(ModuleInstance, [])
