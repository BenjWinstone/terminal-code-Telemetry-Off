import { useEffect, useRef, useState } from "react";

/** The first-run import screen: one question, the editors found on this
 * machine, two buttons. Same tokens and same shape as the shortcuts intro —
 * it has to read as the same program. */

interface Editor {
  name: string;
  /** the app's icon as a data uri, when the machine has one */
  icon: string | null;
}

interface ReportRow {
  kind: "ok" | "warn";
  label: string;
  value: string;
}

export interface ImportState {
  editors: Editor[];
}

const post = async (url: string, payload?: unknown) => {
  const response = await fetch(url, { method: "POST", body: JSON.stringify(payload ?? {}) });
  return response.json();
};

/** Done during onboarding is a navigation, not an exit: the server names the
 * next screen and this pane simply goes there, so the terminal never flashes
 * back to its primary buffer between screens. */
const done = async () => {
  const answer = await post("/done");
  if (answer && answer.next) location.replace(answer.next);
};

export function App({ state }: { state: ImportState }) {
  // icons first, both groups in detection order: an icon-less row also drops
  // the icon's slot, and mixing the two shapes mid-list reads as ragged
  const editors = [
    ...state.editors.filter((editor) => editor.icon),
    ...state.editors.filter((editor) => !editor.icon),
  ];
  const [at, setAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [report, setReport] = useState<ReportRow[] | null>(null);
  const primary = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    primary.current?.focus();
  });

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (busy) return;
      const key = event.key;
      if (key === "Escape") return void done();
      if (report) return;
      if (key === "ArrowUp" || (event.ctrlKey && key.toLowerCase() === "p")) {
        setAt((v) => Math.max(0, v - 1));
      } else if (key === "ArrowDown" || (event.ctrlKey && key.toLowerCase() === "n")) {
        setAt((v) => Math.min(editors.length - 1, v + 1));
      } else if (/^[1-9]$/.test(key) && Number(key) <= editors.length) {
        setAt(Number(key) - 1);
      } else {
        return;
      }
      event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  });

  const start = async () => {
    if (busy) return;
    setBusy(true);
    const result = await post("/import", { name: editors[at].name });
    setBusy(false);
    if (result.ok === false) return;
    setReport(result.rows ?? []);
  };

  if (report) {
    return (
      <main>
        <div className="intro">
          <div className="introlead">imported from {editors[at].name}</div>
          <div className="report">
            {report.map((row, index) => (
              <div key={index} className={"row" + (row.kind === "warn" ? " warn" : "")}>
                <span className="mark">{row.kind === "warn" ? "!" : "✓"}</span>
                <span className="label">{row.label}</span>
                <span>{row.value}</span>
              </div>
            ))}
          </div>
          <div className="introactions">
            <button ref={primary} className="primary" onClick={() => void done()}>
              continue to terminal-code
            </button>
          </div>
        </div>
      </main>
    );
  }

  return (
    <main>
      <div className="intro">
        <div className="introlead">Import config from another editor</div>
        <div className="editors">
          {editors.map((editor, index) => (
            <button
              key={editor.name}
              className={"editor" + (index === at ? " active" : "")}
              onClick={() => setAt(index)}
            >
              {editor.icon && <img src={editor.icon} alt="" />}
              <span>{editor.name}</span>
            </button>
          ))}
        </div>
        <div className="introactions">
          <button onClick={() => void done()}>skip</button>
          <button ref={primary} className="primary" disabled={busy} onClick={start}>
            {busy ? "importing…" : `import ${editors[at].name}`}
          </button>
        </div>
      </div>
    </main>
  );
}
