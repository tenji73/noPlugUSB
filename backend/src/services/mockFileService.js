const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
const util = require('util');
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const thumbnailService = require('./thumbnailService');
const driveService = require('./driveService');
const { isProductionRuntime } = require('../utils/isProduction');

const execPromise = util.promisify(exec);
const IS_PROD = isProductionRuntime();
const PROD_DRIVES_DIR = '/home/pi/noplugusb/data/drives';
const PROD_MOUNT_POINT = '/mnt/noplugusb_mount';

const UPLOADS_ROOT = path.join(__dirname, '../../uploads');

/** @param {string} dirAbs */
function walkFilesRecursive(dirAbs) {
	const out = [];
	let entries;
	try {
		entries = fs.readdirSync(dirAbs, { withFileTypes: true });
	} catch {
		return out;
	}
	for (const e of entries) {
		const full = path.join(dirAbs, e.name);
		if (e.isDirectory()) {
			out.push(...walkFilesRecursive(full));
		} else if (e.isFile()) {
			out.push(full);
		}
	}
	return out;
}

/**
 * Mock volume listing + in-memory registry of uploads per drive (metadata only).
 * Disk bytes live under `backend/uploads/` via Multer; this layer tracks catalog entries.
 */
class MockFileService {
	constructor() {
		/** @type {Map<string, Array<{ id: string; name: string; sizeBytes: number; dateModified: string; extension: string; relativePath?: string; storagePath: string }>>} */
		this._uploadsByDrive = new Map();
		this._idSeq = 1;
	}

	_logicalKey(entry) {
		return entry.relativePath && entry.relativePath.length > 0 ? entry.relativePath : entry.name;
	}

	/**
	 * @param {string} driveId
	 * @param {string} logicalPath — same rules as upload (relative path or basename at root)
	 */
	hasLogicalPath(driveId, logicalPath) {
		const list = this._uploadsByDrive.get(String(driveId)) ?? [];
		const want = String(logicalPath || '').replace(/\\/g, '/');
		return list.some((e) => this._logicalKey(e) === want);
	}

	_extensionFromName(name) {
		const base = path.basename(String(name || ''));
		const i = base.lastIndexOf('.');
		return i >= 0 ? base.slice(i).toLowerCase() : '';
	}

	_nextId() {
		return `f_up_${Date.now()}_${this._idSeq++}`;
	}

	_absPath(driveId, storagePath) {
		const parts = String(storagePath || '').split('/').filter(Boolean);
		return path.join(UPLOADS_ROOT, String(driveId), ...parts);
	}

	/**
	 * Reject paths where any segment starts with "." (except empty). Used for uploads, renames, and new folders.
	 */
	assertPathSegmentsNoLeadingDot(posixPath) {
		const cleaned = String(posixPath || '').replace(/\\/g, '/');
		const segments = cleaned.split('/').filter((s) => s.length > 0);
		for (const seg of segments) {
			if (seg.startsWith('.')) {
				const err = new Error('Names cannot start with a period (.)');
				err.code = 'VALIDATION';
				throw err;
			}
		}
	}

	/**
	 * Recursively collect POSIX relative paths (from drive root) for every file under `absDir`.
	 * Skips dotfiles (e.g. `.DS_Store`).
	 * @param {string} absDir
	 * @param {string} relPrefix — posix segments or ''
	 * @param {string[]} acc
	 */
	_collectRelativeFilePaths(absDir, relPrefix, acc) {
		let entries;
		try {
			entries = fs.readdirSync(absDir, { withFileTypes: true });
		} catch {
			return;
		}
		for (const ent of entries) {
			if (ent.name.startsWith('.') && ent.name !== '.noplugdir') continue;
			const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
			const posix = rel.replace(/\\/g, '/');
			const childAbs = path.join(absDir, ent.name);
			if (ent.isDirectory()) {
				this._collectRelativeFilePaths(childAbs, posix, acc);
			} else if (ent.isFile()) {
				acc.push(posix);
			}
		}
	}

	/**
	 * Reconcile the in-memory catalog with files actually present under `uploads/<driveId>/`.
	 * Picks up files copied in manually, restores after server restart, and drops stale catalog rows.
	 */
	syncUploadsFromDisk(driveId) {
		const id = String(driveId);
		const driveRoot = path.join(UPLOADS_ROOT, id);
		if (!fs.existsSync(driveRoot)) {
			this._uploadsByDrive.set(id, []);
			return;
		}

		/** @type {string[]} */
		const diskPaths = [];
		this._collectRelativeFilePaths(driveRoot, '', diskPaths);
		diskPaths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

		const prev = this._uploadsByDrive.get(id) ?? [];
		const byStorage = new Map(prev.map((e) => [e.storagePath, e]));

		/** @type {typeof prev} */
		const next = [];
		for (const storagePath of diskPaths) {
			const abs = this._absPath(id, storagePath);
			let stat;
			try {
				stat = fs.statSync(abs);
			} catch {
				continue;
			}
			if (!stat.isFile()) continue;

			const name = path.basename(storagePath);
			let entry = byStorage.get(storagePath);
			if (entry) {
				entry.sizeBytes = stat.size;
				entry.dateModified = stat.mtime.toISOString();
				entry.name = name;
				entry.extension = this._extensionFromName(name);
				if (storagePath.includes('/')) {
					entry.relativePath = storagePath.replace(/\\/g, '/');
				} else {
					delete entry.relativePath;
				}
				entry.storagePath = storagePath.replace(/\\/g, '/');
				next.push(entry);
				byStorage.delete(storagePath);
			} else {
				const rel = storagePath.replace(/\\/g, '/');
				next.push({
					id: this._nextId(),
					name,
					sizeBytes: stat.size,
					dateModified: stat.mtime.toISOString(),
					extension: this._extensionFromName(name),
					storagePath: rel,
					...(rel.includes('/') ? { relativePath: rel } : {}),
				});
			}
		}

		this._uploadsByDrive.set(id, next);
	}

