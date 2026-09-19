const logger = require("./logger");

async function withRetry(fn, options = {}) {
  const {
    attempts = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    factor = 2,
    jitter = true,
    retryIf = () => true,
    onRetry,
  } = options;

  let lastErr;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (attempt === attempts || !retryIf(err)) throw err;

      let delay = Math.min(baseDelayMs * Math.pow(factor, attempt - 1), maxDelayMs);
      if (jitter) delay = delay * (0.8 + Math.random() * 0.4);
      delay = Math.round(delay);

      if (onRetry) {
        onRetry(err, attempt, delay);
      } else {
        logger.warn(`Retry attempt ${attempt} after ${delay}ms`, { error: err.message });
      }

      await new Promise((res) => setTimeout(res, delay));
    }
  }
  throw lastErr;
}

module.exports = { withRetry };
