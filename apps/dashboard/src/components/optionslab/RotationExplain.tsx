'use client';

/**
 * Rotation › Explain row: "Why this pick?" beside "Does rank predict results?". Two cards side by
 * side on wide screens, stacked on narrow ones; one list switch drives both, so the breakdown and
 * the correlation always describe the same list.
 */

import { useState } from 'react';

import type { RotationListKey } from '../../types/rotationExplain';
import { RotationRankPredicts } from './RotationRankPredicts';
import { RotationWhyThisPick } from './RotationWhyThisPick';

export function RotationExplain({ initialList = 'A' }: { initialList?: RotationListKey }) {
  const [list, setList] = useState<RotationListKey>(initialList);
  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <RotationWhyThisPick list={list} onList={setList} />
      <RotationRankPredicts list={list} onList={setList} />
    </div>
  );
}
