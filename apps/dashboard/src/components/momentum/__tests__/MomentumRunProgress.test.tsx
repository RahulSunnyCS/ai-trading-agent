// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { MomentumRunBanner, describeStage } from '../MomentumRunProgress';

afterEach(cleanup);

const base = {
  elapsedMs: 8_000,
  datasetLabel: 'Broad Momentum',
  dataset: 'broad',
  hasPreviousResult: false,
};

describe('describeStage', () => {
  it('numbers the four steps in order', () => {
    expect(describeStage('loading')).toBe('Step 1 of 4 · Loading prices');
    expect(describeStage('ranking')).toBe('Step 2 of 4 · Ranking');
    expect(describeStage('simulating')).toBe('Step 3 of 4 · Simulating the weekly trades');
    expect(describeStage('analysing')).toBe('Step 4 of 4 · Preparing the results');
  });

  it('says nothing for a step it does not know, or none', () => {
    expect(describeStage('something-new')).toBeNull();
    expect(describeStage(null)).toBeNull();
    expect(describeStage(undefined)).toBeNull();
  });
});

describe('MomentumRunBanner', () => {
  it('shows the step the server has reached', () => {
    render(<MomentumRunBanner {...base} stage="ranking" />);
    expect(screen.getByText(/Step 2 of 4 · Ranking/)).toBeTruthy();
    expect(screen.getByText('Running Broad Momentum backtest')).toBeTruthy();
  });

  it('shows no step while the run is still queued behind others', () => {
    render(<MomentumRunBanner {...base} stage="ranking" queued />);
    expect(screen.queryByText(/Step 2 of 4/)).toBeNull();
    expect(screen.getByText(/waiting for other runs/)).toBeTruthy();
  });

  it('says how long such a run usually takes, once a few seconds have passed', () => {
    render(<MomentumRunBanner {...base} usualMs={19_600} />);
    expect(screen.getByText('Usually about 20 s.')).toBeTruthy();
  });

  it('keeps the old hint for a dataset it has not seen run here yet', () => {
    render(<MomentumRunBanner {...base} />);
    expect(screen.getByText(/builds category rankings/)).toBeTruthy();
    expect(screen.queryByText(/Usually/)).toBeNull();
  });

  it('says nothing extra in the first few seconds', () => {
    render(<MomentumRunBanner {...base} elapsedMs={2_000} usualMs={19_600} />);
    expect(screen.queryByText(/Usually/)).toBeNull();
    expect(screen.getByText('2s')).toBeTruthy();
  });
});
