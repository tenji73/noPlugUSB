/** Binary GiB → bytes (use for UI “GB” picks → API). */
export function gbToBytes(gb: number): number {
	return Math.round(gb * 1024 * 1024 * 1024);
}

/** Bytes → binary GiB (for comparing to preset sizes). */
export function bytesToGb(bytes: number): number {
	return bytes / (1024 * 1024 * 1024);
}

/** Non-negative bytes remaining; both capacities are total bytes. `usedBytes` defaults to 0 if missing. */
export function driveRemainingBytes(capacityBytes: number, usedBytes: number | undefined): number {
	const cap =
		typeof capacityBytes === 'number' && Number.isFinite(capacityBytes) && capacityBytes >= 0
			? capacityBytes
			: 0;
	const used = typeof usedBytes === 'number' && Number.isFinite(usedBytes) ? usedBytes : 0;
	return Math.max(0, cap - used);
}

/** Short human-readable size (binary units). */
export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes < 0) return '—';
	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	let v = bytes;
	let u = 0;
	while (v >= 1024 && u < units.length - 1) {
		v /= 1024;
		u++;
	}
	const n = u === 0 ? Math.round(v) : v < 10 ? Math.round(v * 10) / 10 : Math.round(v);
	return `${n} ${units[u]}`;
}
