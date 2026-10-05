/**
 * The YAML mode's working state, kept for the browser session rather than in the
 * component: switching to the form, to another Options Lab section or to another tab
 * unmounts the view, and a result that cost a credit must still be there on return.
 * Nothing here is persisted to storage.
 */

import { create } from 'zustand';

import type { RunResult } from '../../../types/backtest';

export interface YamlDraftState {
  yaml: string;
  from: string;
  to: string;
  /** True once the user has set a date, so a coverage default no longer overwrites it. */
  datesTouched: boolean;
  /** The preset the editor was last filled from, with its text, to tell "edited" apart. */
  preset: { name: string; yaml: string } | null;
  /** The last finished run, with the window it was asked for. */
  result: { data: RunResult; from: string; to: string } | null;
  setYaml: (yaml: string) => void;
  loadPreset: (name: string, yaml: string) => void;
  setDates: (dates: { from?: string; to?: string }) => void;
  /** Fill the range from cached coverage unless the user has chosen dates. */
  defaultDates: (from: string, to: string) => void;
  setResult: (result: YamlDraftState['result']) => void;
}

export const useYamlDraft = create<YamlDraftState>((set) => ({
  yaml: '',
  from: '',
  to: '',
  datesTouched: false,
  preset: null,
  result: null,
  setYaml: (yaml) => set({ yaml }),
  loadPreset: (name, yaml) => set({ yaml, preset: { name, yaml } }),
  setDates: (dates) => set({ ...dates, datesTouched: true }),
  defaultDates: (from, to) =>
    set((state) =>
      state.datesTouched || (state.from === from && state.to === to) ? state : { from, to },
    ),
  setResult: (result) => set({ result }),
}));
