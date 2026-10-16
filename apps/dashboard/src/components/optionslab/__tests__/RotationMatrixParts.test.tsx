// @vitest-environment happy-dom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';

import type { MatrixCell } from '../../../types/rotationMatrix';
import { CellReadout } from '../RotationMatrixParts';

afterEach(cleanup);

const cell = (sel: NonNullable<MatrixCell['sel']>): MatrixCell => ({
  v: 148,
  n: 9,
  nv: 9,
  sel,
  rec: 40,
});

describe('CellReadout', () => {
  it('has no "Picked" line when only hidden lists picked the cell', () => {
    render(<CellReadout rowLabel="r" colLabel="c" cell={cell({ A: 3, REF: 1 })} unit="inr" />);
    expect(screen.queryByText(/Picked/)).toBeNull();
    expect(document.body.textContent).not.toMatch(/Steady|Baseline|recorded strategy-days/);
  });

  it('names the shown list only, beside a hidden one that also picked', () => {
    render(<CellReadout rowLabel="r" colLabel="c" cell={cell({ A: 3, C: 2 })} unit="inr" />);
    const line = screen.getByText(/Picked:/);
    expect(line.textContent).toMatch(/Picked:\s*Adaptive 2×\s*of 40 recorded strategy-days/);
    expect(line.textContent).not.toMatch(/Steady/);
  });
});
