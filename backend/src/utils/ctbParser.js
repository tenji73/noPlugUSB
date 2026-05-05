const fs = require('fs');
const zlib = require('zlib');
const sharp = require('sharp');

/** ChiTu/CTB family magic (see uv3dp / ChituBox tooling). */
const CTB_MAGIC = 0x12fd0086;
/** Observed on newer Phrozen exports (same header pointer layout, different revision). */
const CTB_MAGIC_PHROZEN = 0x12fd0107;

function isKnownCtbMagic(m) {
	const u = m >>> 0;
	return u === CTB_MAGIC || u === CTB_MAGIC_PHROZEN;
}
const OFFSET_PREVIEW_HIGH_STD = 0x3c;
const OFFSET_PREVIEW_LOW_STD = 0x48;
const OFFSET_PREVIEW_HIGH_ALT = 0x18;
const OFFSET_PREVIEW_LOW_ALT = 0x1c;

const RLE_REPEAT_FLAG_MASK = 0x20;

/** All 24 assignments of four dwords to (resX, resY, imageOffset, imageLength). */
function generatePermutations4() {
	const nums = [0, 1, 2, 3];
	const result = [];
	function backtrack(start) {
		if (start === nums.length) {
			result.push([...nums]);
			return;
		}
		for (let i = start; i < nums.length; i++) {
			[nums[start], nums[i]] = [nums[i], nums[start]];
			backtrack(start + 1);
			[nums[start], nums[i]] = [nums[i], nums[start]];
		}
	}
	backtrack(0);
	return result;
}
const PREVIEW_FIELD_PERMUTATIONS = generatePermutations4();

/** Standard PNG file signature. */
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** IEND chunk type + CRC (standard empty IEND) — fallback end marker when chunk walk fails. */
const PNG_IEND_CHUNK_TAIL = Buffer.from([0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82]);

const JPEG_SOI = Buffer.from([0xff, 0xd8, 0xff]);
const JPEG_EOI = Buffer.from([0xff, 0xd9]);
/** Reject absurd SOI→EOI spans (binary junk between false markers). */
const MAX_JPEG_CARVE_BYTES = 32 * 1024 * 1024;
const RIFF_SIG = Buffer.from([0x52, 0x49, 0x46, 0x46]);
const WEBP_MAGIC = Buffer.from('WEBP');

function color5to8(c5) {
	return ((c5 << 3) | (c5 >> 2)) & 0xff;
}

function matchesPngSignature(buf, offset) {
	if (offset < 0 || offset + 8 > buf.length) return false;
	return PNG_SIG.equals(buf.subarray(offset, offset + 8));
}

/**
 * Find PNG magic within the first ~32 bytes of a window [base, base + maxScan).
 * @returns {number} offset in **buf** where PNG starts, or -1
 */
function findPngStartInWindow(buf, base, maxScan) {
	const lim = Math.min(32, maxScan);
	if (lim < 8) return -1;
	for (let rel = 0; rel <= lim - 8; rel++) {
		if (matchesPngSignature(buf, base + rel)) {
			return base + rel;
		}
	}
	return -1;
}

/**
 * Walk PNG chunks (big-endian length) from `pngStart` until IEND.
 * @param {Buffer} buf
 * @param {number} pngStart
 * @param {number} hardEnd — do not read past this offset (exclusive)
 */
function slicePngByChunkWalk(buf, pngStart, hardEnd) {
	if (!matchesPngSignature(buf, pngStart)) return null;
	let p = pngStart + 8;
	while (p + 12 <= hardEnd && p + 12 <= buf.length) {
		const len = buf.readUInt32BE(p);
		const type = buf.toString('ascii', p + 4, p + 8);
		if (!Number.isFinite(len) || len < 0) break;
		const chunkTotal = 12 + len;
		if (p + chunkTotal > hardEnd || p + chunkTotal > buf.length) {
			return buf.subarray(pngStart, Math.min(hardEnd, buf.length));
		}
		if (type === 'IEND') {
			return buf.subarray(pngStart, p + chunkTotal);
		}
		p += chunkTotal;
	}
	return buf.subarray(pngStart, Math.min(hardEnd, buf.length));
}

/**
 * Try u32 length immediately before signature (offset 4 or 8 bytes).
 * @param {number} regionEnd — exclusive end of allowed range for PNG bytes
 */
function tryLengthPrefixedPng(buf, pngStart, regionEnd) {
	for (const prefix of [4, 8]) {
		if (pngStart < prefix) continue;
		const len = buf.readUInt32LE(pngStart - prefix);
		if (len < 24 || len > regionEnd - pngStart) continue;
		if (pngStart + len > regionEnd) continue;
		const slice = buf.subarray(pngStart, pngStart + len);
		if (!matchesPngSignature(slice, 0)) continue;
		const exact = slicePngByChunkWalk(buf, pngStart, pngStart + len);
		return exact && exact.length >= 24 ? exact : slice;
	}
	return null;
}

/**
 * Extract embedded PNG from a byte region (Phrozen: PNG or length+PNG in first bytes).
 * @param {Buffer} buf — full file or payload slice
 * @param {number} targetOffset — start of region in **buf**
 * @param {number} [regionLength] — length of region; default to end of buf
 */
