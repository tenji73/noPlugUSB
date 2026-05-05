const fs = require('fs');
const http = require('http');
const path = require('path');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const WebSocket = require('ws');
const { isProductionRuntime } = require('./src/utils/isProduction');

const IS_PROD = isProductionRuntime();

const usbService = IS_PROD
	? require('./src/services/usbHardware')
	: require('./src/services/usbMock');
const driveService = require('./src/services/driveService');
const mockFileService = require('./src/services/mockFileService');
const thumbnailService = require('./src/services/thumbnailService');

const app = express();
const PORT = 3000;

const UPLOADS_DIR = IS_PROD ? '/home/pi/noplugusb/data/uploads' : path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) {
	fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}

/** Max single file ~5 GiB (binary); stream to disk via Multer — never buffer whole file in RAM. */
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024 * 1024;

const storage = multer.diskStorage({
	destination: (req, _file, cb) => {
		try {
			const driveId = String(req.params.driveId ?? 'unknown');
			const baseUpload = path.join(UPLOADS_DIR, driveId);
			fs.mkdirSync(baseUpload, { recursive: true });

			let pathsBody = req.body.paths;
			if (pathsBody == null) pathsBody = [];
			if (!Array.isArray(pathsBody)) pathsBody = [pathsBody];

			const idx = (req._multerDestinationIndex = (req._multerDestinationIndex ?? -1) + 1);
			const relRaw = pathsBody[idx] != null ? String(pathsBody[idx]) : '';
			const relPosix = relRaw.replace(/\\/g, '/');

			let dirPortion = '';
			if (relPosix && relPosix.includes('/')) {
				dirPortion = path.posix.dirname(relPosix);
			}

			const segments = dirPortion
				? dirPortion.split('/').filter((s) => s && s !== '.' && s !== '..')
				: [];

			const targetDir = path.join(baseUpload, ...segments);
			const resolvedBase = path.resolve(baseUpload);
			const resolvedTarget = path.resolve(targetDir);
			if (!resolvedTarget.startsWith(resolvedBase + path.sep) && resolvedTarget !== resolvedBase) {
				return cb(new Error('Invalid upload path'));
			}
			fs.mkdirSync(resolvedTarget, { recursive: true });
			req._multerDestDir = resolvedTarget;
			cb(null, resolvedTarget);
		} catch (e) {
			cb(e instanceof Error ? e : new Error(String(e)));
		}
	},
	filename: (req, file, cb) => {
		try {
			const driveId = String(req.params.driveId ?? 'unknown');
			let pathsBody = req.body.paths;
			if (pathsBody == null) pathsBody = [];
			if (!Array.isArray(pathsBody)) pathsBody = [pathsBody];
			const idx = req._multerDestinationIndex ?? 0;
			const rel = pathsBody[idx] != null ? String(pathsBody[idx]).replace(/\\/g, '/') : '';
			const logical =
				rel && rel.length > 0 ? rel : path.basename(file.originalname || 'file').replace(/\\/g, '/');
			mockFileService.assertPathSegmentsNoLeadingDot(logical);
			const ow = req.body?.overwrite;
			const overwrite = ow === true || ow === 'true' || ow === '1';
			if (mockFileService.hasLogicalPath(driveId, logical) && !overwrite) {
				return cb(new Error('DUPLICATE_FILE'));
			}
			const base = path.basename(file.originalname || 'file');
			const safe = base.replace(/[^\w.\-()+]/g, '_');
			cb(null, safe);
		} catch (e) {
			cb(e instanceof Error ? e : new Error(String(e)));
		}
	},
});

const upload = multer({
	storage,
	limits: { fileSize: MAX_UPLOAD_BYTES },
});

// Chrome Private Network Access: POST preflight to localhost needs this on the OPTIONS response
// when the page is served from another origin (e.g. :4200 → :3000).
app.use((req, res, next) => {
	if (req.headers['access-control-request-private-network'] === 'true') {
		res.setHeader('Access-Control-Allow-Private-Network', 'true');
	}
	next();
});

app.use(
	cors({
		origin: true,
		methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
		allowedHeaders: ['Content-Type', 'Authorization'],
	}),
);
app.use(express.json());

