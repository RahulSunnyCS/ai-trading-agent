/**
 * The Rotation pages' slippage switch (display only): with it on, every paper figure the rotation
 * and correlation reads return is booked with each entry and exit filled `ROTATION_SLIPPAGE`
 * against the trade. The 09:16 picks are ranked without it, and three reads always answer
 * without it (`/rotation/explain`, `/rotation/ic`, `/rotation/live`): those hooks never call
 * `withSlippage`. Pure, so it is unit-tested; the setting itself is `store/rotationSlippage.ts`.
 */

import { formatPct } from './format';

/** The slippage the switch applies, as a fraction of each fill's price. */
export const ROTATION_SLIPPAGE = 0.005;

/** The value the API takes for it (`slippage=0.5`, in percent). */
export const SLIPPAGE_PARAM = '0.5';

/** "0.5%". */
export const SLIPPAGE_TEXT = formatPct(ROTATION_SLIPPAGE);

/** What the switch does, for its tooltip and the cards that sit next to it. */
export const SLIPPAGE_HELP = `With ${SLIPPAGE_TEXT} slippage on, every entry and exit is filled ${SLIPPAGE_TEXT} against the trade (a sell lower, a buy higher) in every paper figure on the Rotation pages. The 09:16 picks are ranked without it; it changes only what is shown.`;

/**
 * `url` with `slippage=0.5` added when the switch is on; unchanged when it is off (the API's
 * default is no slippage). The parameter is part of the URL, so a read cached by URL refetches
 * when the switch flips.
 */
export function withSlippage(url: string, on: boolean): string {
  if (!on) return url;
  const sep = url.includes('?') ? (url.endsWith('?') || url.endsWith('&') ? '' : '&') : '?';
  return `${url}${sep}slippage=${SLIPPAGE_PARAM}`;
}

/** "gross" or "gross after 0.5% slippage": the basis word in a figure's label. */
export function grossLabel(on: boolean): string {
  return on ? `gross after ${SLIPPAGE_TEXT} slippage` : 'gross';
}

/** The same, capitalised, to start a sentence. */
export function grossLabelSentence(on: boolean): string {
  const text = grossLabel(on);
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}`;
}

/** Why the ranking cards (`/rotation/explain`, `/rotation/ic`) show no slippage. */
export const RANKING_NO_SLIPPAGE = 'the picks are ranked without it';

/** Why Live vs paper shows no slippage. */
export const LIVE_NO_SLIPPAGE = 'the live result carries its own fills';

/** " Without the 0.5% slippage: <why>." for a card whose figures never carry it, shown only while
 * the switch is on (a leading space, to append to a sentence); "" when it is off. */
export function noSlippageNote(on: boolean, why: string): string {
  return on ? ` Without the ${SLIPPAGE_TEXT} slippage: ${why}.` : '';
}
