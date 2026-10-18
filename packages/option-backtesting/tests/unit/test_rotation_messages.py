"""The rotation Telegram messages (BL-125): exact text of the morning and evening layouts."""

from __future__ import annotations

from datetime import date

from option_backtesting.rotation import messages, tomorrow
from option_backtesting.rotation import result as rotation_result
from option_backtesting.rotation.result import DailyResult

DIR = ("SL21% · TSLnone · RECOST1 · MTMSL3000",)
WIDE = "SL115% · TSL15%/10% · REnone · MTMSL2500"
BUY = "SL25% · TSL1pt/1pt · RB09:17-09:27-high · MTMSL2000"


def _entry(day="2026-10-20", core=None, buy=(), track=None, **extra):
    core = core or ["N_p100_1202", "N_ditm1_0917", "N_wide_1117"]  # deliberately not in time order
    entry = {
        "day": day,
        "weekday": "Tue",
        "lists": {"C": {"core": core, "buy": list(buy)}},
        "hash": "f1a772478960abcd1111",
        "recorded_at": f"{day}T09:16:25+05:30",
        "before_first_entry": True,
        **extra,
    }
    if track:
        entry["track"] = track
    return entry


T1_CORE = ["N_ditm1-t1s36_0947", "N_p150-t1s11_0917", "N_p150-t1s11_1317"]

ADAPTIVE_NORMAL = f"""🎯 ADAPTIVE · Tue 20 Oct

1️⃣ 09:17  N_dir_ITM1
   {DIR[0]}
2️⃣ 11:17  N_widesl_OTM1
   {WIDE}
3️⃣ 12:02  N_widesl_p100
   {WIDE}"""

T1_NORMAL = """🧪 T1 · TESTING PHASE · not traded

1️⃣ 09:17  N_widesl_p150
   SL60% · TSL15%/10% · REnone · MTMSL4000
2️⃣ 09:47  N_dir_ITM1
   SL20% · TSL10%/5% · RECOST2 · MTMSL4000
3️⃣ 13:17  N_widesl_p150
   SL60% · TSL15%/10% · REnone · MTMSL4000"""


def test_the_morning_message_on_a_normal_day_is_adaptive_then_t1_with_one_hash():
    live = _entry()
    t1 = _entry(core=T1_CORE, track="t1", hash="aaaaaaaa22222222")
    private, group = messages.render_morning(live, None, t1)
    assert private == (f"{ADAPTIVE_NORMAL}\n\n━━━━━━━━━━━━━━━\n{T1_NORMAL}\n\n🔒 f1a77247 · 09:16")
    # the friends' group gets Adaptive alone, with the same witness
    assert group == f"{ADAPTIVE_NORMAL}\n\n🔒 f1a77247 · 09:16"
    assert "🧪" not in group and "T1" not in group.replace("RECOST1", "")


def test_the_expiry_rule_has_one_line_and_the_optional_line_names_the_next_best():
    live = _entry(expiry_only="NIFTY")
    options = {"C": {"wide": "N_wide_1317", "dir": "N_ditm1_0947"}}
    private, group = messages.render_morning(live, options, None)
    assert group.splitlines()[:3] == [
        "🎯 ADAPTIVE · Tue 20 Oct",
        "⚡ Expiry day · NIFTY only",
        "",
    ]
    assert private.count("Expiry day") == 1
    assert "➕ Optional: Widesl 13:17 N_widesl_OTM1 · Dir 09:47 N_dir_ITM1" in group
    # no rule, no line; no options, no optional line
    plain, _ = messages.render_morning(_entry(), None, None)
    assert "Expiry day" not in plain and "Optional" not in plain


def test_a_buy_pick_is_listed_with_its_settings_and_when_it_buys():
    live = _entry(buy=["N_buy_0917"])
    _, group = messages.render_morning(live, None, None)
    assert (
        "➕ Buy\n"
        "   09:17  N_buy_p50\n"
        f"   {BUY}\n"
        "   ⏳ buys only if the premium breaks the range high"
    ) in group


