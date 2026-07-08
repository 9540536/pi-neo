#!/usr/bin/env node
/**
 * Fetch per-platform `fd` (sharkdp/fd) and `rg` (BurntSushi/ripgrep) release
 * binaries into packages/coding-agent/vendor/<tool>/<platform>/<exe> so that
 * scripts/build-binary.mjs can embed them into the single-file Bun binary.
 *
 * Asset naming mirrors `TOOLS.fd`/`TOOLS.rg` `.getAssetName` in
 * packages/coding-agent/src/utils/tools-manager.ts, including the fd darwin-x64
 * -> v10.3.0 pin (last Intel-mac fd release) and rg's linux-x64 musl triple.
 * Each tool defaults to its latest release; pin with `FD_VERSION` / `RG_VERSION`.
 *
 * Usage:
 *   node scripts/fetch-vendored-bins.mjs --all
 *   node scripts/fetch-vendored-bins.mjs --platform linux-x64
 *   node scripts/fetch-vendored-bins.mjs --all --tool rg
 *
 * Platforms: darwin-arm64, darwin-x64, linux-x64, linux-arm64, windows-x64,
 * windows-arm64. Tools: fd, rg (default: both). Idempotent: skips a binary that
 * is already present unless --force is given.
 */

import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const VENDOR_ROOT = join(REPO_ROOT, "packages", "coding-agent", "vendor");

const ALL_PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "linux-arm64", "windows-x64", "windows-arm64"];

// fd darwin-x64: last Intel-mac release (newer fd builds dropped x86_64 macOS).
const FD_DARWIN_X64_VERSION = "10.3.0";

// Per-tool release descriptors. triples: platform -> [triple, archiveExt].
// Mirrors tools-manager.ts TOOLS.<tool>.getAssetName. fd/linux-x64 uses gnu;
// rg/linux-x64 uses musl (matches what the runtime download serves).
const TOOLS = {
	fd: {
		repo: "sharkdp/fd",
		tagPrefix: "v",
		versionEnv: "FD_VERSION",
		binName: "fd",
		triples: {
			"darwin-arm64": ["aarch64-apple-darwin", "tar.gz"],
			"darwin-x64": ["x86_64-apple-darwin", "tar.gz"],
			"linux-arm64": ["aarch64-unknown-linux-gnu", "tar.gz"],
			"linux-x64": ["x86_64-unknown-linux-gnu", "tar.gz"],
			"windows-arm64": ["aarch64-pc-windows-msvc", "zip"],
			"windows-x64": ["x86_64-pc-windows-msvc", "zip"],
		},
		versionFor: (platform) => (platform === "darwin-x64" ? FD_DARWIN_X64_VERSION : null),
		archiveName: (version, triple) => `fd-v${version}-${triple}`,
	},
	rg: {
		repo: "BurntSushi/ripgrep",
		tagPrefix: "",
		versionEnv: "RG_VERSION",
		binName: "rg",
		triples: {
			"darwin-arm64": ["aarch64-apple-darwin", "tar.gz"],
			"darwin-x64": ["x86_64-apple-darwin", "tar.gz"],
			"linux-arm64": ["aarch64-unknown-linux-gnu", "tar.gz"],
			"linux-x64": ["x86_64-unknown-linux-musl", "tar.gz"],
			"windows-arm64": ["aarch64-pc-windows-msvc", "zip"],
			"windows-x64": ["x86_64-pc-windows-msvc", "zip"],
		},
		versionFor: () => null,
		archiveName: (version, triple) => `ripgrep-${version}-${triple}`,
	},
};

async function latestVersion(repo) {
	const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
		headers: { "User-Agent": "pi-build" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!res.ok) throw new Error(`GitHub API error fetching latest ${repo} release: ${res.status}`);
	const data = await res.json();
	return String(data.tag_name).replace(/^v/, "");
}

async function downloadFile(url, dest) {
	const res = await fetch(url, { signal: AbortSignal.timeout(180_000), redirect: "follow" });
	if (!res.ok || !res.body) throw new Error(`Failed to download ${url}: ${res.status}`);
	const { createWriteStream } = await import("node:fs");
	const { Readable } = await import("node:stream");
	const { pipeline } = await import("node:stream/promises");
	await pipeline(Readable.fromWeb(res.body), createWriteStream(dest));
}

function findBinary(root, name) {
	const stack = [root];
	while (stack.length) {
		const dir = stack.pop();
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const full = join(dir, entry.name);
			if (entry.isFile() && entry.name === name) return full;
			if (entry.isDirectory()) stack.push(full);
		}
	}
	return null;
}

