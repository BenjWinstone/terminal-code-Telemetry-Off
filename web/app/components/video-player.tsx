"use client";

import { useRef, useState } from "react";

/* The video is fetched only once someone presses play — preload="none" plus a
   poster means the page costs one 72KB still until then. The aspect ratio is
   declared up front so the frame reserves its space and nothing shifts. */

function fmt(s: number) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export default function VideoPlayer({
  src,
  poster,
  ratio = "4 / 3",
  durationHint = 0,
}: {
  src: string;
  poster: string;
  ratio?: string;
  /* stands in until metadata arrives, which with preload="none" is not until
     the first play */
  durationHint?: number;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(durationHint);

  function toggle() {
    const v = videoRef.current;
    if (!v) return;
    if (v.paused) v.play();
    else v.pause();
  }

  function seekTo(clientX: number, el: HTMLElement) {
    const v = videoRef.current;
    if (!v || !duration) return;
    const rect = el.getBoundingClientRect();
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    v.currentTime = ratio * duration;
    setTime(ratio * duration);
  }

  function onScrubDown(e: React.PointerEvent<HTMLDivElement>) {
    e.currentTarget.setPointerCapture(e.pointerId);
    seekTo(e.clientX, e.currentTarget);
  }

  function onScrubMove(e: React.PointerEvent<HTMLDivElement>) {
    if (!e.currentTarget.hasPointerCapture(e.pointerId)) return;
    seekTo(e.clientX, e.currentTarget);
  }

  function onKeyDown(e: React.KeyboardEvent) {
    const v = videoRef.current;
    if (!v) return;
    if (e.key === " " || e.key === "k") {
      e.preventDefault();
      toggle();
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      v.currentTime = Math.max(0, v.currentTime - 2);
    } else if (e.key === "ArrowRight") {
      e.preventDefault();
      v.currentTime = Math.min(duration, v.currentTime + 2);
    }
  }

  const progress = duration ? (time / duration) * 100 : 0;

  return (
    <figure
      onKeyDown={onKeyDown}
      tabIndex={0}
      className="overflow-hidden rounded-[6px] border border-border bg-panel focus:outline-none focus-visible:border-text2"
    >
      <div className="relative">
        <video
          ref={videoRef}
          src={src}
          poster={poster}
          preload="none"
          playsInline
          muted
          className="block w-full cursor-pointer"
          style={{ aspectRatio: ratio }}
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        />

        {!playing && (
          <button
            type="button"
            onClick={toggle}
            aria-label="Play demo"
            className="group absolute inset-0 grid place-items-center"
          >
            <span className="flex items-center gap-2.5 rounded-full border border-border bg-bg/75 py-2 pr-4 pl-3.5 font-mono text-[11px] text-text backdrop-blur-sm transition-colors group-hover:bg-bg/90">
              <svg width="9" height="11" viewBox="0 0 9 11" aria-hidden>
                <path d="M0 0L9 5.5L0 11Z" fill="currentColor" />
              </svg>
              play
            </span>
          </button>
        )}
      </div>

      <figcaption className="flex h-[38px] items-center gap-3 border-t border-border-soft bg-panel2 px-3">
        <button
          type="button"
          onClick={toggle}
          aria-label={playing ? "Pause" : "Play"}
          className="grid h-[22px] w-[22px] place-items-center text-muted transition-colors hover:text-text"
        >
          {playing ? (
            <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden>
              <rect width="2.5" height="10" fill="currentColor" />
              <rect x="5.5" width="2.5" height="10" fill="currentColor" />
            </svg>
          ) : (
            <svg width="8" height="10" viewBox="0 0 8 10" aria-hidden>
              <path d="M0 0L8 5L0 10Z" fill="currentColor" />
            </svg>
          )}
        </button>

        <div
          onPointerDown={onScrubDown}
          onPointerMove={onScrubMove}
          className="group flex-1 cursor-pointer touch-none py-2"
          role="slider"
          aria-label="Seek"
          aria-valuemin={0}
          aria-valuemax={Math.round(duration)}
          aria-valuenow={Math.round(time)}
          tabIndex={-1}
        >
          <div className="relative h-[2px] rounded-full bg-border">
            <div
              className="absolute inset-y-0 left-0 rounded-full bg-text2 transition-[width] duration-100"
              style={{ width: `${progress}%` }}
            />
          </div>
        </div>

        <span className="font-mono text-[11px] tabular-nums text-faint">
          {fmt(time)} / {fmt(duration)}
        </span>
      </figcaption>
    </figure>
  );
}