	/**
	 * Create an empty directory under the drive root. Adds a `.noplugdir` marker file so the folder
	 * appears in the file tree (folders are derived from paths).
	 * @param {string} posixRelative e.g. `Photos` or `Photos/2024`
	 */
	async createFolder(driveId, posixRelative) {
		const id = String(driveId);
		const raw = String(posixRelative || '').trim().replace(/\\/g, '/');
		const normalized = raw.replace(/^\/+|\/+$/g, '');
		if (!normalized) {
			const err = new Error('Folder path is required');
			err.code = 'VALIDATION';
			throw err;
		}
		if (normalized.includes('..') || normalized.startsWith('/')) {
			const err = new Error('Invalid path');
			err.code = 'VALIDATION';
			throw err;
		}
		const segments = normalized.split('/').filter((s) => s.length > 0);
		if (segments.some((s) => s === '.noplugdir')) {
			const err = new Error('Invalid path');
			err.code = 'VALIDATION';
			throw err;
		}
		this.assertPathSegmentsNoLeadingDot(normalized);

		if (IS_PROD) {
			const drives = await driveService.getDrives();
			const drive = drives.find((d) => String(d.id) === id);
			if (!drive) {
				const err = new Error('Drive not found');
				err.code = 'NOT_FOUND';
				throw err;
			}
			const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
			const mountPoint = PROD_MOUNT_POINT;
			let mounted = false;
			try {
				fs.mkdirSync(mountPoint, { recursive: true });
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
				await execPromise(
					`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
				);
				mounted = true;

				const targetDir = path.join(mountPoint, ...segments);
				const resolvedMount = path.resolve(mountPoint);
				const resolvedTarget = path.resolve(targetDir);
				if (!resolvedTarget.startsWith(resolvedMount + path.sep) && resolvedTarget !== resolvedMount) {
					const err = new Error('Invalid path');
					err.code = 'VALIDATION';
					throw err;
				}

				if (fs.existsSync(resolvedTarget)) {
					const st = fs.statSync(resolvedTarget);
					if (st.isFile()) {
						const err = new Error('A file already exists at that path');
						err.code = 'PATH_EXISTS';
						throw err;
					}
				} else {
					const parent = path.dirname(resolvedTarget);
					if (fs.existsSync(parent)) {
						const pst = fs.statSync(parent);
						if (!pst.isDirectory()) {
							const err = new Error('Cannot create folder here');
							err.code = 'PATH_EXISTS';
							throw err;
						}
					}
					fs.mkdirSync(resolvedTarget, { recursive: true });
				}

				const marker = path.join(resolvedTarget, '.noplugdir');
				if (!fs.existsSync(marker)) {
					fs.writeFileSync(marker, '');
				}
				return { path: segments.join('/') };
			} finally {
				if (mounted) {
					try {
						await execPromise(`sudo umount "${mountPoint}"`);
					} catch (_) {}
				}
			}
		}

		const driveRoot = path.join(UPLOADS_ROOT, id);
		const targetDir = path.join(driveRoot, ...segments);
		const resolvedBase = path.resolve(driveRoot);
		const resolvedTarget = path.resolve(targetDir);
		if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
			const err = new Error('Invalid path');
			err.code = 'VALIDATION';
			throw err;
		}

		if (fs.existsSync(resolvedTarget)) {
			const st = fs.statSync(resolvedTarget);
			if (st.isFile()) {
				const err = new Error('A file already exists at that path');
				err.code = 'PATH_EXISTS';
				throw err;
			}
		} else {
			const parent = path.dirname(resolvedTarget);
			if (fs.existsSync(parent)) {
				const pst = fs.statSync(parent);
				if (!pst.isDirectory()) {
					const err = new Error('Cannot create folder here');
					err.code = 'PATH_EXISTS';
					throw err;
				}
			}
			fs.mkdirSync(resolvedTarget, { recursive: true });
		}

		const marker = path.join(resolvedTarget, '.noplugdir');
		if (!fs.existsSync(marker)) {
			fs.writeFileSync(marker, '');
		}

		this.syncUploadsFromDisk(id);
		return { path: segments.join('/') };
	}

	/**
	 * Remove a directory and everything under it from disk, then resync the catalog.
	 * @param {string} posixRelative path from volume root, e.g. `Photos/2024`
	 */
	async deleteFolderRecursive(driveId, posixRelative) {
		await delay(50);
		const id = String(driveId);
		const raw = String(posixRelative || '').trim().replace(/\\/g, '/');
		const normalized = raw.replace(/^\/+|\/+$/g, '');
		if (!normalized) {
			const err = new Error('Folder path is required');
			err.code = 'VALIDATION';
			throw err;
		}
		if (normalized.includes('..') || normalized.startsWith('/')) {
			const err = new Error('Invalid path');
			err.code = 'VALIDATION';
			throw err;
		}
		const segments = normalized.split('/').filter((s) => s.length > 0);

		if (IS_PROD) {
			const drives = await driveService.getDrives();
			const drive = drives.find((d) => String(d.id) === id);
			if (!drive) {
				const err = new Error('Drive not found');
				err.code = 'NOT_FOUND';
				throw err;
			}
			const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
			const mountPoint = PROD_MOUNT_POINT;
			let mounted = false;
			try {
				fs.mkdirSync(mountPoint, { recursive: true });
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
				await execPromise(
					`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
				);
				mounted = true;

				const targetAbs = path.join(mountPoint, ...segments);
				const resolvedMount = path.resolve(mountPoint);
				const resolvedTarget = path.resolve(targetAbs);
				if (!resolvedTarget.startsWith(resolvedMount + path.sep) && resolvedTarget !== resolvedMount) {
					const err = new Error('Invalid path');
					err.code = 'VALIDATION';
					throw err;
				}
				if (!fs.existsSync(resolvedTarget)) {
					const err = new Error('Folder not found');
					err.code = 'NOT_FOUND';
					throw err;
				}
				const st = fs.statSync(resolvedTarget);
				if (!st.isDirectory()) {
					const err = new Error('Not a folder');
					err.code = 'NOT_A_FOLDER';
					throw err;
				}
				fs.rmSync(resolvedTarget, { recursive: true, force: true });
				return { path: normalized };
			} finally {
				if (mounted) {
					try {
						await execPromise(`sudo umount "${mountPoint}"`);
					} catch (_) {}
				}
			}
		}

		const driveRoot = path.join(UPLOADS_ROOT, id);
		const targetAbs = path.join(driveRoot, ...segments);
		const resolvedBase = path.resolve(driveRoot);
		const resolvedTarget = path.resolve(targetAbs);
		if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
			const err = new Error('Invalid path');
			err.code = 'VALIDATION';
			throw err;
		}
		if (!fs.existsSync(resolvedTarget)) {
			const err = new Error('Folder not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const st = fs.statSync(resolvedTarget);
		if (!st.isDirectory()) {
			const err = new Error('Not a folder');
			err.code = 'NOT_A_FOLDER';
			throw err;
		}
		fs.rmSync(resolvedTarget, { recursive: true, force: true });
		this.syncUploadsFromDisk(id);
		return { path: normalized };
	}

	/**
	 * @param {string} driveId
	 * @returns {Promise<Array<{ id: string; name: string; sizeBytes: number; dateModified: string; extension: string; relativePath?: string; thumbnailURL?: string }>>}
	 */
	async getFilesInDrive(driveId) {
		await delay(200);
		const id = String(driveId);

		if (!IS_PROD) {
			this.syncUploadsFromDisk(id);
			const list = this._uploadsByDrive.get(id) ?? [];
			for (const entry of list) {
				const volRel = String(entry.storagePath || '').replace(/\\/g, '/').trim();
				if (!volRel) continue;
				// Skip if any cache exists (including CTB placeholder) — use POST .../thumbnails/regenerate to force.
				if (thumbnailService.getThumbnailAbsPath(id, volRel)) continue;
				const abs = this._absPath(id, entry.storagePath);
				if (!fs.existsSync(abs)) continue;
				try {
					await thumbnailService.generateThumbnailNow(id, volRel, abs);
				} catch (_) {
					/* best-effort */
				}
			}
			return list.map((entry) => {
				const { storagePath: _s, ...rest } = entry;
				const volRel = String(entry.storagePath || '').replace(/\\/g, '/').trim();
				let thumbnailURL;
				if (volRel) {
					const abs = thumbnailService.getThumbnailAbsPath(id, volRel);
					thumbnailURL = abs ? thumbnailService.thumbnailPublicPath(id, volRel) : undefined;
				}
				return {
					...rest,
					...(thumbnailURL ? { thumbnailURL } : {}),
				};
			});
		}

		// Production: mount the real disk image and read actual file listing.
		const drives = await driveService.getDrives();
		const drive = drives.find((d) => String(d.id) === id);
		if (!drive) {
			const err = new Error('Drive not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
		const mountPoint = PROD_MOUNT_POINT;

		const walkMountedFiles = (dirAbs, relPrefix, out) => {
			let entries;
			try {
				entries = fs.readdirSync(dirAbs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				// Keep `.noplugdir` markers so empty folders appear (same as dev `_collectRelativeFilePaths`).
				if (ent.name.startsWith('.') && ent.name !== '.noplugdir') continue;
				const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
				const childAbs = path.join(dirAbs, ent.name);
				if (ent.isDirectory()) {
					walkMountedFiles(childAbs, rel, out);
				} else if (ent.isFile()) {
					out.push(rel.replace(/\\/g, '/'));
				}
			}
		};

		let mounted = false;
		try {
			fs.mkdirSync(mountPoint, { recursive: true });
			// Best-effort: ensure the mount point is clean.
			try {
				await execPromise(`sudo umount "${mountPoint}"`);
			} catch (_) {}
			await execPromise(
				`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
			);
			mounted = true;

			const relPaths = [];
			walkMountedFiles(mountPoint, '', relPaths);
			relPaths.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));

			// Do not run eager thumbnail generation here on production (Pi). Listing used to call
			// `generateThumbnailNow` for every file; CTB preview extraction is memory-heavy and can
			// trigger the kernel OOM killer (node exits with signal 9 / SIGKILL). Cached `.webp` from
			// earlier runs or from `POST .../thumbnails/regenerate` still apply below.

			return relPaths.map((storagePath) => {
				const cleanStoragePath = String(storagePath || '')
					.replace(/\\/g, '/')
					.replace(/^\/+|\/+$/g, '');
				const abs = path.join(mountPoint, ...cleanStoragePath.split('/').filter(Boolean));
				let st;
				try {
					st = fs.statSync(abs);
				} catch {
					st = null;
				}
				const name = path.basename(cleanStoragePath);
				const ext = this._extensionFromName(name) || '';
				const volRel = cleanStoragePath;
				const thumbAbs = volRel ? thumbnailService.getThumbnailAbsPath(id, volRel) : null;
				const thumbnailURL = thumbAbs ? thumbnailService.thumbnailPublicPath(id, volRel) : undefined;
				const sizeBytes = st && st.isFile() && Number.isFinite(st.size) ? st.size : 0;
				const dateModified =
					st && st.isFile() && st.mtime instanceof Date && !Number.isNaN(st.mtime.getTime())
						? st.mtime.toISOString()
						: new Date(0).toISOString();
				return {
					id: volRel || name || String(Math.random()), // stable enough for listing; real hardware IDs can be added later
					name: String(name || ''),
					sizeBytes,
					dateModified: String(dateModified),
					extension: String(ext),
					...(volRel.includes('/') ? { relativePath: volRel } : {}),
					...(thumbnailURL ? { thumbnailURL } : {}),
				};
			});
		} finally {
			if (mounted) {
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
			}
		}
	}

	/**
	 * Fast file count + byte sum (same mount/walk rules as {@link getFilesInDrive}, no thumbnails).
	 * Used by the dashboard so card stats match the file manager (which sums listed files).
	 * @param {string} driveId
	 * @returns {Promise<{ fileCount: number; usedBytes: number }>}
	 */
	async getDriveVolumeStats(driveId) {
		const id = String(driveId);

		if (!IS_PROD) {
			this.syncUploadsFromDisk(id);
			const list = this._uploadsByDrive.get(id) ?? [];
			const usedBytes = list.reduce((acc, e) => acc + (Number(e.sizeBytes) || 0), 0);
			return { fileCount: list.length, usedBytes };
		}

		const drive = driveService.getProdDriveById(id);
		if (!drive) {
			const err = new Error('Drive not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
		const mountPoint = PROD_MOUNT_POINT;
		let mounted = false;
		try {
			fs.mkdirSync(mountPoint, { recursive: true });
			try {
				await execPromise(`sudo umount "${mountPoint}"`);
			} catch (_) {}
			await execPromise(
				`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
			);
			mounted = true;

			let fileCount = 0;
			let usedBytes = 0;
			const walk = (dirAbs) => {
				let entries;
				try {
					entries = fs.readdirSync(dirAbs, { withFileTypes: true });
				} catch {
					return;
				}
				for (const ent of entries) {
					if (ent.name.startsWith('.') && ent.name !== '.noplugdir') continue;
					const childAbs = path.join(dirAbs, ent.name);
					if (ent.isDirectory()) {
						walk(childAbs);
					} else if (ent.isFile()) {
						fileCount += 1;
						try {
							usedBytes += fs.statSync(childAbs).size;
						} catch (_) {}
					}
				}
			};
			walk(mountPoint);
			return { fileCount, usedBytes };
		} finally {
			if (mounted) {
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
			}
		}
	}

	/**
	 * @param {string} driveId
	 * @param {import('multer').File[]} filesArray
	 * @param {string[]} [pathsArray]
	 * @param {boolean} [overwrite]
	 * @returns {Promise<{ added: number }>}
	 */
	async addUploadedFiles(driveId, filesArray, pathsArray = [], overwrite = false) {
		const id = String(driveId);
		const arr = Array.isArray(filesArray) ? filesArray : [];
		const driveRoot = path.join(UPLOADS_ROOT, id);

		if (IS_PROD) {
			const drives = await driveService.getDrives();
			const drive = drives.find((d) => String(d.id) === id);
			if (!drive) {
				const err = new Error('Drive not found');
				err.code = 'NOT_FOUND';
				throw err;
			}
			const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
			const mountPoint = PROD_MOUNT_POINT;

			let mounted = false;
			try {
				fs.mkdirSync(mountPoint, { recursive: true });
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
				await execPromise(
					`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
				);
				mounted = true;

				for (let i = 0; i < arr.length; i++) {
					const f = arr[i];
					const originalName = f.originalname || f.filename || 'file';
					const rel = pathsArray[i] != null ? String(pathsArray[i]).replace(/\\/g, '/') : '';
					const logical =
						rel && rel.length > 0 ? rel : path.basename(String(originalName)).replace(/\\/g, '/');
					this.assertPathSegmentsNoLeadingDot(logical);

					const destAbs = path.join(mountPoint, ...logical.split('/').filter(Boolean));
					fs.mkdirSync(path.dirname(destAbs), { recursive: true });

					if (fs.existsSync(destAbs)) {
						if (!overwrite) {
							const err = new Error('DUPLICATE_FILE');
							err.code = 'DUPLICATE_FILE';
							err.logicalPath = logical;
							throw err;
						}
						try {
							fs.unlinkSync(destAbs);
						} catch (_) {}
					}

					// Cross-device move (uploads dir → mounted loop device): copy then delete.
					try {
						fs.copyFileSync(f.path, destAbs);
						fs.unlinkSync(f.path);
					} catch (e) {
						const err = new Error(
							`Failed to write into mounted drive image at ${logical}: ${e && e.message ? e.message : e}`,
						);
						err.code = 'IO';
						throw err;
					}

					// Thumbnails must be generated before umount — async queue would point at a path that disappears.
					const volKey = logical.replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
					try {
						await thumbnailService.generateThumbnailNow(id, volKey, destAbs);
					} catch (_) {
						/* best-effort */
					}
				}
				return { added: arr.length };
			} finally {
				// Always unmount to flush and avoid leaving the image locked.
				if (mounted) {
					try {
						await execPromise(`sudo umount "${mountPoint}"`);
					} catch (_) {}
				}
			}
		}

		if (!this._uploadsByDrive.has(id)) {
			this._uploadsByDrive.set(id, []);
		}
		const list = this._uploadsByDrive.get(id);

		for (let i = 0; i < arr.length; i++) {
			const f = arr[i];
			const name = f.originalname || f.filename || 'file';
			const rel = pathsArray[i] != null ? String(pathsArray[i]).replace(/\\/g, '/') : '';
			const logical = rel && rel.length > 0 ? rel : path.basename(name);
			this.assertPathSegmentsNoLeadingDot(logical);

			const existingIdx = list.findIndex((e) => this._logicalKey(e) === logical);
			if (existingIdx >= 0) {
				if (!overwrite) {
					if (f.path && fs.existsSync(f.path)) {
						try {
							fs.unlinkSync(f.path);
						} catch (_) {}
					}
					const err = new Error('DUPLICATE_FILE');
					err.code = 'DUPLICATE_FILE';
					err.logicalPath = logical;
					throw err;
				}
				const old = list[existingIdx];
				const oldAbs = this._absPath(id, old.storagePath);
				if (oldAbs !== f.path && fs.existsSync(oldAbs)) {
					try {
						fs.unlinkSync(oldAbs);
					} catch (_) {}
				}
				list.splice(existingIdx, 1);
			}

			const storagePath = path.relative(driveRoot, f.path).replace(/\\/g, '/');
			const entry = {
				id: this._nextId(),
				name: path.basename(name),
				sizeBytes: typeof f.size === 'number' ? f.size : 0,
				dateModified: new Date().toISOString(),
				extension: this._extensionFromName(name),
				storagePath,
			};
			if (rel) {
				entry.relativePath = rel;
			}
			list.push(entry);
			if (f.path) {
				try {
					await thumbnailService.generateThumbnailNow(id, storagePath, f.path);
				} catch (_) {
					/* best-effort */
				}
			}
		}
		return { added: arr.length };
	}

	/**
	 * Volume-relative path for a file; matches `id` from `getFilesInDrive` on the Pi (relative path or basename).
	 * @param {string} fileId
	 */
	_normalizeProdFileLogicalPath(fileId) {
		const raw = String(fileId ?? '')
			.replace(/\\/g, '/')
			.trim()
			.replace(/^\/+|\/+$/g, '');
		if (!raw || raw.includes('..')) {
			const err = new Error('Invalid file path');
			err.code = 'VALIDATION';
			throw err;
		}
		return raw;
	}

	/**
	 * @param {string} driveId
	 * @param {string} fileId
	 */
	async deleteFile(driveId, fileId) {
		await delay(50);
		const id = String(driveId);

		if (IS_PROD) {
			const logical = this._normalizeProdFileLogicalPath(fileId);
			const drives = await driveService.getDrives();
			const drive = drives.find((d) => String(d.id) === id);
			if (!drive) {
				const err = new Error('NOT_FOUND');
				err.code = 'NOT_FOUND';
				throw err;
			}
			const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
			const mountPoint = PROD_MOUNT_POINT;
			let mounted = false;
			try {
				fs.mkdirSync(mountPoint, { recursive: true });
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
				await execPromise(
					`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
				);
				mounted = true;

				const targetAbs = path.join(mountPoint, ...logical.split('/').filter(Boolean));
				const resolvedMount = path.resolve(mountPoint);
				const resolvedTarget = path.resolve(targetAbs);
				if (!resolvedTarget.startsWith(resolvedMount + path.sep) && resolvedTarget !== resolvedMount) {
					const err = new Error('Invalid file path');
					err.code = 'VALIDATION';
					throw err;
				}
				let st;
				try {
					st = fs.statSync(resolvedTarget);
				} catch {
					const err = new Error('NOT_FOUND');
					err.code = 'NOT_FOUND';
					throw err;
				}
				if (!st.isFile()) {
					const err = new Error('NOT_FOUND');
					err.code = 'NOT_FOUND';
					throw err;
				}
				fs.unlinkSync(resolvedTarget);
				thumbnailService.deleteThumbnailCacheForPath(id, logical);
			} finally {
				if (mounted) {
					try {
						await execPromise(`sudo umount "${mountPoint}"`);
					} catch (_) {}
				}
			}
			return;
		}

		this.syncUploadsFromDisk(id);
		const list = this._uploadsByDrive.get(id);
		if (!list) {
			const err = new Error('NOT_FOUND');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const idx = list.findIndex((e) => e.id === fileId);
		if (idx < 0) {
			const err = new Error('NOT_FOUND');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const entry = list[idx];
		thumbnailService.deleteThumbnailCacheForPath(id, entry.storagePath);
		const abs = this._absPath(id, entry.storagePath);
		if (fs.existsSync(abs)) {
			fs.unlinkSync(abs);
		}
		list.splice(idx, 1);
	}

	/**
	 * @param {string} driveId
	 * @param {string} fileId
	 * @param {string} newBaseName — basename only (sanitized server-side)
	 */
	async renameFile(driveId, fileId, newBaseName) {
		await delay(50);
		const id = String(driveId);
		this.syncUploadsFromDisk(id);
		const list = this._uploadsByDrive.get(id);
		if (!list) {
			const err = new Error('NOT_FOUND');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const idx = list.findIndex((e) => e.id === fileId);
		if (idx < 0) {
			const err = new Error('NOT_FOUND');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const entry = list[idx];
		const oldStorageNorm = String(entry.storagePath || '').replace(/\\/g, '/');
		const safe = path.basename(String(newBaseName || 'file')).replace(/[^\w.\-()+]/g, '_') || 'file';
		if (safe.startsWith('.')) {
			const err = new Error('Names cannot start with a period (.)');
			err.code = 'VALIDATION';
			throw err;
		}
		const oldAbs = this._absPath(id, entry.storagePath);
		let newRelative;
		if (entry.relativePath && entry.relativePath.includes('/')) {
			const dir = path.posix.dirname(entry.relativePath);
			newRelative = `${dir}/${safe}`;
		} else {
			newRelative = safe;
		}
		const newAbs = path.join(UPLOADS_ROOT, id, ...newRelative.split('/').filter(Boolean));

		fs.mkdirSync(path.dirname(newAbs), { recursive: true });

		if (fs.existsSync(newAbs) && path.resolve(oldAbs) !== path.resolve(newAbs)) {
			const err = new Error('NAME_CONFLICT');
			err.code = 'NAME_CONFLICT';
			throw err;
		}
		fs.renameSync(oldAbs, newAbs);

		entry.name = safe;
		entry.extension = this._extensionFromName(safe);
		entry.dateModified = new Date().toISOString();
		entry.storagePath = newRelative.replace(/\\/g, '/');
		entry.relativePath = newRelative.includes('/') ? newRelative.replace(/\\/g, '/') : undefined;

		const newStorageNorm = entry.storagePath.replace(/\\/g, '/');
		thumbnailService.remapThumbnailCache(id, oldStorageNorm, newStorageNorm);

		const { storagePath: _s, ...rest } = entry;
		return rest;
	}

	_normalizePosix(p) {
		return String(p ?? '')
			.trim()
			.replace(/\\/g, '/')
			.replace(/^\/+|\/+$/g, '');
	}

	/**
	 * Move file or folder on the mounted `.bin` image (production).
	 * @param {string} driveId
	 * @param {string} srcLogical — normalized POSIX path from volume root
	 * @param {string} tgtParent — normalized POSIX parent folder or ''
	 */
	async _moveItemProd(driveId, srcLogical, tgtParent) {
		const id = String(driveId);
		const drives = await driveService.getDrives();
		const drive = drives.find((d) => String(d.id) === id);
		if (!drive) {
			const err = new Error('Drive not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
		const mountPoint = PROD_MOUNT_POINT;
		let mounted = false;
		try {
			fs.mkdirSync(mountPoint, { recursive: true });
			try {
				await execPromise(`sudo umount "${mountPoint}"`);
			} catch (_) {}
			await execPromise(
				`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
			);
			mounted = true;

			const resolvedMount = path.resolve(mountPoint);
			const srcAbs = path.join(mountPoint, ...srcLogical.split('/').filter(Boolean));
			const resolvedSrc = path.resolve(srcAbs);
			if (!resolvedSrc.startsWith(resolvedMount + path.sep) && resolvedSrc !== resolvedMount) {
				const err = new Error('Invalid source path');
				err.code = 'VALIDATION';
				throw err;
			}

			let st;
			try {
				st = fs.statSync(srcAbs);
			} catch {
				const err = new Error('Source not found');
				err.code = 'NOT_FOUND';
				throw err;
			}

			const srcNorm = srcLogical.replace(/\\/g, '/');

			if (st.isFile()) {
				const base = path.basename(srcLogical);
				const newStorage = tgtParent ? `${tgtParent}/${base}` : base;
				const newStorageNorm = newStorage.replace(/\\/g, '/');
				if (srcNorm === newStorageNorm) {
					return { kind: 'file', path: newStorageNorm };
				}
				const newAbs = path.join(mountPoint, ...newStorageNorm.split('/').filter(Boolean));
				if (fs.existsSync(newAbs)) {
					const err = new Error('A file already exists at the destination');
					err.code = 'NAME_CONFLICT';
					throw err;
				}
				fs.mkdirSync(path.dirname(newAbs), { recursive: true });
				try {
					fs.renameSync(srcAbs, newAbs);
				} catch (e) {
					if (e && e.code === 'EXDEV') {
						fs.copyFileSync(srcAbs, newAbs);
						fs.unlinkSync(srcAbs);
					} else {
						throw e;
					}
				}
				thumbnailService.remapThumbnailCache(id, srcNorm, newStorageNorm);
				return { kind: 'file', path: newStorageNorm };
			}

			if (!st.isDirectory()) {
				const err = new Error('Source not found');
				err.code = 'NOT_FOUND';
				throw err;
			}

			const srcDir = srcAbs;
			const folderName = path.posix.basename(srcLogical);
			const destRel = tgtParent ? `${tgtParent}/${folderName}` : folderName;
			const destDir = path.join(mountPoint, ...destRel.split('/').filter(Boolean));
			const resolvedDest = path.resolve(destDir);

			if (srcNorm === destRel.replace(/\\/g, '/')) {
				return { kind: 'folder', path: destRel.replace(/\\/g, '/') };
			}
			if (fs.existsSync(destDir)) {
				const err = new Error('A file or folder already exists at the destination');
				err.code = 'PATH_EXISTS';
				throw err;
			}
			if (!resolvedDest.startsWith(resolvedMount + path.sep) && resolvedDest !== resolvedMount) {
				const err = new Error('Invalid destination');
				err.code = 'VALIDATION';
				throw err;
			}
			if (resolvedDest.startsWith(resolvedSrc + path.sep)) {
				const err = new Error('Cannot move a folder into itself or into its own subfolder');
				err.code = 'INVALID_MOVE';
				throw err;
			}
			if (resolvedSrc.startsWith(resolvedDest + path.sep)) {
				const err = new Error('Cannot move a folder into its own subfolder');
				err.code = 'INVALID_MOVE';
				throw err;
			}

			const thumbPairs = [];
			for (const fileAbs of walkFilesRecursive(srcDir)) {
				const oldStorage = path.relative(mountPoint, fileAbs).split(path.sep).join('/');
				const relFromSrc = path.relative(srcDir, fileAbs).split(path.sep).join('/');
				const newStorage = path.posix.join(destRel, relFromSrc);
				thumbPairs.push({ oldPath: oldStorage, newPath: newStorage });
			}
			fs.mkdirSync(path.dirname(destDir), { recursive: true });
			try {
				fs.renameSync(srcDir, destDir);
			} catch (e) {
				if (e && e.code === 'EXDEV') {
					const err = new Error('Cannot move folder across devices');
					err.code = 'INVALID_MOVE';
					throw err;
				}
				throw e;
			}
			for (const { oldPath, newPath } of thumbPairs) {
				thumbnailService.remapThumbnailCache(id, oldPath, newPath);
			}
			return { kind: 'folder', path: destRel.replace(/\\/g, '/') };
		} finally {
			if (mounted) {
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
			}
		}
	}

	/**
	 * Move a file (catalog entry) or a folder (directory on disk) under `targetParentPath` (POSIX, empty = volume root).
	 * @param {string} targetParentPath e.g. `Archive` or `Photos/2024` or `''` for root
	 */
	async moveItem(driveId, sourceLogicalPath, targetParentPath) {
		await delay(50);
		const id = String(driveId);
		const srcLogical = this._normalizePosix(sourceLogicalPath);
		const tgtParent = this._normalizePosix(targetParentPath);
		if (!srcLogical) {
			const err = new Error('sourceLogicalPath is required');
			err.code = 'VALIDATION';
			throw err;
		}
		if (tgtParent) {
			this.assertPathSegmentsNoLeadingDot(tgtParent);
		}

		if (IS_PROD) {
			return this._moveItemProd(id, srcLogical, tgtParent);
		}

		this.syncUploadsFromDisk(id);
		const list = this._uploadsByDrive.get(id) ?? [];
		const entry = list.find((e) => this._logicalKey(e) === srcLogical);

		const driveRoot = path.join(UPLOADS_ROOT, id);

		if (entry) {
			const oldAbs = this._absPath(id, entry.storagePath);
			if (!fs.existsSync(oldAbs)) {
				const err = new Error('Source not found');
				err.code = 'NOT_FOUND';
				throw err;
			}
			const base = path.basename(entry.storagePath);
			const newStorage = tgtParent ? `${tgtParent}/${base}` : base;
			const newStorageNorm = newStorage.replace(/\\/g, '/');
			if (entry.storagePath.replace(/\\/g, '/') === newStorageNorm) {
				return { kind: 'file', path: newStorageNorm };
			}
			const newAbs = this._absPath(id, newStorageNorm);
			if (fs.existsSync(newAbs)) {
				const err = new Error('A file already exists at the destination');
				err.code = 'NAME_CONFLICT';
				throw err;
			}
			fs.mkdirSync(path.dirname(newAbs), { recursive: true });
			const oldStorageNorm = entry.storagePath.replace(/\\/g, '/');
			fs.renameSync(oldAbs, newAbs);
			thumbnailService.remapThumbnailCache(id, oldStorageNorm, newStorageNorm);
			this.syncUploadsFromDisk(id);
			return { kind: 'file', path: newStorageNorm };
		}

		const srcDir = path.join(driveRoot, ...srcLogical.split('/').filter(Boolean));
		if (!fs.existsSync(srcDir) || !fs.statSync(srcDir).isDirectory()) {
			const err = new Error('Source not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const folderName = path.posix.basename(srcLogical);
		const destRel = tgtParent ? `${tgtParent}/${folderName}` : folderName;
		const destDir = path.join(driveRoot, ...destRel.split('/').filter(Boolean));
		const resolvedSrc = path.resolve(srcDir);
		const resolvedDest = path.resolve(destDir);
		const resolvedDrive = path.resolve(driveRoot);

		if (srcLogical === destRel) {
			return { kind: 'folder', path: destRel };
		}
		if (fs.existsSync(destDir)) {
			const err = new Error('A file or folder already exists at the destination');
			err.code = 'PATH_EXISTS';
			throw err;
		}
		if (!resolvedDest.startsWith(resolvedDrive + path.sep) && resolvedDest !== resolvedDrive) {
			const err = new Error('Invalid destination');
			err.code = 'VALIDATION';
			throw err;
		}
		if (resolvedDest.startsWith(resolvedSrc + path.sep)) {
			const err = new Error('Cannot move a folder into itself or into its own subfolder');
			err.code = 'INVALID_MOVE';
			throw err;
		}
		if (resolvedSrc.startsWith(resolvedDest + path.sep)) {
			const err = new Error('Cannot move a folder into its own subfolder');
			err.code = 'INVALID_MOVE';
			throw err;
		}
		const thumbPairs = [];
		for (const fileAbs of walkFilesRecursive(srcDir)) {
			const oldStorage = path.relative(driveRoot, fileAbs).split(path.sep).join('/');
			const relFromSrc = path.relative(srcDir, fileAbs).split(path.sep).join('/');
			const newStorage = path.posix.join(destRel, relFromSrc);
			thumbPairs.push({ oldPath: oldStorage, newPath: newStorage });
		}
		fs.mkdirSync(path.dirname(destDir), { recursive: true });
		fs.renameSync(srcDir, destDir);
		for (const { oldPath, newPath } of thumbPairs) {
			thumbnailService.remapThumbnailCache(id, oldPath, newPath);
		}
		this.syncUploadsFromDisk(id);
		return { kind: 'folder', path: destRel.replace(/\\/g, '/') };
	}

	/**
	 * Clear cached webp thumbnails for every file on this drive, then regenerate them.
	 * Use this after fixing CTB parsing or when previews were stuck as placeholders (listing skips regen if cache exists).
	 * @param {string} driveId
	 * @returns {Promise<{ ok: boolean; processed: number; errors: string[] }>}
	 */
	async regenerateThumbnailsForDrive(driveId) {
		const id = String(driveId);
		const errors = [];
		let processed = 0;

		thumbnailService.thumbLog('regenerate', 'start', { driveId: id });

		if (!IS_PROD) {
			this.syncUploadsFromDisk(id);
			const list = this._uploadsByDrive.get(id) ?? [];
			for (const entry of list) {
				const volRel = String(entry.storagePath || '').replace(/\\/g, '/').trim();
				if (!volRel) continue;
				try {
					thumbnailService.deleteThumbnailCacheForPath(id, volRel);
					const abs = this._absPath(id, entry.storagePath);
					if (!fs.existsSync(abs)) continue;
					await thumbnailService.generateThumbnailNow(id, volRel, abs);
					processed++;
				} catch (e) {
					errors.push(`${volRel}: ${e && e.message ? e.message : e}`);
				}
			}
			thumbnailService.thumbLog('regenerate', 'done (dev)', { processed, errors: errors.length });
			return { ok: errors.length === 0, processed, errors };
		}

		const drives = await driveService.getDrives();
		const drive = drives.find((d) => String(d.id) === id);
		if (!drive) {
			const err = new Error('Drive not found');
			err.code = 'NOT_FOUND';
			throw err;
		}
		const imagePath = path.join(PROD_DRIVES_DIR, drive.filename);
		const mountPoint = PROD_MOUNT_POINT;

		const walkMountedFiles = (dirAbs, relPrefix, out) => {
			let entries;
			try {
				entries = fs.readdirSync(dirAbs, { withFileTypes: true });
			} catch {
				return;
			}
			for (const ent of entries) {
				if (ent.name.startsWith('.') && ent.name !== '.noplugdir') continue;
				const rel = relPrefix ? `${relPrefix}/${ent.name}` : ent.name;
				const childAbs = path.join(dirAbs, ent.name);
				if (ent.isDirectory()) {
					walkMountedFiles(childAbs, rel, out);
				} else if (ent.isFile()) {
					out.push(rel.replace(/\\/g, '/'));
				}
			}
		};

		let mounted = false;
		try {
			fs.mkdirSync(mountPoint, { recursive: true });
			try {
				await execPromise(`sudo umount "${mountPoint}"`);
			} catch (_) {}
			await execPromise(
				`sudo mount -o loop,uid=1000,gid=1000 "${imagePath}" "${mountPoint}"`,
			);
			mounted = true;

			const relPaths = [];
			walkMountedFiles(mountPoint, '', relPaths);

			for (const storagePath of relPaths) {
				const cleanStoragePath = String(storagePath || '')
					.replace(/\\/g, '/')
					.replace(/^\/+|\/+$/g, '');
				const abs = path.join(mountPoint, ...cleanStoragePath.split('/').filter(Boolean));
				let st;
				try {
					st = fs.statSync(abs);
				} catch {
					continue;
				}
				if (!st.isFile()) continue;
				try {
					thumbnailService.deleteThumbnailCacheForPath(id, cleanStoragePath);
					await thumbnailService.generateThumbnailNow(id, cleanStoragePath, abs);
					processed++;
				} catch (e) {
					errors.push(`${cleanStoragePath}: ${e && e.message ? e.message : e}`);
				}
			}
			thumbnailService.thumbLog('regenerate', 'done (prod)', { processed, errors: errors.length });
			return { ok: errors.length === 0, processed, errors };
		} finally {
			if (mounted) {
				try {
					await execPromise(`sudo umount "${mountPoint}"`);
				} catch (_) {}
			}
		}
	}

	/**
	 * @returns {{ absPath: string, entry: object }}
	 */
	getFileForDownload(driveId, fileId) {
		const id = String(driveId);
		this.syncUploadsFromDisk(id);
		const list = this._uploadsByDrive.get(id);
		if (!list) return null;
		const entry = list.find((e) => e.id === fileId);
		if (!entry) return null;
		return { absPath: this._absPath(id, entry.storagePath), entry };
	}
}

module.exports = new MockFileService();
