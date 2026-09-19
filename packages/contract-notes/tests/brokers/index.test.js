const { makeFileName, parseFileName, loadBrokerAccounts, getBroker } = require("../../brokers");

describe("makeFileName / parseFileName", () => {
  test("round-trips through makeFileName → parseFileName", () => {
    const filename = makeFileName("user@example.com", "finvasia", "FA1234", "trade.pdf");
    const result = parseFileName(filename);
    expect(result.email).toBe("user_example_com");
    expect(result.broker).toBe("finvasia");
    expect(result.accountId).toBe("FA1234");
    expect(result.originalName).toBe("trade.pdf");
  });

  test("parseFileName returns null for unrecognised format", () => {
    expect(parseFileName("randomfile.pdf")).toBeNull();
  });

  test("parseFileName handles _decrypted suffix", () => {
    const name = makeFileName("a@b.com", "angelone", "R001", "cn.pdf").replace(
      ".pdf",
      "_decrypted.pdf"
    );
    const result = parseFileName(name);
    expect(result).not.toBeNull();
    expect(result.broker).toBe("angelone");
    expect(result.accountId).toBe("R001");
  });

  test("original filename with multiple underscores is preserved", () => {
    const filename = makeFileName("x@y.com", "finvasia", "ACC1", "contract_note_2025.pdf");
    const result = parseFileName(filename);
    expect(result.originalName).toBe("contract_note_2025.pdf");
  });
});

describe("getBroker()", () => {
  test("returns finvasia broker", () => {
    const broker = getBroker("finvasia");
    expect(typeof broker.subject).toBe("function");
    expect(typeof broker.extract).toBe("function");
  });

  test("returns angelone broker", () => {
    const broker = getBroker("angelone");
    expect(typeof broker.subject).toBe("function");
    expect(typeof broker.extract).toBe("function");
  });

  test("throws for unknown broker", () => {
    expect(() => getBroker("unknownbroker")).toThrow(/Unknown broker/);
  });
});

describe("loadBrokerAccounts()", () => {
  const orig = process.env.BROKER_ACCOUNTS_JSON;
  afterEach(() => {
    process.env.BROKER_ACCOUNTS_JSON = orig;
  });

  test("throws when BROKER_ACCOUNTS_JSON is missing", () => {
    delete process.env.BROKER_ACCOUNTS_JSON;
    expect(() => loadBrokerAccounts()).toThrow(/BROKER_ACCOUNTS_JSON/);
  });

  test("throws on invalid JSON", () => {
    process.env.BROKER_ACCOUNTS_JSON = "{bad json";
    expect(() => loadBrokerAccounts()).toThrow(/not valid JSON/);
  });

  test("throws when config is not an array", () => {
    process.env.BROKER_ACCOUNTS_JSON = JSON.stringify({ email: "x@x.com" });
    expect(() => loadBrokerAccounts()).toThrow(/array/);
  });

  test("throws when sheetStartColumn is missing", () => {
    const config = [
      {
        email: "x@x.com",
        emailPassword: "pw",
        accounts: [{ broker: "finvasia", accountId: "X1", pdfPassword: "pw" }],
      },
    ];
    process.env.BROKER_ACCOUNTS_JSON = JSON.stringify(config);
    expect(() => loadBrokerAccounts()).toThrow(/sheetStartColumn/);
  });

  test("parses valid config successfully", () => {
    const config = [
      {
        email: "user@gmail.com",
        emailPassword: "pw",
        accounts: [
          { broker: "finvasia", accountId: "FA1", pdfPassword: "pp", sheetStartColumn: "D" },
        ],
      },
    ];
    process.env.BROKER_ACCOUNTS_JSON = JSON.stringify(config);
    const result = loadBrokerAccounts();
    expect(result).toHaveLength(1);
    expect(result[0].accounts[0].accountId).toBe("FA1");
  });
});
