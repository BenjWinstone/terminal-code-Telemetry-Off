"use client";

import { useState } from "react";
import { CheckIcon, CopyIcon } from "./icons";

const CMD = "curl -fsSL https://tode.sh/install | bash";

const TABS = [
  { id: "unix", label: "macOS + Linux" },
  { id: "windows", label: "Windows" },
] as const;

type Tab = (typeof TABS)[number]["id"];

export default function Install() {
  const [tab, setTab] = useState<Tab>("unix");
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
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            onClick={() => setTab(t.id)}
            className={`border border-b-0 px-3 py-[5px] transition-colors ${tab === t.id
                ? "border-border bg-panel text-text2"
                : "border-transparent text-faint hover:text-text2"
              }`}
          >
            {t.label}
          </button>
        ))}
      </div>

      <div className="flex h-[38px] max-w-full items-center border border-border bg-panel px-3.5">
        {tab === "unix" ? (
          <>
            <span className="mr-[9px] text-ok">$</span>
            <code className="flex-1 overflow-x-auto whitespace-nowrap text-[11px] text-text2 sm:text-[12px]">
              {CMD}
            </code>
            <button
              type="button"
              onClick={copy}
              aria-label={copied ? "Copied" : "Copy install command"}
              title={copied ? "Copied" : "Copy"}
              className={`ml-2.5 grid h-[26px] w-[26px] shrink-0 place-items-center border border-transparent transition-colors ${copied
                  ? "text-ok"
                  : "text-ok/65 hover:border-ok/35 hover:text-ok"
                }`}
            >
              {copied ? <CheckIcon /> : <CopyIcon />}
            </button>
          </>
        ) : (
          <>
            {/* the windows steps live in the readme, so the block points there */}
            <span className="mr-[9px] text-ok">&gt;</span>
            <span className="font-mono text-[11px] text-text2 sm:text-[12px]">
              learn more{" "}
              <a
                href="https://github.com/zenbu-labs/terminal-code#windows"
                target="_blank"
                rel="noreferrer"
                className="underline decoration-ok/60 underline-offset-[3px] transition-colors hover:text-ok hover:decoration-ok"
              >
                here
              </a>
            </span>
          </>
        )}
      </div>
    </div>
  );
}
