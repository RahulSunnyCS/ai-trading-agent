const { google } = require("googleapis");
const { JWT } = require("google-auth-library");
const dotenv = require("dotenv");
const fs = require("fs");
const { loadBrokerAccounts, flattenAccounts } = require("./brokers");
const { parseDateCell, formatDateCell } = require("./checkDates");
const { requireEnv } = require("./utils/validate");
const { withRetry } = require("./utils/retry");
const logger = require("./utils/logger");

dotenv.config();

function columnToLetter(column) {
  let letter = "";
  while (column > 0) {
    const temp = (column - 1) % 26;
    letter = String.fromCharCode(65 + temp) + letter;
    column = Math.floor((column - temp - 1) / 26);
  }
  return letter;
}

function letterToColumn(letter) {
  let col = 0;
  for (let i = 0; i < letter.length; i++) {
    col = col * 26 + (letter.charCodeAt(i) - 64);
  }
  return col;
}

const ACCOUNT_COLUMN_COUNT = 5;

// True when a column C cell holds a date this pipeline wrote ("26 May 26"),
// as opposed to a totals row, a note, or an empty cell.
function isDateCell(value) {
  if (!value) return false;
  try {
    return !isNaN(parseDateCell(String(value)).getTime());
  } catch {
    return false;
  }
}

function buildAccountValues(match) {
  const payin = match?.payin_payout_obligation ?? 0;
  const brokerage = match?.net_brokerage ?? 0;
  const other = match?.other_charges ?? 0;
  const totalCharges = brokerage + other;
  const finalNet = payin - totalCharges;
  return [payin, brokerage, other, totalCharges, finalNet];
}

const sheetsRetryOpts = {
  attempts: 3,
  baseDelayMs: 1000,
  retryIf: (err) => {
    const code = err?.code || err?.status;
    return code >= 500 || code === 429;
  },
  onRetry: (err, attempt, delay) =>
    logger.warn("Sheets API retry", { attempt, delayMs: delay, error: err.message }),
};