function tryExtractEmbeddedPng(buf, targetOffset, regionLength) {
	const regionEnd =
		regionLength != null ? Math.min(buf.length, targetOffset + regionLength) : buf.length;
	if (targetOffset >= buf.length || targetOffset >= regionEnd) return null;

	const maxScan = regionEnd - targetOffset;
	const pngStart = findPngStartInWindow(buf, targetOffset, maxScan);
	if (pngStart < 0) return null;

	const prefixed = tryLengthPrefixedPng(buf, pngStart, regionEnd);
	if (prefixed) return prefixed;

	const walked = slicePngByChunkWalk(buf, pngStart, regionEnd);
	if (walked && walked.length >= 24) return walked;

	return buf.subarray(pngStart, regionEnd);
}

/**
 * Header u32 preview pointers sometimes store flags in high bits — try in-bounds variants.
 * Example: ptr=0x03f9a452 > fileSize but (ptr & 0xffffff)=0xf9a452 is valid.
 * @param {number} ptr
 * @param {number} bufLen
 * @returns {number[]} unique offsets in (0, bufLen)
 */
function candidateFileOffsetsFromU32(ptr, bufLen) {
	const out = [];
	const push = (v) => {
		const x = (v >>> 0);
		if (x > 0 && x < bufLen && !out.includes(x)) out.push(x);
	};
	push(ptr);
	push(ptr & 0xffffff);
	push(ptr & 0xfffffff);
	push(ptr & 0xfffff);
	if ((ptr >>> 0) >= bufLen) {
		push((ptr & 0xffffff) >>> 0);
		push((ptr & 0xfffff) >>> 0);
	}
	return out;
}

/**
 * Collect PNG slices for every signature: prefer chunk-walk (correct IEND); add IEND-tail slice if different.
 * @param {Buffer} buf
 * @returns {Buffer[]} unique candidates, longest first
 */
function collectPngCarveCandidates(buf) {
	const perStart = new Map();
	const push = (pngStart, slice) => {
		if (!slice || slice.length < 32 || !matchesPngSignature(slice, 0)) return;
		const prev = perStart.get(pngStart);
		if (!prev || slice.length > prev.length) perStart.set(pngStart, slice);
	};

	let from = 0;
	while (from <= buf.length - PNG_SIG.length) {
		const pngStart = buf.indexOf(PNG_SIG, from);
		if (pngStart < 0) break;

		const walked = slicePngByChunkWalk(buf, pngStart, buf.length);
		push(pngStart, walked);

		const searchFrom = pngStart + PNG_SIG.length;
		const iendIdx = buf.indexOf(PNG_IEND_CHUNK_TAIL, searchFrom);
		if (iendIdx >= 0) {
			const endExclusive = iendIdx + PNG_IEND_CHUNK_TAIL.length;
			if (endExclusive <= buf.length) {
				push(pngStart, buf.subarray(pngStart, endExclusive));
			}
		}
		from = pngStart + 1;
	}

	const all = [...perStart.values()];
	all.sort((a, b) => b.length - a.length);
	return all;
}

/**
 * For each JPEG SOI (`FF D8 FF`), take the span through the **first** EOI (`FF D9`) after it.
 * @param {Buffer} buf
 * @returns {Buffer[]} deduped slices (not validated — use {@link carveImageFromBuffer})
 */
function collectSimpleJpegCarvesFromBuffer(buf) {
	const out = [];
	let from = 0;
	while (from <= buf.length - JPEG_SOI.length) {
		const soi = buf.indexOf(JPEG_SOI, from);
		if (soi < 0) break;
		const eoi = buf.indexOf(JPEG_EOI, soi + 2);
		if (eoi >= 0) {
			const end = eoi + JPEG_EOI.length;
			const len = end - soi;
			if (len >= 24 && len <= MAX_JPEG_CARVE_BYTES) {
				out.push(buf.subarray(soi, end));
			}
		}
		from = soi + 1;
	}
	const seen = new Set();
	const uniq = [];
	for (const c of out) {
		const key = `${c.length}:${c.subarray(0, Math.min(32, c.length)).toString('hex')}`;
		if (seen.has(key)) continue;
		seen.add(key);
		uniq.push(c);
	}
	uniq.sort((a, b) => b.length - a.length);
	return uniq;
}

/**
 * Carve embedded raster previews: PNG (chunk walk) and JPEG (SOI → first EOI). Validates with sharp
 * and returns the **largest** decodable image (typical high-res preview).
 * @param {Buffer} buf
 * @returns {Promise<{ buffer: Buffer; width: number; height: number; kind: 'png' | 'jpeg' } | null>}
 */
async function carveImageFromBuffer(buf) {
	const candidates = [];
	for (const b of collectPngCarveCandidates(buf)) {
		candidates.push({ buffer: b, kind: /** @type {'png'} */ ('png') });
	}
	for (const b of collectSimpleJpegCarvesFromBuffer(buf)) {
		candidates.push({ buffer: b, kind: /** @type {'jpeg'} */ ('jpeg') });
	}

	let best = null;
	for (const { buffer: cbuf, kind } of candidates) {
		try {
			const meta = await sharp(cbuf, kind === 'jpeg' ? { failOn: 'none' } : undefined).metadata();
			if (!meta.width || !meta.height) continue;
			if (!best || cbuf.length > best.buffer.length) {
				best = {
					buffer: cbuf,
					width: meta.width,
					height: meta.height,
					kind,
				};
			}
		} catch (_) {
			/* invalid carve */
		}
	}
	return best;
}

/**
 * Every SOI→EOI span for a given start: the first `FF D9` after SOI is often **not** the real EOI
 * (entropy data can contain that byte pair). Scan successive EOIs and try decode on each slice.
 * @param {Buffer} buf
 * @param {number} soi
 * @param {number} [maxSpans]
 * @returns {Buffer[]}
 */
