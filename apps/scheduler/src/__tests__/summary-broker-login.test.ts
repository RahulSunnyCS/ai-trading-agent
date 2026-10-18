import { describe, expect, it } from 'bun:test';
import { brokerLoginFailedPart } from '../summary.js';

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
