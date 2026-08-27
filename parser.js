const fs = require("fs");
const path = require("path");
const pdfParse = require("pdf-parse");
const { getBroker, parseFileName } = require("./brokers");
const logger = require("./utils/logger");

const SUMMARY_FIELDS = ["payin_payout_obligation", "net_brokerage", "other_charges"];

const dataDir = path.join(__dirname, "data");
const pdfFiles = fs
  .readdirSync(dataDir)
  .filter((file) => file.endsWith("_decrypted.pdf"));

if (!pdfFiles.length) {
  logger.info("No decrypted PDF files found in data/");
  process.exit(0);
}

const mergedSummary = {
  individual_account: [],
  total: Object.fromEntries(SUMMARY_FIELDS.map((f) => [f, 0])),
};

const parseResults = { succeeded: [], failed: [] };

(async () => {
  for (const file of pdfFiles) {
    const meta = parseFileName(file);
    if (!meta) {
      logger.warn("Skipping file with unrecognised filename format", { file });
      parseResults.failed.push({ file, error: "Filename does not match expected pattern" });
      continue;
    }

    const pdfPath = path.join(dataDir, file);
    try {
      const pdfBuffer = fs.readFileSync(pdfPath);
      const data = await pdfParse(pdfBuffer);
      logger.info("PDF loaded", { file, broker: meta.broker, account: meta.accountId });

      const broker = getBroker(meta.broker);
      const summary = broker.extract(data.text);
      if (summary.error) {
        logger.error("Extractor failed", null, { file, error: summary.error });
        parseResults.failed.push({ file, error: summary.error });
        continue;
      }

      logger.info(`Extraction complete`, { broker: meta.broker, account: meta.accountId });

      if (summary.skipped_segments && summary.skipped_segments.length) {
        logger.info("Non-F&O segments ignored", {
          broker: meta.broker,
          account: meta.accountId,
          segments: summary.skipped_segments.join(", "),
        });
      }

      const accountEntry = { account: meta.accountId, broker: meta.broker, email: meta.email };
      for (const f of SUMMARY_FIELDS) {
        const v = summary[f] ?? 0;
        accountEntry[f] = v;
        mergedSummary.total[f] += v;
      }
      mergedSummary.individual_account.push(accountEntry);
      parseResults.succeeded.push(file);
    } catch (err) {
      logger.error("Error parsing PDF", err, { file });
      parseResults.failed.push({ file, error: err.message });
    }
  }

  if (parseResults.failed.length > 0) {
    const errPath = path.join(__dirname, "parse_errors.json");
    fs.writeFileSync(errPath, JSON.stringify(parseResults.failed, null, 2));
    logger.warn("Some files failed to parse", {
      failed: parseResults.failed.length,
      succeeded: parseResults.succeeded.length,
      errorsFile: "parse_errors.json",
    });
  }

  if (parseResults.succeeded.length === 0) {
    logger.error("All PDFs failed to parse — no output written");
    process.exit(1);
  }

  const outputPath = path.join(__dirname, "daily_summary.json");
  fs.writeFileSync(outputPath, JSON.stringify(mergedSummary, null, 2));
  logger.info("Merged summary saved", { file: "daily_summary.json" });
})();
