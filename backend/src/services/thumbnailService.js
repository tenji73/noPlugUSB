const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const async = require('async');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');

const CACHE_ROOT = path.join(__dirname, '../../cache/thumbnails');

/** Extensions we attempt to thumbnail. */
const IMAGE_EXT = new Set(['.jpg', '.jpeg', '.png', '.gif', '.webp']);
const VIDEO_EXT = new Set(['.mp4']);
const PLACEHOLDER_3D_EXT = new Set(['.gcode', '.ctb']);

function ensureCacheDir() {
	if (!fs.existsSync(CACHE_ROOT)) {
		fs.mkdirSync(CACHE_ROOT, { recursive: true });
	}
}

ensureCacheDir();

/** Set `NOPLUGUSB_THUMB_LOG=1` for extra thumbnail job detail (server stdout / journalctl). */
function thumbLog(tag, message, detail) {
	const extra = detail != null && detail !== '' ? ` ${typeof detail === 'string' ? detail : JSON.stringify(detail)}` : '';
	console.log(`[thumbnail][${tag}] ${message}${extra}`);
}

if (process.env.FFMPEG_PATH) {
	ffmpeg.setFfmpegPath(process.env.FFMPEG_PATH);
}
if (process.env.FFPROBE_PATH) {
	ffmpeg.setFfprobePath(process.env.FFPROBE_PATH);
}

/**
 * Canonical volume-relative path for hashing: `{driveId}/{posixPathFromVolumeRoot}`.
 * Example: `drive_539771/Photos/vacation/IMG_001.jpg`
 * @param {string} driveId
 * @param {string} logicalPath — relative path from volume root (same as catalog logical key)
 */
