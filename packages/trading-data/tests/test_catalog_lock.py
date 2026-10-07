"""`connect()`'s in-process readers-writer lock (`db._CatalogLock`).

DuckDB 1.5.6 cannot open one file from two threads at once unless both are read-only: mixed
modes raise `ConnectionException: ... different configuration`, and two read-write
connections opening and closing together raise `BinderException: Unique file handle
conflict`. `mbt serve` hit both on 2026-10-07 (`GET /api/meta` waiting 8 s and more behind
the dashboard's saved-runs polling)."""

import threading
import time
from concurrent.futures import ThreadPoolExecutor

import duckdb
import pytest

from trading_data import db
from trading_data.db import CatalogBusy, connect


@pytest.fixture
def root(tmp_path):
    root = tmp_path / "data"
    with connect(root, views=()):
        pass  # create and migrate the catalog outside the concurrent part
    return root


@pytest.fixture
def clashes(monkeypatch):
    """Every DuckDB open that failed because another thread of this process had the file:
    `_open` retries those, so only counting them shows the lock is doing its job."""
    seen: list[str] = []
    real = duckdb.connect

    def counting(*args, **kwargs):
        try:
            return real(*args, **kwargs)
        except (duckdb.ConnectionException, duckdb.BinderException) as error:
            seen.append(str(error))
            raise

    monkeypatch.setattr(db.duckdb, "connect", counting)
    return seen


def test_mixed_concurrent_connections_never_clash(root, clashes):
    errors: list[Exception] = []
    state = {"writers": 0, "readers": 0, "overlap": False}
    guard = threading.Lock()

    def work(i: int) -> None:
        read_only = i % 3 != 0
        key = "readers" if read_only else "writers"
        try:
            # lock_wait: the queue is the point here, not how long it takes on a busy machine.
            with connect(root, read_only=read_only, lock_wait=120, views=()) as con:
                with guard:
                    state[key] += 1
                    if state["writers"] > 1 or (state["writers"] and state["readers"]):
                        state["overlap"] = True
                con.execute("SELECT count(*) FROM schema_migrations").fetchone()
                time.sleep(0.005)
                with guard:
                    state[key] -= 1
        except Exception as error:  # noqa: BLE001 - the point is that nothing raises
            errors.append(error)

    with ThreadPoolExecutor(8) as pool:
        list(pool.map(work, range(90)))
    assert errors == []
    assert clashes == []
    assert not state["overlap"], "a read-write connection was open alongside another"


def test_read_only_connections_share(root):
    """Two readers on two threads hold the catalog at the same time."""
    both_open = threading.Barrier(2, timeout=5)

    def reader() -> None:
        with connect(root, read_only=True, views=()):
            both_open.wait()

    threads = [threading.Thread(target=reader) for _ in range(2)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert not both_open.broken


def test_a_waiting_writer_goes_before_new_readers(root):
    """A polled read endpoint must not starve a save: once a writer waits, later readers
    queue behind it."""
    order: list[str] = []
    first_reader_in = threading.Event()
    release_first_reader = threading.Event()

    def first_reader() -> None:
        with connect(root, read_only=True, views=()):
            first_reader_in.set()
            release_first_reader.wait(5)
        order.append("reader 1 out")

    def writer() -> None:
        with connect(root, views=()):
            order.append("writer in")

    def late_reader() -> None:
        with connect(root, read_only=True, views=()):
            order.append("reader 2 in")

    t1 = threading.Thread(target=first_reader)
    t1.start()
    first_reader_in.wait(5)
    tw = threading.Thread(target=writer)
    tw.start()
    lock = db._catalog_lock(db.catalog_path(root))
    deadline = time.monotonic() + 5
    while not lock._writers_waiting and time.monotonic() < deadline:
        time.sleep(0.01)
    t2 = threading.Thread(target=late_reader)
    t2.start()
    time.sleep(0.2)
    assert order == []  # the late reader is held back by the waiting writer
    release_first_reader.set()
    for t in (t1, tw, t2):
        t.join(10)
    assert order == ["reader 1 out", "writer in", "reader 2 in"]


def test_nested_connections_of_the_same_mode_on_one_thread_do_not_deadlock(root):
    with connect(root, read_only=True, views=()), connect(root, read_only=True, views=()) as inner:
        assert inner.execute("SELECT 1").fetchone() == (1,)
    with connect(root, views=()), connect(root, views=()) as inner:
        assert inner.execute("SELECT 1").fetchone() == (1,)


def test_mixing_modes_on_one_thread_fails_at_once_instead_of_deadlocking(root):
    with connect(root, views=()), pytest.raises(RuntimeError, match="read-write"):
        connect(root, read_only=True, views=()).__enter__()
    with connect(root, read_only=True, views=()), pytest.raises(RuntimeError, match="read-only"):
        connect(root, views=()).__enter__()


def test_another_thread_holding_past_lock_wait_raises_catalog_busy(root):
    held = threading.Event()
    done = threading.Event()

    def holder() -> None:
        with connect(root, views=()):
            held.set()
            done.wait(5)

    t = threading.Thread(target=holder)
    t.start()
    held.wait(5)
    try:
        start = time.monotonic()
        with pytest.raises(CatalogBusy):
            connect(root, read_only=True, lock_wait=0.3, views=()).__enter__()
        assert time.monotonic() - start < 2
        assert issubclass(CatalogBusy, duckdb.IOException)  # callers' lock handling covers it
    finally:
        done.set()
        t.join()
    with connect(root, read_only=True, views=()):  # released: a reader gets straight in
        pass
