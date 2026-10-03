/**
 * thumbnail/fig.js — Eagle format-extension thumbnail generator for
 * `.fig` / `.jam` / `.deck` (Figma) files.
 *
 * Eagle calls:  module.exports = async ({ src, dest, item }) => { ... }
 * Must write a PNG/JPG to `dest` and resolve with the (optionally
 * dimension-updated) item. Reject only when thumbnail truly cannot be made —
 * we always fall back to a branded placeholder so the library never shows
 * a broken tile.
 *
 * Strategy (dependency-free, offline):
 *   1. Modern file = ZIP STORE → extract `thumbnail.png` verbatim.
 *   2. Legacy file = scan binary for largest embedded PNG.
 *   3. Fallback = synthesized placeholder PNG (never rejects).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const utils = require('../js/fig-utils.js');

module.exports = async ({ src, dest, item }) => {
	return new Promise((resolve, reject) => {
		try {
			if (!src || !fs.existsSync(src)) {
				return reject(new Error(`fig thumbnail: source not found: ${src}`));
			}

			let buffer;
			try {
				buffer = fs.readFileSync(src);
			} catch (e) {
				return reject(new Error(`fig thumbnail: cannot read file (${e.message})`));
			}

			let thumb = null;
			let meta = null;

			// Path A — modern ZIP container: grab thumbnail.png directly.
			if (utils.isZip(buffer)) {
				try {
					const zip = utils.unzip(buffer);
					if (zip.has('thumbnail.png')) {
						const t = zip.get('thumbnail.png');
						if (t && t.length > 1024 && utils.sniffImageKind(t) === 'png') {
							thumb = t;
						}
					}
					meta = utils.parseMeta(zip);
				} catch (e) {
					// Corrupt ZIP — fall through to PNG scan, then placeholder.
				}
			}

			// Path B — legacy pre-ZIP file: largest embedded PNG.
			if (!thumb) {
				try {
					thumb = utils.extractLargestPng(buffer);
				} catch (e) {
					thumb = null;
				}
			}

			// Path C — guaranteed placeholder (synthesized, no assets needed).
			if (!thumb) {
				thumb = utils.placeholderPng();
			}

			try {
				fs.mkdirSync(path.dirname(dest), { recursive: true });
				fs.writeFileSync(dest, thumb);
			} catch (e) {
				return reject(new Error(`fig thumbnail: cannot write dest (${e.message})`));
			}

			if (!fs.existsSync(dest)) {
				return reject(new Error('fig thumbnail: generation failed.'));
			}

			// Report real dimensions back to Eagle so grid tiles keep aspect ratio.
			try {
				const dim = utils.pngDimensions(thumb);
				if (dim && dim.width > 0 && dim.height > 0) {
					item.width = dim.width;
					item.height = dim.height;
				}
			} catch (e) {
				/* keep Eagle defaults */
			}

			// Stash the Figma document title into the annotation when available
			// (Eagle shows it in the inspector; harmless when meta is absent).
			try {
				if (meta && (meta.file_name || meta.fileName || meta.name) && !item.annotation) {
					item.annotation = String(meta.file_name || meta.fileName || meta.name);
				}
			} catch (e) {
				/* ignore */
			}

			return resolve(item);
		} catch (err) {
			return reject(err);
		}
	});
};
