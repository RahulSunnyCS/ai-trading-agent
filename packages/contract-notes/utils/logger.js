function formatContext(ctx) {
  if (!ctx || typeof ctx !== "object") return "";
  return (
    " | " +
    Object.entries(ctx)
      .map(([k, v]) => `${k}=${v}`)
      .join(" ")
  );
}

function timestamp() {
  return new Date().toISOString();
}

const logger = {
  info(msg, ctx) {
    console.log(`[INFO] [${timestamp()}] ${msg}${formatContext(ctx)}`);
  },
  warn(msg, ctx) {
    console.warn(`[WARN] [${timestamp()}] ${msg}${formatContext(ctx)}`);
  },
  error(msg, err, ctx) {
    const errStr = err instanceof Error ? ` | error=${err.message}` : "";
    console.error(`[ERROR] [${timestamp()}] ${msg}${errStr}${formatContext(ctx)}`);
  },
};

module.exports = logger;
