from momentum_backtesting.categories import broad, wide_tags


def _k(sector, industry="", group="", sub=""):
    return (sector, industry, group, sub)


def _curated():
    # five curated pharma stocks in one category -> a clear majority for the BSE class
    return {
        "Healthcare :: Pharma": {"P1", "P2", "P3", "P4", "P5"},
        "Financials :: Banks": {"B1", "B2"},
    }


def _classes():
    pharma = _k("Healthcare", "Pharma", "Pharmaceuticals", "Pharmaceuticals")
    out = {f"P{i}": pharma for i in range(1, 6)}
    out.update(
        {
            "B1": _k("Financials", "Banks", "Banks", "Private Banks"),
            "B2": _k("Financials", "Banks", "Banks", "Private Banks"),
        }
    )
    out["NEWPHARMA"] = pharma  # joins the curated category
    # four small caps share a BSE class no curated stock has -> a new wider-universe category
    textile = _k("Textiles", "Textiles", "Fabrics", "Cotton Fabrics")
    out.update({f"T{i}": textile for i in range(1, 5)})
    # one lonely stock falls back to its coarser group
    out["LONE"] = _k("Textiles", "Textiles", "Fabrics", "Silk")
    return out


def test_joins_curated_category_when_class_is_a_clear_majority():
    rows = wide_tags.build_rows(_classes(), _curated(), {}, ["NEWPHARMA"])
    assert [(r["parent_group"], r["subgroup"], r["symbol"]) for r in rows] == [
        ("Healthcare", "Pharma", "NEWPHARMA")
    ]


def test_new_categories_use_the_finest_level_with_enough_members():
    rows = wide_tags.build_rows(_classes(), _curated(), {}, ["T1", "T2", "T3", "T4", "LONE"])
    by_symbol = {r["symbol"]: r["subgroup"] for r in rows}
    assert by_symbol["T1"] == "Cotton Fabrics" + wide_tags.WIDE_SUFFIX
    # LONE's sub-group has one stock, so it moves up to the shared industry group
    assert by_symbol["LONE"] == "Fabrics" + wide_tags.WIDE_SUFFIX
    assert {r["parent_group"] for r in rows} == {"Textiles"}


def test_curated_and_unclassified_symbols_are_left_alone():
    rows = wide_tags.build_rows(_classes(), _curated(), {}, ["P1", "NOCLASS"])
    assert rows == []


def test_extended_loader_merges_wide_file(tmp_path):
    (tmp_path / broad.STOCK_GROUPS_FILENAME).write_text(
        "parent_group,subgroup,symbol,company_name,note\nHealthcare,Pharma,P1,P One,x\n"
    )
    (tmp_path / broad.STOCK_GROUPS_WIDE_FILENAME).write_text(
        "parent_group,subgroup,symbol,company_name,note\n"
        "Healthcare,Pharma,NEWPHARMA,New,y\nTextiles,Fabrics (wider universe),T1,T,y\n"
    )
    plain = broad.load_stock_groups(tmp_path)
    wide = broad.load_stock_groups(tmp_path, extended=True)
    assert plain == {"Healthcare :: Pharma": {"P1"}}
    assert wide["Healthcare :: Pharma"] == {"P1", "NEWPHARMA"}
    assert wide["Textiles :: Fabrics (wider universe)"] == {"T1"}
    assert broad.load_stock_groups(tmp_path) is plain  # variants cached independently


def test_apply_merges_moves_rows_into_curated_or_new_wide_categories():
    rows = [
        {
            "parent_group": "Commodities",
            "subgroup": "Cement & Cement Products" + wide_tags.WIDE_SUFFIX,
            "symbol": "C1",
        },
        {
            "parent_group": "Commodities",
            "subgroup": "Petrochemicals" + wide_tags.WIDE_SUFFIX,
            "symbol": "P1",
        },
        {
            "parent_group": "Commodities",
            "subgroup": "Dyes And Pigments" + wide_tags.WIDE_SUFFIX,
            "symbol": "P2",
        },
        {
            "parent_group": "Unlisted",
            "subgroup": "Anything" + wide_tags.WIDE_SUFFIX,
            "symbol": "U1",
        },
    ]
    curated_ids = {"Construction Materials :: Cement"}
    out = {
        r["symbol"]: (r["parent_group"], r["subgroup"])
        for r in wide_tags.apply_merges(rows, curated_ids)
    }
    assert out["C1"] == ("Construction Materials", "Cement")  # into the curated category
    assert (
        out["P1"]
        == out["P2"]
        == ("Commodities", "Commodity Chemicals & Petrochemicals" + wide_tags.WIDE_SUFFIX)
    )
    assert out["U1"] == ("Unlisted", "Anything" + wide_tags.WIDE_SUFFIX)  # unlisted: unchanged


def test_apply_merges_rejects_a_target_missing_from_the_curated_file():
    import pytest

    rows = [
        {
            "parent_group": "Commodities",
            "subgroup": "Cement & Cement Products" + wide_tags.WIDE_SUFFIX,
            "symbol": "C1",
        }
    ]
    with pytest.raises(KeyError):
        wide_tags.apply_merges(rows, set())


def test_every_merge_target_is_a_real_curated_category():
    from pathlib import Path

    curated = broad.load_stock_groups(Path(broad.__file__).parent / "curated")
    for target in wide_tags.MERGES.values():
        if isinstance(target, str):
            assert target in curated, target
