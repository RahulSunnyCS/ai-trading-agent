const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// The store (BL-168): TRADING_DATA_ROOT/contract-notes/
//   days/<day>.jsonl                     one line per broker account and session
//   raw/<broker>/<account>/<day>.pdf     the note as received (encrypted)
//   raw/<broker>/<account>/<day>.decrypted.pdf
// Python reads days/ with DuckDB; nothing here touches the DuckDB catalog.

/**
 * `TRADING_DATA_ROOT/contract-notes`. Like trading_data.db.check_mounted, a root on
 * /Volumes/<name> must be that volume's mount point: an unplugged SSD must fail the run,
 * not have `mkdir` create a fresh, empty root on the laptop's own disk.
 */
function storeRoot(env = process.env) {
  const configured = env.TRADING_DATA_ROOT || path.join(os.homedir(), 'TradingData');
  const root = path.resolve(configured.replace(/^~(?=$|\/)/, os.homedir()));
  let resolved = root;
  try {
    resolved = fs.realpathSync(root);
  } catch {
    // A missing root is reported below, by the volume check or by the first write.
  }
  const parts = resolved.split(path.sep);
  if (parts[1] === 'Volumes' && parts.length >= 3) {
    const volume = path.join('/', parts[1], parts[2]);
    if (!isMountPoint(volume)) {
      throw new Error(
        `the trading data root ${configured} is on ${volume}, which is not mounted — run \`uv run tdata mount\` or connect the SSD`,
      );
    }
  }
  return path.join(resolved, 'contract-notes');
}

function isMountPoint(dir) {
  try {
    return fs.statSync(dir).dev !== fs.statSync(path.dirname(dir)).dev;
  } catch {
    return false;
  }
}

function dayFile(root, day) {
  return path.join(root, 'days', `${day}.jsonl`);
}

/** Every line stored for `day`, in file order. A missing file is no lines. */
function readDay(root, day) {
  let text;
  try {
    text = fs.readFileSync(dayFile(root, day), 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  return text
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const lineKey = (l) => `${l.broker}/${l.account}`;

/**
 * Put `line` into its day's file, replacing the line for the same broker account. Written to a
 * temporary file and renamed, so a reader (or a crash) never sees half a file.
 */
function writeLine(root, line) {
  const file = dayFile(root, line.day);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = readDay(root, line.day).filter((l) => lineKey(l) !== lineKey(line));
  lines.push(line);
  lines.sort((a, b) => lineKey(a).localeCompare(lineKey(b)));
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${lines.map((l) => JSON.stringify(l)).join('\n')}\n`);
  fs.renameSync(tmp, file);
}

/** Map of `broker/account` -> line, over the given days. */
function readStatus(root, days) {
  const status = new Map();
  for (const day of days) {
    for (const line of readDay(root, day)) status.set(`${line.day}|${lineKey(line)}`, line);
  }
  return status;
}

function rawDir(root, broker, account) {
  return path.join(root, 'raw', broker, account);
}

/** Keep the encrypted note; returns its path and SHA-256. */
function saveRaw(root, broker, account, day, content) {
  const dir = rawDir(root, broker, account);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${day}.pdf`);
  fs.writeFileSync(file, content);
  return { file, sha256: crypto.createHash('sha256').update(content).digest('hex') };
}

/**
 * How far each account's mail has been read: { "<mailbox>|<broker>/<account>": { uidvalidity,
 * last_uid, checked_at } }. A run reads only mail after `last_uid`; a changed UIDVALIDITY (Gmail
 * renumbered the folder) drops the bookmark and the run reads the window by date again.
 */
function cursorFile(root) {
  return path.join(root, 'cursor.json');
}

function readCursors(root) {
  try {
    return JSON.parse(fs.readFileSync(cursorFile(root), 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return {};
    throw err;
  }
}

function writeCursors(root, cursors) {
  fs.mkdirSync(root, { recursive: true });
  const file = cursorFile(root);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(cursors, null, 2)}\n`);
  fs.renameSync(tmp, file);
}

/**
 * One contract-notes run at a time over the store (`run.lock`, holding the pid). A lock left by
 * a process that is gone is taken over. Returns the release function.
 */
function acquireLock(root) {
  fs.mkdirSync(root, { recursive: true });
  const file = path.join(root, 'run.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fs.writeFileSync(file, String(process.pid), { flag: 'wx' });
      return () => fs.rmSync(file, { force: true });
    } catch (err) {
      if (err.code !== 'EEXIST') throw err;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      let alive = false;
      try {
        process.kill(pid, 0);
        alive = true;
      } catch (e) {
        alive = e.code === 'EPERM'; // it exists, owned by someone else; ESRCH: gone, take over
      }
      if (alive && pid !== process.pid) {
        throw new Error(
          `another contract-notes run (pid ${pid}) is using the store; try again when it ends`,
        );
      }
      fs.rmSync(file, { force: true });
    }
  }
  throw new Error('could not take the store lock');
}

module.exports = {
  acquireLock,
  storeRoot,
  readDay,
  writeLine,
  readStatus,
  saveRaw,
  rawDir,
  dayFile,
  readCursors,
  writeCursors,
};
