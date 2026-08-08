"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

const METHODS = [
  { label: "macOS", cmd: "curl -fsSL https://tode.sh/install | bash" },
  { label: "Linux", cmd: null },
];

export default function Install() {
  const [copied, setCopied] = useState(false);
  const [method, setMethod] = useState(0);
  const cmd = METHODS[method].cmd;

  async function copy() {
    if (!cmd) return;
    try {
      await navigator.clipboard.writeText(cmd);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="overflow-hidden rounded-[6px] border border-border bg-panel">
      {/* method picker and copy live on a strip above the command itself */}
      <div className="flex items-center justify-between border-b border-border-soft bg-panel2 pl-2 pr-1.5">
        <div className="flex">
          {METHODS.map((m, i) => (
            <button
              key={m.label}
              type="button"
              onClick={() => {
                setMethod(i);
                setCopied(false);
              }}
              className={`relative px-2.5 py-[9px] font-mono text-[11px] transition-colors ${
                i === method
                  ? "text-text after:absolute after:inset-x-2.5 after:bottom-0 after:h-px after:bg-text"
                  : "text-faint hover:text-muted"
              }`}
            >
              {m.label}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={copy}
          disabled={!cmd}
          aria-label={copied ? "Copied" : "Copy install command"}
          title={copied ? "Copied" : "Copy"}
          className={`grid h-[26px] w-[26px] place-items-center rounded-[4px] transition-colors ${
            copied
              ? "text-ok"
              : "text-faint hover:bg-panel hover:text-text disabled:pointer-events-none disabled:opacity-40"
          }`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>

      <div className="flex h-[42px] items-center px-3.5 font-mono text-[12px]">
        {cmd ? (
          <>
            <span className="mr-2.5 select-none text-faint">$</span>
            <code className="flex-1 overflow-x-auto whitespace-nowrap text-text2">
              {cmd}
            </code>
          </>
        ) : (
          <span className="text-faint">coming soon</span>
        )}
      </div>
    </div>
  );
}
