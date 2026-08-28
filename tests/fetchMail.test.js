const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { decryptWithQpdf } = require("../fetchMail");

const hasQpdf = spawnSync("qpdf", ["--version"]).status === 0;
const describeQpdf = hasQpdf ? describe : describe.skip;

let tmpDir;
const samplePdf = path.join(__dirname, "..", "Angel One sample.pdf");

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "qpdf-test-"));
});

afterAll(() => {
  if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
});

function encrypted(name, password) {
  const out = path.join(tmpDir, name);
  const r = spawnSync("qpdf", [
    "--encrypt",
    `--user-password=${password}`,
    `--owner-password=${password}`,
    "--bits=256",
    "--",
    samplePdf,
    out,
  ]);
  if (r.status !== 0) throw new Error(`could not build fixture: ${r.stderr}`);
  return out;
}

describeQpdf("decryptWithQpdf()", () => {
  test("decrypts a password-protected PDF", () => {
    const result = decryptWithQpdf(encrypted("ok.pdf", "SECRET123"), "SECRET123");
    expect(result.error).toBeNull();
    expect(fs.existsSync(result.path)).toBe(true);
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
  });

  test("reports the real reason for a wrong password", () => {
    const result = decryptWithQpdf(encrypted("bad.pdf", "SECRET123"), "WRONG");
    expect(result.path).toBeNull();
    // Regression: the reason used to be swallowed by stdio "ignore".
    expect(result.error).toMatch(/invalid password/i);
  });

  test("keeps a PDF that qpdf repairs with warnings (exit code 3)", () => {
    // Regression: qpdf exits 3 when it reconstructs a damaged cross-reference
    // table, but the decrypted file is written and readable. That used to be
    // treated as a hard failure, which aborted the whole run.
    const damaged = path.join(tmpDir, "damaged.pdf");
    const bytes = fs.readFileSync(samplePdf);
    const at = bytes.lastIndexOf(Buffer.from("startxref"));
    const offsetLen = String(bytes.length).length;
    fs.writeFileSync(
      damaged,
      Buffer.concat([
        bytes.subarray(0, at + 10),
        Buffer.from("999999999"),
        bytes.subarray(at + 10 + offsetLen),
      ])
    );

    const probe = spawnSync("qpdf", ["--decrypt", damaged, path.join(tmpDir, "probe.pdf")]);
    expect(probe.status).toBe(3); // guard: the fixture really is a warnings case

    const result = decryptWithQpdf(damaged, "unused");
    expect(result.error).toBeNull();
    expect(fs.statSync(result.path).size).toBeGreaterThan(0);
  });

  test("reports a file that is not a PDF at all", () => {
    const notPdf = path.join(tmpDir, "notapdf.pdf");
    fs.writeFileSync(notPdf, "<html>session expired</html>");
    const result = decryptWithQpdf(notPdf, "whatever");
    expect(result.path).toBeNull();
    expect(result.error).toMatch(/PDF header|damaged/i);
  });
});
