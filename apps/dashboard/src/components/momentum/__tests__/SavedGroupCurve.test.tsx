// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import { SavedGroupCurve } from '../saved/SavedGroupCurve';

afterEach(cleanup);

const dates = ['2024-01-05', '2024-01-12', '2024-01-19'];

describe('SavedGroupCurve', () => {
  it('draws the group line and one faint line per sleeve, and says what it shows', () => {
    const { container } = render(
      <SavedGroupCurve
        name="Trio"
        dates={dates}
        blend={[100, 110, 121]}
        sleeves={[
          { name: 'Friday 1 of 2', values: [100, 112, 125] },
          { name: 'Friday 2 of 2', values: [100, 108, 117] },
        ]}
      />,
    );
    expect(container.querySelectorAll('path')).toHaveLength(3);
    expect(screen.getByRole('img').getAttribute('aria-label')).toContain('Trio');
    expect(screen.getByText(/All sleeves together/)).toBeTruthy();
  });

  it('draws nothing for a curve with fewer than two points', () => {
    const { container } = render(
      <SavedGroupCurve name="Trio" dates={['2024-01-05']} blend={[100]} sleeves={[]} />,
    );
    expect(container.firstChild).toBeNull();
  });
});
