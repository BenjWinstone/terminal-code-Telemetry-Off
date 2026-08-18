const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");

const { resolveTarget, workbenchUrl } = require("../dist/target.js");

test("a folder resolves to a folder target, a file to a file target", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-target-"));
  const file = path.join(dir, "present.txt");
  fs.writeFileSync(file, "");
  assert.deepEqual(resolveTarget(".", dir), { folder: dir, file: null });
  assert.deepEqual(resolveTarget("present.txt", dir), { folder: null, file });
});

test("a path that does not exist yet opens as a new file, like vim", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tode-target-"));
  const target = resolveTarget("not-made-yet.txt", dir);
  assert.deepEqual(target, { folder: null, file: path.join(dir, "not-made-yet.txt") });
  // and it rides the openFile payload, whose workbench side is open-or-create
  const url = new URL(workbenchUrl("http://127.0.0.1:8080/", target));
  const payload = JSON.parse(url.searchParams.get("payload"));
  assert.equal(payload[0][0], "openFile");
  assert.ok(payload[0][1].endsWith("/not-made-yet.txt"));
});
