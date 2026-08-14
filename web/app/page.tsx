import Install from "./components/install";
import SiteHeader from "./components/site-header";
import Usage from "./components/usage";
import VideoPlayer from "./components/video-player";
import { GithubMark } from "./components/icons";

export default function Home() {
  return (
    <>
      <SiteHeader />

      <main className="mx-auto w-full max-w-[880px] px-5 sm:px-8">
        {/* the left rail is an indent now rather than an index — with one
            section left there is no sequence to number */}
        <div className="grid gap-8 pt-16 pb-14 sm:grid-cols-[64px_1fr] sm:pt-24 sm:pb-16">
          <div className="hidden sm:block" aria-hidden />
          <div>
            <h1 className="text-[20px] leading-[1.22] font-medium tracking-[-0.02em] text-text sm:text-[26px] sm:whitespace-nowrap">
              VS Code inside your{" "}
              <span className="keyword">
                terminal
                <span className="caret" aria-hidden />
              </span>
            </h1>

            <div className="mt-9 w-[440px] max-w-full">
              <Install />
            </div>
          </div>
        </div>

        {/* the demo sits in the same column as the text, indent and all */}
        <div className="grid gap-8 sm:grid-cols-[64px_1fr]">
          <div className="hidden sm:block" aria-hidden />
          <VideoPlayer
            dark={{
              src: "/demo-dark.mp4",
              poster: "/demo-dark-poster.webp",
              durationHint: 7.07,
            }}
            light={{
              src: "/demo-light.mp4",
              poster: "/demo-light-poster.webp",
              durationHint: 8.23,
            }}
            ratio="1600 / 1076"
          />
        </div>

        <div className="grid gap-6 pt-12 sm:grid-cols-[64px_1fr] sm:gap-8 sm:pt-14">
          <div className="hidden sm:block" aria-hidden />
          <Usage />
        </div>

        <footer className="rule mt-14 flex items-center justify-between py-8 sm:mt-20">
          <span className="font-mono text-[11px] text-faint">© 2026 tode</span>
          <span className="flex items-center gap-5">
            <a
              href="mailto:rob@zenbu.dev"
              className="font-mono text-[11px] text-faint transition-colors hover:text-text2"
            >
              contact
            </a>
            <a
              href="https://github.com/zenbu-labs/tode"
              target="_blank"
              rel="noreferrer"
              aria-label="tode on GitHub"
              title="zenbu-labs/tode"
              className="flex items-center text-faint transition-colors hover:text-text2"
            >
              <GithubMark size={14} />
            </a>
          </span>
        </footer>
      </main>
    </>
  );
}