function jpegSpansFromSoi(buf, soi, maxSpans = 48) {
	const out = [];
	let search = soi + 2;
	let n = 0;
	while (n < maxSpans && search < buf.length) {
		const eoi = buf.indexOf(JPEG_EOI, search);
		if (eoi < 0) break;
		const slice = buf.subarray(soi, eoi + JPEG_EOI.length);
		if (slice.length >= 24 && slice.length <= MAX_JPEG_CARVE_BYTES) out.push(slice);
		search = eoi + JPEG_EOI.length;
		n++;
	}
	return out;
}

/**
 * All plausible JPEG blobs: for each `FF D8 FF` occurrence, collect multiple EOI endpoints.
 * @param {Buffer} buf
 * @returns {Buffer[]} longest first (preview is usually the biggest valid decode)
 */
function collectJpegCarveCandidates(buf) {
	const candidates = [];
	let from = 0;
	while (from <= buf.length - JPEG_SOI.length) {
		const soi = buf.indexOf(JPEG_SOI, from);
		if (soi < 0) break;
		candidates.push(...jpegSpansFromSoi(buf, soi));
		from = soi + 1;
	}
	const seen = new Set();
	const uniq = [];
	for (const c of candidates) {
		const key = `${c.length}:${c.subarray(0, Math.min(32, c.length)).toString('hex')}`;
		if (seen.has(key)) continue;
		seen.add(key);
		uniq.push(c);
	}
	uniq.sort((a, b) => b.length - a.length);
	return uniq;
}

/**
 * Largest JPEG (SOI … first EOI only) — kept for callers/tests; prefer collectJpegCarveCandidates.
 * @param {Buffer} buf
 * @returns {Buffer | null}
 */
function carveLargestJpegFromBuffer(buf) {
	const all = collectJpegCarveCandidates(buf);
	return all.length ? all[0] : null;
}

/**
 * RIFF/WEBP slices (extended WebP in CTB).
 * @param {Buffer} buf
 * @returns {Buffer[]}
 */
function collectWebpCandidates(buf) {
	const out = [];
	let from = 0;
	while (from <= buf.length - 12) {
		const r = buf.indexOf(RIFF_SIG, from);
		if (r < 0) break;
		if (r + 12 > buf.length) break;
		if (!WEBP_MAGIC.equals(buf.subarray(r + 8, r + 12))) {
			from = r + 1;
			continue;
		}
		const riffSize = buf.readUInt32LE(r + 4);
		const total = 8 + riffSize;
		if (r + total > buf.length || total < 12 || total > buf.length) {
			from = r + 1;
			continue;
		}
		out.push(buf.subarray(r, r + total));
		from = r + 1;
	}
	out.sort((a, b) => b.length - a.length);
	return out;
}

/**
 * Writes the best carved raster to disk (PNG or JPEG bytes — sharp downstream accepts both).
 * Order: {@link carveImageFromBuffer} (largest valid PNG or simple SOI→EOI JPEG), then WebP, then tail heuristics.
 * @param {Buffer} buf
 * @param {string} destPngPath
 * @returns {Promise<{ width: number; height: number; kind?: string; bytes?: number } | null>}
 */
async function tryCarvedRastersToPngFile(buf, destPngPath) {
	const carved = await carveImageFromBuffer(buf);
	if (carved) {
		fs.writeFileSync(destPngPath, carved.buffer);
		return {
			width: carved.width,
			height: carved.height,
			kind: carved.kind,
			bytes: carved.buffer.length,
		};
	}

	const webps = collectWebpCandidates(buf);
	for (const wbuf of webps) {
		try {
			const meta = await sharp(wbuf).metadata();
			if (meta.width && meta.height) {
				await sharp(wbuf).png().toFile(destPngPath);
				return { width: meta.width, height: meta.height, kind: 'webp', bytes: wbuf.length };
			}
		} catch (_) {}
	}

	/**
	 * Many embedded JPEGs lack a reliable FF D9 in-file; libjpeg often still decodes a prefix.
	 * Try capped tails from each FF D8 FF (same order as Pi logs: several SOIs, none with clean carve).
	 */
	const tailCaps = [256 * 1024, 1024 * 1024, 4 * 1024 * 1024, 16 * 1024 * 1024, MAX_JPEG_CARVE_BYTES];
	let jfrom = 0;
	while (jfrom <= buf.length - JPEG_SOI.length) {
		const soi = buf.indexOf(JPEG_SOI, jfrom);
		if (soi < 0) break;
		for (const cap of tailCaps) {
			const end = Math.min(buf.length, soi + cap);
			if (end - soi < 32) continue;
			const tail = buf.subarray(soi, end);
			try {
				const dec = await sharpFirstDecodableVariant(zlibDecodeVariants(tail));
				if (dec && dec.meta.width >= 4 && dec.meta.height >= 4) {
					await sharp(dec.buf, { failOn: 'none' }).png().toFile(destPngPath);
					return {
						width: dec.meta.width,
						height: dec.meta.height,
						kind: 'jpeg-tail',
						bytes: dec.buf.length,
						soi,
					};
				}
			} catch (_) {}
		}
		jfrom = soi + 1;
	}

	return null;
}