function extract(archive, dest, ext) {
	let failure = null;
	if (ext === "tar.gz") {
		const r = spawnSync("tar", ["xzf", archive, "-C", dest], { stdio: "pipe" });
		if (r.status !== 0) failure = `tar: ${r.stderr?.toString().trim() || r.status}`;
	} else {
		// zip: prefer unzip, fall back to bsdtar (tar -xf handles zip on macOS/Win).
		let r = spawnSync("unzip", ["-q", "-o", archive, "-d", dest], { stdio: "pipe" });
		if (r.error || r.status !== 0) {
			r = spawnSync("tar", ["xf", archive, "-C", dest], { stdio: "pipe" });
			if (r.error || r.status !== 0) failure = `unzip/tar: ${r.stderr?.toString().trim() || r.status}`;
		}
	}
	if (failure) throw new Error(`Failed to extract ${archive}: ${failure}`);
}

async function fetchTool(toolKey, platform, latestByTool, force) {
	const tool = TOOLS[toolKey];
	const [triple, ext] = tool.triples[platform];
	const isWindows = platform.startsWith("windows");
	const exe = isWindows ? `${tool.binName}.exe` : tool.binName;

	const targetDir = join(VENDOR_ROOT, toolKey, platform);
	const outPath = join(targetDir, exe);
	if (existsSync(outPath) && !force) {
		console.log(`  ✓ ${toolKey}/${platform}: already present`);
		return;
	}

	// versionFor may pin a platform (fd darwin-x64); else env override, else latest.
	const pinned = tool.versionFor(platform);
	const version =
		pinned ?? (process.env[tool.versionEnv] ? process.env[tool.versionEnv].replace(/^v/, "") : latestByTool[toolKey]);

	const archiveBase = tool.archiveName(version, triple);
	const asset = `${archiveBase}.${ext}`;

	const tmp = mkdtempSync(join(tmpdir(), `pi-${toolKey}-${platform}-`));
	try {
		const archivePath = join(tmp, asset);
		console.log(`  • ${toolKey}/${platform}: downloading ${asset} ...`);
		await downloadFile(`https://github.com/${tool.repo}/releases/download/${tool.tagPrefix}${version}/${asset}`, archivePath);

		const extractDir = join(tmp, "extract");
		mkdirSync(extractDir, { recursive: true });
		extract(archivePath, extractDir, ext);

		const binary = findBinary(extractDir, exe);
		if (!binary) throw new Error(`${tool.binName} binary ${exe} not found in archive ${asset}`);

		mkdirSync(targetDir, { recursive: true });
		copyFileSync(binary, outPath);
		if (!isWindows) chmodSync(outPath, 0o755);
		const sizeMb = (statSync(outPath).size / (1024 * 1024)).toFixed(2);
		console.log(`  ✓ ${toolKey}/${platform}: ${outPath} (${sizeMb} MB)`);
	} finally {
		rmSync(tmp, { recursive: true, force: true });
	}
}

function parseArgs(argv) {
	const args = { platforms: [], tools: ["fd", "rg"], force: false };
	for (let i = 2; i < argv.length; i++) {
		const a = argv[i];
		if (a === "--all") args.platforms = [...ALL_PLATFORMS];
		else if (a === "--platform") args.platforms = [argv[++i]];
		else if (a === "--tool") args.tools = [argv[++i]];
		else if (a === "--force") args.force = true;
		else throw new Error(`Unknown argument: ${a}`);
	}
	return args;
}

async function main() {
	const args = parseArgs(process.argv);
	if (args.platforms.length === 0) {
		console.error("Usage: fetch-vendored-bins.mjs --all | --platform <platform> [--tool fd|rg] [--force]");
		process.exit(1);
	}
	for (const p of args.platforms) {
		if (!ALL_PLATFORMS.includes(p)) {
			console.error(`Invalid platform: ${p}\nValid: ${ALL_PLATFORMS.join(", ")}`);
			process.exit(1);
		}
	}
	for (const t of args.tools) {
		if (!TOOLS[t]) {
			console.error(`Invalid tool: ${t}\nValid: ${Object.keys(TOOLS).join(", ")}`);
			process.exit(1);
		}
	}

	// Resolve each requested tool's latest version once (unless every platform is pinned).
	const latestByTool = {};
	for (const t of args.tools) {
		const allPinned = args.platforms.every((p) => TOOLS[t].versionFor(p) || process.env[TOOLS[t].versionEnv]);
		latestByTool[t] = allPinned ? null : await latestVersion(TOOLS[t].repo);
		const src = process.env[TOOLS[t].versionEnv]
			? `${process.env[TOOLS[t].versionEnv]} (${TOOLS[t].versionEnv})`
			: allPinned
				? "pinned"
				: `${latestByTool[t]} (latest)`;
		console.log(`==> ${t} version: ${src}`);
	}

	for (const t of args.tools) {
		for (const p of args.platforms) {
			await fetchTool(t, p, latestByTool, args.force);
		}
	}
	console.log("==> Done.");
}

main().catch((err) => {
	console.error(`Error: ${err instanceof Error ? err.message : err}`);
	process.exit(1);
});
