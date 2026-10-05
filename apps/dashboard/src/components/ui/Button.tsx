import { Loader2 } from 'lucide-react';
import {
  type ButtonHTMLAttributes,
  type ReactElement,
  type ReactNode,
  cloneElement,
  isValidElement,
} from 'react';

import { cn } from '../../lib/cn';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger';
type Size = 'sm' | 'md' | 'icon';

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner in place of the leading icon and disables the button. */
  loading?: boolean;
  /** Style the single child element (a link, say) as the button instead of rendering <button>. */
  asChild?: boolean;
  children: ReactNode;
}

const VARIANTS: Record<Variant, string> = {
  primary: 'bg-primary text-primary-foreground hover:bg-primary/90 shadow-card',
  secondary:
    'border border-border bg-surface text-foreground hover:bg-surface-2 hover:border-border-strong',
  ghost: 'text-muted hover:bg-surface-2 hover:text-foreground',
  danger: 'border border-negative/30 bg-negative/10 text-negative hover:bg-negative/15',
};

const SIZES: Record<Size, string> = {
  sm: 'h-8 px-3 text-xs gap-1.5',
  md: 'h-9 px-4 text-sm gap-2',
  // Square, for a lone icon. Give it an aria-label.
  icon: 'h-8 w-8 shrink-0',
};

export function buttonClass(variant: Variant = 'secondary', size: Size = 'md'): string {
  return cn(
    'inline-flex items-center justify-center rounded-lg font-medium transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background',
    'disabled:cursor-not-allowed disabled:opacity-50',
    VARIANTS[variant],
    SIZES[size],
  );
}

export function Button({
  variant = 'secondary',
  size = 'md',
  loading = false,
  asChild = false,
  className,
  children,
  type = 'button',
  disabled,
  ...rest
}: ButtonProps) {
  const classes = cn(buttonClass(variant, size), className);
  if (asChild && isValidElement(children)) {
    const child = children as ReactElement<{ className?: string }>;
    return cloneElement(child, { className: cn(classes, child.props.className) });
  }
  return (
    <button
      type={type}
      className={classes}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      {...rest}
    >
      {loading ? <Loader2 className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
      {loading && size === 'icon' ? null : children}
    </button>
  );
}
