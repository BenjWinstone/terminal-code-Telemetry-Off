function columns(): number {
  return Math.max(process.stdout.columns ?? 80, 40);
}

/** Word-wraps into lines that fit the window, each carrying the given indent,
 * so a narrow pane wraps on purpose instead of mid-word. */
export function wrap(text: string, indent: string): string[] {
  const width = Math.max(columns() - indent.length - 1, 20);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

export function fit(text: string): string {
  const width = columns() - 1;
  return text.length > width ? `${text.slice(0, width - 1)}…` : text;
}
