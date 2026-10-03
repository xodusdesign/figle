/**
 * fig-utils.js — shared dependency-free helpers for the Figma Preview Eagle plugin.
 *
 * A modern `.fig` / `.jam` / `.deck` file is a plain ZIP archive in STORE mode:
 *   canvas.fig      — the real binary (fig-kiwi)
 *   meta.json       — { file_name, background_color, exported_at, ... }
 *   thumbnail.png   — file-browser preview (Figma rejects files without it)
 *   images/<sha1>  — deduped fill bitmaps, no extension (sniff magic bytes)
 *
 * Older `.fig` files (pre-ZIP) embed a trailing PNG thumbnail instead.
 * Everything here uses only Node.js built-ins so it runs inside Eagle's
 * thumbnail sandbox (no Eagle Plugin API, no npm install needed).
 */

'use strict';

const fs = require('fs');
const path = require('path');

const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const ZIP_LOCAL_SIG = 0x04034b50;
const ZIP_CENTRAL_SIG = 0x02014b50;
const ZIP_EOCD_SIG = 0x06054b50;

/** True when buffer starts with the ZIP local-file magic `PK\x03\x04`. */
function isZip(buffer) {
	return (
		buffer &&
		buffer.length > 4 &&
		buffer[0] === 0x50 &&
		buffer[1] === 0x4b &&
		(buffer[2] === 0x03 || buffer[2] === 0x05 || buffer[2] === 0x07) &&
		(buffer[3] === 0x04 || buffer[3] === 0x06 || buffer[3] === 0x08)
	);
}

/**
 * Minimal ZIP reader supporting STORE (method 0) and DEFLATE (method 8).
 * `.fig` archives are STORE-only, so extraction is a pure slice (no inflate).
 * DEFLATE entries are inflated with Node's built-in `zlib` when available.
 *
 * Returns Map<entryName, Buffer>. Throws when no End-Of-Central-Directory found.
 */
function unzip(buffer) {
	const file = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer);
	// Find EOCD by scanning backwards (22 bytes + up to 64KiB comment).
	let eocd = -1;
	const scanStart = Math.max(0, file.length - 22 - 0xffff);
	for (let i = file.length - 22; i >= scanStart; i--) {
		if (file.readUInt32LE(i) === ZIP_EOCD_SIG) {
			eocd = i;
			break;
		}
	}
	if (eocd < 0) throw new Error('fig: not a ZIP archive (EOCD not found)');

	const count = file.readUInt16LE(eocd + 10);
	let p = file.readUInt32LE(eocd + 16);
	const out = new Map();

	for (let i = 0; i < count; i++) {
		if (file.readUInt32LE(p) !== ZIP_CENTRAL_SIG) {
			throw new Error('fig: corrupt ZIP central directory');
		}
		const method = file.readUInt16LE(p + 10);
		const csize = file.readUInt32LE(p + 20);
		const usize = file.readUInt32LE(p + 24);
		const nameLen = file.readUInt16LE(p + 28);
		const extraLen = file.readUInt16LE(p + 30);
		const commentLen = file.readUInt16LE(p + 32);
		const localOff = file.readUInt32LE(p + 42);
		const name = file.toString('utf8', p + 46, p + 46 + nameLen);
		p += 46 + nameLen + extraLen + commentLen;

		if (name.endsWith('/')) continue; // directory marker

		// Local header name/extra lengths can differ from the central copy.
		if (file.readUInt32LE(localOff) !== ZIP_LOCAL_SIG) {
			throw new Error(`fig: bad local header for ${name}`);
		}
		const localNameLen = file.readUInt16LE(localOff + 26);
		const localExtraLen = file.readUInt16LE(localOff + 28);
		const dataOff = localOff + 30 + localNameLen + localExtraLen;
		const raw = file.subarray(dataOff, dataOff + csize);

		if (method === 0) {
			out.set(name, Buffer.from(raw));
		} else if (method === 8) {
			try {
				const zlib = require('zlib');
				out.set(name, zlib.inflateRawSync(Buffer.from(raw)));
			} catch (e) {
				// Keep the entry missing rather than failing the whole file.
				continue;
			}
		} else {
			continue; // unsupported method — skip entry
		}
		if (out.get(name) && usize && out.get(name).length !== usize && method === 0) {
			// STORE size mismatch — keep anyway, central dir wins.
		}
	}
	return out;
}

/** Parse `meta.json` from an unzipped fig map. Returns object or null. */
function parseMeta(zipMap) {
	try {
		if (!zipMap || !zipMap.has('meta.json')) return null;
		return JSON.parse(zipMap.get('meta.json').toString('utf8'));
	} catch (e) {
		return null;
	}
}

/** Read PNG dimensions from IHDR without any dependency. Returns {width,height} or null. */
function pngDimensions(pngBuffer) {
	try {
		if (!pngBuffer || pngBuffer.length < 33) return null;
		if (!pngBuffer.subarray(0, 8).equals(PNG_SIG)) return null;
		// IHDR is the first chunk: length(4) + "IHDR"(4) + width(4) + height(4)
		if (pngBuffer.toString('ascii', 12, 16) !== 'IHDR') return null;
		return {
			width: pngBuffer.readUInt32BE(16),
			height: pngBuffer.readUInt32BE(20),
		};
	} catch (e) {
		return null;
	}
}

/**
 * Scan an arbitrary buffer for embedded PNGs (handles legacy pre-ZIP `.fig`
 * files whose thumbnail is appended at the end). Returns the largest PNG
 * found (>8KB by default) or null.
 */
