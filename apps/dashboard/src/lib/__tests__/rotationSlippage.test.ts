import { describe, expect, it } from 'vitest';

import {
  RANKING_NO_SLIPPAGE,
  SLIPPAGE_TEXT,
  grossLabel,
  grossLabelSentence,
  noSlippageNote,
  withSlippage,
} from '../rotationSlippage';

describe('withSlippage', () => {
  it('adds slippage=0.5 when on, with the right separator', () => {
    expect(withSlippage('/api/backtest/legwise/rotation/overview', true)).toBe(
      '/api/backtest/legwise/rotation/overview?slippage=0.5',
    );
    expect(withSlippage('/api/backtest/legwise/rotation/drift?list=C', true)).toBe(
      '/api/backtest/legwise/rotation/drift?list=C&slippage=0.5',
    );
    expect(withSlippage('/x?', true)).toBe('/x?slippage=0.5');
    expect(withSlippage('/x?a=1&', true)).toBe('/x?a=1&slippage=0.5');
  });

  it('sends nothing when off (the API default is no slippage)', () => {
    expect(withSlippage('/api/backtest/legwise/rotation/summary?lots=1', false)).toBe(
      '/api/backtest/legwise/rotation/summary?lots=1',
    );
  });

  it('makes the on and off URLs differ, so a read cached by URL refetches', () => {
    const url = '/api/backtest/legwise/correlation?selectors=a';
    expect(withSlippage(url, true)).not.toBe(withSlippage(url, false));
  });
});

describe('labels', () => {
  it('names the slippage in the basis word only when on', () => {
    expect(SLIPPAGE_TEXT).toBe('0.5%');
    expect(grossLabel(true)).toBe('gross after 0.5% slippage');
    expect(grossLabel(false)).toBe('gross');
    expect(grossLabelSentence(true)).toBe('Gross after 0.5% slippage');
    expect(grossLabelSentence(false)).toBe('Gross');
  });

  it('notes a card without slippage only while the switch is on', () => {
    expect(noSlippageNote(true, RANKING_NO_SLIPPAGE)).toBe(
      ' Without the 0.5% slippage: the picks are ranked without it.',
    );
    expect(noSlippageNote(false, RANKING_NO_SLIPPAGE)).toBe('');
  });
});
