"""The gap-and-go chain's registered rules (BL-164), shared with BL-165's leads.

BL-164's three specs and the definitions they share, exactly as registered; BL-165 builds its two
subsets from the same definitions. Imported by module name after a `sys.path` insert of this folder.
"""

from __future__ import annotations

# --- the definitions every spec shares (Phase 0 "Definitions fixed here") --------------------

COMMON = {
    # the gap: the 09:15 bar's open against the previous session's 15:15 close
    "p1515": {"prev_at": {"x": "close", "clock": "15:15"}},
    "gap": {"div": [{"sub": ["session_open", "p1515"]}, "p1515"]},
    "gap_up": {"gt": ["gap", 0]},
    "gap_down": {"lt": ["gap", 0]},
    # the opening range: highest / lowest 1-minute close 09:15-09:45, both included
    "or_hi": {"at": {"x": {"cum_max": {"x": "close"}}, "clock": "09:45"}},
    "or_lo": {"at": {"x": {"cum_min": {"x": "close"}}, "clock": "09:45"}},
    "or_w": {"sub": ["or_hi", "or_lo"]},
    "band_up": {"add": ["or_hi", {"mul": [0.1, "or_w"]}]},
    "band_down": {"sub": ["or_lo", {"mul": [0.1, "or_w"]}]},
    # band breaks on closes, 09:46-12:00 (the band is unknown before the 09:45 close)
    "morning": {"le": ["minute", {"clock": "12:00"}]},
    "break_up": {"all": [{"gt": ["close", "band_up"]}, "morning"]},
    "break_down": {"all": [{"lt": ["close", "band_down"]}, "morning"]},
    "first_up": {"first": "break_up"},
    "first_down": {"first": "break_down"},
    # "touched" the previous 15:15 close: a bar with low <= p1515 <= high at a stamp BEFORE this
    # one (ever ... and not its first stamp = its first stamp is earlier than this one)
    "touch": {"all": [{"le": ["low", "p1515"]}, {"ge": ["high", "p1515"]}]},
    "touched_before": {"all": [{"ever": "touch"}, {"not": {"first": "touch"}}]},
    # H1: the first break in the gap's direction, with no opposite break before it, unfilled
    "h1_up": {
        "all": ["gap_up", "first_up", {"not": {"ever": "break_down"}}, {"not": "touched_before"}]
    },
    "h1_down": {
        "all": ["gap_down", "first_down", {"not": {"ever": "break_up"}}, {"not": "touched_before"}]
    },
    "h1": {"any": ["h1_up", "h1_down"]},
    # the stand-down minute: opposite_first (the opposite band breaks before the gap's own band)
    # or filled (the gap's own first break, after a touch); never no_break
    "stand_down": {
        "any": [
            {"all": ["gap_up", "first_down", {"not": {"ever": "break_up"}}]},
            {"all": ["gap_down", "first_up", {"not": {"ever": "break_down"}}]},
            {
                "all": [
                    "gap_up",
                    "first_up",
                    {"not": {"ever": "break_down"}},
                    "touched_before",
                ]
            },
            {
                "all": [
                    "gap_down",
                    "first_down",
                    {"not": {"ever": "break_up"}},
                    "touched_before",
                ]
            },
        ]
    },
    # handed over: strictly after the stand-down minute
    "handed_over": {"all": [{"ever": "stand_down"}, {"not": {"first": "stand_down"}}]},
    # Williams: the gap under 0.2% or at least 0.5%; levels = today's open +/- 0.5 x R, R = the
    # previous session's highest minus lowest 1-minute close
    "gap_band": {"any": [{"lt": [{"abs": "gap"}, 0.002]}, {"ge": [{"abs": "gap"}, 0.005]}]},
    "prev_range": {
        "sub": [
            {"prev_agg": {"x": "close", "how": "max"}},
            {"prev_agg": {"x": "close", "how": "min"}},
        ]
    },
    "w_up": {"add": ["session_open", {"mul": [0.5, "prev_range"]}]},
    "w_down": {"sub": ["session_open", {"mul": [0.5, "prev_range"]}]},
    "beyond_w": {"any": [{"gt": ["close", "w_up"]}, {"lt": ["close", "w_down"]}]},
    "h2": {"all": ["handed_over", "gap_band", "beyond_w"]},
}

LEG = {
    "lots": 1,
    "position": "buy",
    "expiry": "weekly",
    "strike": {"strike_type": "ITM3"},  # 150 points at NIFTY's 50-point step
    "stop_loss": {"percent": 30},
    "trail_peak": {"activate_percent": 105, "exit_percent": 80},
    "stop_on": "close",
}
TEMPLATE = {
    "exit_time": "15:15",
    "legs": [
        {"id": "ce", "option_type": "CE", **LEG, "on": "up"},
        {"id": "pe", "option_type": "PE", **LEG, "on": "down"},
    ],
}

#: the trend-matched controls: a random minute or placebo day is used only where the index closed
#: beyond the trade's level the minute before it enters
CONTROL_H1 = {"up": {"gt": ["close", "band_up"]}, "down": {"lt": ["close", "band_down"]}}
CONTROL_H2 = {"up": {"gt": ["close", "w_up"]}, "down": {"lt": ["close", "w_down"]}}
CONTROL_H3 = {
    "up": {"any": [CONTROL_H1["up"], CONTROL_H2["up"]]},
    "down": {"any": [CONTROL_H1["down"], CONTROL_H2["down"]]},
}


def rule(rid: str, name: str, when: str, window: tuple[str, str], direction, control) -> dict:
    return {
        "id": rid,
        "name": name,
        "underlying": "NIFTY",
        "window": {"from": window[0], "to": window[1]},
        "define": COMMON,
        "when": when,
        "direction_up": direction,
        "control_when": control,
        "template": TEMPLATE,
        "notes": "BL-164, as published by OptionsBuyer.in; registered in the backlog item",
    }


def specs() -> list[dict]:
    """The three registered tests. H3's direction: the gap's on an H1 event, else which Williams
    level the close is beyond (an H2 event is never also an H1 one: after a stand-down H1 cannot
    fire, and H2 fires only after one)."""
    return [
        rule("bl164_h1_gap_and_go", "BL-164 H1 gap-and-go band", "h1", ("09:46", "12:00"),
             "gap_up", CONTROL_H1),
        rule("bl164_h2_williams", "BL-164 H2 Williams back-up", "h2", ("09:47", "14:29"),
             {"gt": ["close", "w_up"]}, CONTROL_H2),
        rule("bl164_h3_chain", "BL-164 H3 the chain", {"any": ["h1", "h2"]}, ("09:46", "14:29"),
             {"any": [{"all": ["h1", "gap_up"]},
                      {"all": [{"not": "h1"}, {"gt": ["close", "w_up"]}]}]},
             CONTROL_H3),
    ]  # fmt: skip
