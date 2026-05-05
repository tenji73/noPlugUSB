const fs = require('fs');
const fsPromises = require('fs').promises;
const path = require('path');
const { exec } = require('child_process');
const util = require('util');

const execPromise = util.promisify(exec);
const { isProductionRuntime } = require('../utils/isProduction');

const IS_PROD = isProductionRuntime();
const PROD_DRIVES_DIR = '/home/pi/noplugusb/data/drives';
/**
 * Mount loop images here only for df/walk — avoids clashing with `mockFileService` at `/mnt/noplugusb_mount`.
 * Keep under the data dir so `pi` can `mkdir` without root (not `/mnt/...`, which often causes EACCES).
 */
const PROD_STATS_MOUNT = path.join(path.dirname(PROD_DRIVES_DIR), 'stats_mount_loop');

const DRIVES_PATH = path.join(__dirname, '..', '..', 'drives.json');

/**
 * Production (Pi) runtime state: no JSON DB dependency.
 * Drives are discovered from the SD card on service start.
 */
const prodState = {
	systemState: {
		activeDriveId: null,
		lastConnectedAt: null,
		isPrinterIdle: true,
	},
	/** @type {Array<any>} */
	drives: [],
};

function sanitizeIdFromFilename(filename) {
	return String(filename || '')
		.replace(/\\/g, '/')
		.split('/')
		.pop()
		.replace(/[^a-zA-Z0-9_.\-]+/g, '_')
		.replace(/^_+|_+$/g, '');
}

function displayNameFromFilename(filename) {
	const base = String(filename || '').replace(/\.bin$/i, '');
	const pretty = base.replace(/[_\-]+/g, ' ').trim();
	return pretty.length ? pretty : base || 'Drive';
}

/**
 * Walk files under `dirAbs` (same visibility rules as production file listing).
 * @param {string} dirAbs
 * @returns {{ fileCount: number; sumBytes: number }}
 */
