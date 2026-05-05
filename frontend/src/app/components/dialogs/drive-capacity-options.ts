/** Preset capacities for create/edit drive UI (binary GiB → bytes via `gbToBytes`). */
export interface DriveCapacityOption {
	label: string;
	gb: number;
}

export const DRIVE_CAPACITY_OPTIONS: ReadonlyArray<DriveCapacityOption> = [
	{ label: '512 MB', gb: 0.5 },
	{ label: '1 GB', gb: 1 },
	{ label: '4 GB', gb: 4 },
	{ label: '8 GB', gb: 8 },
	{ label: '16 GB', gb: 16 },
	{ label: '32 GB', gb: 32 },
	{ label: '64 GB', gb: 64 },
	{ label: '128 GB', gb: 128 },
	{ label: '256 GB', gb: 256 },
];
