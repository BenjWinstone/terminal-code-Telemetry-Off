const assert = require("node:assert");
const { test } = require("node:test");

function fakePalette() {
  return {
    background: [20, 22, 26],
    foreground: [232, 230, 227],
    ansi: Array.from({ length: 16 }, (_, at) => [at * 10, at * 10, at * 10]),
  };
}

test("the import page server: page, import, done", async () => {
  const { startImportPage } = require("../dist/import/web.js");
  const ran = [];
  const page = await startImportPage({
    palette: fakePalette(),
    editors: [{ name: "Cursor" }, { name: "Code" }],
    run: (name) => {
      ran.push(name);
      return [{ kind: "ok", label: "settings", value: "3 entries" }];
    },
  });
  const base = `http://127.0.0.1:${page.port}`;
  try {
    assert.equal(page.served(), false, "nothing served yet");
    const html = await (await fetch(base)).text();
    assert.match(html, /terminal-browser import/);
    assert.match(html, /--bg: #14161a/, "the page draws with the terminal's tokens");
    assert.equal(page.served(), true);

    const state = await (await fetch(`${base}/state`)).json();
    assert.deepEqual(state.editors.map((editor) => editor.name), ["Cursor", "Code"]);

    const refused = await (await fetch(`${base}/import`, { method: "POST", body: JSON.stringify({ name: "Nope" }) })).json();
    assert.equal(refused.ok, false);
    assert.deepEqual(ran, [], "an unknown name runs nothing");

    const imported = await (await fetch(`${base}/import`, { method: "POST", body: JSON.stringify({ name: "Cursor" }) })).json();
    assert.equal(imported.ok, true);
    assert.deepEqual(imported.rows, [{ kind: "ok", label: "settings", value: "3 entries" }]);
    assert.deepEqual(ran, ["Cursor"]);

    let closed = false;
    page.done.then(() => (closed = true));
    await (await fetch(`${base}/done`, { method: "POST", body: "{}" })).json();
    await new Promise((r) => setTimeout(r, 10));
    assert.ok(closed, "done resolves so the pane can be handed back");
  } finally {
    page.close();
  }
});
