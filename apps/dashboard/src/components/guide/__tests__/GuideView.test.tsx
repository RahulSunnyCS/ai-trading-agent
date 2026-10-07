// @vitest-environment happy-dom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let mockPathname = '/guide';
vi.mock('next/navigation', () => ({ usePathname: () => mockPathname }));

import { GuideLink } from '../GuideLink';
import { GuideView } from '../GuideView';

beforeEach(() => {
  window.scrollTo = vi.fn();
});
afterEach(() => {
  cleanup();
  window.history.replaceState(null, '', '/');
});

describe('GuideView', () => {
  it('shows the first page of a bare chapter and settles on its canonical path', async () => {
    mockPathname = '/guide/momentum';
    window.history.replaceState(null, '', mockPathname);
    render(<GuideView />);
    expect(
      screen.getByRole('heading', { name: 'How weekly momentum rotation works' }),
    ).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/guide/momentum/how-it-works'));
  });

  it('settles a bare /guide on the Welcome page', async () => {
    mockPathname = '/guide';
    window.history.replaceState(null, '', mockPathname);
    render(<GuideView />);
    expect(screen.getByRole('heading', { name: 'Welcome' })).toBeTruthy();
    await waitFor(() => expect(window.location.pathname).toBe('/guide/start/welcome'));
  });

  it('leaves an exact page path alone and offers its screen', () => {
    mockPathname = '/guide/momentum/journal';
    window.history.replaceState(null, '', mockPathname);
    render(<GuideView />);
    expect(window.location.pathname).toBe('/guide/momentum/journal');
    expect(screen.getByRole('link', { name: /Open this screen/ }).getAttribute('href')).toBe(
      '/momentum/journal',
    );
  });
});

describe('GuideLink', () => {
  it('links a screen to its guide page, using the most specific page', () => {
    render(<GuideLink tab="optionslab" rest={['builder', 'yaml']} />);
    expect(screen.getByRole('link').getAttribute('href')).toBe('/guide/optionslab/builder-yaml');
  });

  it('renders nothing for a screen with no guide page', () => {
    const { container } = render(<GuideLink tab="live" />);
    expect(container.innerHTML).toBe('');
  });
});
