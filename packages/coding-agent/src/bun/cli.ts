#!/usr/bin/env node
// Side-effect import FIRST: registers the `$bunfs` paths of all embedded
// package assets (including package.json) before config.ts reads them at
// startup. This module is Bun-binary-only; the Node entry never imports it.
import "./embedded-assets.ts";
import { APP_NAME } from "../config.ts";

process.title = APP_NAME;
process.emitWarning = (() => {}) as typeof process.emitWarning;

import { restoreSandboxEnv } from "./restore-sandbox-env.ts";

restoreSandboxEnv();

await import("./register-bedrock.ts");
await import("../cli.ts");
