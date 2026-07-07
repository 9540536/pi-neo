#!/usr/bin/env bun
/**
 * Compile a single-file Bun binary with package assets embedded, replacing the
 * previous `bun build --compile` CLI invocation.
 *
 * Why a script instead of the CLI: the project's tsconfig uses `module: Node16`,
 * which rejects import attributes (`with { type: "file" }`). To embed arbitrary
 * file types (HTML/CSS/PNG, and vendored `.min.js` as raw text rather than as an
 * executed module) we instead resolve a custom `pi-asset:` namespace through a
 * build plugin and force the `file` loader, which Bun embeds into the `$bunfs`
 * virtual filesystem of the compiled executable. `readFileSync()` works against
 * those `$bunfs` paths at runtime.
 *
 * Usage:
 *   bun run scripts/build-binary.mjs \
 *     --entry packages/coding-agent/dist/bun/cli.js \
 *     --worker packages/coding-agent/src/utils/image-resize-worker.ts \
 *     --outfile packages/coding-agent/dist/pi[.exe] \
 *     [--target bun-windows-x64] \
 *     [--dist-root packages/coding-agent/dist]
 */

import { mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

function parseArgs(argv) {
	const args = { target: undefined, entry: undefined, worker: undefined, outfile: undefined, distRoot: undefined };
	for (let i = 2; i < argv.length; i++) {
		const next = argv[i + 1];
		switch (argv[i]) {
			case "--target":
				args.target = next;
				i++;
				break;
			case "--entry":
				args.entry = next;
				i++;
				break;
			case "--worker":
				args.worker = next;
				i++;
				break;
			case "--outfile":
				args.outfile = next;
				i++;
				break;
			case "--dist-root":
				args.distRoot = next;
				i++;
				break;
			default:
				throw new Error(`Unknown argument: ${argv[i]}`);
		}
	}
	return args;
}

const args = parseArgs(process.argv);
if (!args.entry || !args.outfile) {
	console.error(
		"Usage: build-binary.mjs --entry <cli.js> [--worker <worker.ts>] --outfile <path> [--target bun-...] [--dist-root <dir>]",
	);
	process.exit(1);
}

// Asset files are copied under dist/ by the package's `copy-assets` step, so
// resolve `pi-asset:` paths relative to the dist root. The entry lives at
// <dist-root>/bun/cli.js, so the default dist root is the entry directory's
// parent unless overridden via --dist-root.
const distRoot = resolve(args.distRoot ?? dirname(dirname(resolve(args.entry))));

const entrypoints = [args.entry];
if (args.worker) {
	entrypoints.push(args.worker);
}

// Bun.build names a compiled executable after the FIRST entrypoint's basename
// (here "cli", or "cli.exe" for Windows targets) and ignores `outfile` when
// multiple entrypoints are present (we pass the worker explicitly so it gets
// embedded). Write into a fresh temp directory — kept on the same filesystem as
// the target so the rename is atomic — then move the produced executable,
// whose real path is reported in result.outputs, to the requested outfile.
const target = resolve(args.outfile);
const outdir = mkdtempSync(join(tmpdir(), "pi-build-"));

const result = await Bun.build({
	entrypoints,
	outdir,
	// Omitting --target compiles for the host platform/runtime (matches the old
	// bare `bun build --compile`). Explicit targets cross-compile.
	target: args.target ?? "bun",
	compile: true,
	plugins: [
		{
			name: "pi-embed-assets",
			setup(build) {
				build.onResolve({ filter: /^pi-asset:/ }, (a) => ({
					// Strip the namespace prefix; the remainder is a dist-relative path.
					path: a.path.slice("pi-asset:".length),
					namespace: "pi-asset",
				}));
				build.onLoad({ filter: /.*/, namespace: "pi-asset" }, (a) => {
					const abs = isAbsolute(a.path) ? a.path : join(distRoot, a.path);
					// `loader: "file"` embeds the bytes and replaces the import with a
					// `$bunfs` path string that readFileSync/Bun.file can read back.
					return { contents: readFileSync(abs), loader: "file" };
				});
			},
		},
	],
});

if (!result.success) {
	for (const log of result.logs) {
		console.error(log);
	}
	rmSync(outdir, { recursive: true, force: true });
	process.exit(1);
}

// Rename the produced executable (named after the first entrypoint) to the
// requested outfile path, then clean up the temp directory.
const produced = result.outputs?.[0]?.path;
if (!produced) {
	console.error(`Build succeeded but produced no output (expected ${target}).`);
	rmSync(outdir, { recursive: true, force: true });
	process.exit(1);
}
if (produced !== target) {
	renameSync(produced, target);
}
rmSync(outdir, { recursive: true, force: true });

