import assert from 'node:assert/strict';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';
import { type APIRequestContext, request } from 'playwright';
import { deleteStrategyById, vanished } from './strategy-delete.js';

/**
 * The delete call against a local stand-in for api.algotest.in: what it sends (method, path, CSRF
 * header) and that anything but a 2xx is an error. No browser and no network needed.
 */
interface Seen {
  method?: string;
  url?: string;
  csrf?: string | string[];
}
let server: Server;
let api: string;
let client: APIRequestContext;
const seen: Seen[] = [];
let status = 200;

before(async () => {
  server = createServer((req, res) => {
    seen.push({ method: req.method, url: req.url, csrf: req.headers['x-csrf-token-access'] });
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ msg: 'Strategy deleted' }));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  api = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  client = await request.newContext();
});
after(async () => {
  await client.dispose();
  await new Promise<void>((done) => server.close(() => done()));
});

describe('deleteStrategyById', () => {
  it('sends DELETE /strategy/<id> with the CSRF header the web app uses', async () => {
    seen.length = 0;
    status = 200;
    await deleteStrategyById(client, '6ad590af06a3aebabc43634d', 'csrf-1', api);
    assert.deepEqual(seen, [
      { method: 'DELETE', url: '/strategy/6ad590af06a3aebabc43634d', csrf: 'csrf-1' },
    ]);
  });

  it('throws on a non-2xx answer', async () => {
    status = 404;
    await assert.rejects(
      deleteStrategyById(client, '6ad590af06a3aebabc43634d', 'csrf-1', api),
      /delete answered 404/,
    );
  });

  it('refuses anything that is not a strategy id, before sending', async () => {
    seen.length = 0;
    for (const bad of ['', '../strategies', '6ad590af06a3aebabc43634d/x', 'abc']) {
      await assert.rejects(deleteStrategyById(client, bad, 'csrf-1', api), /not a strategy id/);
    }
    assert.equal(seen.length, 0);
  });
});

describe('vanished', () => {
  it('names every other id that is missing after a delete', () => {
    assert.deepEqual(vanished(['a', 'b', 'c'], ['a', 'c'], 'b'), []);
    assert.deepEqual(vanished(['a', 'b', 'c'], ['c'], 'b'), ['a']);
  });
});
