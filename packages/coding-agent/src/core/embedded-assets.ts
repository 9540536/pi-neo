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
