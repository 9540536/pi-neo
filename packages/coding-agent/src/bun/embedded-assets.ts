/**
 * Bun-binary-only asset embedding.
 *
 * This module is imported (for its side effects) only by `src/bun/cli.ts`,
 * i.e. only inside the Bun compiled binary. It statically imports every
 * package asset that previously had to ship as a companion file next to the
 * executable (HTML export templates + vendored JS, built-in themes, the
 * announcement image) through the `pi-asset:` namespace, then registers each
 * embedded `$bunfs` path so shared code can read it via `getEmbeddedAsset()`.
 *
 * The Node.js (npm) entry never imports this module, so the `pi-asset:`
 * imports — which have no loader under Node — are never evaluated there.
 */

import templateCss from "pi-asset:core/export-html/template.css";

// HTML export pipeline (templates + vendored JS, read as text and inlined).
import templateHtml from "pi-asset:core/export-html/template.html";
import templateJs from "pi-asset:core/export-html/template.js";
import highlightJs from "pi-asset:core/export-html/vendor/highlight.min.js";
import markedJs from "pi-asset:core/export-html/vendor/marked.min.js";
// Interactive-mode bundled image asset.
import announcementImage from "pi-asset:modes/interactive/assets/clankolas.png";
// Built-in themes (custom/user themes stay on disk under ~/.pi).
import darkTheme from "pi-asset:modes/interactive/theme/dark.json";
import lightTheme from "pi-asset:modes/interactive/theme/light.json";
// Native addons (per-target; the build embeds the platform-appropriate binding
// or an empty stub for targets that don't use a given addon).
import clipboardNode from "pi-asset:node/clipboard.node";
import darwinModifiersNode from "pi-asset:node/darwin-modifiers.node";
import win32ConsoleModeNode from "pi-asset:node/win32-console-mode.node";
// Photon WASM (image processing). photon-node reads this via fs.readFileSync at
// runtime; the embedded $bunfs path is fed to it through photon.ts's fallback.
import photonWasm from "pi-asset:wasm/photon_rs_bg.wasm";
import { loadEmbeddedNative, registerEmbeddedAsset } from "../core/embedded-assets.ts";

registerEmbeddedAsset("export-html/template.html", templateHtml);
registerEmbeddedAsset("export-html/template.css", templateCss);
registerEmbeddedAsset("export-html/template.js", templateJs);
registerEmbeddedAsset("export-html/vendor/marked.min.js", markedJs);
registerEmbeddedAsset("export-html/vendor/highlight.min.js", highlightJs);
registerEmbeddedAsset("themes/dark.json", darkTheme);
registerEmbeddedAsset("themes/light.json", lightTheme);
registerEmbeddedAsset("interactive/assets/clankolas.png", announcementImage);
registerEmbeddedAsset("wasm/photon_rs_bg.wasm", photonWasm);
registerEmbeddedAsset("node/clipboard.node", clipboardNode);
registerEmbeddedAsset("node/darwin-modifiers.node", darwinModifiersNode);
registerEmbeddedAsset("node/win32-console-mode.node", win32ConsoleModeNode);

// Expose a lazy native-addon loader on globalThis so the pi-tui package (which
// this package depends on and therefore cannot import back) can load embedded
// native addons without companion files on disk.
(globalThis as { __piEmbeddedNative?: (name: string) => unknown }).__piEmbeddedNative = (name: string) =>
	loadEmbeddedNative(name);
