import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "omni-cmdtest-"));
process.env.OMNI_HOME = home;

const { loadSettings, saveSettings, resolveModel } = await import("../src/core/config.mjs");
const { COMMANDS, findCommand, dispatchCommand, commandNames } = await import("../src/cli/commands.mjs");
const { buildConnectRows, buildDisconnectRows, disconnectInteractive, addProviderInteractive } = await import("../src/cli/models.mjs");

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    pass++;
  } catch (err) {
    console.error(`  ✗ ${name}:`, err.message);
    fail++;
  }
}

const settings = await loadSettings();
const model = resolveModel(settings, settings.defaultModel);

// Minimal mock CLI context
function createCtx() {
  return {
    settings,
    model,
    messages: [],
    session: {
      append: async () => {},
      messages: () => [],
    },
    skills: [],
    skillByCommand: new Map(),
    canRaw: false, // Non-interactive mode for tests
    contextMode: "classic",
    activePersona: "coding",
    project: { registry: "https://globalwarningnetworks.com/repo" },
    routerCfg: { enabled: false },
    routeMode: "auto",
    lastFetchedModels: [],
  };
}

console.log("\nTesting Command Registry & Resolution:");

await test("no command name or alias is registered twice", () => {
  // Two entries shared the name "providers". findCommand keeps the LAST, so
  // the other handler was dead code — and /help printed the command twice,
  // with two different descriptions.
  const names = COMMANDS.flatMap((c) => [c.name, ...c.aliases]).filter(Boolean);
  const dupes = [...new Set(names.filter((n, i) => names.indexOf(n) !== i))];
  assert.deepEqual(dupes, [], "a shadowed command is unreachable and appears twice in /help");
});

await test("every registered command is reachable via findCommand", () => {
  const unreachable = COMMANDS.filter((c) => findCommand(c.name) !== c).map((c) => c.name);
  assert.deepEqual(unreachable, []);
});

await test("All 53 commands have name, summary, category, and handler", () => {
  assert.ok(COMMANDS.length >= 50, `Expected at least 50 commands, got ${COMMANDS.length}`);
  for (const cmd of COMMANDS) {
    assert.ok(cmd.name, "Command has a name");
    assert.ok(cmd.summary, `Command ${cmd.name} has a summary`);
    assert.ok(cmd.category, `Command ${cmd.name} has a category`);
    assert.equal(typeof cmd.handler, "function", `Command ${cmd.name} has a handler`);
    assert.ok(findCommand(cmd.name), `findCommand resolves ${cmd.name}`);
  }
});

await test("commandNames() returns all slash-prefixed names", () => {
  const names = commandNames();
  assert.ok(names.includes("/help"));
  assert.ok(names.includes("/connect"));
  assert.ok(names.includes("/disconnect"));
  assert.ok(names.includes("/apikey"));
  assert.ok(names.includes("/model"));
});

console.log("\nTesting Safe Command Dispatch (Non-Interactive):");

const safeCommands = [
  ["help", ""],
  ["version", ""],
  ["status", ""],
  ["config", ""],
  ["cwd", ""],
  ["cost", ""],
  ["tools", ""],
  ["providers", ""],
  ["provider", "list"],
  ["provider", "presets"],
  ["apikey", ""],
  ["route", ""],
  ["effort", ""],
  ["thinking", ""],
  ["diff", ""],
  ["perm", ""],
  ["workspace", ""],
  ["packages", ""],
  ["bridge", ""],
  ["mcp", ""],
  ["hardware", ""],
];

for (const [cmd, arg] of safeCommands) {
  await test(`dispatch /${cmd} ${arg}`.trim(), async () => {
    const ctx = createCtx();
    const parts = [cmd, ...arg.split(/\s+/).filter(Boolean)];
    await dispatchCommand(ctx, cmd, arg, parts);
  });
}

console.log("\nTesting /disconnect & /connect flows:");

await test("buildDisconnectRows: lists providers with keys", () => {
  const testSettings = {
    providers: {
      hasKey: { baseUrl: "https://api.example.com", apiKey: "sk-123" },
      noKey: { baseUrl: "https://api.example.com", apiKey: "" },
      sentinel: { baseUrl: "http://localhost:8080", apiKey: "not-needed" },
    },
  };
  const rows = buildDisconnectRows(testSettings);
  assert.equal(rows.length, 2, "only hasKey and sentinel (not-needed) should appear");
  assert.equal(rows[0].id, "hasKey");
  assert.equal(rows[1].id, "sentinel");
});

await test("buildConnectRows: lists configured, presets, and custom", () => {
  const testSettings = {
    providers: {
      nvidia: { baseUrl: "https://integrate.api.nvidia.com/v1", apiKey: "nv-123" },
    },
  };
  const rows = buildConnectRows(testSettings);
  assert.ok(rows.find(r => r.id === "configured:nvidia"));
  assert.ok(rows.find(r => r.id === "custom"));
  assert.ok(rows.find(r => r.id === "preset:minimax.io"));
});

await test("Direct /disconnect clears provider apiKey", async () => {
  const ctx = createCtx();
  ctx.settings.providers.testProv = {
    baseUrl: "https://api.example.com",
    apiKey: "sk-test-to-clear",
  };
  await dispatchCommand(ctx, "disconnect", "testProv", ["disconnect", "testProv"]);
  assert.equal(ctx.settings.providers.testProv.apiKey, "", "apiKey should be cleared");
});

await test("/addprovider rejects raw API keys as baseUrls", async () => {
  const ctx = createCtx();
  await addProviderInteractive(ctx, "customBad sk-cp-1234567890");
  assert.equal(ctx.settings.providers.customBad, undefined, "should not save provider with invalid baseUrl");
});

await test("/addprovider accepts preset name with apiKey and preserves preset baseUrl", async () => {
  const ctx = createCtx();
  await addProviderInteractive(ctx, "minimax.io sk-test-key-preset");
  assert.ok(ctx.settings.providers["minimax.io"]);
  assert.equal(ctx.settings.providers["minimax.io"].baseUrl, "https://api.minimax.io/v1");
  assert.equal(ctx.settings.providers["minimax.io"].apiKey, "sk-test-key-preset");
});

console.log(`\nAll Tests: ${pass} passed, ${fail} failed\n`);
process.exit(fail > 0 ? 1 : 0);
