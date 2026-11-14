"""BL-226 Phase 1: the NSE F&O bhavcopy reader, both formats, with a fake HTTP opener (no network)."""

import io
import urllib.error
import zipfile
from datetime import date

import pyarrow.parquet as pq

from option_backtesting.nse import fo_bhavcopy as fb

OLD = """INSTRUMENT,SYMBOL,EXPIRY_DT,STRIKE_PR,OPTION_TYP,OPEN,HIGH,LOW,CLOSE,SETTLE_PR,CONTRACTS,VAL_INLAKH,OPEN_INT,CHG_IN_OI,TIMESTAMP,
FUTSTK,RELIANCE,25-Jul-2024,0,XX,3150,3200,3140,3187.35,3187.35,54084,427958.01,30303750,100,05-JUL-2024,
OPTSTK,RELIANCE,25-Jul-2024,2700,CE,458,497,455,496.35,496.35,12,94.96,38250,-250,05-JUL-2024,
"""
UDIFF_HEAD = (
    "TradDt,BizDt,Sgmt,Src,FinInstrmTp,FinInstrmId,ISIN,TckrSymb,SctySrs,XpryDt,FininstrmActlXpryDt,"
    "StrkPric,OptnTp,FinInstrmNm,OpnPric,HghPric,LwPric,ClsPric,LastPric,PrvsClsgPric,UndrlygPric,"
    "SttlmPric,OpnIntrst,ChngInOpnIntrst,TtlTradgVol,TtlTrfVal,TtlNbOfTxsExctd,SsnId,NewBrdLotQty,"
    "Rmks,Rsvd1,Rsvd2,Rsvd3,Rsvd4\n"
)
UDIFF = UDIFF_HEAD + (
    "2024-07-08,2024-07-08,FO,NSE,STF,1,,RELIANCE,,2024-07-25,2024-07-25,,,RELIANCE24JULFUT,"
    "3190,3210,3180,3200.5,3200,3187,3195.1,3200.5,30000000,-303750,50000,4.0e10,40000,F1,250,,,,,\n"
    "2024-07-08,2024-07-08,FO,NSE,STO,2,,RELIANCE,,2024-07-25,2024-07-25,3300.00,PE,RELIANCE24JUL3300PE,"
    "120,130,110,125.5,125,121,3195.1,126.0,50000,250,40,3.4e7,30,F1,250,,,,,\n"
)
BAN = "Securities in Ban For Trade Date 08-JUL-2024:\n1,ABFRL\n2,IDEA\n"
EMPTY_BAN = "Securities in Ban For Trade Date 05-JUL-2024:\n"


def _zip(name: str, text: str) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as z:
        z.writestr(name, text)
    return buf.getvalue()


def _opener(files: dict[str, bytes]):
    def open_(req, timeout):
        url = req.full_url
        if url in files:
            return files[url]
        raise urllib.error.HTTPError(url, 404, "Not Found", {}, None)

    return open_


def test_both_formats_parse_to_the_same_units():
    old = fb.parse_old(OLD, date(2024, 7, 5)).to_pylist()
    new = fb.parse_udiff(UDIFF, date(2024, 7, 8)).to_pylist()
    fut, opt = old
    assert fut["instrument"] == "FUTSTK" and fut["strike"] is None and fut["option_type"] is None
    assert fut["expiry"] == date(2024, 7, 25) and fut["contracts"] == 54084
    assert abs(fut["value_rs"] - 42795801000.0) < 1 and fut["oi"] == 30303750
    assert opt["strike"] == 2700.0 and opt["option_type"] == "CE" and opt["lot_size"] is None
    nfut, nopt = new
    assert nfut["instrument"] == "FUTSTK" and nfut["lot_size"] == 250 and nfut["contracts"] == 50000
    assert (
        nopt["instrument"] == "OPTSTK" and nopt["option_type"] == "PE" and nopt["settle"] == 126.0
    )
    assert nopt["underlying_price"] == 3195.1 and nopt["source_format"] == "udiff"


def test_ban_list_parses_with_and_without_names():
    assert fb.parse_ban(BAN) == ["ABFRL", "IDEA"]
    assert fb.parse_ban(EMPTY_BAN) == []


def test_fetch_stores_raw_lake_and_bans_and_resumes(tmp_path):
    d_old, d_new, d_hol = date(2024, 7, 5), date(2024, 7, 8), date(2024, 7, 4)
    files = {
        fb.old_url(d_old): _zip("fo05JUL2024bhav.csv", OLD),
        fb.udiff_url(d_new): _zip("x.csv", UDIFF),
        fb.ban_url(d_old): EMPTY_BAN.encode(),
        fb.ban_url(d_new): BAN.encode(),
    }
    http = fb.Http(min_interval_s=0, opener=_opener(files))
    out = fb.fetch(tmp_path, d_hol, d_new, http=http, today=date(2024, 8, 1), log=lambda _m: None)
    assert out["counts"]["ok"] == 2 and out["counts"]["missing"] == 1 and out["stopped"] is None
    assert fb.lake_days(tmp_path) == [d_old, d_new]
    assert pq.read_table(fb.lake_path(tmp_path, d_new)).num_rows == 2
    assert (
        fb.read_bans(tmp_path, d_new) == ["ABFRL", "IDEA"] and fb.read_bans(tmp_path, d_old) == []
    )
    assert (fb.raw_dir(tmp_path) / "2024" / "fo05JUL2024bhav.csv.zip").exists()
    again = fb.Http(min_interval_s=0, opener=_opener(files))
    out = fb.fetch(tmp_path, d_hol, d_new, http=again, today=date(2024, 8, 1), log=lambda _m: None)
    assert again.calls == 0 and out["counts"]["cached"] == 3


def test_a_recent_404_is_asked_again_and_a_server_error_stops(tmp_path):
    day = date(2024, 7, 8)
    http = fb.Http(min_interval_s=0, opener=_opener({}))
    fb.fetch(tmp_path, day, day, http=http, today=date(2024, 7, 9), log=lambda _m: None)
    again = fb.Http(min_interval_s=0, opener=_opener({}))
    fb.fetch(tmp_path, day, day, http=again, today=date(2024, 7, 9), log=lambda _m: None)
    assert again.calls == 2  # both formats asked again: the day is not old enough to call missing

    def broken(req, timeout):
        raise urllib.error.HTTPError(req.full_url, 503, "Unavailable", {}, None)

    http = fb.Http(min_interval_s=0, retries=0, opener=broken)
    out = fb.fetch(tmp_path, date(2024, 7, 10), date(2024, 7, 12), http=http,
                   today=date(2024, 8, 1), log=lambda _m: None)  # fmt: skip
    assert out["stopped"] and out["counts"]["error"] == 1 and http.calls == 1
