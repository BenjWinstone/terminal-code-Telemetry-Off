"use client";

import { useEffect, useRef, useState } from "react";

/* The video is fetched only once someone presses play — preload="none" plus a
   poster means the page costs one small still until then. The aspect ratio is
   declared up front so the frame reserves its space and nothing shifts.

   There are two captures, one per theme. A <source media> attribute would be
   the tidy way to pick between them, but browsers dropped media matching on
   video sources, so the choice is made here instead. */

function fmt(s: number) {
  if (!Number.isFinite(s)) return "0:00";
  const m = Math.floor(s / 60);
  const r = Math.floor(s % 60);
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export interface Capture {
  src: string;
  poster: string;
  durationHint?: number;
}

export default function VideoPlayer({
  dark,
  light,
  ratio = "4 / 3",
}: {
  dark: Capture;
  /* the server has no way to know the visitor's theme, so it renders the dark
     capture — the site's default — and the light one swaps in on mount */
  light: Capture;
  ratio?: string;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const [isLight, setIsLight] = useState(false);
  const [playing, setPlaying] = useState(false);

  /* The browser sends timeupdate about four times a second. If React drives the
     bar from those events, the bar moves in steps. A CSS transition only turns
     the steps into a stutter, because each step starts and stops. While the
     video plays, this loop writes the width on every frame instead, and it
     writes to the node directly to prevent a render on each frame. */
  useEffect(() => {
    if (!playing) return;
    let frame = 0;
    const tick = () => {
      const v = videoRef.current;
      const fill = fillRef.current;
      if (v && fill && v.duration) {
        fill.style.width = `${(v.currentTime / v.duration) * 100}%`;
      }
      frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [playing]);

  const capture = isLight ? light : dark;

  useEffect(() => {
    const query = window.matchMedia("(prefers-color-scheme: light)");
    const apply = () => setIsLight(query.matches);
    apply();
    query.addEventListener("change", apply);
    return () => query.removeEventListener("change", apply);
  }, []);

  /* Position and duration are stamped with the clip they belong to, so a theme
     flip falls back to the new clip's own values without an effect to reset
     them. Swapping does restart the demo — the two captures are separate
     recordings of different lengths, so the same timestamp is a different
     moment anyway, and restarting is at least predictable. */
  const [track, setTrack] = useState({
    src: capture.src,
    duration: capture.durationHint ?? 0,
    time: 0,
  });
  const current =
    track.src === capture.src
      ? track
      : { src: capture.src, duration: capture.durationHint ?? 0, time: 0 };
  const { duration, time } = current;
  const setTime = (t: number) => setTrack({ ...current, time: t });

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
      /* No frame of our own. The capture already has the editor window's
         rounded corners and outline, and it was recorded on a backdrop that
         matches the page (#f9f9f9 / #0c0c0c against #fbfbfa / #0c0c0d), so the
         window reads as the frame. Wrapping it in a second rounded border just
         nested one corner radius inside another. */
      className="focus:outline-none"
    >
      {/* The border goes on the wrapper, so it traces the clipped corner and
          not the square edge of the video. A radius clips the content at the
          padding box, which sits 1px inside the border, so the outer radius
          carries an extra 1px. Without it the clip is 1px short and the
          desktop shows again in the corner. */}
      <div
        className="relative overflow-hidden border border-border"
        style={{
          borderRadius: "calc(1.8057% + 1px) / calc(2.6851% + 1px)",
        }}
      >
        <video
          ref={videoRef}
          key={capture.src}
          src={capture.src}
          poster={capture.poster}
          preload="none"
          playsInline
          muted
          className="block w-full cursor-pointer"
          /* The frame itself is square; the editor window inside it is what is
             rounded, and the desktop shows through the four corner notches.
             Clipping at the window's own corner radius removes them exactly.
             58px of the 3212px capture = 1.8057% of the width, measured by
             differencing the two backdrops. Given as a percentage pair so the
             corner stays circular and scales with the element: the vertical
             figure is the horizontal one times the 1.487 aspect. */
          style={{ aspectRatio: ratio, borderRadius: "1.8057% / 2.6851%" }}
          onClick={toggle}
          onPlay={() => setPlaying(true)}
          onPause={() => setPlaying(false)}
          onEnded={() => setPlaying(false)}
          onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
          onLoadedMetadata={(e) =>
            setTrack({ ...current, duration: e.currentTarget.duration })
          }
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

      <figcaption className="flex h-[38px] items-center gap-3 pt-1">
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
            {/* the loop owns the width while the video plays, so React must not
                write it back on the renders that the time label causes */}
            <div
              ref={fillRef}
              className="absolute inset-y-0 left-0 rounded-full bg-text2"
              style={playing ? undefined : { width: `${progress}%` }}
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
