'use client';

import {
  FAVOURITE_STATUSES,
  MAX_FOLLOWED,
  STATUS_HINT,
  STATUS_LABEL,
  isFollowed,
} from '../../../lib/momentumFavourites';
import type { FavouriteStatus } from '../../../types/momentum';
import { RadioMenu } from '../../ui/RadioMenu';

/**
 * A saved strategy's favourite status (BL-051): Not a favourite, Watching, Paper or Invested.
 * Paper and Invested are refused at the cap (the server refuses them too); a group is always a
 * favourite.
 */
export function StrategyStatusMenu({
  name,
  status,
  isGroup,
  followed,
  atLimit,
  onChange,
}: {
  name: string;
  status: FavouriteStatus | null;
  isGroup: boolean;
  /** Paper + Invested across every dataset; null until known. */
  followed: number | null;
  atLimit: boolean;
  onChange: (status: FavouriteStatus | 'none') => void;
}) {
  return (
    <RadioMenu
      ariaLabel={`Favourite status of ${name}: ${status ? STATUS_LABEL[status] : 'not a favourite'}. Change it`}
      value={status ?? 'none'}
      valueLabel={status ? STATUS_LABEL[status] : 'Not a favourite'}
      heading="Favourite status"
      options={[
        {
          value: 'none',
          label: 'Not a favourite',
          disabled: isGroup,
          title: isGroup ? 'A group is always a favourite: remove the group instead.' : undefined,
        },
        ...FAVOURITE_STATUSES.map((value) => {
          const blocked = atLimit && isFollowed(value) && !isFollowed(status);
          return {
            value,
            label: STATUS_LABEL[value],
            disabled: blocked,
            title: blocked
              ? `${MAX_FOLLOWED} favourites are already Paper or Invested. Set one to Watching first.`
              : STATUS_HINT[value],
          };
        }),
      ]}
      footer={
        followed !== null
          ? `Paper + Invested: ${followed} of ${MAX_FOLLOWED}, across every dataset. Watching has no limit.`
          : undefined
      }
      onChange={(value) => onChange(value as FavouriteStatus | 'none')}
    />
  );
}
