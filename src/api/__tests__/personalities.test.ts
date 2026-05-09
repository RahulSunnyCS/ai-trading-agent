import { mock, describe, it, expect, beforeEach } from 'bun:test';

const mockQuery = mock<(...args: unknown[]) => Promise<unknown[]>>(() => Promise.resolve([]));

mock.module('../../db/client',       () => ({ query: mockQuery }));
mock.module('../../api/ws/live-feed', () => ({ registerLiveFeed: () => {} }));

const { buildApp } = await import('../server');

import type { PersonalityConfig } from '../../db/schema';

function makePersonality(overrides: Partial<PersonalityConfig> = {}): PersonalityConfig {
  return {
    id:                       'p1',
    name:                     'Precision',
    version:                  1,
    is_active:                true,
    is_frozen:                false,
    created_at:               new Date(),
    entry_type:               'MOMENTUM_EXHAUSTION',
    management_style:         'HOLD',
    phase:                    1,
    min_probability:          0.6,
    max_daily_trades:         3,
    max_daily_loss:           5000,
    entry_delay_secs:         60,
    position_multiplier:      1,
    adjustment_trigger_points: undefined,
    max_open_legs:            undefined,
    reentry_min_probability:  undefined,
    min_vix:                  12,
    max_vix:                  30,
    require_profit_gate:      false,
    profit_gate_amount:       undefined,
    profit_gate_days:         undefined,
    allow_reentry:            false,
    reentry_delay_mins:       undefined,
    allowed_regimes:          ['RANGING'],
    allowed_strategies:       undefined,
    cached_win_rate:          undefined,
    cached_sharpe:            undefined,
    cached_total_trades:      undefined,
    cache_updated_at:         undefined,
    evolved_from:             undefined,
    evolution_reason:         undefined,
    ...overrides,
  };
}

describe('GET /api/personalities', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns empty array when no personalities', async () => {
    mockQuery.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({ method: 'GET', url: '/api/personalities' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body)).toEqual([]);
  });
});

describe('POST /api/personalities/:id/freeze', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns 404 for unknown personality', async () => {
    mockQuery.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method:  'POST',
      url:     '/api/personalities/no-such-id/freeze',
      payload: { frozen: true },
    });
    expect(res.statusCode).toBe(404);
  });

  it('returns 400 when trying to unfreeze a frozen personality', async () => {
    const frozen = makePersonality({ is_frozen: true, name: 'Clockwork' });
    mockQuery.mockResolvedValue([frozen]);
    const app = await buildApp();
    const res = await app.inject({
      method:  'POST',
      url:     '/api/personalities/p1/freeze',
      payload: { frozen: false },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.parse(res.body).error).toContain('frozen');
  });

  it('freezes an unfrozen personality', async () => {
    const unfrozen = makePersonality({ is_frozen: false });
    const frozenNow = makePersonality({ is_frozen: true });
    mockQuery.mockResolvedValueOnce([unfrozen]).mockResolvedValueOnce([frozenNow]);
    const app = await buildApp();
    const res = await app.inject({
      method:  'POST',
      url:     '/api/personalities/p1/freeze',
      payload: { frozen: true },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).is_frozen).toBe(true);
  });

  it('returns 400 for missing body', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method:  'POST',
      url:     '/api/personalities/p1/freeze',
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/personalities/:id/activate', () => {
  beforeEach(() => mockQuery.mockReset());

  it('returns 404 for unknown personality', async () => {
    mockQuery.mockResolvedValue([]);
    const app = await buildApp();
    const res = await app.inject({
      method:  'POST',
      url:     '/api/personalities/no-such-id/activate',
      payload: { active: false },
    });
    expect(res.statusCode).toBe(404);
  });

  it('deactivates a personality', async () => {
    const deactivated = makePersonality({ is_active: false });
    mockQuery.mockResolvedValue([deactivated]);
    const app = await buildApp();
    const res = await app.inject({
      method:  'POST',
      url:     '/api/personalities/p1/activate',
      payload: { active: false },
    });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.body).is_active).toBe(false);
  });
});
