#!/usr/bin/env node
import { APP_NAME } from "../config.ts";
// Side-effect import: registers the `$bunfs` paths of all embedded package
// assets (themes, export templates, announcement image) before the CLI runs.
// This module is Bun-binary-only; the Node entry never imports it.
import "./embedded-assets.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

await import("./register-bedrock.ts");
await import("../cli.ts");
