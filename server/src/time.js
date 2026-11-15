/**
 * Resi positions come as "HH:MM:SS" (decoder telemetry) or "HH:MM:SS.mmm" (cues).
 * Mirrors Studio's own parser: numbers are milliseconds, strings are colon-separated.
 */
export function positionToSeconds(value) {
	if (value === null || value === undefined || value === '') return NaN
	if (typeof value === 'number') return value / 1000
	const parts = String(value).trim().split(':')
	const nums = parts.map((p) => Number(p))
	if (nums.some((n) => Number.isNaN(n))) return NaN
	if (nums.length === 1) return nums[0]
	if (nums.length === 2) return nums[0] * 60 + nums[1]
	if (nums.length === 3) return nums[0] * 3600 + nums[1] * 60 + nums[2]
	return NaN
}

/** 2063 -> "34:23", 3725 -> "1:02:05", -65 -> "-1:05" */
export function formatClock(totalSeconds, { forceHours = false } = {}) {
	if (!Number.isFinite(totalSeconds)) return ''
	const negative = totalSeconds < 0
	const secs = Math.abs(Math.round(totalSeconds))
	const h = Math.floor(secs / 3600)
	const m = Math.floor((secs % 3600) / 60)
	const s = secs % 60
	const body =
		h > 0 || forceHours
			? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
			: `${m}:${String(s).padStart(2, '0')}`
	return negative ? `-${body}` : body
}

export function formatPosition(totalSeconds) {
	if (!Number.isFinite(totalSeconds)) return ''
	return formatClock(totalSeconds, { forceHours: true })
}
