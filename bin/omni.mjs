#!/usr/bin/env node
// Omni CLI launcher — all logic lives in src/cli/.
import { main } from "../src/cli/main.mjs";

main(process.argv.slice(2)).catch((e) => {
  console.error(e?.stack || String(e));
  process.exit(1);
});
