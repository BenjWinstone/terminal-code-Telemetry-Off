"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

const CMD = "curl -fsSL https://tode.sh/install | bash";

export default function Install() {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(CMD);
    } catch {
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1600);
  }

  return (
    <div className="max-w-full">
      {/* tab strip sits on the box, active tab merges into it */}
      <div className="relative z-10 -mb-px flex text-[11px]">
        <span className="border border-b-0 border-border bg-panel px-3 py-[5px] text-text2">
          macOS + Linux
        </span>
      </div>

      <div className="flex h-[38px] max-w-full items-center border border-border bg-panel px-3.5">
        <span className="mr-[9px] text-ok">$</span>
        <code className="flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-text2 sm:text-[12px]">
          {CMD}
        </code>
        <button
          type="button"
          onClick={copy}
          aria-label={copied ? "Copied" : "Copy install command"}
          title={copied ? "Copied" : "Copy"}
          className={`ml-2.5 grid h-[26px] w-[26px] shrink-0 place-items-center border border-transparent transition-colors ${
            copied
              ? "text-ok"
              : "text-faint hover:border-border-soft hover:text-text2"
          }`}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
        </button>
      </div>
    </div>
  );
}
