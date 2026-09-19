# Trade Mail Parser

## Overview

This project consists of three main scripts:

- **fetchMail.js**  
  Fetches emails from multiple Gmail accounts using the provided credentials and filters the emails based on specific criteria (e.g., subject line, sender).

- **parse.js**  
  Parses the fetched email content to extract relevant trade-related data in a structured format (like trade entries, exits, quantities, etc.).

- **sheetUpdate.js**  
  Updates a Google Sheet with the parsed data, appending new rows or updating existing ones based on the extracted information.

---

## Environment Variables

Before running the scripts, you need to set up a `.env` file with the following variables:

```env
BROKER_ACCOUNTS_JSON=[{"email":"user1@gmail.com","emailPassword":"app-pwd-1","accounts":[{"broker":"finvasia","accountId":"FA1234","pdfPassword":"pdf-pwd-1","sheetStartColumn":"D"},{"broker":"angelone","accountId":"R59799620","pdfPassword":"pdf-pwd-2","sheetStartColumn":"I"}]}]
GOOGLE_CREDENTIALS=Base64_Encoded_Google_Credentials_JSON
GOOGLE_SHEET_ID=your_google_sheet_id
SHEET_GID=your_sheet_gid
SHEET_NAME=your_sheet_name
```

`BROKER_ACCOUNTS_JSON` models the real 1-to-N relationship between a Gmail inbox and the broker accounts whose contract notes land in it. Pretty-printed:

```json
[
  {
    "email": "user1@gmail.com",
    "emailPassword": "gmail-app-password-1",
    "accounts": [
      { "broker": "finvasia", "accountId": "FA1234", "pdfPassword": "pdf-pwd-1", "sheetStartColumn": "D" },
      { "broker": "angelone",  "accountId": "R59799620", "pdfPassword": "pdf-pwd-2", "sheetStartColumn": "I" }
    ]
  },
  {
    "email": "user2@gmail.com",
    "emailPassword": "gmail-app-password-2",
    "accounts": [
      { "broker": "finvasia", "accountId": "FA9999", "pdfPassword": "pdf-pwd-3", "sheetStartColumn": "N" }
    ]
  }
]
```

Supported `broker` values: `finvasia`, `angelone`.

### F&O-only numbers

Only equity-derivative (F&O) trades are recorded. Contract notes are issued per day, not per segment, so an equity/cash trade taken on the same day arrives in the same PDF and is included in the note's own totals. The parsers read the obligation table one exchange/segment row at a time (`NSEFNO-NCL`, `NSECASH-NCL`, `BSE-FUTURES`, `NSE-CASH`, …) and keep only the F&O rows — the note's `TOTAL(NET)` and `Total Brokerage` figures are used as cross-checks, never as values, since they span every segment. Per-segment brokerage is derived from the row's taxable value of supply.

A note with only equity rows records zeros. A segment label that the classifier in `brokers/segments.js` does not recognise is reported as an error rather than guessed at, so nothing unexpected is silently added to or dropped from the day's P&L.

`sheetStartColumn` is the leftmost Google Sheet column for that account's daily values. Each account writes a contiguous 5-column block starting there:

| Offset | Column (e.g. start = `D`) | Value                                                |
| ------ | ------------------------- | ---------------------------------------------------- |
| 0      | `D`                       | `payin_payout_obligation`                            |
| 1      | `E`                       | `net_brokerage`                                      |
| 2      | `F`                       | `other_charges`                                      |
| 3      | `G`                       | `total_charges` (= `net_brokerage + other_charges`)  |
| 4      | `H`                       | `final_net`                                          |

Columns A–C are reserved for the serial number, day name and formatted date. Pick `sheetStartColumn` per account so the 5-column blocks don't overlap; any other columns (gaps between blocks, or formulas further right) are preserved from the previous row.

### Explanation:

| Variable               | Description                                                                                                                                |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `BROKER_ACCOUNTS_JSON` | JSON array of mailboxes, each with `email`, `emailPassword`, and `accounts[]` (each account has `broker`, `accountId`, `pdfPassword`).     |
| `GOOGLE_CREDENTIALS`   | Base64 encoded service account JSON credentials for Google Sheets API access.                                                              |
| `GOOGLE_SHEET_ID`      | ID of the target Google Sheet where data should be updated.                                                                                |
| `SHEET_GID`            | GID of the specific sheet/tab inside the Google Sheet.                                                                                     |
| `SHEET_NAME`           | Name of the specific sheet/tab inside the Google Sheet.                                                                                    |

---

## Helpful Links

- **How to Create Google Service Account and Get Credentials:**  
  [Guide: Creating Service Account and Enabling Google Sheets API](https://cloud.google.com/iam/docs/creating-managing-service-account-keys)

- **How to Get Google Sheet ID and GID:**

  - **Sheet ID**: It's the long string in the URL between `/d/` and `/edit`.  
    Example: `https://docs.google.com/spreadsheets/d/your_google_sheet_id/edit#gid=0`
  - **GID**: It’s the value after `gid=` in the URL.

- **Base64 Encode your Credentials:**
  You can encode your service account JSON file using:
  ```bash
  base64 service-account.json
  ```

---

## Example `.env` (Generic)

```env
BROKER_ACCOUNTS_JSON=[{"email":"user1@gmail.com","emailPassword":"yourpassword1","accounts":[{"broker":"finvasia","accountId":"accountid1","pdfPassword":"pdfpwd1","sheetStartColumn":"D"}]},{"email":"user2@gmail.com","emailPassword":"yourpassword2","accounts":[{"broker":"angelone","accountId":"accountid2","pdfPassword":"pdfpwd2","sheetStartColumn":"I"}]}]
GOOGLE_CREDENTIALS=your_base64_encoded_service_account_json
GOOGLE_SHEET_ID=your_google_sheet_id_here
SHEET_GID=your_sheet_gid_here
SHEET_NAME=your_sheet_name_here
```

---

## Adding Environment Variables to GitHub Actions

To use this project with **GitHub Actions**, make sure you add the environment variables as **GitHub Secrets**:

### Steps:

1. Go to your GitHub repository.
2. Navigate to **Settings** → **Secrets and variables** → **Actions**.
3. Click **"New repository secret"**.
4. Add each of the following as separate secrets:

| GitHub Secret Name     | Corresponds to .env Variable |
| ---------------------- | ---------------------------- |
| `BROKER_ACCOUNTS_JSON` | `BROKER_ACCOUNTS_JSON`       |
| `GOOGLE_CREDENTIALS`   | `GOOGLE_CREDENTIALS`         |
| `GOOGLE_SHEET_ID`      | `GOOGLE_SHEET_ID`            |
| `SHEET_GID`            | `SHEET_GID`                  |
| `SHEET_NAME`           | `SHEET_NAME`                 |

### Notes:

- Make sure your GitHub Actions workflow is configured to load these secrets using the `secrets` context.
- You can access the secrets in your workflow like this:

```yaml
env:
  BROKER_ACCOUNTS_JSON: ${{ secrets.BROKER_ACCOUNTS_JSON }}
  GOOGLE_CREDENTIALS: ${{ secrets.GOOGLE_CREDENTIALS }}
  GOOGLE_SHEET_ID: ${{ secrets.GOOGLE_SHEET_ID }}
  SHEET_GID: ${{ secrets.SHEET_GID }}
  SHEET_NAME: ${{ secrets.SHEET_NAME }}
```