function volumePathKey(driveId, logicalPath) {
	const vol = String(driveId ?? '')
		.trim()
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	const rel = String(logicalPath ?? '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
	return `${vol}/${rel}`;
}

/**
 * MD5 hex of {@link volumePathKey} — used as the only thumbnail filename: `{hex}.webp`.
 * @param {string} driveId
 * @param {string} logicalPath
 * @returns {string} 32-char lowercase hex
 */
function hashVolumePath(driveId, logicalPath) {
	const key = volumePathKey(driveId, logicalPath);
	return crypto.createHash('md5').update(key, 'utf8').digest('hex');
}

/**
 * @returns {string | null} absolute path to `cache/{hash}.webp` if it exists
 */
function getThumbnailAbsPath(driveId, logicalPath) {
	const hex = hashVolumePath(driveId, logicalPath);
	const abs = path.join(CACHE_ROOT, `${hex}.webp`);
	return fs.existsSync(abs) ? abs : null;
}

/** Public URL path for a thumbnail that exists (same hash as {@link hashVolumePath}). */
function thumbnailPublicPath(driveId, logicalPath) {
	return `/api/thumbnails/${hashVolumePath(driveId, logicalPath)}.webp`;
}

function normalizeStoragePath(p) {
	return String(p ?? '')
		.replace(/\\/g, '/')
		.replace(/^\/+|\/+$/g, '');
}

/** @type {null | ((payload: { type: string; driveId: string; storagePath: string; thumbnailURL: string }) => void)} */
let broadcastThumbnailReady = null;

function setThumbnailReadyBroadcast(fn) {
	broadcastThumbnailReady = typeof fn === 'function' ? fn : null;
}

/**
 * Notify subscribers (WebSocket) that a thumbnail exists for this volume path.
 * @param {string} driveId
 * @param {string} storagePath — POSIX path from volume root (same as catalog `storagePath`)
 */
function emitThumbnailReady(driveId, storagePath) {
	if (!broadcastThumbnailReady) return;
	const vol = normalizeStoragePath(storagePath);
	if (!vol) return;
	broadcastThumbnailReady({
		type: 'thumbnailReady',
		driveId: String(driveId),
		storagePath: vol,
		thumbnailURL: thumbnailPublicPath(driveId, vol),
	});
}

/**
 * After rename/move on disk, move cached `{md5(old)}.webp` → `{md5(new)}.webp` if present.
 * @returns {boolean} true if a cache file was moved
 */
function remapThumbnailCache(driveId, oldStoragePath, newStoragePath) {
	const id = String(driveId);
	const oldNorm = normalizeStoragePath(oldStoragePath);
	const newNorm = normalizeStoragePath(newStoragePath);
	if (!oldNorm || !newNorm || oldNorm === newNorm) return false;
	const oldHex = hashVolumePath(id, oldNorm);
	const newHex = hashVolumePath(id, newNorm);
	if (oldHex === newHex) return false;
	const oldAbs = path.join(CACHE_ROOT, `${oldHex}.webp`);
	const newAbs = path.join(CACHE_ROOT, `${newHex}.webp`);
	if (!fs.existsSync(oldAbs)) return false;
	try {
		if (fs.existsSync(newAbs)) fs.unlinkSync(newAbs);
		fs.renameSync(oldAbs, newAbs);
		emitThumbnailReady(id, newNorm);
		return true;
	} catch (e) {
		console.warn('[thumbnail] remapThumbnailCache', e && e.message ? e.message : e);
		return false;
	}
}

/** Remove cached thumbnail for a deleted file (best-effort). */
function deleteThumbnailCacheForPath(driveId, storagePath) {
	const abs = getThumbnailAbsPath(driveId, normalizeStoragePath(storagePath));
	if (!abs) return;
	try {
		fs.unlinkSync(abs);
	} catch (_) {}
}

async function write3DPlaceholderWebp(outputAbs, ext) {
	const label = ext === '.ctb' ? 'CTB' : ext === '.gcode' ? 'G-code' : '3D';
	const svg = `<svg width="256" height="256" xmlns="http://www.w3.org/2000/svg">
  <rect width="256" height="256" fill="#0f172a" rx="14"/>
  <rect x="18" y="18" width="220" height="220" fill="none" stroke="#6366f1" stroke-width="2" rx="10" opacity="0.55"/>
  <text x="128" y="122" text-anchor="middle" fill="#e2e8f0" font-family="system-ui,Segoe UI,sans-serif" font-size="24" font-weight="600">${label}</text>
  <text x="128" y="154" text-anchor="middle" fill="#64748b" font-family="system-ui,Segoe UI,sans-serif" font-size="12">Preview</text>
</svg>`;
	try {
		await sharp(Buffer.from(svg)).webp({ quality: 86 }).toFile(outputAbs);
	} catch (e) {
		console.warn('[thumbnail] SVG placeholder failed, using solid fallback:', e && e.message ? e.message : e);
		await sharp({
			create: {
				width: 256,
				height: 256,
				channels: 3,
				background: { r: 15, g: 23, b: 42 },
			},
		})
			.webp({ quality: 86 })
			.toFile(outputAbs);
	}
}

function shouldProcessExtension(ext) {
	return IMAGE_EXT.has(ext) || VIDEO_EXT.has(ext) || PLACEHOLDER_3D_EXT.has(ext);
}

async function extractImageWebp(sourceAbs, destAbs) {
	await sharp(sourceAbs, { limitInputPixels: 268402689 })
		.resize(256, 256, { fit: 'cover', position: 'center' })
		.webp({ quality: 82 })
		.toFile(destAbs);
}

function ffprobeDuration(filePath) {
	return new Promise((resolve, reject) => {
		ffmpeg.ffprobe(filePath, (err, metadata) => {
			if (err) reject(err);
			else resolve(Number(metadata.format.duration) || 0);
		});
	});
}

async function extractVideoWebp(sourceAbs, destAbs) {
	const duration = await ffprobeDuration(sourceAbs);
	const seekSec = Math.max(0, duration * 0.1);
	const tmpPng = path.join(
		os.tmpdir(),
		`noplug-vthumb-${crypto.randomBytes(8).toString('hex')}.png`,
	);
	try {
		await new Promise((resolve, reject) => {
			ffmpeg(sourceAbs)
				.seekInput(seekSec)
				.outputOptions(['-vframes', '1'])
				.output(tmpPng)
				.on('end', resolve)
				.on('error', reject)
				.run();
		});
		await sharp(tmpPng, { limitInputPixels: 268402689 })
			.resize(256, 256, { fit: 'cover', position: 'center' })
			.webp({ quality: 82 })
			.toFile(destAbs);
	} finally {
		try {
			if (fs.existsSync(tmpPng)) fs.unlinkSync(tmpPng);
		} catch (_) {}
	}
}

async function processThumbnailJob(job) {
	const { driveId, logicalPath, absolutePath } = job;
	if (!absolutePath || !fs.existsSync(absolutePath)) {
		return;
	}
	let ext = path.extname(logicalPath).toLowerCase();
	if (!ext && absolutePath) {
		ext = path.extname(absolutePath).toLowerCase();
	}
	if (!shouldProcessExtension(ext)) {
		return;
	}

	const hex = hashVolumePath(driveId, logicalPath);
	const finalPath = path.join(CACHE_ROOT, `${hex}.webp`);
	const tmpPath = path.join(CACHE_ROOT, `.${hex}.${process.pid}.tmp.webp`);

	try {
		if (PLACEHOLDER_3D_EXT.has(ext)) {
			thumbLog('job', '3D / slice file', {
				driveId,
				logicalPath,
				absolutePath,
				ext,
			});
			// .ctb: encrypted / vendor — never read or decode for previews (use icon only).
			// .gcode: text; still use the same lightweight placeholder (no slice preview).
			await write3DPlaceholderWebp(tmpPath, ext);
			fs.renameSync(tmpPath, finalPath);
			emitThumbnailReady(driveId, logicalPath);
			return;
		}
		if (IMAGE_EXT.has(ext)) {
			await extractImageWebp(absolutePath, tmpPath);
		} else if (VIDEO_EXT.has(ext)) {
			await extractVideoWebp(absolutePath, tmpPath);
		} else {
			return;
		}
		fs.renameSync(tmpPath, finalPath);
		emitThumbnailReady(driveId, logicalPath);
	} catch (e) {
		try {
			if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
		} catch (_) {}
		console.error('[thumbnail]', logicalPath, e && e.message ? e.message : e);
	}
}

const queue = async.queue((task, done) => {
	processThumbnailJob(task)
		.then(() => done())
		.catch((e) => {
			console.error('[thumbnail] queue', e);
			done();
		});
}, 1);

function enqueueThumbnail(driveId, logicalPath, absolutePath) {
	let ext = path.extname(logicalPath).toLowerCase();
	if (!ext && absolutePath) {
		ext = path.extname(absolutePath).toLowerCase();
	}
	if (!shouldProcessExtension(ext)) {
		return;
	}
	queue.push({ driveId: String(driveId), logicalPath, absolutePath });
}

/**
 * Generate thumbnail immediately (await). Use while a volume is still mounted at `absolutePath`,
 * or for dev uploads where the file path is stable.
 * @param {string} driveId
 * @param {string} logicalPath — volume-relative POSIX path (same as catalog `storagePath`)
 * @param {string} absolutePath — readable file on disk
 * @returns {Promise<void>}
 */
async function generateThumbnailNow(driveId, logicalPath, absolutePath) {
	const job = { driveId: String(driveId), logicalPath, absolutePath };
	let ext = path.extname(logicalPath).toLowerCase();
	if (!ext && absolutePath) {
		ext = path.extname(absolutePath).toLowerCase();
	}
	if (!shouldProcessExtension(ext)) {
		return;
	}
	await processThumbnailJob(job);
}

module.exports = {
	volumePathKey,
	hashVolumePath,
	getThumbnailAbsPath,
	thumbnailPublicPath,
	enqueueThumbnail,
	generateThumbnailNow,
	setThumbnailReadyBroadcast,
	emitThumbnailReady,
	remapThumbnailCache,
	deleteThumbnailCacheForPath,
	normalizeStoragePath,
	CACHE_ROOT,
	thumbLog,
};
