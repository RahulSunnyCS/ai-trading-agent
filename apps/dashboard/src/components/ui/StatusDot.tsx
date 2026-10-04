import { cn } from '../../lib/cn';
import type { Tone } from './Badge';

const DOT_TONES: Record<Tone, string> = {
  positive: 'bg-positive',
  negative: 'bg-negative',
  warning: 'bg-warning',
  info: 'bg-info',
  accent: 'bg-accent',
  primary: 'bg-primary',
  neutral: 'bg-faint',
};

/** Small status dot, optionally pulsing for "live" connections. */
export function StatusDot({
  tone = 'neutral',
  pulse = false,
  label,
  className,
}: {
  tone?: Tone;
  pulse?: boolean;
  /** What the dot means ("Feed live"). Without it the dot is decorative and hidden from screen readers. */
  label?: string;
  className?: string;
}) {
  return (
    <span
      className={cn('relative inline-flex h-2 w-2', className)}
      {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}
    >
      {pulse ? (
        <span
          className={cn(
            'absolute inline-flex h-full w-full animate-ping rounded-full opacity-60',
            DOT_TONES[tone],
          )}
        />
      ) : null}
      <span className={cn('relative inline-flex h-2 w-2 rounded-full', DOT_TONES[tone])} />
    </span>
  );
}
