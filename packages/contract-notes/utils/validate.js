function requireEnv(names) {
  const missing = names.filter((n) => !process.env[n]);
  if (missing.length) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }

  if (process.env.GOOGLE_CREDENTIALS) {
    try {
      const decoded = Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString("utf8");
      JSON.parse(decoded);
    } catch {
      throw new Error("GOOGLE_CREDENTIALS is not valid base64-encoded JSON");
    }
  }

  if (process.env.TARGET_DATE) {
    const d = new Date(process.env.TARGET_DATE);
    if (isNaN(d.getTime())) {
      throw new Error(`TARGET_DATE is not a valid date: "${process.env.TARGET_DATE}"`);
    }
  }
}

module.exports = { requireEnv };
