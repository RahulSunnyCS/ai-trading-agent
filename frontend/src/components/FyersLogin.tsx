import { useEffect, useState } from "react";

interface Status {
  configured: boolean;
  connected: boolean;
  expiresAt?: string;
  appId?: string;
}

export default function FyersLogin(): JSX.Element {
  const [status, setStatus] = useState<Status | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = async (): Promise<void> => {
    try {
      const res = await fetch("/api/auth/fyers/status");
      const body = (await res.json()) as Status;
      setStatus(body);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  useEffect(() => {
    void refresh();
    const interval = setInterval(() => void refresh(), 15_000);
    return () => clearInterval(interval);
  }, []);

  const login = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/auth/fyers/login");
      if (!res.ok) {
        const body = (await res.json()) as { message?: string };
        throw new Error(body.message ?? `HTTP ${res.status}`);
      }
      const body = (await res.json()) as { url: string };
      window.open(body.url, "_blank", "noopener,noreferrer");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  if (!status) {
    return <div className="text-sm text-slate-400">Checking Fyers status…</div>;
  }

  if (!status.configured) {
    return (
      <div className="rounded border border-amber-700 bg-amber-950/40 px-3 py-2 text-sm text-amber-200">
        Fyers OAuth not configured — set <code>FYERS_APP_ID</code> and{" "}
        <code>FYERS_APP_SECRET</code> in the server env.
      </div>
    );
  }

  const label = status.connected
    ? `Connected (expires ${status.expiresAt ? new Date(status.expiresAt).toLocaleString() : ""})`
    : "Not connected";

  return (
    <div className="flex items-center gap-3 rounded border border-slate-700 bg-slate-800/60 px-3 py-2 text-sm">
      <span
        className={`inline-block h-2 w-2 rounded-full ${status.connected ? "bg-emerald-400" : "bg-rose-400"}`}
      />
      <span className="text-slate-300">Fyers: {label}</span>
      <button
        type="button"
        onClick={() => void login()}
        disabled={busy}
        className="ml-auto rounded bg-indigo-600 px-3 py-1 text-white hover:bg-indigo-500 disabled:opacity-50"
      >
        {status.connected ? "Re-login" : "Login with Fyers"}
      </button>
      {error && <span className="text-rose-400">{error}</span>}
    </div>
  );
}
