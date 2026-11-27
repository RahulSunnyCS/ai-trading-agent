import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { MARKET_OPEN, decide, parseBrokerStop, saved, stopExtra } from './broker-stop-plan.js';

const TRAIL = { InstrumentMove: 3000, StopLossMove: 2000 };

const answer = (config: object | null, isActive = true) => ({
  brokers: [
    {
      _id: 'abc123',
      broker: 'Broker.Finvasia',
      app_keys: { secret: 'never read' },
      v2_settings: { non_signal_settings: config && { state: { config, is_active: isActive } } },
    },
    { _id: 'gone', broker: 'Broker.Finvasia', deleted: true },
  ],
});

const read = (config: object | null, isActive = true) =>
  parseBrokerStop(answer(config, isActive), 'Broker.Finvasia');

describe('parseBrokerStop', () => {
  it('reads the stop in force as rupees of loss, with the target and trail', () => {
    assert.deepEqual(read({ StopLoss: -8500, Target: null, LockAndTrail: TRAIL }), {
      id: 'abc123',
      stopLoss: 8500,
      kept: { Target: null, OverallTrailSL: null, LockAndTrail: TRAIL },
    });
  });

  it('reads an inactive or never-set stop as none, keeping nothing', () => {
    const none = { Target: null, OverallTrailSL: null, LockAndTrail: null };
    assert.deepEqual(read({ StopLoss: 8500, Target: 100 }, false), {
      id: 'abc123',
      stopLoss: null,
      kept: none,
    });
    assert.equal(read(null).stopLoss, null);
  });

  it('refuses an answer it does not understand', () => {
    assert.throws(() => parseBrokerStop({}, 'Broker.Finvasia'), /no brokers list/);
    const bare = { brokers: [{ _id: 'abc123', broker: 'Broker.Finvasia' }] };
    assert.throws(() => parseBrokerStop(bare, 'Broker.Finvasia'), /no v2_settings/);
    assert.throws(() => parseBrokerStop(answer(null), 'Broker.AngelOne'), /0 entries/);
    assert.throws(() => read({ StopLoss: { Value: 1 } }), /not a number/);
  });
});

describe('decide', () => {
  const current = read({ StopLoss: 8500, LockAndTrail: TRAIL });
  const early = MARKET_OPEN - 60;

  it('leaves a stop that already matches', () => {
    assert.deepEqual(decide(current, 8500, early), { kind: 'holds' });
  });

  it('sets only the stop before the open, sending the trail back', () => {
    assert.deepEqual(decide(current, 9000, early), {
      kind: 'set',
      body: { StopLoss: 9000, Target: null, OverallTrailSL: null, LockAndTrail: TRAIL },
    });
  });

  it('writes nothing once the market is open', () => {
    assert.equal(decide(current, 9000, MARKET_OPEN).kind, 'left');
    const none = decide(read(null), 9000, MARKET_OPEN + 60);
    assert.match(none.kind === 'left' ? none.why : '', /by hand/);
  });
});

describe('saved', () => {
  const before = read({ StopLoss: 8500, LockAndTrail: TRAIL });

  it('needs the new stop and the same trail', () => {
    assert.ok(saved(read({ StopLoss: 9000, LockAndTrail: TRAIL }), 9000, before));
    assert.ok(!saved(read({ StopLoss: 8500, LockAndTrail: TRAIL }), 9000, before));
    assert.ok(!saved(read({ StopLoss: 9000 }), 9000, before));
    assert.ok(!saved(read({ StopLoss: 9000, LockAndTrail: TRAIL }, false), 9000, before));
  });
});

describe('stopExtra', () => {
  const manifest = {
    day: '2026-11-30',
    dir_boost: true,
    strategies: [
      { name: 'dir', lots: 2, file: 'a' },
      { name: 'wide', file: 'b' },
      { name: 'buy', addon: true, lots: 2, file: 'c' },
    ],
  };
  const mtm = { strategy: { OverallSL: { Type: 'OverallTgtSLType.MTM', Value: 3000 } } };

  it('adds the doubled pick’s own stop, once per extra lot', () => {
    assert.equal(stopExtra(manifest, new Map([['dir', mtm]])), 3000);
  });

  it('adds ₹4,000 a lot for a pick with no stop of its own', () => {
    const none = { strategy: { OverallSL: { Type: 'None', Value: 0 } } };
    assert.equal(stopExtra(manifest, new Map([['dir', none]])), 4000);
  });

  it('adds nothing when nothing is doubled', () => {
    assert.equal(stopExtra({ ...manifest, dir_boost: false }, new Map()), 0);
  });
});
