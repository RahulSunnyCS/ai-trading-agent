/** Start OAuth in the click's user-activation window so popup blockers allow it. */
export function startFyersLogin(): void {
  window.open('/api/auth/fyers/start', '_blank', 'noopener,noreferrer');
}
