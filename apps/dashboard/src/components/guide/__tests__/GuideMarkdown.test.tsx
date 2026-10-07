// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { GuideMarkdown } from '../GuideMarkdown';

afterEach(cleanup);

describe('GuideMarkdown', () => {
  it('renders headings and tables', () => {
    render(<GuideMarkdown>{'## Title\n\n| A | B |\n|---|---|\n| 1 | 2 |\n'}</GuideMarkdown>);
    expect(screen.getByRole('heading', { name: 'Title' })).toBeTruthy();
    expect(screen.getByRole('table')).toBeTruthy();
    expect(screen.getByRole('columnheader', { name: 'A' })).toBeTruthy();
  });

  it('turns a NOTE blockquote into a labelled callout without its marker', () => {
    render(<GuideMarkdown>{'> [!WARNING]\n> Be careful.\n'}</GuideMarkdown>);
    const callout = screen.getByLabelText('Watch out');
    expect(callout.textContent).toContain('Be careful.');
    expect(callout.textContent).not.toContain('[!WARNING]');
  });

  it('leaves an ordinary blockquote alone', () => {
    render(<GuideMarkdown>{'> just a quote\n'}</GuideMarkdown>);
    expect(screen.queryByLabelText('Watch out')).toBeNull();
    expect(screen.getByText('just a quote')).toBeTruthy();
  });

  it('keeps app: and guide: links as real hrefs', () => {
    render(
      <GuideMarkdown>
        {'[open](app:/momentum/backtest) and [read](guide:start/limits)'}
      </GuideMarkdown>,
    );
    expect(screen.getByRole('link', { name: 'open' }).getAttribute('href')).toBe(
      '/momentum/backtest',
    );
    expect(screen.getByRole('link', { name: 'read' }).getAttribute('href')).toBe(
      '/guide/start/limits',
    );
  });

  it('links a glossary term to its Glossary entry', () => {
    render(<GuideMarkdown>{'a [drawdown](glossary:max-drawdown) here'}</GuideMarkdown>);
    expect(screen.getByRole('link', { name: 'drawdown' }).getAttribute('href')).toBe(
      '/guide/glossary/terms#term-max-drawdown',
    );
  });

  it('shows an unknown glossary term as plain text rather than a broken link', () => {
    render(<GuideMarkdown>{'a [thing](glossary:no-such-term) here'}</GuideMarkdown>);
    expect(screen.queryByRole('link', { name: 'thing' })).toBeNull();
    expect(screen.getByText(/thing/)).toBeTruthy();
  });

  it('opens web links in a new tab safely', () => {
    render(<GuideMarkdown>{'[nse](https://www.nseindia.com)'}</GuideMarkdown>);
    const link = screen.getByRole('link', { name: 'nse' });
    expect(link.getAttribute('target')).toBe('_blank');
    expect(link.getAttribute('rel')).toContain('noopener');
  });
});
