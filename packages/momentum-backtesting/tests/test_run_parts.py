"""run_parts.RunParts (BL-005 Phase 2): a result held as its core plus sections built on demand."""

from __future__ import annotations

import threading

import pytest

from momentum_backtesting.run_parts import RunParts


def _parts(**builders):
    return RunParts({"kpis": {"cagr": 0.1}}, builders, "2026-10-06T12:00:00+05:30")


def test_sections_are_not_built_until_asked_for():
    built = []
    parts = _parts(trades=lambda: built.append("trades") or [1, 2])
    assert parts.names == ("trades",) and built == []
    assert parts.section("trades") == [1, 2]
    assert built == ["trades"]


def test_a_section_is_built_once_and_the_builder_is_released():
    calls = []
    parts = _parts(trades=lambda: calls.append(1) or ["row"])
    first, second = parts.section("trades"), parts.section("trades")
    assert first is second and calls == [1]
    assert parts._builders == {}  # the closure (and the result frames it holds) can be freed


def test_full_is_the_core_plus_every_section():
    parts = _parts(trades=lambda: [1], latest=lambda: {"rows": []})
    assert parts.full() == {"kpis": {"cagr": 0.1}, "trades": [1], "latest": {"rows": []}}


def test_a_builder_that_fails_can_be_asked_again():
    attempts = []

    def flaky():
        attempts.append(1)
        if len(attempts) == 1:
            raise RuntimeError("transient")
        return "ok"

    parts = _parts(trades=flaky)
    with pytest.raises(RuntimeError):
        parts.section("trades")
    assert parts.section("trades") == "ok"


def test_two_requests_for_the_same_section_build_it_once():
    started, release, calls = threading.Event(), threading.Event(), []

    def slow():
        calls.append(1)
        started.set()
        release.wait(5)
        return "value"

    parts = _parts(trades=slow)
    results: list[object] = []
    threads = [threading.Thread(target=lambda: results.append(parts.section("trades")))]
    threads[0].start()
    assert started.wait(5)
    threads.append(threading.Thread(target=lambda: results.append(parts.section("trades"))))
    threads[1].start()
    release.set()
    for thread in threads:
        thread.join(5)
    assert results == ["value", "value"] and calls == [1]


def test_release_gives_up_unbuilt_sections_and_keeps_built_ones():
    from momentum_backtesting.run_parts import SectionReleased

    parts = _parts(trades=lambda: [1], timeline=lambda: [2])
    assert parts.section("trades") == [1]
    assert parts.complete
    parts.release()
    assert not parts.complete
    assert parts.section("trades") == [1]  # built: it is only data now
    with pytest.raises(SectionReleased):
        parts.section("timeline")
    assert parts._builders == {}  # nothing left that holds the run's frames


def test_release_of_a_fully_built_run_leaves_it_complete():
    parts = _parts(trades=lambda: [1])
    parts.full()
    parts.release()
    assert parts.complete and parts.full()["trades"] == [1]


def test_unknown_sections_are_reported():
    parts = _parts(trades=lambda: [])
    assert parts.has("trades") and not parts.has("timeline")
