"""A finished backtest held in two parts (BL-005 Phase 2): `core`, what every view needs the
moment the run ends, and the heavy sections (trades, instruments, timeline, the weekly signal,
for Broad the circuit-lock card) that are built only when something asks for them.

A Broad result is ~1.7 MB, of which the sections are ~60%, and one of them (the circuit card)
costs a second engine run. The dashboard shows the core at once and fetches a section when its
card or tab opens. `full()` is everything, which is what the synchronous endpoint, the weekly job
and the golden tests have always got, so splitting a result never changes what it contains.
"""

from __future__ import annotations

import threading
from collections.abc import Callable


class RunParts:
    def __init__(self, core: dict, lazy: dict[str, Callable[[], object]], computed_at: str) -> None:
        self.core = core
        self.computed_at = computed_at
        self.names: tuple[str, ...] = tuple(lazy)
        # The builders hold the run's result and price frames. Each is dropped once built, so a
        # fully loaded run keeps only its values.
        self._builders = dict(lazy)
        self._values: dict[str, object] = {}
        self._locks = {name: threading.Lock() for name in lazy}

    def has(self, name: str) -> bool:
        return name in self._locks

    def section(self, name: str) -> object:
        """The section, built on first use. Two requests for the same one build it once."""
        with self._locks[name]:
            if name not in self._values:
                self._values[name] = self._builders[name]()
                del self._builders[name]
            return self._values[name]

    def full(self) -> dict:
        return {**self.core, **{name: self.section(name) for name in self.names}}