// --- Health Check ---
app.get('/', (req, res) => {
	res.status(200).send(`
        <html>
            <body style="font-family: sans-serif; padding: 2rem; text-align: center;">
                <h2>🚀 NoPlugUSB API is running!</h2>
                <p>Status: Operating in MOCK mode</p>
            </body>
        </html>
    `);
});

// --- API Endpoints ---

/**
 * Dev: merge live stats from mock uploads. Prod: `getDrives` / `getFullState` already ran
 * `refreshProdDriveStats()` (one loop mount per drive for df + file walk). Do not call
 * `mockFileService.getDriveVolumeStats` here — that would mount every `.bin` a second time on
 * `/mnt/noplugusb_mount` and double load time; a bad image can block the whole API.
 * @param {Array<Record<string, unknown>>} drives
 */
async function mergeVolumeStatsIntoDrives(drives) {
	if (IS_PROD) {
		return drives;
	}
	if (!Array.isArray(drives) || drives.length === 0) return drives;
	const out = [];
	for (const d of drives) {
		const id = d && d.id != null ? String(d.id) : '';
		if (!id) {
			out.push(d);
			continue;
		}
		try {
			const stats = await mockFileService.getDriveVolumeStats(id);
			out.push({
				...d,
				fileCount: stats.fileCount,
				usedBytes: stats.usedBytes,
			});
		} catch (e) {
			console.warn('[api] volume-stats merge skipped for', id, e && e.message ? e.message : e);
			out.push(d);
		}
	}
	return out;
}

app.get('/api/drives', async (req, res) => {
	try {
		const drives = await driveService.getDrives();
		const merged = await mergeVolumeStatsIntoDrives(drives);
		res.status(200).json(merged);
	} catch (error) {
		console.error('GET /api/drives:', error);
		res.status(500).json({ error: 'Failed to read drives' });
	}
});

app.get('/api/state', async (req, res) => {
	try {
		const state = await driveService.getFullState();
		const drives = await mergeVolumeStatsIntoDrives(state.drives);
		res.status(200).json({ ...state, drives });
	} catch (error) {
		console.error('GET /api/state:', error);
		res.status(500).json({ error: 'Failed to read state' });
	}
});

/** Thumbnail file: `{md5(driveId/relativePath)}.webp` — see thumbnailService.hashVolumePath */
app.get('/api/thumbnails/:filename', (req, res) => {
	const fn = req.params.filename;
	if (!/^[a-f0-9]{32}\.webp$/i.test(fn)) {
		return res.status(404).end();
	}
	const abs = path.join(thumbnailService.CACHE_ROOT, fn.toLowerCase());
	if (!fs.existsSync(abs)) {
		return res.status(404).end();
	}
	res.type('image/webp');
	res.sendFile(path.resolve(abs), (err) => {
		if (err && !res.headersSent) {
			console.error('GET thumbnail sendFile:', err);
			res.status(500).end();
		}
	});
});

/** Remove generated thumbnail webp files (frees disk under `cache/thumbnails`). */
app.post('/api/cache/purge', (req, res) => {
	try {
		const dir = thumbnailService.CACHE_ROOT;
		if (!fs.existsSync(dir)) {
			return res.status(200).json({ success: true, removed: 0 });
		}
		let removed = 0;
		for (const name of fs.readdirSync(dir)) {
			if (!name.endsWith('.webp') || name.startsWith('.')) continue;
			try {
				fs.unlinkSync(path.join(dir, name));
				removed += 1;
			} catch (_) {}
		}
		res.status(200).json({ success: true, removed });
	} catch (error) {
		console.error('POST /api/cache/purge:', error);
		res.status(500).json({ success: false, error: 'Failed to purge cache' });
	}
});

app.get('/api/drives/:driveId/files', async (req, res) => {
	try {
		const files = await mockFileService.getFilesInDrive(req.params.driveId);
		res.status(200).json(files);
	} catch (error) {
		console.error('GET /api/drives/:driveId/files:', error);
		res.status(500).json({ error: 'Failed to list files' });
	}
});