function rleDecodeRGB15(width, height, rle) {
	const expected = width * height * 4;
	const out = Buffer.alloc(expected, 0);
	let x = 0;
	let y = 0;
	let n = 0;

	const setPixel = (R, G, B) => {
		if (y >= height) return;
		const i = (y * width + x) * 4;
		out[i] = R;
		out[i + 1] = G;
		out[i + 2] = B;
		out[i + 3] = 255;
		x++;
		if (x >= width) {
			x = 0;
			y++;
		}
	};

	while (n < rle.length) {
		if (n + 2 > rle.length) break;
		let color16 = rle.readUInt16LE(n);
		n += 2;
		let repeat = 1;
		if ((color16 & RLE_REPEAT_FLAG_MASK) !== 0) {
			if (n + 2 > rle.length) break;
			repeat += rle.readUInt16LE(n) & 0xfff;
			n += 2;
		}
		const R = color5to8((color16 >> 11) & 0x1f);
		const G = color5to8((color16 >> 6) & 0x1f);
		const B = color5to8(color16 & 0x1f);
		for (let r = 0; r < repeat; r++) {
			if (y >= height) break;
			setPixel(R, G, B);
		}
	}

	return out;
}

function readPreviewTable(buf, off) {
	if (buf.length < off + 16) return null;
	const resX = buf.readUInt32LE(off);
	const resY = buf.readUInt32LE(off + 4);
	const imageOffset = buf.readUInt32LE(off + 8);
	const imageLength = buf.readUInt32LE(off + 12);
	return { resX, resY, imageOffset, imageLength };
}

/**
 * @param {Buffer} header
 * @param {number} fileSize — reject bogus huge “offsets” from mis-parsed dwords
 */
function collectPreviewTableOffsets(header, fileSize) {
	const magic = header.readUInt32LE(0);
	const stdH = header.readUInt32LE(OFFSET_PREVIEW_HIGH_STD);
	const stdL = header.readUInt32LE(OFFSET_PREVIEW_LOW_STD);
	const altH = header.readUInt32LE(OFFSET_PREVIEW_HIGH_ALT);
	const altL = header.readUInt32LE(OFFSET_PREVIEW_LOW_ALT);

	const ordered = [];
	const push = (o) => {
		const v = o >>> 0;
		if (v > 0 && v < fileSize && v + 16 <= fileSize && !ordered.includes(v)) ordered.push(v);
	};

	if (isKnownCtbMagic(magic)) {
		push(stdH);
		push(stdL);
		push(altH);
		push(altL);
	} else {
		push(altH);
		push(altL);
		push(stdH);
		push(stdL);
	}
	return ordered;
}

function isSanePreviewStruct(p, fileSize) {
	const { resX, resY, imageOffset, imageLength } = p;
	if (!resX || !resY) return false;
	if (resX > 8192 || resY > 8192) return false;
	if (!imageLength || imageLength > fileSize) return false;
	if (imageOffset >= fileSize || imageOffset + imageLength > fileSize) return false;
	return true;
}

function isSanePayloadBounds(imageOffset, imageLength, fileSize) {
	const off = imageOffset >>> 0;
	const len = imageLength >>> 0;
	if (!len || len < 16 || len > fileSize) return false;
	if (!off || off >= fileSize) return false;
	if (off + len > fileSize) return false;
	if (len > MAX_JPEG_CARVE_BYTES) return false;
	return true;
}

/**
 * CTB v4 / Phrozen: preview may be JPEG/PNG bytes with invalid resX/resY in the 16-byte table.
 * @param {Buffer} payload
 * @returns {Promise<import('sharp').Metadata | null>}
 */
async function sharpMetadataRasterPayload(payload) {
	try {
		const meta = await sharp(payload, { failOn: 'none' }).metadata();
		if (meta.width && meta.height) return meta;
	} catch (_) {}
	return null;
}

/** Try zlib/deflate-wrapped preview (common when ChiTu length field is compressed size). */
function zlibDecodeVariants(raw) {
	const out = [];
	if (!raw || raw.length < 6) return out;
	out.push(raw);
	try {
		out.push(zlib.inflateSync(raw, { maxOutputLength: 48 * 1024 * 1024 }));
	} catch (_) {}
	try {
		out.push(zlib.inflateRawSync(raw, { maxOutputLength: 48 * 1024 * 1024 }));
	} catch (_) {}
	return out;
}

async function sharpFirstDecodableVariant(buffers) {
	for (const b of buffers) {
		if (!b || b.length < 24) continue;
		const meta = await sharpMetadataRasterPayload(b);
		if (meta) return { buf: b, meta };
	}
	return null;
}

/**
 * Raw RGB565 little-endian tile (Phrozen / ChiTu-style preview when not JPEG).
 * @returns {Buffer | null}
 */
function rgb565ToRgbaBuffer(src, w, h) {
	const need = w * h * 2;
	if (!src || src.length < need || w < 2 || h < 2) return null;
	const out = Buffer.alloc(w * h * 4);
	for (let i = 0; i < w * h; i++) {
		const px = src.readUInt16LE(i * 2);
		const r5 = (px >> 11) & 0x1f;
		const g6 = (px >> 5) & 0x3f;
		const b5 = px & 0x1f;
		out[i * 4] = (r5 << 3) | (r5 >> 2);
		out[i * 4 + 1] = (g6 << 2) | (g6 >> 4);
		out[i * 4 + 2] = (b5 << 3) | (b5 >> 2);
		out[i * 4 + 3] = 255;
	}
	return out;
}

