"""research/common/trend_state.py (BL-221 / BL-222): the EMA state and its point-in-time shift."""
import sys
from pathlib import Path
from types import SimpleNamespace

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "research" / "common"))
from trend_state import ema_state, trend_states  # noqa: E402


def test_ema_state_follows_a_rise_and_a_fall():
    rising = ema_state([float(i) for i in range(100)], 20, 50)
    assert rising[-1] == 1.0
    falling = ema_state([float(100 - i) for i in range(100)], 20, 50)
    assert falling[-1] == -1.0


def test_session_state_uses_only_earlier_sessions():
    n = 80
    closes = np.linspace(100, 200, n)
    C = np.repeat(closes[:, None], 375, axis=1)
    frame = SimpleNamespace(days=[f"d{i}" for i in range(n)], C=C)
    st = trend_states(frame)
    assert st["hourly"]["d0"] == 0.0  # nothing earlier
    assert st["hourly"]["d79"] == 1.0
    # changing today's bars cannot change today's state
    C2 = C.copy()
    C2[79, :] = 1.0
    assert trend_states(SimpleNamespace(days=frame.days, C=C2))["hourly"]["d79"] == 1.0