async function updateGoogleSheet() {
  requireEnv(["GOOGLE_CREDENTIALS", "GOOGLE_SHEET_ID", "SHEET_GID", "SHEET_NAME"]);

  const credentials = JSON.parse(
    Buffer.from(process.env.GOOGLE_CREDENTIALS, "base64").toString("utf8")
  );

  const auth = new JWT({
    email: credentials.client_email,
    key: credentials.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });

  const sheets = google.sheets({ version: "v4", auth });
  const spreadsheetId = process.env.GOOGLE_SHEET_ID;
  const sheetId = process.env.SHEET_GID;
  const sheetName = process.env.SHEET_NAME;

  let lastRow = 0;
  try {
    const trackerRaw = fs.readFileSync("row_tracker.json", "utf-8");
    const trackerData = JSON.parse(trackerRaw);
    lastRow = trackerData.lastUpdatedRow || 0;
    logger.info("Row from tracker", { lastRow });
  } catch {
    logger.warn("No row_tracker.json found — falling back to sheet");
  }

  if (lastRow === 0) {
    const readResponse = await withRetry(
      () => sheets.spreadsheets.values.get({ spreadsheetId, range: `${sheetName}!A:A` }),
      sheetsRetryOpts
    );
    const rows = readResponse.data.values;
    lastRow = rows ? rows.length : 0;
    logger.info("Row from sheet", { lastRow });
  }

  const targetDate = process.env.TARGET_DATE
    ? new Date(process.env.TARGET_DATE)
    : (() => {
        const d = new Date();
        d.setDate(d.getDate() - 1);
        return d;
      })();

  const dayName = targetDate.toLocaleDateString("en-GB", { weekday: "long" });
  const dateFormatted = formatDateCell(targetDate);

  // Two rows in one read: the row being appended after, and the row below it,
  // which must still be empty for the tracker to be trustworthy.
  const window =
    lastRow > 0
      ? (
          await withRetry(
            () =>
              sheets.spreadsheets.values.get({
                spreadsheetId,
                range: `${sheetName}!A${lastRow}:ZZ${lastRow + 1}`,
              }),
            sheetsRetryOpts
          )
        ).data.values || []
      : [];

  const lastRowData = window[0] || [];
  const nextRowDateCell = window[1]?.[2];

  const lastRowValue = lastRowData[0] || 0;
  const lastDateCell = lastRowData[2];

  // Column C can hold more than one spelling of the same day: rows written
  // before formatDateCell() carry the locale's "1 Sept 26", rows written after
  // carry "1 Sep 26". Compare the parsed dates so a re-run is still recognised
  // as a duplicate across both.
  const targetTime = Date.UTC(
    targetDate.getFullYear(),
    targetDate.getMonth(),
    targetDate.getDate()
  );

  let lastDate = null;
  if (lastDateCell) {
    try {
      const parsed = parseDateCell(lastDateCell);
      if (!isNaN(parsed.getTime())) lastDate = parsed;
      else throw new Error(`Not a valid date: "${lastDateCell}"`);
    } catch (err) {
      logger.warn("Could not parse last row date — skipping order check", {
        cell: lastDateCell,
        error: err.message,
      });
    }
  }

  if (lastDate && lastDate.getTime() === targetTime) {
    logger.info("Date already exists in sheet, skipping", { date: dateFormatted });
    return;
  }

  // row_tracker.json is restored from a CI artifact, so it can lag behind the
  // sheet if a previous run died before uploading it. Rows are only ever
  // appended, so a dated row directly below the tracked one means the tracker
  // is stale — inserting here would duplicate rows and push the rest down.
  // Non-date content below (a totals or notes row) is left alone.
  if (lastRow > 0 && nextRowDateCell && isDateCell(nextRowDateCell)) {
    throw new Error(
      `row_tracker.json is behind the sheet: row ${lastRow + 1} already holds "${nextRowDateCell}". ` +
        `Run the "Update Last Updated Row" workflow with the sheet's real last row before re-running.`
    );
  }

  // Dates are only ever appended, so anything at or before the last row's date
  // would land out of order.
  if (lastDate && targetTime <= lastDate.getTime()) {
    logger.warn("Target date is not after the last row — skipping", {
      date: dateFormatted,
      lastRowDate: lastDateCell,
    });
    return;
  }

  const summaryPath = "daily_summary.json";
  if (!fs.existsSync(summaryPath)) {
    logger.warn("No daily_summary.json found, skipping update");
    return;
  }
  const data = JSON.parse(fs.readFileSync(summaryPath, "utf-8"));
  if (!data.individual_account || data.individual_account.length === 0) {
    logger.warn("No account data in daily_summary.json, skipping update");
    return;
  }

  const flatAccounts = flattenAccounts(loadBrokerAccounts());

  const newRow = lastRow ? parseInt(lastRow, 10) + 1 : 2;
  const newRowValue = lastRowValue ? parseInt(lastRowValue, 10) + 1 : 1;

  await withRetry(
    () =>
      sheets.spreadsheets.batchUpdate({
        spreadsheetId,
        resource: {
          requests: [
            {
              insertDimension: {
                range: {
                  sheetId,
                  dimension: "ROWS",
                  startIndex: newRow - 1,
                  endIndex: newRow,
                },
                inheritFromBefore: false,
              },
            },
          ],
        },
      }),
    sheetsRetryOpts
  );

  if (lastRow > 0 && lastRowData.length > 0) {
    await withRetry(
      () =>
        sheets.spreadsheets.batchUpdate({
          spreadsheetId,
          resource: {
            requests: [
              {
                copyPaste: {
                  source: {
                    sheetId,
                    startRowIndex: lastRow - 1,
                    endRowIndex: lastRow,
                    startColumnIndex: 0,
                    endColumnIndex: lastRowData.length,
                  },
                  destination: {
                    sheetId,
                    startRowIndex: newRow - 1,
                    endRowIndex: newRow,
                    startColumnIndex: 0,
                    endColumnIndex: lastRowData.length,
                  },
                  pasteType: "PASTE_FORMULA",
                },
              },
            ],
          },
        }),
      sheetsRetryOpts
    );
  }

  const valueUpdates = [
    {
      range: `${sheetName}!A${newRow}:C${newRow}`,
      values: [[newRowValue, dayName, dateFormatted]],
    },
  ];

  for (const acc of flatAccounts) {
    const match = data.individual_account.find((a) => a.account === acc.accountId);
    const startColNum = letterToColumn(acc.sheetStartColumn);
    const endColLetter = columnToLetter(startColNum + ACCOUNT_COLUMN_COUNT - 1);
    valueUpdates.push({
      range: `${sheetName}!${acc.sheetStartColumn}${newRow}:${endColLetter}${newRow}`,
      values: [buildAccountValues(match)],
    });
  }

  await withRetry(
    () =>
      sheets.spreadsheets.values.batchUpdate({
        spreadsheetId,
        resource: { valueInputOption: "RAW", data: valueUpdates },
      }),
    sheetsRetryOpts
  );

  logger.info("Sheet updated successfully", { row: newRow, date: dateFormatted });

  fs.writeFileSync(
    "row_tracker.json",
    JSON.stringify({ lastUpdatedRow: newRow }, null, 2),
    "utf-8"
  );
}

if (require.main === module) {
  updateGoogleSheet().catch((err) => {
    logger.error("updateGoogleSheet failed", err);
    process.exit(1);
  });
}

module.exports = { columnToLetter, letterToColumn, buildAccountValues, isDateCell, updateGoogleSheet };