/**
 * Last-resort: every aligned u32 pair in the 36-byte footer as (off,len), (table+off,len), swapped, EOF-length.
 * @param {Buffer} buf
 * @param {number} tableOff
 * @returns {Promise<{ buf: Buffer; meta: import('sharp').Metadata; tag: string } | null>}
 */
async function tryFooterBruteForce(buf, tableOff) {
	const maxFooter = 36;
	if (tableOff < 0 || tableOff >= buf.length) return null;
	const win = Math.min(maxFooter, buf.length - tableOff);
	if (win < 8) return null;
	const slice = buf.subarray(tableOff, tableOff + win);

	const tryPayload = async (payload, tag) => {
		const dec = await sharpFirstDecodableVariant(zlibDecodeVariants(payload));
		if (dec) return { buf: dec.buf, meta: dec.meta, tag };
		return null;
	};

	const trySlice = async (absOff, len, tag) => {
		const o = absOff >>> 0;
		let l = len >>> 0;
		if (o >= buf.length || l < 8) return null;
		l = Math.min(l, buf.length - o, MAX_JPEG_CARVE_BYTES);
		if (l < 24) return null;
		return tryPayload(buf.subarray(o, o + l), tag);
	};

	for (let i = 0; i + 8 <= win; i += 4) {
		const pairs = [
			[slice.readUInt32LE(i), slice.readUInt32LE(i + 4), 'le'],
			[slice.readUInt32BE(i), slice.readUInt32BE(i + 4), 'be'],
		];
		for (const [a, b, endian] of pairs) {
			const tries = [
				[a, b, `abs:${endian}:${i}`],
				[(tableOff + a) >>> 0, b, `rel:${endian}:${i}`],
				[b, a, `swap:${endian}:${i}`],
				[(tableOff + b) >>> 0, a, `relswap:${endian}:${i}`],
			];
			for (const [off, len, tag] of tries) {
				const got = await trySlice(off, len, tag);
				if (got) return got;
			}
		}
	}

	for (let i = 0; i + 4 <= win; i += 4) {
		for (const [readU, endian] of [
			[slice.readUInt32LE(i), 'le'],
			[slice.readUInt32BE(i), 'be'],
		]) {
			const o = readU >>> 0;
			for (const base of [o, (tableOff + o) >>> 0]) {
				if (base < 8 || base >= buf.length - 24) continue;
				const l = Math.min(buf.length - base, MAX_JPEG_CARVE_BYTES);
				const got = await tryPayload(buf.subarray(base, base + l), `eof:${endian}:${i}`);
				if (got) return got;
			}
		}
	}

	return null;
}

/**
 * ChiTu 16-byte table as (w,h,off,len) with uncompressed RGB565 tile.
 * @returns {Promise<{ rgba: Buffer; w: number; h: number } | null>}
 */
async function tryRgb565FromPreviewTable(buf, tableOff) {
	const preview = readPreviewTable(buf, tableOff);
	if (!preview) return null;
	const w = preview.resX >>> 0;
	const h = preview.resY >>> 0;
	const o = preview.imageOffset >>> 0;
	const len = preview.imageLength >>> 0;
	if (w < 4 || h < 4 || w > 8192 || h > 8192) return null;
	const need = w * h * 2;
	if (len < need || o + need > buf.length) return null;
	const src = buf.subarray(o, o + need);
	const rgba = rgb565ToRgbaBuffer(src, w, h);
	if (!rgba) return null;
	try {
		await sharp(rgba, { raw: { width: w, height: h, channels: 4 } }).metadata();
	} catch (_) {
		return null;
	}
	return { rgba, w, h };
}

/**
 * Scan a 36-byte v4 “footer” window for plausible u32 (offset,length) pairs and try sharp.
 * @param {Buffer} buf
 * @param {number} base
 * @returns {Promise<{ payload: Buffer; meta: import('sharp').Metadata; tag: string } | null>}
 */
async function tryV4FooterRasterScan(buf, base) {
	const maxWin = 64;
	if (base < 0 || base + 8 > buf.length) return null;
	const win = Math.min(maxWin, buf.length - base);
	const slice = buf.subarray(base, base + win);

	const tryPair = async (o, l, tag) => {
		const off = o >>> 0;
		const len = l >>> 0;
		if (!isSanePayloadBounds(off, len, buf.length)) return null;
		const payload = buf.subarray(off, off + len);
		const dec = await sharpFirstDecodableVariant(zlibDecodeVariants(payload));
		if (!dec) return null;
		return { payload: dec.buf, meta: dec.meta, tag };
	};

	const tryOffsetToEof = async (idx, endian) => {
		const o = (endian === 'be' ? slice.readUInt32BE(idx) : slice.readUInt32LE(idx)) >>> 0;
		if (o < 8 || o >= buf.length) return null;
		const len = Math.min(buf.length - o, MAX_JPEG_CARVE_BYTES);
		if (len < 24) return null;
		return tryPair(o, len, `solo${endian}+${idx}eof`);
	};

	for (let i = 0; i + 8 <= slice.length; i += 4) {
		const gotLe = await tryPair(slice.readUInt32LE(i), slice.readUInt32LE(i + 4), `u32[${i},${i + 4}]le`);
		if (gotLe) return gotLe;
		const gotBe = await tryPair(slice.readUInt32BE(i), slice.readUInt32BE(i + 4), `u32[${i},${i + 4}]be`);
		if (gotBe) return gotBe;
	}

	/** Pairs miss when length is implicit (JPEG to EOF or length in another field). */
	for (let i = 0; i + 4 <= slice.length; i += 4) {
		const a = await tryOffsetToEof(i, 'le');
		if (a) return a;
		const b = await tryOffsetToEof(i, 'be');
		if (b) return b;
	}
	return null;
}