/** File count + sum of file sizes (same rules as listing; no thumbnail generation). */
app.get('/api/drives/:driveId/volume-stats', async (req, res) => {
	try {
		const stats = await mockFileService.getDriveVolumeStats(req.params.driveId);
		res.status(200).json(stats);
	} catch (error) {
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: error.message, code: 'NOT_FOUND' });
		}
		console.error('GET /api/drives/:driveId/volume-stats:', error);
		res.status(500).json({ error: 'Failed to read volume stats' });
	}
});

/** Delete cached thumbnails for every file on the drive, then regenerate (see CTB / placeholder notes). */
app.post('/api/drives/:driveId/thumbnails/regenerate', async (req, res) => {
	try {
		const result = await mockFileService.regenerateThumbnailsForDrive(req.params.driveId);
		res.status(200).json(result);
	} catch (error) {
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: error.message, code: 'NOT_FOUND' });
		}
		console.error('POST /api/drives/:driveId/thumbnails/regenerate:', error);
		res.status(500).json({ error: 'Failed to regenerate thumbnails' });
	}
});

app.post('/api/drives/:driveId/folders', async (req, res) => {
	try {
		const bodyPath = req.body?.path ?? req.body?.name;
		const result = await mockFileService.createFolder(req.params.driveId, bodyPath);
		res.status(201).json(result);
	} catch (error) {
		if (error && error.code === 'VALIDATION') {
			return res.status(400).json({ error: error.message, code: 'VALIDATION' });
		}
		if (error && error.code === 'PATH_EXISTS') {
			return res.status(409).json({ error: error.message, code: 'PATH_EXISTS' });
		}
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: error.message, code: 'NOT_FOUND' });
		}
		console.error('POST /api/drives/:driveId/folders:', error);
		res.status(500).json({ error: 'Failed to create folder' });
	}
});

app.delete('/api/drives/:driveId/folders', async (req, res) => {
	try {
		const bodyPath = req.body?.path ?? req.body?.name;
		await mockFileService.deleteFolderRecursive(req.params.driveId, bodyPath);
		res.status(204).send();
	} catch (error) {
		if (error && error.code === 'VALIDATION') {
			return res.status(400).json({ error: error.message, code: 'VALIDATION' });
		}
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: error.message, code: 'NOT_FOUND' });
		}
		if (error && error.code === 'NOT_A_FOLDER') {
			return res.status(400).json({ error: error.message, code: 'NOT_A_FOLDER' });
		}
		console.error('DELETE /api/drives/:driveId/folders:', error);
		res.status(500).json({ error: 'Failed to delete folder' });
	}
});

app.post('/api/drives/:driveId/upload', (req, res) => {
	// Match duplicate checks and catalog to files already on disk (e.g. copied into uploads/).
	mockFileService.syncUploadsFromDisk(req.params.driveId);
	upload.array('files')(req, res, async (err) => {
		if (err) {
			if (err.code === 'LIMIT_FILE_SIZE') {
				return res.status(400).json({ success: false, error: 'File exceeds maximum size (5 GiB)' });
			}
			if (err.code === 'VALIDATION') {
				return res.status(400).json({ success: false, error: err.message, code: 'VALIDATION' });
			}
			if (err.message === 'DUPLICATE_FILE') {
				return res.status(409).json({
					success: false,
					error: 'A file with this path already exists on the volume',
					code: 'DUPLICATE_FILE',
				});
			}
			return res.status(400).json({ success: false, error: err.message || 'Upload error' });
		}
		try {
			const driveId = req.params.driveId;
			const files = req.files || [];
			let pathsList = [];
			const pr = req.body.paths;
			if (Array.isArray(pr)) pathsList = pr.map(String);
			else if (pr != null && pr !== '') pathsList = [String(pr)];
			const ow = req.body?.overwrite;
			const overwrite = ow === true || ow === 'true' || ow === '1';
			const result = await mockFileService.addUploadedFiles(driveId, files, pathsList, overwrite);
			res.status(200).json({
				success: true,
				message: 'Upload complete',
				filesReceived: files.length,
				...result,
			});
		} catch (error) {
			if (error && error.code === 'DUPLICATE_FILE') {
				return res.status(409).json({
					success: false,
					error: 'A file with this path already exists on the volume',
					code: 'DUPLICATE_FILE',
				});
			}
			if (error && error.code === 'VALIDATION') {
				return res.status(400).json({ success: false, error: error.message, code: 'VALIDATION' });
			}
			console.error('POST /api/drives/:driveId/upload:', error);
			res.status(500).json({ success: false, error: 'Upload failed' });
		}
	});
});

