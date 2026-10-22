import { describe, expect, it } from 'bun:test';
import { brokerLoginFailedPart, pickBrokerLoginRun } from '../summary.js';

const job = (steps: Array<[string, string | null]>) => ({
  steps: steps.map(([name, conclusion]) => ({ name, conclusion })),
});

describe('brokerLoginFailedPart', () => {
  it('names Quantiply when only its step failed', () => {
    const jobs = [
      job([['check', 'success']]),
      job([
        ['Log in brokers', 'success'],
        ['Quantiply login', 'failure'],
      ]),
    ];
    expect(brokerLoginFailedPart(jobs)).toBe('quantiply');
  });

  it('names AlgoTest when the login step failed and Quantiply did not', () => {
    const jobs = [
      job([
        ['Log in brokers', 'failure'],
        ['Quantiply login', 'skipped'],
      ]),
    ];
    expect(brokerLoginFailedPart(jobs)).toBe('algotest');
  });

  it('names both, and says unknown when neither step tells', () => {
    expect(
      brokerLoginFailedPart([
        job([
          ['Log in brokers', 'failure'],
          ['Quantiply login', 'failure'],
        ]),
      ]),
    ).toBe('both');
    expect(brokerLoginFailedPart([job([['Prepare container', 'failure']])])).toBe('unknown');
    expect(brokerLoginFailedPart([{}])).toBe('unknown');
  });
});

describe('pickBrokerLoginRun', () => {
  const run = (id: number, conclusion: string) => ({
    conclusion,
    status: 'completed',
    createdAt: '2026-10-19T02:30:00Z',
    url: `https://example.test/${id}`,
    databaseId: id,
  });
  const ran = [job([['Log in brokers', 'success']])];
  const skipped = [job([['check', 'success']]), job([['Log in brokers', null]])];

  it('does not let a skipped backstop hide the 08:00 Quantiply failure', () => {
    const today = [run(2, 'success'), run(1, 'failure')];
    const picked = pickBrokerLoginRun(today, (r) => (r.databaseId === 2 ? skipped : ran));
    expect(picked?.databaseId).toBe(1);
  });

  it('takes a success whose login step ran over an earlier failure', () => {
    const today = [run(2, 'success'), run(1, 'failure')];
    expect(pickBrokerLoginRun(today, () => ran)?.databaseId).toBe(2);
  });

  it('trusts a success when GitHub cannot list its steps, and falls back to the newest run', () => {
    expect(pickBrokerLoginRun([run(1, 'success')], () => null)?.databaseId).toBe(1);
    expect(pickBrokerLoginRun([run(3, 'cancelled')], () => ran)?.databaseId).toBe(3);
    expect(pickBrokerLoginRun([], () => ran)).toBeUndefined();
  });
});