function tryDecodeFromPreviewTable(buf, tableOffset) {
	const preview = readPreviewTable(buf, tableOffset);
	if (!preview) return null;

	const { resX, resY, imageOffset, imageLength } = preview;

	if (isSanePreviewStruct(preview, buf.length)) {
		const pngBuf = tryExtractEmbeddedPng(buf, imageOffset, imageLength);
		if (pngBuf && pngBuf.length >= 24 && matchesPngSignature(pngBuf, 0)) {
			return { kind: 'png', png: pngBuf, tableOffset, imageOffset, imageLength };
		}

		const payload = buf.subarray(imageOffset, imageOffset + imageLength);
		const rgba = rleDecodeRGB15(resX, resY, payload);
		return {
			kind: 'rle',
			rgba,
			width: resX,
			height: resY,
			tableOffset,
			imageOffset,
			imageLength,
		};
	}

	/** v4: dimensions may be unset; payload can still be JPEG/PNG at imageOffset..length */
	if (isSanePayloadBounds(imageOffset, imageLength, buf.length)) {
		return {
			kind: 'raster',
			payload: buf.subarray(imageOffset, imageOffset + (imageLength >>> 0)),
			tableOffset,
			imageOffset,
			imageLength: imageLength >>> 0,
		};
	}

	return null;
}

function tryDecodeLegacyDirectAfterPtr(buf) {
	const ptr = buf.readUInt32LE(OFFSET_PREVIEW_HIGH_ALT);
	if (!ptr) return null;

	for (const off of candidateFileOffsetsFromU32(ptr, buf.length)) {
		const pngBuf = tryExtractEmbeddedPng(buf, off);
		if (pngBuf && pngBuf.length >= 24 && matchesPngSignature(pngBuf, 0)) {
			return { kind: 'png', png: pngBuf, tableOffset: off };
		}
	}

	for (const off of candidateFileOffsetsFromU32(ptr, buf.length)) {
		if (off + 8 > buf.length) continue;
		const w = buf.readUInt32LE(off);
		const h = buf.readUInt32LE(off + 4);
		if (!w || !h || w > 8192 || h > 8192) continue;
		const rle = buf.subarray(off + 8);
		const rgba = rleDecodeRGB15(w, h, rle);
		return { kind: 'rle', rgba, width: w, height: h, tableOffset: off };
	}
	return null;
}

/**
 * One preview struct interpretation: embedded PNG, RGB15-RLE, or raw JPEG/PNG bytes.
 * @param {string} label — log tag (struct pointer + optional permutation index)
 */
async function attemptChituPreviewDecode(buf, preview, destPngPath, label) {
	const { resX, resY, imageOffset, imageLength } = preview;

	const pngBuf = tryExtractEmbeddedPng(buf, imageOffset, imageLength);
	if (pngBuf && pngBuf.length >= 24 && matchesPngSignature(pngBuf, 0)) {
		fs.writeFileSync(destPngPath, pngBuf);
		const meta = await sharp(pngBuf).metadata();
		console.log(`[ctb] OK ChiTu embedded PNG (${label}) ${meta.width}x${meta.height}`);
		return { width: meta.width || 0, height: meta.height || 0 };
	}

	if (isSanePreviewStruct(preview, buf.length)) {
		const payload = buf.subarray(imageOffset, imageOffset + imageLength);
		let rgba;
		try {
			rgba = rleDecodeRGB15(resX, resY, payload);
		} catch (_) {
			rgba = null;
		}
		if (rgba) {
			try {
				await sharp(rgba, { raw: { width: resX, height: resY, channels: 4 } })
					.png()
					.toFile(destPngPath);
				console.log(
					`[ctb] OK ChiTu RGB15-RLE preview (${label}) img@0x${imageOffset.toString(16)} ${resX}x${resY}`,
				);
				return { width: resX, height: resY };
			} catch (_) {
				/* fall through to raster */
			}
		}
	}

	if (isSanePayloadBounds(imageOffset, imageLength, buf.length)) {
		const payload = buf.subarray(imageOffset, imageOffset + imageLength);
		const meta = await sharpMetadataRasterPayload(payload);
		if (meta && meta.width) {
			await sharp(payload, { failOn: 'none' }).png().toFile(destPngPath);
			console.log(
				`[ctb] OK ChiTu raster (${label}) img@0x${imageOffset.toString(16)} ${meta.width}x${meta.height}`,
			);
			return { width: meta.width || 0, height: meta.height || 0 };
		}
	}

	return null;
}

/**
 * Try every dword ordering — Phrozen / variant slicers sometimes use (offset,length,w,h).
 * @param {string} baseLabel
 */
async function tryPreviewStructPermutations(buf, structPtr, destPngPath, baseLabel) {
	if (structPtr + 16 > buf.length) return null;
	const v = [
		buf.readUInt32LE(structPtr),
		buf.readUInt32LE(structPtr + 4),
		buf.readUInt32LE(structPtr + 8),
		buf.readUInt32LE(structPtr + 12),
	];
	for (let pi = 0; pi < PREVIEW_FIELD_PERMUTATIONS.length; pi++) {
		const p = PREVIEW_FIELD_PERMUTATIONS[pi];
		const preview = {
			resX: v[p[0]] >>> 0,
			resY: v[p[1]] >>> 0,
			imageOffset: v[p[2]] >>> 0,
			imageLength: v[p[3]] >>> 0,
		};
		const label = `${baseLabel}#${pi}`;
		const r = await attemptChituPreviewDecode(buf, preview, destPngPath, label);
		if (r) return r;
	}
	return null;
}