def test_a_late_entry_says_so_first():
    live = _entry(before_first_entry=False)
    private, group = messages.render_morning(live, None, None)
    assert private.splitlines()[0] == "⚠️ LATE · not a forward entry"
    assert group.splitlines()[0] == "⚠️ LATE · not a forward entry"
    # a late T1 is flagged inside its own block
    t1 = _entry(core=T1_CORE, track="t1", before_first_entry=False)
    private, group = messages.render_morning(_entry(), None, t1)
    assert "🧪 T1 · TESTING PHASE · not traded\n   ⚠️ LATE · not a forward entry\n" in private
    assert private.splitlines()[0] == "🎯 ADAPTIVE · Tue 20 Oct"
    assert "LATE" not in group
    # a late T1 message of its own says so once, as its first line
    own = messages.render_entry(t1)
    assert own.splitlines()[0] == "⚠️ LATE · not a forward entry"
    assert own.count("LATE") == 1


def test_when_t1_was_not_recorded_the_message_says_so_and_adaptive_is_unchanged():
    private, group = messages.render_morning(_entry(), None, None)
    assert private == (
        f"{ADAPTIVE_NORMAL}\n\n━━━━━━━━━━━━━━━\n"
        "🧪 T1 · TESTING PHASE · not recorded today\n\n🔒 f1a77247 · 09:16"
    )
    assert group == f"{ADAPTIVE_NORMAL}\n\n🔒 f1a77247 · 09:16"


def test_a_t1_entry_that_follows_on_its_own_uses_the_t1_layout_and_its_own_hash():
    t1 = _entry(core=T1_CORE, track="t1", hash="aaaaaaaa22222222", expiry_only="NIFTY")
    text = messages.render_entry(t1, {"C": {"wide": "N_wide_1117", "dir": "N_ditm1_0917"}})
    assert text.splitlines()[:3] == [
        "🧪 T1 · TESTING PHASE · not traded · Tue 20 Oct",
        "⚡ Expiry day · NIFTY only",
        "",
    ]
    assert text.endswith("\n\n🔒 aaaaaaaa · 09:16")
    assert "ADAPTIVE" not in text


def test_a_dry_run_has_no_hash_to_show():
    assert messages.footer({"hash": "(dry run)", "recorded_at": "2026-10-20T09:16:25+05:30"}) == (
        "🔒 dry run · 09:16"
    )


def test_a_strategy_with_no_file_is_shown_by_its_id_without_a_params_line():
    text = messages.render_entry(_entry(core=["N_wide_9999", "N_wide_1117", "N_ditm1_0917"]))
    assert "1️⃣ 09:17  N_dir_ITM1\n" in text
    assert "3️⃣ N_wide_9999" in text  # shown as given: no time, no params line
    assert text.count("MTMSL") == 2


def test_money_is_signed_with_a_real_minus():
    assert messages.rupees(1240) == "+₹1,240"
    assert messages.rupees(-460.4) == "−₹460"
    assert messages.rupees(0) == "₹0"
    assert messages.rupees(-0.2) == "₹0"


# -- evening ------------------------------------------------------------------------------------

A_ROWS = [("N_p100_1202", -460.0), ("N_ditm1_0917", 1200.0), ("N_wide_1117", 500.0)]
T1_ROWS = [("N_ditm1-t1s36_0947", -280.0), ("N_p150-t1s11_0917", -30.0)]


def _next(day=date(2026, 10, 21), core=None, buy=(), options=None, expiry_only=None):
    return tomorrow.NextPicks(
        day,
        day.strftime("%a"),
        core or ["N_wide_1117", "N_ditm1_0917", "N_p100_1202"],
        list(buy),
        options,
        expiry_only,
    )


