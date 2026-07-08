/**
 * Registry for assets embedded into the Bun compiled binary.
 *
 * The Bun-only module `src/bun/embedded-assets.ts` imports each asset through
 * the `pi-asset:` namespace (resolved and embedded by the build plugin in
 * `scripts/build-binary.mjs`) and registers its `$bunfs` path here at startup.
 *
 * Shared runtime code reads via `getEmbeddedAsset()`. When running under
 * Node.js (the npm distribution) the registry is empty, so callers fall back
 * to resolving the asset on disk relative to the executable — i.e. embedding
 * only changes the Bun binary path, never the Node path.
 */

import { createHash } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const embeddedAssets = new Map<string, string>();

/** Register an embedded asset's virtual filesystem path. Bun binary only. */
export function registerEmbeddedAsset(name: string, path: string): void {
	embeddedAssets.set(name, path);
}

/**
 * Look up an embedded asset path by logical name.
 * Returns `undefined` unless running inside a Bun compiled binary whose entry
 * imported `src/bun/embedded-assets.ts`.
 */
export function getEmbeddedAsset(name: string): string | undefined {
	return embeddedAssets.get(name);
}

const nativeRequire = createRequire(import.meta.url);
const nativeCache = new Map<string, unknown>();

/**
 * Load an embedded native `.node` addon by logical name (e.g. "clipboard.node").
 *
 * Bun 1.3.x has a bundler codegen bug: importing an embedded `.node` addon in a
 * compiled binary emits `__require("/$bunfs/...")`, which is undefined at
 * runtime. So addons are embedded as raw bytes (file loader) and materialized
 * to a temp file here, then loaded via `require()` (which triggers
 * `process.dlopen`). The temp name derives from the embedded path (which Bun
 * hashes by content), so identical content reuses the same file across runs.
 *
 * Returns `undefined` when no addon is registered (Node path) or the embedded
 * payload is empty (the build embeds a stub for native addons not applicable to
 * the current target). Load errors fall through to `undefined` so callers can
 * degrade gracefully.
 */
export function loadEmbeddedNative<T = unknown>(name: string): T | undefined {
	if (nativeCache.has(name)) return nativeCache.get(name) as T | undefined;
	const embeddedPath = getEmbeddedAsset(`node/${name}`);
	if (!embeddedPath) return undefined;
	try {
		const bytes = readFileSync(embeddedPath);
		if (bytes.byteLength === 0) return undefined; // stub for an inapplicable target
		const tmpNode = join(tmpdir(), `pi-${basename(embeddedPath)}`);
		if (!existsSync(tmpNode)) writeFileSync(tmpNode, bytes, { mode: 0o755 });
		const addon = nativeRequire(tmpNode) as T;
		nativeCache.set(name, addon);
		return addon;
	} catch {
		return undefined;
	}
}

const binaryCache = new Map<string, string>();

/**
 * Materialize an embedded standalone executable (e.g. the `fd` binary) to a
 * temp file and return its absolute path, so callers can `spawn()` it.
 *
 * Standalone executables can't be loaded like a `.node` addon, so — as with
 * `loadEmbeddedNative` — the embedded bytes (file loader under the `pi-asset:`
 * namespace) are written to `os.tmpdir()` on first use. The temp name carries a
 * short hash of the bytes: identical content reuses the file across runs, while
 * a new binary version lands at a fresh path instead of overwriting a possibly
 * running copy. On Windows the `.exe` suffix is forced so `CreateProcess`
 * accepts the path. Returns `undefined` under Node (nothing registered) or when
 * the embedded payload is empty (the build embeds a 0-byte stub for a target
 * that had no vendored binary available, in which case callers fall back to the
 * usual locate-or-download path).
 */
export function loadEmbeddedBinary(name: string): string | undefined {
	if (binaryCache.has(name)) return binaryCache.get(name);
	const embeddedPath = getEmbeddedAsset(`bin/${name}`);
	if (!embeddedPath) return undefined;
	try {
		const bytes = readFileSync(embeddedPath);
		if (bytes.byteLength === 0) return undefined; // stub for a target without a vendored binary
		const hash = createHash("sha256").update(bytes).digest("hex").slice(0, 16);
		const ext = process.platform === "win32" ? ".exe" : "";
		const tmpPath = join(tmpdir(), `pi-${name}-${hash}${ext}`);
		if (!existsSync(tmpPath)) {
			writeFileSync(tmpPath, bytes, { mode: 0o755 });
			// writeFileSync's mode is masked by the process umask; set the real bit.
			if (process.platform !== "win32") chmodSync(tmpPath, 0o755);
		}
		binaryCache.set(name, tmpPath);
		return tmpPath;
	} catch {
		return undefined;
	}
}
