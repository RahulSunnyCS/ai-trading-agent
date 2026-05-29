/**
 * Tiny classname joiner — filters out falsy values and joins with spaces.
 * Keeps the design-system components dependency-free (no clsx/tailwind-merge).
 */
export type ClassValue = string | false | null | undefined;

export function cn(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ');
}