app.delete('/api/drives/:driveId/files/:fileId', async (req, res) => {
	try {
		await mockFileService.deleteFile(req.params.driveId, req.params.fileId);
		res.status(204).send();
	} catch (error) {
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
		}
		console.error('DELETE /api/drives/:driveId/files/:fileId:', error);
		res.status(500).json({ error: 'Failed to delete file' });
	}
});

app.post('/api/drives/:driveId/move', async (req, res) => {
	try {
		const sourceLogicalPath = req.body?.sourceLogicalPath;
		const targetParentPath = req.body?.targetParentPath;
		if (sourceLogicalPath == null || String(sourceLogicalPath).trim() === '') {
			return res.status(400).json({ error: 'sourceLogicalPath is required', code: 'VALIDATION' });
		}
		if (targetParentPath == null) {
			return res.status(400).json({ error: 'targetParentPath is required (use empty string for root)', code: 'VALIDATION' });
		}
		const result = await mockFileService.moveItem(
			req.params.driveId,
			String(sourceLogicalPath),
			typeof targetParentPath === 'string' ? targetParentPath : String(targetParentPath),
		);
		res.status(200).json(result);
	} catch (error) {
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: error.message, code: 'NOT_FOUND' });
		}
		if (error && error.code === 'VALIDATION') {
			return res.status(400).json({ error: error.message, code: 'VALIDATION' });
		}
		if (error && error.code === 'INVALID_MOVE') {
			return res.status(400).json({ error: error.message, code: 'INVALID_MOVE' });
		}
		if (error && (error.code === 'NAME_CONFLICT' || error.code === 'PATH_EXISTS')) {
			return res.status(409).json({ error: error.message, code: error.code });
		}
		console.error('POST /api/drives/:driveId/move:', error);
		res.status(500).json({ error: 'Failed to move item' });
	}
});

app.patch('/api/drives/:driveId/files/:fileId', async (req, res) => {
	try {
		const name = req.body?.name;
		if (name == null || String(name).trim() === '') {
			return res.status(400).json({ error: 'name is required', code: 'VALIDATION' });
		}
		const updated = await mockFileService.renameFile(req.params.driveId, req.params.fileId, name);
		res.status(200).json(updated);
	} catch (error) {
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
		}
		if (error && error.code === 'VALIDATION') {
			return res.status(400).json({ error: error.message, code: 'VALIDATION' });
		}
		if (error && error.code === 'NAME_CONFLICT') {
			return res.status(409).json({ error: 'A file with that name already exists', code: 'NAME_CONFLICT' });
		}
		console.error('PATCH /api/drives/:driveId/files/:fileId:', error);
		res.status(500).json({ error: 'Failed to rename file' });
	}
});

app.get('/api/drives/:driveId/files/:fileId/download', async (req, res) => {
	try {
		const got = mockFileService.getFileForDownload(req.params.driveId, req.params.fileId);
		if (!got) {
			return res.status(404).json({ error: 'File not found', code: 'NOT_FOUND' });
		}
		res.download(got.absPath, got.entry.name, (err) => {
			if (err) {
				console.error('download sendfile:', err);
				if (!res.headersSent) {
					res.status(500).json({ error: 'Failed to send file' });
				}
			}
		});
	} catch (error) {
		console.error('GET /api/drives/:driveId/files/:fileId/download:', error);
		res.status(500).json({ error: 'Failed to download file' });
	}
});

app.post('/api/drives', async (req, res) => {
	try {
		const { displayName, description, size, format, icon, themeColor } = req.body || {};
		const drive = await driveService.createDrive({
			displayName,
			description,
			size,
			format,
			icon,
			themeColor,
		});
		res.status(201).json(drive);
	} catch (error) {
		if (error && error.code === 'DUPLICATE_DRIVE') {
			return res.status(409).json({ error: error.message, code: 'DUPLICATE_DRIVE' });
		}
		if (error && error.code === 'VALIDATION') {
			return res.status(400).json({ error: error.message, code: 'VALIDATION' });
		}
		console.error('POST /api/drives:', error);
		res.status(500).json({ error: 'Failed to create drive' });
	}
});

