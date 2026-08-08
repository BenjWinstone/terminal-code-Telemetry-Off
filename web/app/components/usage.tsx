/* straight from `tode --help` — enough to go from installed to editing without
   opening the docs. Rows rather than a boxed block, so it reads as reference
   material and not as a second install widget. */

const LINES = [
  { cmd: "tode", note: "opens the current folder" },
  { cmd: "tode <folder>", note: "opens that folder" },
  { cmd: "tode <file>", note: "opens the file" },
  { cmd: "tode --split right", note: "opens tode " },
  { cmd: "tode import", note: "brings your vscode settings over" },
];

export default function Usage() {
  return (
    <div className="divide-y divide-border-soft border-y border-border-soft">
      {LINES.map((l) => (
        <div
          key={l.cmd}
          className="flex flex-col gap-0.5 py-2.5 sm:flex-row sm:items-baseline sm:gap-6"
        >
          <code className="font-mono text-[12px] whitespace-nowrap text-text2 sm:w-[220px] sm:shrink-0">
            {l.cmd}
          </code>
          <span className="text-[12.5px] text-muted">{l.note}</span>
        </div>
      ))}
    </div>
  );
}