def test_the_evening_message_for_a_normal_day():
    t1_next = _next(core=T1_CORE)
    text = messages.render_result(
        date(2026, 10, 20), (1240.0, A_ROWS), (-310.0, T1_ROWS), _next(), t1_next
    )
    assert (
        text
        == f"""📊 Tue 20 Oct · result
1 lot per strategy, after costs

🎯 Adaptive   +₹1,240
   09:17  N_dir_ITM1     +₹1,200
   11:17  N_widesl_OTM1    +₹500
   12:02  N_widesl_p100    −₹460

🧪 T1         −₹310
   09:17  N_widesl_p150   −₹30
   09:47  N_dir_ITM1     −₹280

➡️ Wed 21 Oct

🎯 Adaptive
1️⃣ 09:17  N_dir_ITM1
   {DIR[0]}
2️⃣ 11:17  N_widesl_OTM1
   {WIDE}
3️⃣ 12:02  N_widesl_p100
   {WIDE}
🧪 T1
1️⃣ 09:17  N_widesl_p150
   SL60% · TSL15%/10% · REnone · MTMSL4000
2️⃣ 09:47  N_dir_ITM1
   SL20% · TSL10%/5% · RECOST2 · MTMSL4000
3️⃣ 13:17  N_widesl_p150
   SL60% · TSL15%/10% · REnone · MTMSL4000"""
    )
    # none of the old explanations and tables is in it
    for gone in ("%)", "Win rate", "Probable changes", "forecast", "chain", "🔒", "Base"):
        assert gone not in text


def test_a_buy_row_is_in_the_result_and_in_the_total_and_tomorrow_lists_it_in_full():
    rows = [*A_ROWS, ("N_buy_0917", -100.0)]
    text = messages.render_result(
        date(2026, 10, 20),
        (1140.0, rows),
        None,
        _next(buy=["N_buy_0917"], options={"wide": "N_wide_1317", "dir": None}),
    )
    assert "🎯 Adaptive   +₹1,140" in text
    assert "➕ 09:17  N_buy_p50        −₹100" in text
    assert f"➕ Buy\n   09:17  N_buy_p50\n   {BUY}\n   ⏳ buys only if" in text
    assert "➕ Optional: Widesl 13:17 N_widesl_OTM1" in text
    assert "🧪" not in text  # the group's copy: Adaptive alone


def test_tomorrow_being_a_rule_day_is_one_short_line():
    text = messages.render_result(
        date(2026, 10, 16), (10.0, A_ROWS[:1]), None, _next(date(2026, 10, 19), expiry_only="NIFTY")
    )
    assert "➡️ Mon 19 Oct\n⚡ NIFTY only\n\n🎯 Adaptive\n1️⃣" in text
    assert "Expiry day" not in text
    plain = messages.render_result(date(2026, 10, 16), (10.0, A_ROWS[:1]), None, _next())
    assert "only" not in plain.replace("Adaptive", "")


def test_t1_that_is_not_ready_is_one_line_and_its_tomorrow_follows_suit():
    text = messages.render_result(
        date(2026, 10, 20),
        (1240.0, A_ROWS),
        "🧪 T1 · result not ready",
        _next(),
        "🧪 T1 · not ready",
    )
    assert "\n\n🧪 T1 · result not ready\n\n➡️ Wed 21 Oct" in text
    assert text.endswith("   " + WIDE + "\n🧪 T1 · not ready")


def test_no_tomorrow_means_no_section():
    text = messages.render_result(date(2026, 10, 20), (1240.0, A_ROWS), (-310.0, T1_ROWS))
    assert "➡️" not in text and text.rstrip().endswith("−₹280")


def test_the_t1_followup_is_a_message_of_its_own():
    done = DailyResult(date(2026, 10, 20), "Tue", {"C": -310.0}, "h", {"C": T1_ROWS}, track="t1")
    text = rotation_result.render_t1_followup(done, _next(core=T1_CORE))
    assert text.startswith("📊 Tue 20 Oct · T1 result\n1 lot per strategy, after costs\n\n🧪 T1 ")
    assert "Adaptive" not in text.split("➡️")[0]
    assert "➡️ Wed 21 Oct\n\n🧪 T1\n1️⃣ 09:17  N_widesl_p150" in text