app.put('/api/drives/:id', async (req, res) => {
	try {
		const { displayName, description, size, icon } = req.body || {};
		const drive = await driveService.updateDrive(req.params.id, {
			displayName,
			description,
			size,
			icon,
		});
		res.status(200).json(drive);
	} catch (error) {
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: error.message, code: 'NOT_FOUND' });
		}
		if (error && error.code === 'DUPLICATE_DRIVE') {
			return res.status(409).json({ error: error.message, code: 'DUPLICATE_DRIVE' });
		}
		if (error && error.code === 'VALIDATION') {
			return res.status(400).json({ error: error.message, code: 'VALIDATION' });
		}
		console.error('PUT /api/drives/:id:', error);
		res.status(500).json({ error: 'Failed to update drive' });
	}
});

app.delete('/api/drives/:id', async (req, res) => {
	try {
		const state = await driveService.deleteDrive(req.params.id);
		const drives = await mergeVolumeStatsIntoDrives(state.drives);
		res.status(200).json({ ...state, drives });
	} catch (error) {
		if (error && error.code === 'NOT_FOUND') {
			return res.status(404).json({ error: error.message, code: 'NOT_FOUND' });
		}
		console.error('DELETE /api/drives/:id:', error);
		res.status(500).json({ error: 'Failed to delete drive' });
	}
});

app.post('/api/usb/disconnect', async (req, res) => {
	try {
		const result = await usbService.disconnectPrinter();
		const systemState = await driveService.setActiveDrive(null);
		res.status(200).json({ success: true, message: result, systemState });
	} catch (error) {
		res.status(500).json({ success: false, message: 'Hardware failure' });
	}
});

app.post('/api/usb/connect', async (req, res) => {
	try {
		const driveId = req.body?.driveId;
		if (!driveId) {
			return res.status(400).json({ success: false, message: 'driveId is required' });
		}
		const drives = await driveService.getDrives();
		const drive = drives.find((d) => d.id === driveId);
		if (!drive) {
			return res.status(404).json({ success: false, message: 'Drive not found' });
		}
		const result = await usbService.connectPrinter(drive.filename);
		const systemState = await driveService.setActiveDrive(driveId);
		res.status(200).json({ success: true, message: result, systemState });
	} catch (error) {
		console.error('API Error:', error);
		res.status(500).json({ success: false, message: 'Hardware failure' });
	}
});

// HTTP + WebSocket (thumbnail-ready events on the same port)
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
wss.on('connection', (ws) => {
	ws.on('error', () => {});
});
thumbnailService.setThumbnailReadyBroadcast((payload) => {
	const msg = JSON.stringify(payload);
	for (const client of wss.clients) {
		if (client.readyState === WebSocket.OPEN) {
			client.send(msg);
		}
	}
});

server.listen(PORT, () => {
	process.stderr.write(`\n🚀 NoPlugUSB Backend pid=${process.pid} http://localhost:${PORT}\n`);
	process.stderr.write(
		`   WebSocket: ws://localhost:${PORT} (thumbnailReady events)\n` +
			`   Confirm listener: lsof -nP -iTCP:${PORT} -sTCP:LISTEN  → PID ${process.pid}\n`,
	);
	console.log(
		IS_PROD ? `🛠️  Operating in PRODUCTION (Hardware Active)` : `🛠️  Operating in MOCK (Laptop Development)`,
	);
	console.log(`📁 Uploads directory: ${UPLOADS_DIR}`);
	console.log(`🖼️  Thumbnail cache: ${thumbnailService.CACHE_ROOT}`);
});

server.on('error', (err) => {
	if (err && err.code === 'EADDRINUSE') {
		process.stderr.write(
			`\n[x] Port ${PORT} is already in use — this process did NOT start the listener.\n` +
				`    Your curl/browser may be talking to an OLD node. Fix:\n` +
				`    lsof -nP -iTCP:${PORT} -sTCP:LISTEN   then   kill <PID>\n` +
				`    Then run npm run dev again.\n\n`,
		);
	} else {
		process.stderr.write(`\n[x] Server listen error: ${err && err.message ? err.message : err}\n`);
	}
	process.exit(1);
});
