import Image from "next/image";
import Link from "next/link";

import frog from "@/public/frog.png";
import { GithubMark } from "./icons";

export default function SiteHeader() {
  return (
    <header className="sticky top-0 z-30 border-b border-border-soft bg-bg/85 backdrop-blur-md">
      <div className="mx-auto flex h-[52px] max-w-[880px] items-center justify-between px-5 sm:px-8">
        <Link
          href="/"
          className="flex items-center gap-2.5 font-mono text-[14px] tracking-tight text-text"
        >
          {/* hand the file over untouched and let the browser scale it — a
              server-side resample only softens the strokes further */}
          <Image src={frog} alt="" width={24} height={19} priority unoptimized />
          tode
        </Link>
        <a
          href="https://github.com/zenbu-labs/tode"
          target="_blank"
          rel="noreferrer"
          aria-label="tode on GitHub"
          title="zenbu-labs/tode"
          className="flex items-center text-faint transition-colors hover:text-text"
        >
          <GithubMark />
        </a>
      </div>
    </header>
  );
}
