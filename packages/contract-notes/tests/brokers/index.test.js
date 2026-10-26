const { getBroker, isSupported, loadBrokerAccounts } = require('../../brokers');

describe('getBroker()', () => {
  test('returns finvasia broker', () => {
    const broker = getBroker('finvasia');
    expect(typeof broker.searchSubject).toBe('function');
    expect(typeof broker.extract).toBe('function');
  });

  test('returns angelone broker', () => {
    const broker = getBroker('angelone');
    expect(typeof broker.searchSubject).toBe('function');
    expect(typeof broker.extract).toBe('function');
  });

  test('throws for unknown broker', () => {
    expect(() => getBroker('unknownbroker')).toThrow(/Unknown broker/);
  });
});

describe('loadBrokerAccounts()', () => {
  const orig = process.env.BROKER_ACCOUNTS_JSON;
  afterEach(() => {
    process.env.BROKER_ACCOUNTS_JSON = orig;
  });

  test('throws when BROKER_ACCOUNTS_JSON is missing', () => {
    delete process.env.BROKER_ACCOUNTS_JSON;
    expect(() => loadBrokerAccounts()).toThrow(/BROKER_ACCOUNTS_JSON/);
  });

  test('throws on invalid JSON', () => {
    process.env.BROKER_ACCOUNTS_JSON = '{bad json';
    expect(() => loadBrokerAccounts()).toThrow(/not valid JSON/);
  });

  test('throws when config is not an array', () => {
    process.env.BROKER_ACCOUNTS_JSON = JSON.stringify({ email: 'x@x.com' });
    expect(() => loadBrokerAccounts()).toThrow(/array/);
  });

  test('needs no sheetStartColumn, and accepts a broker with no reader yet', () => {
    const config = [
      {
        email: 'x@x.com',
        emailPassword: 'pw',
        accounts: [
          { broker: 'finvasia', accountId: 'X1', pdfPassword: 'pw' },
          { broker: 'icici', accountId: 'IC1', pdfPassword: 'pw2' },
        ],
      },
    ];
    process.env.BROKER_ACCOUNTS_JSON = JSON.stringify(config);
    expect(loadBrokerAccounts()[0].accounts).toHaveLength(2);
    expect(isSupported('finvasia')).toBe(true);
    expect(isSupported('kite')).toBe(true);
    expect(isSupported('icici')).toBe(false);
  });

  test('never echoes the config, which holds the passwords', () => {
    process.env.BROKER_ACCOUNTS_JSON = JSON.stringify([
      { email: 'x@x.com', emailPassword: 'SECRETPW', accounts: [{ broker: 'finvasia' }] },
    ]);
    expect(() => loadBrokerAccounts()).toThrow(/Mailbox 1, account 1/);
    expect(() => loadBrokerAccounts()).not.toThrow(/SECRETPW/);
  });

  test('a pretty-printed value read as one line says so', () => {
    expect(() => loadBrokerAccounts('[')).toThrow(/1 characters; it must be on one line/);
  });

  test('parses valid config successfully', () => {
    const config = [
      {
        email: 'user@gmail.com',
        emailPassword: 'pw',
        accounts: [{ broker: 'finvasia', accountId: 'FA1', pdfPassword: 'pp' }],
      },
    ];
    process.env.BROKER_ACCOUNTS_JSON = JSON.stringify(config);
    const result = loadBrokerAccounts();
    expect(result).toHaveLength(1);
    expect(result[0].accounts[0].accountId).toBe('FA1');
  });
});