/**
 * ChiTu/UVtools: previews are **RGB565 RLE**, not JPEG. Header holds pointers to Preview structs:
 * `PreviewLargeOffsetAddress` @0x3c, `PreviewSmallOffsetAddress` @0x48 (see UVtools ChituboxFile.Header).
 * Also tries `ptr@0x18` and header dword scan when std pointers are zero — Phrozen `0x12fd0107` variants.
 *
 * @param {Buffer} buf
 * @param {string} destPngPath
 * @returns {Promise<{ width: number; height: number } | null>}
 */
async function tryChituUvToolsPreviewDecode(buf, destPngPath) {
	if (buf.length < 0x50) return null;
	const largeStruct = buf.readUInt32LE(OFFSET_PREVIEW_HIGH_STD);
	const smallStruct = buf.readUInt32LE(OFFSET_PREVIEW_LOW_STD);
	const ptr18 = buf.readUInt32LE(OFFSET_PREVIEW_HIGH_ALT);

	console.log(
		`[ctb] previewPtr@0x3c=0x${largeStruct.toString(16)} @0x48=0x${smallStruct.toString(16)} ptr@0x18=0x${ptr18.toString(16)}`,
	);

	const structPtrs = [];
	const push = (p) => {
		const u = p >>> 0;
		if (u && u + 16 <= buf.length && !structPtrs.includes(u)) structPtrs.push(u);
	};
	push(largeStruct);
	push(smallStruct);
	push(ptr18);

	if (!largeStruct && !smallStruct) {
		for (let o = 0x24; o < 0x120 && o + 4 <= buf.length; o += 4) {
			push(buf.readUInt32LE(o));
		}
	}

	for (const structPtr of structPtrs) {
		let baseLabel = `struct@0x${structPtr.toString(16)}`;
		if (structPtr === largeStruct && largeStruct) baseLabel = `large@0x${structPtr.toString(16)}`;
		else if (structPtr === smallStruct && smallStruct) baseLabel = `small@0x${structPtr.toString(16)}`;
		else if (structPtr === ptr18 && ptr18) baseLabel = `ptr18@0x${structPtr.toString(16)}`;

		const r = await tryPreviewStructPermutations(buf, structPtr, destPngPath, baseLabel);
		if (r) return r;
	}
	return null;
}

/**
 * Extract CTB embedded preview to PNG on disk.
 *
 * @param {string} ctbFilePath
 * @param {string} destPngPath
 * @returns {Promise<{ width: number; height: number }>}
 */
