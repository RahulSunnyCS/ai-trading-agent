const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { decryptWithQpdf } = require('../fetchMail');

const hasQpdf = spawnSync('qpdf', ['--version']).status === 0;
const describeQpdf = hasQpdf ? describe : describe.skip;

let tmpDir;
let samplePdf;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qpdf-test-'));
  // A blank one-page PDF, written out by qpdf so it has a proper cross-reference table: no
  // real contract note is committed (the repo is public).
  const page = path.join(tmpDir, 'page.pdf');
  fs.writeFileSync(
    page,
    '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n' +
      '2 0 obj<</Type/Pages/Kids[3 0 R]/Count 1>>endobj\n' +
      '3 0 obj<</Type/Page/Parent 2 0 R/MediaBox[0 0 200 200]/Resources<<>>>>endobj\n' +
      'trailer<</Root 1 0 R/Size 4>>\n%%EOF\n',
  );
  samplePdf = path.join(tmpDir, 'blank.pdf');
  if (hasQpdf) {
    const built = spawnSync('qpdf', [page, samplePdf]);
    // 0 = clean, 3 = written with warnings (the hand-written source has no xref table).
    expect([0, 3]).toContain(built.status);
    expect(fs.existsSync(samplePdf)).toBe(true);
  }
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function encrypted(name, password) {
  const out = path.join(tmpDir, name);
  const r = spawnSync('qpdf', [
    '--encrypt',
    `--user-password=${password}`,
    `--owner-password=${password}`,
    '--bits=256',
    '--',
    samplePdf,
    out,
  ]);
  if (r.status !== 0) throw new Error(`could not build fixture: ${r.stderr}`);
  return out;
}

describeQpdf('decryptWithQpdf()', () => {
  test('decrypts a password-protected PDF', () => {
    const result = decryptWithQpdf(encrypted('ok.pdf', 'SECRET123'), 'SECRET123');
    expect(result.error).toBeNull();
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
  });

  test('reports the real reason for a wrong password', () => {
    const result = decryptWithQpdf(encrypted('bad.pdf', 'SECRET123'), 'WRONG');
    expect(result.path).toBeNull();
    // Regression: the reason used to be swallowed by stdio "ignore".
    expect(result.error).toMatch(/invalid password/i);
  });

  test('keeps a PDF that qpdf repairs with warnings (exit code 3)', () => {
    // Regression: qpdf exits 3 when it reconstructs a damaged cross-reference
    // table, but the decrypted file is written and readable. That used to be
    // treated as a hard failure, which aborted the whole run.
    const damaged = path.join(tmpDir, 'damaged.pdf');
    const bytes = fs.readFileSync(samplePdf);
    // Point startxref at an offset past the end of the file.
    const at = bytes.lastIndexOf(Buffer.from('startxref'));
    const m = /^startxref(\s+)(\d+)/.exec(bytes.subarray(at).toString('latin1'));
    if (!m) throw new Error('blank PDF has no startxref offset');
    const offsetStart = at + 'startxref'.length + m[1].length;
    fs.writeFileSync(
      damaged,
      Buffer.concat([
        bytes.subarray(0, offsetStart),
        Buffer.from('999999999'),
        bytes.subarray(offsetStart + m[2].length),
      ]),
    );

    const probe = spawnSync('qpdf', ['--decrypt', damaged, path.join(tmpDir, 'probe.pdf')]);
    expect(probe.status).toBe(3); // guard: the fixture really is a warnings case

    const result = decryptWithQpdf(damaged, 'unused');
    expect(result.error).toBeNull();
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
  });

  test('reports a file that is not a PDF at all', () => {
    const notPdf = path.join(tmpDir, 'notapdf.pdf');
    fs.writeFileSync(notPdf, '<html>session expired</html>');
    const result = decryptWithQpdf(notPdf, 'whatever');
    expect(result.path).toBeNull();
    expect(result.error).toMatch(/PDF header|damaged/i);
  });
});
