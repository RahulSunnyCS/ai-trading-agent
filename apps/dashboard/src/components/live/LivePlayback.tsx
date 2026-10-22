/**
 * Playback for a replayed day: play / pause, a speed, and a slider over the minutes. The page holds
 * the minute shown; this only changes it. It is not shown for a live day, where the minute is
 * always the latest one.
 */

import { Pause, Play, SkipForward } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { formatIstTime } from '../../lib/format';
import { SPEEDS, type SpeedId } from '../../lib/liveSession';
import { Button } from '../ui/Button';
import { SegmentedControl } from '../ui/SegmentedControl';

export function LivePlayback({
  minute,
  last,
  timeAt,
  playing,
  speed,
  onMinute,
  onPlaying,
  onSpeed,
}: {
  minute: number;
  last: number;
  /** Epoch seconds of the minute shown. */
  timeAt: number;
  playing: boolean;
  speed: SpeedId;
  onMinute: (minute: number) => void;
  onPlaying: (playing: boolean) => void;
  onSpeed: (speed: SpeedId) => void;
}) {
  // The timer reads the latest minute through a ref, so it is one interval per play, not one per tick.
  const minuteRef = useRef(minute);
  minuteRef.current = minute;

  useEffect(() => {
    if (!playing) return;
    const perSecond = SPEEDS.find((s) => s.value === speed)?.minutesPerSecond ?? 1;
    // 4 steps a second: smooth at 1x (a quarter minute is shown as the same minute), and at 60x a
    // step is 15 minutes, which still reads as motion.
    const timer = setInterval(() => {
      const next = minuteRef.current + perSecond / 4;
      if (next >= last) {
        onMinute(last);
        onPlaying(false);
      } else {
        onMinute(next);
      }
    }, 250);
    return () => clearInterval(timer);
  }, [playing, speed, last, onMinute, onPlaying]);

  const shown = Math.floor(minute);
  return (
    <div className="flex flex-wrap items-center gap-3">
      <Button
        size="sm"
        variant={playing ? 'secondary' : 'primary'}
        onClick={() => {
          if (!playing && minute >= last) onMinute(0);
          onPlaying(!playing);
        }}
        aria-label={playing ? 'Pause replay' : 'Play the day from here'}
      >
        {playing ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
        {playing ? 'Pause' : minute >= last ? 'Replay' : 'Play'}
      </Button>
      <SegmentedControl
        ariaLabel="Replay speed, in minutes of the day per second"
        size="sm"
        value={speed}
        options={SPEEDS.map((s) => ({ value: s.value, label: s.label }))}
        onChange={onSpeed}
      />
      <input
        type="range"
        min={0}
        max={last}
        step={1}
        value={shown}
        aria-label="Minute of the day shown"
        aria-valuetext={`${formatIstTime(timeAt * 1000)} IST`}
        onChange={(event) => {
          onPlaying(false);
          onMinute(Number(event.target.value));
        }}
        className="h-1.5 min-w-40 flex-1 cursor-pointer accent-primary"
      />
      <span className="metric w-24 text-right text-sm text-foreground">
        {formatIstTime(timeAt * 1000)} IST
      </span>
      <Button
        size="icon"
        variant="ghost"
        aria-label="Jump to the end of the day"
        onClick={() => {
          onPlaying(false);
          onMinute(last);
        }}
      >
        <SkipForward className="h-4 w-4" />
      </Button>
    </div>
  );
}
