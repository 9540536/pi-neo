/**
 * Ambient declaration for the `pi-asset:` import namespace.
 *
 * `pi-asset:<dist-relative-path>` imports are resolved at Bun build time by
 * the plugin in `scripts/build-binary.mjs`, which embeds the referenced file
 * into the compiled executable and replaces the import with its `$bunfs`
 * virtual path (a string). This namespace is only ever imported by
 * `src/bun/embedded-assets.ts`, which the Node.js entry never loads, so the
 * lack of a real module loader for `pi-asset:` under Node is harmless.
 */
declare module "pi-asset:*" {
	const path: string;
	export default path;
}
