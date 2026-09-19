const { requireEnv } = require("../../utils/validate");

describe("requireEnv()", () => {
  const saved = {};
  beforeEach(() => {
    ["GOOGLE_CREDENTIALS", "TARGET_DATE", "TEST_VAR_A", "TEST_VAR_B"].forEach((k) => {
      saved[k] = process.env[k];
    });
  });
  afterEach(() => {
    Object.entries(saved).forEach(([k, v]) => {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    });
  });

  test("passes when all required vars are set", () => {
    process.env.TEST_VAR_A = "val";
    process.env.TEST_VAR_B = "val";
    expect(() => requireEnv(["TEST_VAR_A", "TEST_VAR_B"])).not.toThrow();
  });

  test("throws listing all missing vars in one message", () => {
    delete process.env.TEST_VAR_A;
    delete process.env.TEST_VAR_B;
    expect(() => requireEnv(["TEST_VAR_A", "TEST_VAR_B"])).toThrow(
      /TEST_VAR_A.*TEST_VAR_B|TEST_VAR_B.*TEST_VAR_A/
    );
  });

  test("throws on invalid base64 GOOGLE_CREDENTIALS", () => {
    process.env.GOOGLE_CREDENTIALS = "!!!not-base64-json!!!";
    expect(() => requireEnv(["GOOGLE_CREDENTIALS"])).toThrow(/GOOGLE_CREDENTIALS/);
  });

  test("throws when GOOGLE_CREDENTIALS is valid base64 but not JSON", () => {
    process.env.GOOGLE_CREDENTIALS = Buffer.from("not json").toString("base64");
    expect(() => requireEnv(["GOOGLE_CREDENTIALS"])).toThrow(/GOOGLE_CREDENTIALS/);
  });

  test("passes when GOOGLE_CREDENTIALS is valid base64 JSON", () => {
    const creds = JSON.stringify({ client_email: "x@x.com", private_key: "key" });
    process.env.GOOGLE_CREDENTIALS = Buffer.from(creds).toString("base64");
    expect(() => requireEnv(["GOOGLE_CREDENTIALS"])).not.toThrow();
  });

  test("throws on invalid TARGET_DATE", () => {
    process.env.TARGET_DATE = "not-a-date";
    expect(() => requireEnv([])).toThrow(/TARGET_DATE/);
  });

  test("passes on valid TARGET_DATE", () => {
    process.env.TARGET_DATE = "2025-04-30";
    expect(() => requireEnv([])).not.toThrow();
  });
});
