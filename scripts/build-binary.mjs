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

import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

function parseArgs(argv) {
	const args = { target: undefined, entry: undefined, worker: undefined, outfile: undefined, distRoot: undefined };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		// Accept both `--flag value` and `--flag=value`.
		const eq = a.indexOf("=");
		const key = eq >= 0 ? a.slice(0, eq) : a;
		const inline = eq >= 0 ? a.slice(eq + 1) : undefined;
		const value = inline ?? argv[i + 1];
		switch (key) {
			case "--target":
				args.target = value;
				if (inline === undefined) i++;
				break;
			case "--entry":
				args.entry = value;
				if (inline === undefined) i++;
				break;
			case "--worker":
				args.worker = value;
				if (inline === undefined) i++;
				break;
			case "--outfile":
				args.outfile = value;
				if (inline === undefined) i++;
				break;
			case "--dist-root":
				args.distRoot = value;
				if (inline === undefined) i++;
				break;
			default:
				throw new Error(`Unknown argument: ${a}`);
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
const repoRoot = resolve(distRoot, "../../.."); // monorepo root (for node_modules)
const pkgRoot = dirname(distRoot); // packages/coding-agent (package.json lives here)

// Map each `pi-asset:<name>` import to its source file. Most assets live under
// dist/ (copied by copy-assets); the Photon WASM lives in node_modules, package.json
// at the package root, and native addons (added per target below) in node_modules /
// tui/native. Stable logical names keep the Bun-only embedded-assets module
// target-agnostic.
const assets = {
	"package.json": join(pkgRoot, "package.json"),
	"core/export-html/template.html": join(distRoot, "core/export-html/template.html"),
	"core/export-html/template.css": join(distRoot, "core/export-html/template.css"),
	"core/export-html/template.js": join(distRoot, "core/export-html/template.js"),
	"core/export-html/vendor/marked.min.js": join(distRoot, "core/export-html/vendor/marked.min.js"),
	"core/export-html/vendor/highlight.min.js": join(distRoot, "core/export-html/vendor/highlight.min.js"),
	"modes/interactive/theme/dark.json": join(distRoot, "modes/interactive/theme/dark.json"),
	"modes/interactive/theme/light.json": join(distRoot, "modes/interactive/theme/light.json"),
	"modes/interactive/assets/clankolas.png": join(distRoot, "modes/interactive/assets/clankolas.png"),
	"wasm/photon_rs_bg.wasm": join(repoRoot, "node_modules/@silvia-odwyer/photon-node/photon_rs_bg.wasm"),
};

// Per-target native addons. Linux needs none (clipboard uses wl-copy/xclip and
// there is no terminal native); darwin and windows each need their clipboard
// binding plus a terminal native. The platform binding packages are installed
// by scripts/build-binaries.sh; for a host build (no --target) we target the
// host platform so a dev build on macOS/Windows embeds the right addon.
const nativeAddons = {
	"bun-darwin-arm64": {
		"node/clipboard.node": join(
			repoRoot,
			"node_modules/@mariozechner/clipboard-darwin-arm64/clipboard.darwin-arm64.node",
		),
		"node/darwin-modifiers.node": join(
			repoRoot,
			"packages/tui/native/darwin/prebuilds/darwin-arm64/darwin-modifiers.node",
		),
	},
	"bun-darwin-x64": {
		"node/clipboard.node": join(
			repoRoot,
			"node_modules/@mariozechner/clipboard-darwin-x64/clipboard.darwin-x64.node",
		),
		"node/darwin-modifiers.node": join(
			repoRoot,
			"packages/tui/native/darwin/prebuilds/darwin-x64/darwin-modifiers.node",
		),
	},
	"bun-windows-x64": {
		"node/clipboard.node": join(
			repoRoot,
			"node_modules/@mariozechner/clipboard-win32-x64-msvc/clipboard.win32-x64-msvc.node",
		),
		"node/win32-console-mode.node": join(
			repoRoot,
			"packages/tui/native/win32/prebuilds/win32-x64/win32-console-mode.node",
		),
	},
	"bun-windows-arm64": {
		"node/clipboard.node": join(
			repoRoot,
			"node_modules/@mariozechner/clipboard-win32-arm64-msvc/clipboard.win32-arm64-msvc.node",
		),
		"node/win32-console-mode.node": join(
			repoRoot,
			"packages/tui/native/win32/prebuilds/win32-arm64/win32-console-mode.node",
		),
	},
};

function hostTargetKey() {
	const platform = process.platform === "darwin" ? "darwin" : process.platform === "win32" ? "windows" : "linux";
	return `bun-${platform}-${process.arch}`;
}
const targetKey = args.target ?? hostTargetKey();
Object.assign(assets, nativeAddons[targetKey] ?? {});

// Standalone executables embedded per target. `fd` (file-finder) and `rg`
// (ripgrep) are fetched into packages/coding-agent/vendor/<tool>/<platform>/
// <exe> by scripts/fetch-vendored-bins.mjs (invoked from build-binaries.sh).
// When no vendored binary is present for a tool/target — e.g. a host
// `npm run build:binary` without a prior fetch — no entry is added and the
// plugin below embeds a 0-byte stub so the build still succeeds; at runtime
// loadEmbeddedBinary then returns undefined and the tool is located/downloaded
// as usual.
const embeddedBinaries = {
	"bun-darwin-arm64": "darwin-arm64",
	"bun-darwin-x64": "darwin-x64",
	"bun-linux-x64": "linux-x64",
	"bun-linux-arm64": "linux-arm64",
	"bun-windows-x64": "windows-x64",
	"bun-windows-arm64": "windows-arm64",
};
const binPlatform = embeddedBinaries[targetKey];
if (binPlatform) {
	for (const tool of ["fd", "rg"]) {
		const exe = binPlatform.startsWith("windows") ? `${tool}.exe` : tool;
		const path = join(pkgRoot, "vendor", tool, binPlatform, exe);
		if (existsSync(path)) {
			assets[`bin/${tool}`] = path;
		} else {
			console.warn(
				`[build-binary] No vendored ${tool} for ${targetKey} at ${path}; ` +
					`embedding a stub (${tool} will be located/downloaded at runtime).`,
			);
		}
	}
}

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
					const mapped = assets[a.path];
					if (mapped) {
						return { contents: readFileSync(mapped), loader: "file" };
					}
					// Native-addon names not applicable to this target (e.g. the
					// darwin addon on a linux build) embed as an empty stub so the
					// static import in embedded-assets.ts still resolves; the runtime
					// loader treats a 0-byte payload as "no native available".
					// Standalone `bin/` executables do the same when no vendored binary
					// was available for this target.
					if (a.path.startsWith("node/") || a.path.startsWith("bin/")) {
						return { contents: new Uint8Array(0), loader: "file" };
					}
					// Any other asset is resolved relative to dist/.
					return { contents: readFileSync(join(distRoot, a.path)), loader: "file" };
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
	try {
		renameSync(produced, target);
	} catch (err) {
		if (err?.code !== "EXDEV") throw err;
		// Cross-device rename (e.g. outdir on /tmp, target on a WSL /mnt/c Windows
		// mount): copy across filesystems, then drop the temp. chmod because cpSync
		// may not preserve the executable bit.
		cpSync(produced, target);
		chmodSync(target, 0o755);
	}
}
rmSync(outdir, { recursive: true, force: true });

