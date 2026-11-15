import { InstanceBase, InstanceStatus, runEntrypoint, type SomeCompanionConfigField } from '@companion-module/base'
import { GetConfigFields, type ModuleConfig } from './config.js'
import { UpdateFeedbacks } from './feedbacks.js'
import type { CampusTimer, TimersResponse } from './types.js'
import { UpdateVariableDefinitions, UpdateVariableValues } from './variables.js'

export class ModuleInstance extends InstanceBase<ModuleConfig> {
	config!: ModuleConfig
	timers: CampusTimer[] = []
	connected = false
	resiStatus = ''
	pollTimer: NodeJS.Timeout | null = null
	lastSlugs = ''
	lastError = ''

	constructor(internal: unknown) {
		super(internal)
	}

	async init(config: ModuleConfig): Promise<void> {
		this.config = config
		UpdateVariableDefinitions(this)
		UpdateFeedbacks(this)
		this.updateStatus(InstanceStatus.Connecting)
		this.schedulePoll(0)
	}

	async destroy(): Promise<void> {
		if (this.pollTimer) clearTimeout(this.pollTimer)
		this.pollTimer = null
	}

	async configUpdated(config: ModuleConfig): Promise<void> {
		this.config = config
		this.lastSlugs = ''
		this.schedulePoll(0)
	}

	getConfigFields(): SomeCompanionConfigField[] {
		return GetConfigFields()
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
