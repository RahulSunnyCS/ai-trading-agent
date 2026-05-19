/**
 * Placeholder for the real-time NIFTY straddle value and momentum view.
 * Sprint 2+ will replace this with live WebSocket data from /ws/ticks.
 */
export function LiveView() {
  return (
    <div className="space-y-4">
      <div className="rounded-lg bg-gray-900 p-4">
        <h2 className="text-lg font-semibold">NIFTY Straddle</h2>
        <p className="mt-2 text-3xl font-bold tabular-nums text-white">--</p>
        <p className="text-sm text-gray-400">Connecting to feed...</p>
      </div>
    </div>
  );
}
