/** Matches backend `toSafeBinFilename` so the UI can predict collisions. */
export function displayNameToBinFilename(displayName: string): string {
	const base = String(displayName || 'drive')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 80);
	const safe = base.length > 0 ? base : 'drive';
	return `${safe}.bin`;
}

export function normalizeDriveNameKey(displayName: string): string {
	return String(displayName ?? '')
		.trim()
		.toLowerCase();
}
