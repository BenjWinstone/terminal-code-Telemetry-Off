const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const { test } = require("node:test");

const { parseRawColors, watchLiveColors } = require("../dist/livesync.js");
const { withFallbacks } = require("../dist/terminal/osc.js");
const { liveSettings, paletteFingerprint } = require("../dist/theme/generate.js");

const RED = withFallbacks({ background: [0, 0, 0], foreground: [255, 255, 255], ansi: new Array(16).fill(null) });
const BLUE = withFallbacks({ background: [0, 0, 40], foreground: [230, 230, 255], ansi: new Array(16).fill(null) });

test("a colours file with both ends missing is not a palette", () => {
  assert.equal(parseRawColors("{}"), null);
  assert.equal(parseRawColors('{"background":[0,0,0]}'), null);
  assert.equal(parseRawColors("not json"), null);
});

test("a full colours file round-trips through withFallbacks", () => {
  const palette = parseRawColors(
    JSON.stringify({ background: [0, 0, 0], foreground: [255, 255, 255], ansi: new Array(16).fill(null) }),
  );
  assert.deepEqual(palette.background, [0, 0, 0]);
  assert.deepEqual(palette.foreground, [255, 255, 255]);
  assert.equal(palette.ansi.length, 16);
});

/** the writer replaces the file with an atomic rename rather than an in-place
 * write, which is exercised here instead of a plain writeFileSync so the
 * directory-watch path (not a same-inode watch) is what is actually tested */
function writeAtomic(file, contents) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, contents);
  fs.renameSync(tmp, file);
}

test("a genuine palette change on disk is reported, a rewrite of the same one is not", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-livecolors-"));
  const file = path.join(dir, "live-colors.raw.json");
  const seen = [];
  const stop = watchLiveColors(file, RED, (palette) => seen.push(palette));
  try {
    writeAtomic(file, JSON.stringify({ background: RED.background, foreground: RED.foreground, ansi: RED.ansi }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 0, "the starting palette rewritten is not a change");

    writeAtomic(file, JSON.stringify({ background: BLUE.background, foreground: BLUE.foreground, ansi: BLUE.ansi }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 1, "a real change must fire exactly once");
    assert.equal(paletteFingerprint(seen[0]), paletteFingerprint(BLUE));

    writeAtomic(file, JSON.stringify({ background: BLUE.background, foreground: BLUE.foreground, ansi: BLUE.ansi }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 1, "rewriting the same palette again must not fire again");
  } finally {
    stop();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stopping the watcher stops further callbacks", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-livecolors-"));
  const file = path.join(dir, "live-colors.raw.json");
  const seen = [];
  const stop = watchLiveColors(file, RED, (palette) => seen.push(palette));
  stop();
  try {
    writeAtomic(file, JSON.stringify({ background: BLUE.background, foreground: BLUE.foreground, ansi: BLUE.ansi }));
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(seen.length, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** loads the generated bridge extension in a sandbox with a fake vscode, so
 * the live-settings watch is exercised the same way code-server would run it,
 * not just checked for valid syntax. os.homedir() is pointed at a scratch
 * directory too, since activate() also stands up the real ipc socket and this
 * must not touch the actual home directory while doing it. */
function loadBridgeSandbox(extensionSource, fakeHome) {
  const updates = [];
  const vscode = {
    workspace: { getConfiguration: () => ({ update: (key, value) => updates.push({ key, value }) }) },
    ConfigurationTarget: { Global: 1 },
    commands: { registerCommand: () => ({ dispose() {} }) },
    window: { tabGroups: { all: [], onDidChangeTabs: () => ({ dispose() {} }) } },
  };
  const realOs = require("node:os");
  const sandboxModules = { vscode, os: { ...realOs, homedir: () => fakeHome } };
  const sandbox = {
    require: (id) => sandboxModules[id] ?? require(id),
    module: { exports: {} },
    exports: {},
    console,
    process,
    setTimeout,
    clearTimeout,
  };
  sandbox.exports = sandbox.module.exports;
  vm.createContext(sandbox);
  new vm.Script(extensionSource).runInContext(sandbox);
  return { extension: sandbox.module.exports, updates };
}

test("the bridge applies live settings on activation and again on every change, without a reload", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-live-bridge-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installBridge, BRIDGE_DIR } = require("../dist/bridge.js");
  const { LIVE_SETTINGS_FILE } = require("../dist/profile.js");
  try {
    installBridge(["/usr/local/bin/tode"]);
    const source = fs.readFileSync(path.join(BRIDGE_DIR, "extension.js"), "utf8");

    fs.mkdirSync(path.dirname(LIVE_SETTINGS_FILE), { recursive: true });
    fs.writeFileSync(LIVE_SETTINGS_FILE, `${JSON.stringify(liveSettings(RED))}\n`);

    const { extension, updates } = loadBridgeSandbox(source, home);
    const context = { subscriptions: [], environmentVariableCollection: { replace() {} } };
    extension.activate(context);
    try {
      // values crossed the vm sandbox boundary, so they carry that context's
      // Object prototype; comparing serialized form sidesteps the realm mismatch
      const same = (a, b) => assert.equal(JSON.stringify(a), JSON.stringify(b));
      assert.equal(updates.length, 2, "activation applies the settings already on disk");
      same(updates[0].value, liveSettings(RED)["workbench.colorCustomizations"]);

      const tmp = `${LIVE_SETTINGS_FILE}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(liveSettings(BLUE))}\n`);
      fs.renameSync(tmp, LIVE_SETTINGS_FILE);
      await new Promise((r) => setTimeout(r, 150));

      // a directory watch can report a single rename as more than one event
      // (platform-dependent), so more than one redundant, idempotent
      // re-application is fine — what must hold is that it settles on the new
      // palette without anyone reloading the window in between
      assert.ok(updates.length > 2, "a live change is applied again, with no reload in between");
      const last = (key) => [...updates].reverse().find((u) => u.key === key)?.value;
      same(last("workbench.colorCustomizations"), liveSettings(BLUE)["workbench.colorCustomizations"]);
      same(last("editor.tokenColorCustomizations"), liveSettings(BLUE)["editor.tokenColorCustomizations"]);
    } finally {
      for (const sub of context.subscriptions) sub.dispose();
    }
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});

test("installLiveSettings writes exactly what the bridge will read back", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "tode-live-settings-"));
  const prev = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = path.join(home, "share");
  for (const key of Object.keys(require.cache)) delete require.cache[key];
  const { installLiveSettings, LIVE_SETTINGS_FILE } = require("../dist/profile.js");
  try {
    const changed = installLiveSettings(RED);
    assert.equal(changed, true);
    const onDisk = JSON.parse(fs.readFileSync(LIVE_SETTINGS_FILE, "utf8"));
    assert.deepEqual(onDisk, liveSettings(RED));

    const changedAgain = installLiveSettings(RED);
    assert.equal(changedAgain, false, "writing the same palette twice is a no-op");
  } finally {
    process.env.XDG_DATA_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
    for (const key of Object.keys(require.cache)) delete require.cache[key];
  }
});