function sumBytesAndCountFiles(dirAbs) {
	let fileCount = 0;
	let sumBytes = 0;
	function walk(dir) {
		let entries;
		try {
			entries = fs.readdirSync(dir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (ent.name.startsWith('.') && ent.name !== '.noplugdir') continue;
			const full = path.join(dir, ent.name);
			if (ent.isDirectory()) {
				walk(full);
			} else if (ent.isFile()) {
				fileCount += 1;
				try {
					sumBytes += fs.statSync(full).size;
				} catch (_) {}
			}
		}
	}
	walk(dirAbs);
	return { fileCount, sumBytes };
}

/**
 * @param {string} mountPoint
 * @returns {Promise<{ totalBytes: number; usedBytes: number }>}
 */
async function readDfBytes(mountPoint) {
	let totalBytes = 0;
	let usedBytes = 0;
	try {
		const { stdout } = await execPromise(
			`df -B1 --output=size,used "${mountPoint}" 2>/dev/null`,
		);
		const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
		if (lines.length >= 2) {
			const last = lines[lines.length - 1];
			const parts = last.trim().split(/\s+/);
			if (parts.length >= 2) {
				totalBytes = parseInt(parts[0], 10) || 0;
				usedBytes = parseInt(parts[1], 10) || 0;
				if (totalBytes > 0 || usedBytes > 0) {
					return { totalBytes, usedBytes };
				}
			}
		}
	} catch (_) {}
	try {
		const { stdout } = await execPromise(`df -B1 -P "${mountPoint}" 2>/dev/null`);
		const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
		if (lines.length < 2) return { totalBytes: 0, usedBytes: 0 };
		const line =
			lines.find((l) => l.includes(mountPoint)) || lines[lines.length - 1];
		const parts = line.trim().split(/\s+/);
		if (parts.length >= 4) {
			totalBytes = parseInt(parts[1], 10) || 0;
			usedBytes = parseInt(parts[2], 10) || 0;
		}
	} catch (_) {}
	if (totalBytes === 0 && usedBytes === 0) {
		try {
			const { stdout } = await execPromise(`df -B1 "${mountPoint}"`);
			const lines = stdout.trim().split('\n').filter((l) => l.length > 0);
			if (lines.length >= 2) {
				const parts = lines[lines.length - 1].trim().split(/\s+/);
				if (parts.length >= 4) {
					totalBytes = parseInt(parts[1], 10) || 0;
					usedBytes = parseInt(parts[2], 10) || 0;
				}
			}
		} catch (_) {}
	}
	return { totalBytes, usedBytes };
}

/**
 * Mount a `.bin` briefly, read `df` usage + file count, then unmount.
 * @param {string} imagePath — absolute path to the drive image
 * @returns {Promise<{ usedBytes: number; fileCount: number; totalBytes: number }>}
 */
async function computeProdDriveUsage(imagePath) {
	const mountPoint = PROD_STATS_MOUNT;
	fs.mkdirSync(mountPoint, { recursive: true });
	try {
		try {
			await execPromise(`sudo umount "${mountPoint}"`);
		} catch (_) {}
		await execPromise(
			`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
		);

		let { totalBytes, usedBytes } = await readDfBytes(mountPoint);
		const { fileCount, sumBytes } = sumBytesAndCountFiles(mountPoint);

		if (totalBytes === 0 && sumBytes > 0) {
			try {
				const st = fs.statSync(imagePath);
				if (st.isFile() && Number.isFinite(st.size)) totalBytes = st.size;
			} catch (_) {}
		}
		if (usedBytes === 0 && sumBytes > 0) {
			const cap = totalBytes > 0 ? totalBytes : sumBytes;
			usedBytes = Math.min(sumBytes, cap);
		}

		return {
			usedBytes: Math.max(0, usedBytes),
			fileCount: Math.max(0, fileCount),
			totalBytes: Math.max(0, totalBytes),
		};
	} finally {
		try {
			await execPromise(`sudo umount "${mountPoint}"`);
		} catch (_) {}
	}
}

/** Refresh `usedBytes`, `fileCount`, and `size` (total FS) for every production drive. */
async function refreshProdDriveStats() {
	if (!IS_PROD) return;
	for (const d of prodState.drives) {
		const imagePath = d.path || path.join(PROD_DRIVES_DIR, d.filename);
		if (!imagePath || !fs.existsSync(imagePath)) continue;
		try {
			const stats = await computeProdDriveUsage(imagePath);
			d.usedBytes = stats.usedBytes;
			d.fileCount = stats.fileCount;
			if (stats.totalBytes > 0) {
				d.size = stats.totalBytes;
			} else {
				const st = fs.statSync(imagePath);
				if (st.isFile() && Number.isFinite(st.size)) {
					d.size = st.size;
				}
			}
		} catch (e) {
			console.warn(
				'[driveService] refreshProdDriveStats',
				d.filename,
				e && e.message ? e.message : e,
			);
		}
	}
}

/**
 * Production only: rebuild drive list from `/home/pi/noplugusb/data/drives/*.bin`.
 * Ensures the UI still shows drives after `systemctl restart`.
 */
function initializeDrivesFromDisk() {
	if (!IS_PROD) return;
	let names = [];
	try {
		names = fs.readdirSync(PROD_DRIVES_DIR);
	} catch {
		// Directory may not exist yet on first boot; create it so future writes succeed.
		try {
			fs.mkdirSync(PROD_DRIVES_DIR, { recursive: true });
			names = [];
		} catch {
			names = [];
		}
	}

	const drives = [];
	for (const name of names) {
		if (!name || typeof name !== 'string') continue;
		if (!name.toLowerCase().endsWith('.bin')) continue;
		const fullPath = path.join(PROD_DRIVES_DIR, name);
		let st;
		try {
			st = fs.statSync(fullPath);
		} catch {
			continue;
		}
		if (!st.isFile()) continue;

		const id = sanitizeIdFromFilename(name) || name;
		drives.push({
			id,
			path: fullPath,
			filename: name,
			displayName: displayNameFromFilename(name),
			description: '',
			size: Number.isFinite(st.size) ? st.size : 0,
			format: 'FAT32',
			icon: '💾',
			themeColor: 'blue',
			usedBytes: 0,
			fileCount: 0,
		});
	}
	prodState.drives = drives;
	// Best-effort: write a snapshot JSON file so external tools / debugging can inspect it.
	// The source of truth in production is the .bin files on disk.
	try {
		fs.writeFileSync(
			DRIVES_PATH,
			JSON.stringify({ systemState: prodState.systemState, drives: prodState.drives }, null, 2),
			'utf8',
		);
	} catch (_) {}
}

function createDefaultState() {
	return {
		systemState: {
			activeDriveId: null,
			lastConnectedAt: null,
			isPrinterIdle: true,
		},
		drives: [],
	};
}

function ensureShape(data) {
	const defaults = createDefaultState();
	if (!data || typeof data !== 'object') {
		return { ...defaults };
	}
	if (!Array.isArray(data.drives)) {
		data.drives = [];
	}
	if (!data.systemState || typeof data.systemState !== 'object') {
		data.systemState = { ...defaults.systemState };
	}
	const sys = data.systemState;
	if (sys.activeDriveId === undefined) sys.activeDriveId = null;
	if (sys.lastConnectedAt === undefined) sys.lastConnectedAt = null;
	if (sys.isPrinterIdle === undefined) sys.isPrinterIdle = true;
	return data;
}

function ensureDrivesFile() {
	if (!fs.existsSync(DRIVES_PATH)) {
		fs.writeFileSync(DRIVES_PATH, JSON.stringify(createDefaultState(), null, 2), 'utf8');
	}
}

ensureDrivesFile();
initializeDrivesFromDisk();

function delay(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function generateUniqueId() {
	return `drive_${Math.floor(100000 + Math.random() * 900000)}`;
}

function normalizeDisplayNameKey(name) {
	return String(name ?? '')
		.trim()
		.toLowerCase();
}

function toSafeBinFilename(displayName) {
	const base = String(displayName || 'drive')
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, '_')
		.replace(/^_+|_+$/g, '')
		.slice(0, 80);
	const safe = base.length > 0 ? base : 'drive';
	return `${safe}.bin`;
}

async function writeFileJson(data) {
	await fsPromises.writeFile(DRIVES_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Reads persisted JSON. Migrates legacy array-only files to the global state object and saves.
 */
async function _readData() {
	const raw = await fsPromises.readFile(DRIVES_PATH, 'utf8');
	let parsed;
	try {
		parsed = JSON.parse(raw);
	} catch {
		const empty = createDefaultState();
		await writeFileJson(empty);
		return empty;
	}

	if (parsed === null || typeof parsed !== 'object') {
		const empty = createDefaultState();
		await writeFileJson(empty);
		return empty;
	}

	if (Array.isArray(parsed)) {
		const migrated = createDefaultState();
		migrated.drives = parsed;
		await writeFileJson(migrated);
		return migrated;
	}

	const data = ensureShape(parsed);
	const needsPersist = !parsed.systemState || !Array.isArray(parsed.drives);
	let statsDirty = false;
	for (const d of data.drives) {
		const before = JSON.stringify({ u: d.usedBytes, f: d.fileCount, z: d.size });
		ensureDriveStats(d);
		ensureDriveSizeBytes(d);
		const after = JSON.stringify({ u: d.usedBytes, f: d.fileCount, z: d.size });
		if (before !== after) statsDirty = true;
	}
	if (needsPersist || statsDirty) {
		await writeFileJson(data);
	}
	return data;
}

/** Total capacity: bytes. Migrates legacy JSON that stored GiB as a small number (e.g. 8 → 8 GiB). */
function ensureDriveSizeBytes(d) {
	const s = Number(d.size);
	if (!Number.isFinite(s) || s < 0) {
		d.size = 0;
		return;
	}
	// Legacy: value was GiB (integer ≤ 4096 or fractional like 0.5), not byte count
	if (s > 0 && s <= 4096 && s < 1024 * 1024) {
		d.size = Math.round(s * 1024 * 1024 * 1024);
	} else {
		d.size = Math.round(s);
	}
}

/** Demo / live stats: bytes used and file count; defaulted when missing. */
function ensureDriveStats(d) {
	if (typeof d.usedBytes !== 'number' || !Number.isFinite(d.usedBytes) || d.usedBytes < 0) {
		d.usedBytes = 0;
	}
	if (typeof d.fileCount !== 'number' || !Number.isFinite(d.fileCount) || d.fileCount < 0) {
		d.fileCount = 0;
	}
	return d;
}

async function getDrives() {
	if (IS_PROD) {
		await refreshProdDriveStats();
		return prodState.drives;
	}
	const data = await _readData();
	return data.drives;
}

async function getFullState() {
	if (IS_PROD) {
		await refreshProdDriveStats();
		return prodState;
	}
	return _readData();
}

async function setActiveDrive(driveId) {
	if (IS_PROD) {
		const now = new Date().toISOString();
		const id = driveId === null || driveId === undefined ? null : String(driveId);
		prodState.systemState.activeDriveId = id;
		prodState.systemState.lastConnectedAt = now;
		prodState.systemState.isPrinterIdle = id === null;
		return prodState.systemState;
	}
	const data = await _readData();
	const now = new Date().toISOString();
	const id = driveId === null || driveId === undefined ? null : String(driveId);
	data.systemState.activeDriveId = id;
	data.systemState.lastConnectedAt = now;
	data.systemState.isPrinterIdle = id === null;
	await writeFileJson(data);
	return data.systemState;
}

async function createDrive(driveData) {
	const {
		displayName = '',
		description = '',
		size = 0,
		format = 'FAT32',
		icon = '💾',
		themeColor = 'blue',
	} = driveData || {};

	const displayNameStr = String(displayName).trim();
	if (!displayNameStr) {
		const err = new Error('Display name is required.');
		err.code = 'VALIDATION';
		throw err;
	}

	const data = await _readData();
	const existing = data.drives;
	const filename = toSafeBinFilename(displayNameStr);
	const nameKey = normalizeDisplayNameKey(displayNameStr);

	for (const d of existing) {
		if (normalizeDisplayNameKey(d.displayName) === nameKey) {
			const err = new Error('A drive with this name already exists.');
			err.code = 'DUPLICATE_DRIVE';
			throw err;
		}
		if (d.filename === filename) {
			const err = new Error(
				'Another drive already uses this disk image filename. Pick a different display name.',
			);
			err.code = 'DUPLICATE_DRIVE';
			throw err;
		}
	}

	let id = generateUniqueId();
	while (existing.some((d) => d.id === id)) {
		id = generateUniqueId();
	}

	const sizeNum = Number(size);
	const sizeBytes =
		Number.isFinite(sizeNum) && sizeNum >= 0 ? Math.round(sizeNum) : 0;

	if (IS_PROD) {
		const drivesDir = PROD_DRIVES_DIR;
		const filePath = path.join(drivesDir, filename);
		try {
			fs.mkdirSync(drivesDir, { recursive: true });
			await execPromise(`sudo fallocate -l ${sizeBytes} ${filePath}`);
			await execPromise(`sudo mkfs.fat -F 32 ${filePath}`);
		} catch (error) {
			const err = new Error(
				`Failed to create or format drive image at ${filePath}: ${error && error.message ? error.message : error}`,
			);
			err.code = 'HARDWARE';
			throw err;
		}
	}

	const newDrive = {
		id,
		...(IS_PROD ? { path: path.join(PROD_DRIVES_DIR, filename) } : {}),
		filename,
		displayName: displayNameStr,
		description: String(description),
		size: sizeBytes,
		format: String(format),
		icon: String(icon),
		themeColor: String(themeColor),
		usedBytes: 0,
		fileCount: 0,
	};

	existing.push(newDrive);
	if (!IS_PROD) {
		await writeFileJson(data);
		await delay(2000);
	} else {
		prodState.drives = existing;
		try {
			fs.writeFileSync(
				DRIVES_PATH,
				JSON.stringify({ systemState: prodState.systemState, drives: prodState.drives }, null, 2),
				'utf8',
			);
		} catch (_) {}
	}
	return newDrive;
}

async function updateDrive(driveId, updates) {
	if (IS_PROD) {
		const id = String(driveId);
		const idx = prodState.drives.findIndex((d) => String(d.id) === id);
		if (idx === -1) {
			const err = new Error('Drive not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const drive = prodState.drives[idx];
		const { displayName, description, size, icon } = updates || {};

		let nextName = drive.displayName;
		if (displayName !== undefined) {
			const s = String(displayName).trim();
			if (!s) {
				const err = new Error('Display name is required.');
				err.code = 'VALIDATION';
				throw err;
			}
			nextName = s;
		}

		const nameKey = normalizeDisplayNameKey(nextName);
		const nextFilename = toSafeBinFilename(nextName);

		for (const d of prodState.drives) {
			if (String(d.id) === id) continue;
			if (normalizeDisplayNameKey(d.displayName) === nameKey) {
				const err = new Error('A drive with this name already exists.');
				err.code = 'DUPLICATE_DRIVE';
				throw err;
			}
			if (d.filename === nextFilename) {
				const err = new Error(
					'Another drive already uses this disk image filename. Pick a different display name.',
				);
				err.code = 'DUPLICATE_DRIVE';
				throw err;
			}
		}

		// If renaming, move the underlying .bin on disk.
		if (drive.filename !== nextFilename) {
			const oldPath = path.join(PROD_DRIVES_DIR, drive.filename);
			const newPath = path.join(PROD_DRIVES_DIR, nextFilename);
			try {
				await execPromise(`sudo mv "${oldPath}" "${newPath}"`);
			} catch (e) {
				const err = new Error('Failed to rename drive image on disk.');
				err.code = 'HARDWARE';
				throw err;
			}
			drive.filename = nextFilename;
			drive.path = newPath;
			drive.id = sanitizeIdFromFilename(nextFilename) || drive.id;
		}

		drive.displayName = nextName;
		if (description !== undefined) drive.description = String(description);
		if (size !== undefined) {
			const n = Number(size);
			drive.size = Number.isFinite(n) && n >= 0 ? Math.round(n) : drive.size;
		}
		if (icon !== undefined) drive.icon = String(icon);
		try {
			fs.writeFileSync(
				DRIVES_PATH,
				JSON.stringify({ systemState: prodState.systemState, drives: prodState.drives }, null, 2),
				'utf8',
			);
		} catch (_) {}
		return drive;
	}
	const data = await _readData();
	const id = String(driveId);
	const idx = data.drives.findIndex((d) => d.id === id);
	if (idx === -1) {
		const err = new Error('Drive not found');
		err.code = 'NOT_FOUND';
		throw err;
	}

	const drive = data.drives[idx];
	const { displayName, description, size, icon } = updates || {};

	let nextName = drive.displayName;
	if (displayName !== undefined) {
		const s = String(displayName).trim();
		if (!s) {
			const err = new Error('Display name is required.');
			err.code = 'VALIDATION';
			throw err;
		}
		nextName = s;
	}

	const nameKey = normalizeDisplayNameKey(nextName);
	const filename = toSafeBinFilename(nextName);

	for (const d of data.drives) {
		if (d.id === id) continue;
		if (normalizeDisplayNameKey(d.displayName) === nameKey) {
			const err = new Error('A drive with this name already exists.');
			err.code = 'DUPLICATE_DRIVE';
			throw err;
		}
		if (d.filename === filename) {
			const err = new Error(
				'Another drive already uses this disk image filename. Pick a different display name.',
			);
			err.code = 'DUPLICATE_DRIVE';
			throw err;
		}
	}

	drive.displayName = nextName;
	drive.filename = filename;
	if (description !== undefined) {
		drive.description = String(description);
	}
	if (size !== undefined) {
		const n = Number(size);
		drive.size = Number.isFinite(n) && n >= 0 ? Math.round(n) : 0;
	}
	if (icon !== undefined) {
		drive.icon = String(icon);
	}

	await writeFileJson(data);
	return drive;
}

async function deleteDrive(driveId) {
	if (IS_PROD) {
		const id = String(driveId);
		const idx = prodState.drives.findIndex((d) => String(d.id) === id);
		if (idx === -1) {
			const err = new Error('Drive not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const drive = prodState.drives[idx];
		const filePath = path.join(PROD_DRIVES_DIR, drive.filename);
		try {
			await execPromise(`sudo rm -f "${filePath}"`);
		} catch (e) {
			const err = new Error('Failed to delete drive image on disk.');
			err.code = 'HARDWARE';
			throw err;
		}
		prodState.drives.splice(idx, 1);
		if (prodState.systemState.activeDriveId === id) {
			prodState.systemState.activeDriveId = null;
			prodState.systemState.lastConnectedAt = new Date().toISOString();
			prodState.systemState.isPrinterIdle = true;
		}
		try {
			fs.writeFileSync(
				DRIVES_PATH,
				JSON.stringify({ systemState: prodState.systemState, drives: prodState.drives }, null, 2),
				'utf8',
			);
		} catch (_) {}
		return prodState;
	}
	const data = await _readData();
	const id = String(driveId);
	const before = data.drives.length;
	data.drives = data.drives.filter((d) => d.id !== id);
	if (data.drives.length === before) {
		const err = new Error('Drive not found');
		err.code = 'NOT_FOUND';
		throw err;
	}
	if (data.systemState.activeDriveId === id) {
		data.systemState.activeDriveId = null;
		data.systemState.lastConnectedAt = new Date().toISOString();
		data.systemState.isPrinterIdle = true;
	}
	await writeFileJson(data);
	return data;
}

/**
 * Production: lookup drive in memory without triggering {@link refreshProdDriveStats}.
 * For internal callers that mount images themselves (e.g. volume stats).
 * @param {string} driveId
 * @returns {object | null}
 */
function getProdDriveById(driveId) {
	if (!IS_PROD) return null;
	const id = String(driveId);
	return prodState.drives.find((d) => String(d.id) === id) ?? null;
}

module.exports = {
	getDrives,
	getFullState,
	getProdDriveById,
	setActiveDrive,
	createDrive,
	updateDrive,
	deleteDrive,
};