function extractLargestPng(buffer, minSize = 8192) {
	if (!buffer || buffer.length < minSize) return null;
	let best = null;
	let cursor = 0;
	while (true) {
		const start = buffer.indexOf(PNG_SIG, cursor);
		if (start < 0) break;
		// Find IEND chunk: 00 00 00 00 49 45 4E 44 AE 42 60 82
		let end = -1;
		let scan = start + 8;
		while (scan < buffer.length - 12) {
			if (
				buffer[scan] === 0x00 &&
				buffer[scan + 1] === 0x00 &&
				buffer[scan + 2] === 0x00 &&
				buffer[scan + 3] === 0x00 &&
				buffer[scan + 4] === 0x49 && // I
				buffer[scan + 5] === 0x45 && // E
				buffer[scan + 6] === 0x4e && // N
				buffer[scan + 7] === 0x44 // D
			) {
				end = scan + 12; // include CRC
				break;
			}
			// Jump chunk-by-chunk when possible to keep this O(n).
			if (scan + 8 > buffer.length) break;
			const len = buffer.readUInt32BE(scan);
			if (len > 64 * 1024 * 1024) {
				scan += 1;
				continue;
			}
			scan += 12 + len;
		}
		if (end > start && end - start >= minSize) {
			const candidate = buffer.subarray(start, end);
			if (!best || candidate.length > best.length) best = candidate;
			cursor = end;
		} else {
			cursor = start + 8;
		}
		if (cursor >= buffer.length) break;
	}
	return best ? Buffer.from(best) : null;
}

/** Detect image kind by magic bytes. Returns 'png' | 'jpeg' | 'webp' | 'gif' | null. */
function sniffImageKind(buffer) {
	if (!buffer || buffer.length < 12) return null;
	if (buffer.subarray(0, 8).equals(PNG_SIG)) return 'png';
	if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpeg';
	if (
		buffer.toString('ascii', 0, 4) === 'RIFF' &&
		buffer.toString('ascii', 8, 12) === 'WEBP'
	)
		return 'webp';
	if (buffer.toString('ascii', 0, 6) === 'GIF87' || buffer.toString('ascii', 0, 6) === 'GIF89')
		return 'gif';
	return null;
}

/** Human-readable byte count, e.g. 24576 -> "24 KB". */
function formatBytes(bytes) {
	if (bytes == null || isNaN(bytes)) return '—';
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(2)} MB`;
}

/**
 * Branded placeholder thumbnail (800x600 dark card with Figma-ish mark).
 * Returned as a Buffer. Hand-built PNG via pure JS (no canvas dependency)
 * so thumbnail generation never fails — solid cover + simple glyph blocks.
 */
function placeholderPng() {
	// 1x1 fallback is too small for Eagle; instead ship a real bundled asset
	// when available, otherwise synthesize a solid 800x600 PNG.
	const bundled = tryLoadBundledPlaceholder();
	if (bundled) return bundled;
	return solidPng(800, 600, { r: 30, g: 30, b: 34 });
}

function tryLoadBundledPlaceholder() {
	try {
		const candidates = [
			path.join(__dirname, '..', 'assets', 'fig-placeholder.png'),
			path.join(__dirname, 'fig-placeholder.png'),
		];
		for (const c of candidates) {
			if (fs.existsSync(c)) return fs.readFileSync(c);
		}
	} catch (e) {
		/* ignore */
	}
	return null;
}

// Minimal truecolor PNG writer (solid fill + subtle vignette rows).
function solidPng(width, height, rgb) {
	const zlib = require('zlib');
	const raw = Buffer.alloc((width * 3 + 1) * height);
	let o = 0;
	for (let y = 0; y < height; y++) {
		raw[o++] = 0; // filter byte
		const shade = 1 - (Math.abs(y - height / 2) / height) * 0.12;
		for (let x = 0; x < width; x++) {
			raw[o++] = Math.max(0, Math.min(255, Math.round(rgb.r * shade)));
			raw[o++] = Math.max(0, Math.min(255, Math.round(rgb.g * shade)));
			raw[o++] = Math.max(0, Math.min(255, Math.round(rgb.b * shade)));
		}
	}
	const compressed = zlib.deflateSync(raw);

	function chunk(type, data) {
		const len = Buffer.alloc(4);
		len.writeUInt32BE(data.length, 0);
		const typeBuf = Buffer.from(type, 'ascii');
		const crc = crc32(Buffer.concat([typeBuf, data]));
		const crcBuf = Buffer.alloc(4);
		crcBuf.writeUInt32BE(crc >>> 0, 0);
		return Buffer.concat([len, typeBuf, data, crcBuf]);
	}

	const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
	const ihdr = Buffer.alloc(13);
	ihdr.writeUInt32BE(width, 0);
	ihdr.writeUInt32BE(height, 4);
	ihdr[8] = 8; // bit depth
	ihdr[9] = 2; // truecolor
	ihdr[10] = 0;
	ihdr[11] = 0;
	ihdr[12] = 0;
	return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', compressed), chunk('IEND', Buffer.alloc(0))]);
}

// CRC32 (IEEE) for PNG chunks.
const _crcTable = (() => {
	const t = new Int32Array(256);
	for (let n = 0; n < 256; n++) {
		let c = n;
		for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
		t[n] = c;
	}
	return t;
})();

function crc32(buf) {
	let c = -1;
	for (let i = 0; i < buf.length; i++) c = _crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
	return c ^ -1;
}

module.exports = {
	isZip,
	unzip,
	parseMeta,
	pngDimensions,
	extractLargestPng,
	sniffImageKind,
	formatBytes,
	placeholderPng,
};