async function extractCtbThumbnail(ctbFilePath, destPngPath) {
	const buf = fs.readFileSync(ctbFilePath);
	if (buf.length < 0x50) {
		throw new Error('CTB too small');
	}

	const header = buf.subarray(0, Math.min(0x200, buf.length));
	const ptr18 = buf.readUInt32LE(OFFSET_PREVIEW_HIGH_ALT);

	console.log(
		`[ctb] ${JSON.stringify(ctbFilePath)} size=${buf.length} magic=0x${header.readUInt32LE(0).toString(16)} ptr@0x18=0x${ptr18.toString(16)}`,
	);

	const uv = await tryChituUvToolsPreviewDecode(buf, destPngPath);
	if (uv) {
		return uv;
	}

	/** (1) u32 @ 0x18 → preview blob (try masked offsets if raw value is out of range — Phrozen). */
	if (ptr18 > 0) {
		for (const off of candidateFileOffsetsFromU32(ptr18, buf.length)) {
			const embeddedPng = tryExtractEmbeddedPng(buf, off);
			if (embeddedPng && embeddedPng.length >= 24 && matchesPngSignature(embeddedPng, 0)) {
				fs.writeFileSync(destPngPath, embeddedPng);
				const meta = await sharp(embeddedPng).metadata();
				console.log(
					`[ctb] OK embedded PNG @0x${off.toString(16)} (from ptr 0x${ptr18.toString(16)}) bytes=${embeddedPng.length} ${meta.width}x${meta.height}`,
				);
				return { width: meta.width || 0, height: meta.height || 0 };
			}
		}
		/** v4: ptr may reference a 36-byte footer of (offset,length) pairs → JPEG/PNG payload */
		for (const base of candidateFileOffsetsFromU32(ptr18, buf.length)) {
			const v4 = await tryV4FooterRasterScan(buf, base);
			if (v4) {
				await sharp(v4.payload, { failOn: 'none' }).png().toFile(destPngPath);
				console.log(
					`[ctb] OK v4 footer @0x${base.toString(16)} ${v4.tag} bytes=${v4.payload.length} ${v4.meta.width}x${v4.meta.height}`,
				);
				return { width: v4.meta.width || 0, height: v4.meta.height || 0 };
			}
		}
	}

	const candidates = collectPreviewTableOffsets(header, buf.length);
	if (ptr18 > 0) {
		for (const x of candidateFileOffsetsFromU32(ptr18, buf.length)) {
			if (!candidates.includes(x)) candidates.push(x);
		}
	}
	console.log(
		`[ctb] RLE/table candidates ${candidates.map((o) => `0x${o.toString(16)}`).join(',')}`,
	);

	for (const tableOff of candidates) {
		try {
			const got = tryDecodeFromPreviewTable(buf, tableOff);
			if (got) {
				if (got.kind === 'png') {
					fs.writeFileSync(destPngPath, got.png);
					const meta = await sharp(got.png).metadata();
					console.log(
						`[ctb] OK PNG in preview table @0x${tableOff.toString(16)} payload@0x${got.imageOffset.toString(16)} ${meta.width}x${meta.height}`,
					);
					return { width: meta.width || 0, height: meta.height || 0 };
				}
				if (got.kind === 'raster') {
					const dec = await sharpFirstDecodableVariant(zlibDecodeVariants(got.payload));
					if (dec) {
						await sharp(dec.buf, { failOn: 'none' }).png().toFile(destPngPath);
						console.log(
							`[ctb] OK raster in preview table @0x${tableOff.toString(16)} payload@0x${got.imageOffset.toString(16)} len=${got.imageLength} ${dec.meta.width}x${dec.meta.height}`,
						);
						return { width: dec.meta.width, height: dec.meta.height };
					}
				} else if (got.kind === 'rle') {
					console.log(
						`[ctb] OK RLE via preview table @0x${tableOff.toString(16)} → ${got.width}x${got.height} rle@${got.imageOffset} len=${got.imageLength}`,
					);
					await sharp(got.rgba, {
						raw: { width: got.width, height: got.height, channels: 4 },
					})
						.png()
						.toFile(destPngPath);
					return { width: got.width, height: got.height };
				}
			}
			const brute = await tryFooterBruteForce(buf, tableOff);
			if (brute) {
				await sharp(brute.buf, { failOn: 'none' }).png().toFile(destPngPath);
				console.log(
					`[ctb] OK footer brute @0x${tableOff.toString(16)} ${brute.tag} ${brute.meta.width}x${brute.meta.height}`,
				);
				return { width: brute.meta.width || 0, height: brute.meta.height || 0 };
			}
			const rgb565 = await tryRgb565FromPreviewTable(buf, tableOff);
			if (rgb565) {
				await sharp(rgb565.rgba, {
					raw: { width: rgb565.w, height: rgb565.h, channels: 4 },
				})
					.png()
					.toFile(destPngPath);
				console.log(`[ctb] OK RGB565 @0x${tableOff.toString(16)} ${rgb565.w}x${rgb565.h}`);
				return { width: rgb565.w, height: rgb565.h };
			}
		} catch (e) {
			if (process.env.NOPLUGUSB_THUMB_LOG === '1') {
				console.warn(`[ctb] table @0x${tableOff.toString(16)} failed`, e && e.message ? e.message : e);
			}
		}
	}

	try {
		const got = tryDecodeLegacyDirectAfterPtr(buf);
		if (got && got.kind === 'png') {
			fs.writeFileSync(destPngPath, got.png);
			const meta = await sharp(got.png).metadata();
			console.log(`[ctb] OK legacy PNG @0x${got.tableOffset.toString(16)} ${meta.width}x${meta.height}`);
			return { width: meta.width || 0, height: meta.height || 0 };
		}
		if (got && got.kind === 'rle') {
			console.log(`[ctb] OK legacy RLE @0x${got.tableOffset.toString(16)} ${got.width}x${got.height}`);
			await sharp(got.rgba, {
				raw: { width: got.width, height: got.height, channels: 4 },
			})
				.png()
				.toFile(destPngPath);
			return { width: got.width, height: got.height };
		}
	} catch (e) {
		console.warn('[ctb] legacy layout failed', e && e.message ? e.message : e);
	}

	const carved = await tryCarvedRastersToPngFile(buf, destPngPath);
	if (carved) {
		console.log(
			`[ctb] OK carved ${carved.kind} bytes=${carved.bytes} ${carved.width}x${carved.height}`,
		);
		return { width: carved.width, height: carved.height };
	}

	const firstOffsets = (needle, max = 5) => {
		const out = [];
		for (let f = 0; out.length < max && (f = buf.indexOf(needle, f)) !== -1; f++) out.push(f);
		return out;
	};
	const countNeedle = (needle) => {
		let n = 0;
		for (let f = 0; (f = buf.indexOf(needle, f)) !== -1; f++) n++;
		return n;
	};

	const pngSigCount = countNeedle(PNG_SIG);
	const jpgSigCount = countNeedle(JPEG_SOI);
	const riffCount = countNeedle(RIFF_SIG);
	const webpCount = collectWebpCandidates(buf).length;

	console.log(
		`[ctb] carve failed pngSignatures=${pngSigCount} jpegSOI=${jpgSigCount} riff=${riffCount} webpRiff=${webpCount} pngOffsets=${firstOffsets(PNG_SIG)
			.map((o) => `0x${o.toString(16)}`)
			.join(',')} jpegOffsets=${firstOffsets(JPEG_SOI)
			.map((o) => `0x${o.toString(16)}`)
			.join(',')} riffOffsets=${firstOffsets(RIFF_SIG)
			.map((o) => `0x${o.toString(16)}`)
			.join(',')}`,
	);

	throw new Error('Could not decode CTB preview (no PNG or RLE preview)');
}

module.exports = {
	extractCtbThumbnail,
	rleDecodeRGB15,
	readPreviewTable,
	collectPreviewTableOffsets,
	carveImageFromBuffer,
	collectPngCarveCandidates,
	collectJpegCarveCandidates,
	collectSimpleJpegCarvesFromBuffer,
	tryCarvedRastersToPngFile,
};
