# Day-type strategy lists (BL-104, research leads — not adopted)

For every Core-298 family, for each of three time bands — **09:15–10:30** (09:17, 09:32, 09:47,
10:17), **10:30–13:00** (10:47, 11:32, 12:17, 13:02) and **13:00–15:30** (13:17, 13:47, 14:02,
14:32) — and for **all times** (one setting across all 12, beating the template at 9 or more of
them): **one setting per day type
that works across the band's entry times**, for **expiry days** and for
**non-expiry days** (each index's own weekly expiries). The premium families (NIFTY / SENSEX
Widesl, NIFTY / SENSEX Buy) also choose up to three premiums, each with its own setting.
Net ₹ per lot-day after charges, averaged over the band's entry times, 2024-10-09 → 2026-10-09;
the first year ends 2025-10-08.

How a row was chosen (registered in `backlog/BL-104-full-parameter-sweep.md` → Experiments,
day-type lists, Amendments 1–4): the default is the family's own rotation file (for N_wide, the
owner's settings: expiry SL 150 % / trail 25/15 / MTM ₹4,000 / RE cost ×1; other days SL 60 % /
trail 15/10 / MTM ₹3,000 / no re-entry). Settings are ranked on the **first year** (band means):
beat the default by ₹25 (expiry) or ₹15 (other days) a lot-day, beat the template at 3 of the band's
4 times (9 of 12 for all times), a worst day no more than 1.25 × the template's and at least two
grid neighbours that also beat it. The rank-1 setting is taken if it **also beats the template in
the second year** by at least half the margin (₹12.5 expiry, ₹7.5 other days) and at a majority of the
times (2 of 4; 7 of 12); otherwise rank 2, then rank 3, and no further (Amendments 10–11). A second pick is kept
only when its daily P&L correlates below 0.7 with the first.

The engine has no day filter: each file trades every day if run. The day type is in its folder
and in its name (`EXP` / `NONEXP`); one file per entry time carries the same setting.

- NIFTY_Widesl_premium expiry 09:15-10:30: premiums kept ₹100, ₹120, ₹80; best band gain by premium ₹40 -198, ₹60 -46, ₹80 +185, ₹90 +165, ₹100 +272, ₹110 +150, ₹120 +220, ₹135 +131, ₹150 +61, ₹180 -59
- NIFTY_Widesl_premium expiry 10:30-13:00: premiums kept ₹150, ₹180, ₹135; best band gain by premium ₹40 -30, ₹60 -56, ₹80 +183, ₹90 +201, ₹100 +101, ₹110 +237, ₹120 +380, ₹135 +388, ₹150 +501, ₹180 +420
- NIFTY_Widesl_premium expiry 13:00-15:30: premiums kept ₹90, ₹120, ₹110; best band gain by premium ₹40 +25, ₹60 +191, ₹80 +165, ₹90 +231, ₹100 +176, ₹110 +215, ₹120 +218, ₹135 +191, ₹150 +183, ₹180 +147
- NIFTY_Widesl_premium expiry all times: premiums kept ₹120, ₹150, ₹135; best band gain by premium ₹40 -150, ₹60 -34, ₹80 +96, ₹90 +125, ₹100 +116, ₹110 +124, ₹120 +172, ₹135 +142, ₹150 +168, ₹180 +104
- NIFTY_Widesl_premium non_expiry 09:15-10:30: premiums kept ₹150, ₹80, ₹60; best band gain by premium ₹40 +26, ₹60 +64, ₹80 +104, ₹90 +176, ₹100 +172, ₹110 +211, ₹120 +223, ₹135 +221, ₹150 +241, ₹180 +231
- NIFTY_Widesl_premium non_expiry 10:30-13:00: premiums kept ₹180, ₹110, ₹150; best band gain by premium ₹40 -55, ₹60 +11, ₹80 +68, ₹90 +82, ₹100 +97, ₹110 +120, ₹120 +115, ₹135 +109, ₹150 +116, ₹180 +144
- NIFTY_Widesl_premium non_expiry 13:00-15:30: premiums kept ₹120; best band gain by premium ₹40 -95, ₹60 -22, ₹80 +22, ₹90 +30, ₹100 +28, ₹110 +34, ₹120 +48, ₹135 +22, ₹150 +18, ₹180 +14
- NIFTY_Widesl_premium non_expiry all times: premiums kept ₹120, ₹40; best band gain by premium ₹40 -58, ₹60 -10, ₹80 +57, ₹90 +90, ₹100 +87, ₹110 +107, ₹120 +110, ₹135 +99, ₹150 +101, ₹180 +107
- NIFTY_Widesl_premium all_days 09:15-10:30: premiums kept ₹150, ₹80, ₹60; best band gain by premium ₹40 -30, ₹60 -9, ₹80 +44, ₹90 +97, ₹100 +115, ₹110 +147, ₹120 +144, ₹135 +139, ₹150 +147, ₹180 +96
- NIFTY_Widesl_premium all_days 10:30-13:00: premiums kept ₹180, ₹150, ₹120; best band gain by premium ₹40 -38, ₹60 -3, ₹80 +62, ₹90 +64, ₹100 +69, ₹110 +136, ₹120 +147, ₹135 +137, ₹150 +170, ₹180 +210
- NIFTY_Widesl_premium all_days 13:00-15:30: premiums kept ₹90, ₹120, ₹135; best band gain by premium ₹40 -95, ₹60 +8, ₹80 +26, ₹90 +51, ₹100 +38, ₹110 +51, ₹120 +49, ₹135 +36, ₹150 +26, ₹180 -13
- NIFTY_Widesl_premium all_days all times: premiums kept ₹110, ₹80, ₹60; best band gain by premium ₹40 -80, ₹60 -34, ₹80 +19, ₹90 +46, ₹100 +44, ₹110 +74, ₹120 +74, ₹135 +56, ₹150 +59, ₹180 +50
- SENSEX_Widesl_premium expiry 09:15-10:30: premiums kept ₹250, ₹200, ₹360; best band gain by premium ₹100 -95, ₹150 +154, ₹200 +321, ₹225 +362, ₹250 +390, ₹285 +372, ₹320 +326, ₹360 +185, ₹400 +181, ₹480 +125
- SENSEX_Widesl_premium expiry 10:30-13:00: premiums kept ₹480, ₹320, ₹360; best band gain by premium ₹100 +34, ₹150 +104, ₹200 +139, ₹225 +309, ₹250 +387, ₹285 +321, ₹320 +439, ₹360 +401, ₹400 +447, ₹480 +727
- SENSEX_Widesl_premium expiry 13:00-15:30: premiums kept ₹360, ₹200, ₹250; best band gain by premium ₹100 +244, ₹150 +230, ₹200 +267, ₹225 +189, ₹250 +262, ₹285 +269, ₹320 +236, ₹360 +294, ₹400 +279, ₹480 +65
- SENSEX_Widesl_premium expiry all times: premiums kept ₹250, ₹400, ₹200; best band gain by premium ₹100 +11, ₹150 +116, ₹200 +201, ₹225 +229, ₹250 +329, ₹285 +302, ₹320 +276, ₹360 +260, ₹400 +292, ₹480 +256
- SENSEX_Widesl_premium non_expiry 09:15-10:30: premiums kept ₹480, ₹250, ₹200; best band gain by premium ₹100 +126, ₹150 +148, ₹200 +180, ₹225 +170, ₹250 +187, ₹285 +178, ₹320 +165, ₹360 +172, ₹400 +182, ₹480 +229
- SENSEX_Widesl_premium non_expiry 10:30-13:00: premiums kept ₹480, ₹285, ₹320; best band gain by premium ₹100 +123, ₹150 +115, ₹200 +156, ₹225 +144, ₹250 +151, ₹285 +178, ₹320 +163, ₹360 +185, ₹400 +208, ₹480 +229
- SENSEX_Widesl_premium non_expiry 13:00-15:30: premiums kept ₹480, ₹285, ₹225; best band gain by premium ₹100 +8, ₹150 +15, ₹200 +34, ₹225 +33, ₹250 +28, ₹285 +48, ₹320 +52, ₹360 +47, ₹400 +51, ₹480 +63
- SENSEX_Widesl_premium non_expiry all times: premiums kept ₹480, ₹250, ₹100; best band gain by premium ₹100 +75, ₹150 +83, ₹200 +106, ₹225 +96, ₹250 +106, ₹285 +130, ₹320 +115, ₹360 +127, ₹400 +142, ₹480 +168
- SENSEX_Widesl_premium all_days 09:15-10:30: premiums kept ₹250, ₹480, ₹150; best band gain by premium ₹100 +74, ₹150 +142, ₹200 +193, ₹225 +196, ₹250 +209, ₹285 +206, ₹320 +158, ₹360 +151, ₹400 +163, ₹480 +181
- SENSEX_Widesl_premium all_days 10:30-13:00: premiums kept ₹480, ₹360, ₹320; best band gain by premium ₹100 +94, ₹150 +108, ₹200 +127, ₹225 +155, ₹250 +180, ₹285 +199, ₹320 +201, ₹360 +220, ₹400 +239, ₹480 +323
- SENSEX_Widesl_premium all_days 13:00-15:30: premiums kept ₹360, ₹225, ₹480; best band gain by premium ₹100 +39, ₹150 +45, ₹200 +58, ₹225 +61, ₹250 +70, ₹285 +86, ₹320 +86, ₹360 +96, ₹400 +96, ₹480 +54
- SENSEX_Widesl_premium all_days all times: premiums kept ₹480, ₹285, ₹150; best band gain by premium ₹100 +62, ₹150 +80, ₹200 +123, ₹225 +121, ₹250 +147, ₹285 +152, ₹320 +144, ₹360 +146, ₹400 +161, ₹480 +180
- NIFTY_Buy_premium expiry 09:15-10:30: premiums kept ₹30, ₹100, ₹50; best band gain by premium ₹20 +196, ₹25 +240, ₹30 +265, ₹40 +162, ₹50 +133, ₹60 +118, ₹75 +120, ₹90 +79, ₹100 +180, ₹125 +112
- NIFTY_Buy_premium expiry 10:30-13:00: premiums kept ₹125, ₹100, ₹90; best band gain by premium ₹20 +199, ₹25 +165, ₹30 +219, ₹40 +231, ₹50 +224, ₹60 +293, ₹75 +296, ₹90 +461, ₹100 +478, ₹125 +502
- NIFTY_Buy_premium expiry 13:00-15:30: premiums kept ₹25, ₹30, ₹50; best band gain by premium ₹20 +124, ₹25 +155, ₹30 +139, ₹40 +109, ₹50 +114, ₹60 +74, ₹75 +84, ₹90 +61, ₹100 +47, ₹125 +93
- NIFTY_Buy_premium expiry all times: premiums kept ₹125, ₹100, ₹30; best band gain by premium ₹20 +58, ₹25 +85, ₹30 +103, ₹40 +84, ₹50 +72, ₹60 +69, ₹75 +87, ₹90 +123, ₹100 +164, ₹125 +176
- NIFTY_Buy_premium non_expiry 09:15-10:30: premiums kept ₹125, ₹60, ₹50; best band gain by premium ₹20 -39, ₹25 -15, ₹30 -4, ₹40 +43, ₹50 +32, ₹60 +73, ₹75 +72, ₹90 +84, ₹100 +87, ₹125 +162
- NIFTY_Buy_premium non_expiry 10:30-13:00: premiums kept ₹125, ₹100, ₹50; best band gain by premium ₹20 +20, ₹25 +25, ₹30 +27, ₹40 +51, ₹50 +70, ₹60 +55, ₹75 +72, ₹90 +107, ₹100 +124, ₹125 +181
- NIFTY_Buy_premium non_expiry 13:00-15:30: premiums kept ₹90, ₹20; best band gain by premium ₹20 +78, ₹25 +83, ₹30 +86, ₹40 +90, ₹50 +91, ₹60 +103, ₹75 +120, ₹90 +128, ₹100 +109, ₹125 +99
- NIFTY_Buy_premium non_expiry all times: premiums kept ₹125, ₹40, ₹60; best band gain by premium ₹20 +11, ₹25 +19, ₹30 +30, ₹40 +38, ₹50 +33, ₹60 +34, ₹75 +50, ₹90 +80, ₹100 +77, ₹125 +116
- NIFTY_Buy_premium all_days 09:15-10:30: premiums kept ₹125, ₹100, ₹90; best band gain by premium ₹20 -50, ₹25 -8, ₹30 +15, ₹40 +40, ₹50 +8, ₹60 +38, ₹75 +45, ₹90 +66, ₹100 +74, ₹125 +138
- NIFTY_Buy_premium all_days 10:30-13:00: premiums kept ₹125, ₹75, ₹40; best band gain by premium ₹20 +59, ₹25 +55, ₹30 +55, ₹40 +79, ₹50 +75, ₹60 +76, ₹75 +93, ₹90 +138, ₹100 +162, ₹125 +245
- NIFTY_Buy_premium all_days 13:00-15:30: premiums kept ₹75, ₹25, ₹50; best band gain by premium ₹20 +77, ₹25 +86, ₹30 +84, ₹40 +77, ₹50 +84, ₹60 +75, ₹75 +89, ₹90 +81, ₹100 +72, ₹125 +71
- NIFTY_Buy_premium all_days all times: premiums kept ₹125, ₹90, ₹30; best band gain by premium ₹20 +18, ₹25 +32, ₹30 +40, ₹40 +34, ₹50 +27, ₹60 +24, ₹75 +34, ₹90 +61, ₹100 +64, ₹125 +102
- SENSEX_Buy_premium expiry 09:15-10:30: premiums kept ₹300, ₹120, ₹225; best band gain by premium ₹30 +85, ₹50 +165, ₹90 +367, ₹120 +631, ₹150 +615, ₹190 +624, ₹225 +611, ₹300 +686
- SENSEX_Buy_premium expiry 10:30-13:00: premiums kept ₹190, ₹300, ₹120; best band gain by premium ₹30 +52, ₹50 +69, ₹90 +226, ₹120 +340, ₹150 +480, ₹190 +587, ₹225 +465, ₹300 +582
- SENSEX_Buy_premium expiry 13:00-15:30: premiums kept ₹190, ₹150, ₹225; best band gain by premium ₹30 +72, ₹50 +83, ₹90 +220, ₹120 +247, ₹150 +292, ₹190 +307, ₹225 +251, ₹300 +199
- SENSEX_Buy_premium expiry all times: premiums kept ₹225, ₹50, ₹30; best band gain by premium ₹30 +8, ₹50 +80, ₹90 +217, ₹120 +290, ₹150 +378, ₹190 +382, ₹225 +422, ₹300 +402
- SENSEX_Buy_premium non_expiry 09:15-10:30: premiums kept ₹300, ₹225, ₹190; best band gain by premium ₹30 +2, ₹50 +19, ₹90 +86, ₹120 +120, ₹150 +138, ₹190 +182, ₹225 +211, ₹300 +250
- SENSEX_Buy_premium non_expiry 10:30-13:00: premiums kept ₹300, ₹190, ₹90; best band gain by premium ₹30 +27, ₹50 +47, ₹90 +77, ₹120 +132, ₹150 +175, ₹190 +211, ₹225 +250, ₹300 +306
- SENSEX_Buy_premium non_expiry 13:00-15:30: premiums kept ₹300, ₹50, ₹30; best band gain by premium ₹30 +39, ₹50 +43, ₹90 +68, ₹120 +82, ₹150 +94, ₹190 +99, ₹225 +117, ₹300 +123
- SENSEX_Buy_premium non_expiry all times: premiums kept ₹300, ₹190, ₹50; best band gain by premium ₹30 +20, ₹50 +33, ₹90 +64, ₹120 +101, ₹150 +124, ₹190 +145, ₹225 +169, ₹300 +195
- SENSEX_Buy_premium all_days 09:15-10:30: premiums kept ₹300, ₹225, ₹190; best band gain by premium ₹30 +4, ₹50 +45, ₹90 +118, ₹120 +210, ₹150 +219, ₹190 +250, ₹225 +271, ₹300 +318
- SENSEX_Buy_premium all_days 10:30-13:00: premiums kept ₹300, ₹225, ₹150; best band gain by premium ₹30 +17, ₹50 +28, ₹90 +61, ₹120 +99, ₹150 +157, ₹190 +192, ₹225 +225, ₹300 +258
- SENSEX_Buy_premium all_days 13:00-15:30: premiums kept ₹225, ₹50; best band gain by premium ₹30 +38, ₹50 +48, ₹90 +98, ₹120 +106, ₹150 +114, ₹190 +127, ₹225 +141, ₹300 +129
- SENSEX_Buy_premium all_days all times: premiums kept ₹300, ₹225, ₹90; best band gain by premium ₹30 +16, ₹50 +35, ₹90 +73, ₹120 +123, ₹150 +144, ₹190 +164, ₹225 +179, ₹300 +206

## Expiry days — 09:15-10:30

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 09:15-10:30 | chosen | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 120% | 25%/15% | ₹3,000 | none | none | 15:28 | 797 (956 / 631) | 782 (940 / 618) | +15 (+16 / +14) | 3/4 | 1.08 |
| NIFTY_Widesl_premium | 09:15-10:30 | chosen (1 premium) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹80 | — | 100% | 15%/10% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 829 (964 / 690) | 799 (920 / 672) | +31 (+43 / +17) | 3/4 | 1.12 |
| S_wide | 09:15-10:30 | chosen (2, low correlation) | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 150% | 25%/15% | ₹3,000 | none | none | 15:28 | 540 (865 / 215) | 407 (753 / 60) | +133 (+112 / +155) | 3/4 | 1.18 |
| S_wide (pick 2) | 09:15-10:30 | chosen (2, low correlation) | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 60% | 15%/10% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 469 (861 / 77) | 407 (753 / 60) | +62 (+108 / +17) | 3/4 | 0.87 |
| SENSEX_Widesl_premium | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹250 | — | 40% | 25%/15% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 821 (1127 / 514) | 537 (737 / 337) | +283 (+390 / +177) | 4/4 | 0.89 |
| SENSEX_Widesl_premium (pick 2) | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹200 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 838 (1058 / 619) | 537 (737 / 337) | +301 (+321 / +282) | 4/4 | 0.98 |
| SENSEX_Widesl_premium (pick 3) | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹360 | — | 40% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 715 (922 / 508) | 537 (737 / 337) | +178 (+185 / +171) | 3/4 | 1.11 |
| N_dir | 09:15-10:30 | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 40% | none | ₹3,000 | none | ASAP ×1, no cutoff | 15:28 | 817 (923 / 707) | 503 (462 / 546) | +314 (+461 / +161) | 4/4 | 1.11 |
| N_ditm1 | 09:15-10:30 | chosen | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 40% | none | ₹3,000 | none | ASAP ×1, no cutoff | 15:28 | 897 (918 / 876) | 616 (628 / 603) | +282 (+290 / +273) | 3/4 | 0.99 |
| S_dir | 09:15-10:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 20% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 723 (1082 / 364) | 544 (833 / 256) | +179 (+249 / +108) | 4/4 | 1.14 |
| S_ditm1 | 09:15-10:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 40% | 10%/5% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 936 (1286 / 586) | 749 (1064 / 434) | +187 (+222 / +152) | 2/4 | 0.93 |
| NIFTY_Buy_premium | 09:15-10:30 | chosen (1 premium) | NIFTY | Buy (range breakout) | closest premium ₹100 | 10 min after entry on instrument, high side, gap 0% | 20% | 1/1 pts | ₹1,000 | 50% | none | 15:14 | 15 (161 / -136) | -93 (70 / -263) | +108 (+91 / +127) | 4/4 | 0.87 |
| SENSEX_Buy_premium | 09:15-10:30 | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -7 (26 / -40) | -7 (26 / -40) | +0 (+0 / +0) | 0/4 | 1.0 |

Gain by entry time (expiry days — 09:15-10:30):

- N_wide 09:15-10:30 pick 1: 09:17 -73, 09:32 +55, 09:47 +51, 10:17 +28
- NIFTY_Widesl_premium 09:15-10:30 pick 1: 09:17 +18, 09:32 +234, 09:47 -191, 10:17 +62
- S_wide 09:15-10:30 pick 1: 09:17 +50, 09:32 +340, 09:47 +175, 10:17 -33
- S_wide 09:15-10:30 pick 2: 09:17 -285, 09:32 +200, 09:47 +270, 10:17 +64
- SENSEX_Widesl_premium 09:15-10:30 pick 1: 09:17 +272, 09:32 +38, 09:47 +328, 10:17 +495
- SENSEX_Widesl_premium 09:15-10:30 pick 2: 09:17 +178, 09:32 +46, 09:47 +210, 10:17 +771
- SENSEX_Widesl_premium 09:15-10:30 pick 3: 09:17 +347, 09:32 -290, 09:47 +145, 10:17 +510
- N_dir 09:15-10:30 pick 1: 09:17 +324, 09:32 +134, 09:47 +235, 10:17 +562
- N_ditm1 09:15-10:30 pick 1: 09:17 +223, 09:32 -47, 09:47 +446, 10:17 +505
- S_dir 09:15-10:30 pick 1: 09:17 +211, 09:32 +165, 09:47 +180, 10:17 +159
- S_ditm1 09:15-10:30 pick 1: 09:17 -160, 09:32 +601, 09:47 +339, 10:17 -33
- NIFTY_Buy_premium 09:15-10:30 pick 1: 09:17 +191, 09:32 +24, 09:47 +126, 10:17 +93
- SENSEX_Buy_premium 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0

## Expiry days — 10:30-13:00

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 10:30-13:00 | default (owner setting) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 150% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 333 (212 / 458) | 290 (113 / 474) | +43 (+98 / -15) | 2/4 | 1.41 |
| NIFTY_Widesl_premium | 10:30-13:00 | default (template) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹80 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 479 (330 / 633) | 479 (330 / 633) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_wide | 10:30-13:00 | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 60% | 25%/15% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 523 (692 / 355) | 291 (373 / 209) | +233 (+319 / +146) | 4/4 | 0.98 |
| SENSEX_Widesl_premium | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹480 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 1043 (1322 / 765) | 497 (595 / 399) | +546 (+727 / +366) | 4/4 | 1.2 |
| SENSEX_Widesl_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹320 | — | 40% | none | ₹4,000 | none | none | 15:28 | 738 (991 / 486) | 497 (595 / 399) | +241 (+396 / +87) | 3/4 | 1.1 |
| SENSEX_Widesl_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹360 | — | 40% | 25%/15% | ₹4,000 | none | none | 15:28 | 743 (997 / 490) | 497 (595 / 399) | +246 (+401 / +92) | 3/4 | 0.98 |
| N_dir | 10:30-13:00 | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 30% | 10%/5% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 419 (409 / 430) | 345 (280 / 413) | +74 (+128 / +17) | 3/4 | 1.0 |
| N_ditm1 | 10:30-13:00 | default (template) | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 404 (297 / 514) | 404 (297 / 514) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_dir | 10:30-13:00 | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 25% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 665 (954 / 376) | 563 (834 / 293) | +102 (+119 / +84) | 3/4 | 0.94 |
| S_ditm1 | 10:30-13:00 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 25% | none | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 799 (1060 / 539) | 728 (958 / 498) | +71 (+102 / +41) | 4/4 | 1.25 |
| NIFTY_Buy_premium | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹125 | 10 min after entry on instrument, high side, gap 0% | 30% | 3/1 pts | ₹1,000 | 100% | none | 15:14 | 122 (364 / -131) | -200 (-95 / -308) | +321 (+460 / +177) | 4/4 | 0.87 |
| NIFTY_Buy_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹100 | 15 min after entry on instrument, high side, gap 0% | 40% | 1/1 pts | ₹2,000 | 100% | none | 15:14 | 41 (361 / -291) | -200 (-95 / -308) | +241 (+457 / +17) | 4/4 | 1.08 |
| NIFTY_Buy_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹90 | 15 min after entry on underlying, high side, gap 0% | 40% | 3/1 pts | ₹2,000 | none | none | 15:14 | 102 (354 / -160) | -200 (-95 / -308) | +302 (+450 / +148) | 4/4 | 1.17 |
| SENSEX_Buy_premium | 10:30-13:00 | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -4 (4 / -13) | -4 (4 / -13) | +0 (+0 / +0) | 0/4 | 1.0 |

Gain by entry time (expiry days — 10:30-13:00):

- N_wide 10:30-13:00 pick 1: 10:47 -163, 11:32 +264, 12:17 -110, 13:02 +180
- NIFTY_Widesl_premium 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0
- S_wide 10:30-13:00 pick 1: 10:47 +287, 11:32 +379, 12:17 +183, 13:02 +81
- SENSEX_Widesl_premium 10:30-13:00 pick 1: 10:47 +564, 11:32 +1005, 12:17 +289, 13:02 +327
- SENSEX_Widesl_premium 10:30-13:00 pick 2: 10:47 -154, 11:32 +688, 12:17 +269, 13:02 +162
- SENSEX_Widesl_premium 10:30-13:00 pick 3: 10:47 -66, 11:32 +780, 12:17 +6, 13:02 +266
- N_dir 10:30-13:00 pick 1: 10:47 -100, 11:32 +201, 12:17 +173, 13:02 +21
- N_ditm1 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0
- S_dir 10:30-13:00 pick 1: 10:47 +291, 11:32 +73, 12:17 -26, 13:02 +69
- S_ditm1 10:30-13:00 pick 1: 10:47 +107, 11:32 +7, 12:17 +98, 13:02 +73
- NIFTY_Buy_premium 10:30-13:00 pick 1: 10:47 +18, 11:32 +318, 12:17 +504, 13:02 +445
- NIFTY_Buy_premium 10:30-13:00 pick 2: 10:47 +137, 11:32 +157, 12:17 +458, 13:02 +212
- NIFTY_Buy_premium 10:30-13:00 pick 3: 10:47 +610, 11:32 +377, 12:17 +138, 13:02 +83
- SENSEX_Buy_premium 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0

## Expiry days — 13:00-15:30

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 13:00-15:30 | default (owner setting) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 150% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 147 (108 / 187) | 100 (33 / 169) | +47 (+75 / +18) | 2/4 | 1.77 |
| NIFTY_Widesl_premium | 13:00-15:30 | default (template) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹80 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 228 (141 / 317) | 228 (141 / 317) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_wide | 13:00-15:30 | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 120% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 372 (425 / 319) | 297 (366 / 228) | +75 (+58 / +91) | 3/4 | 1.04 |
| SENSEX_Widesl_premium | 13:00-15:30 | chosen (2 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹360 | — | 40% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 541 (620 / 463) | 349 (326 / 372) | +192 (+294 / +91) | 3/4 | 1.17 |
| SENSEX_Widesl_premium (pick 2) | 13:00-15:30 | chosen (2 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹250 | — | 40% | 15%/10% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 500 (588 / 412) | 349 (326 / 372) | +151 (+262 / +40) | 3/4 | 0.82 |
| N_dir | 13:00-15:30 | default (template) | NIFTY | Directional (short straddle, tight SL) | ATM | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | -62 (108 / -238) | -62 (108 / -238) | +0 (+0 / +0) | 0/4 | 1.0 |
| N_ditm1 | 13:00-15:30 | chosen | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 20% | none | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 65 (341 / -222) | -8 (216 / -240) | +73 (+125 / +18) | 4/4 | 1.04 |
| S_dir | 13:00-15:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 30% | none | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 347 (541 / 154) | 193 (324 / 62) | +155 (+217 / +92) | 4/4 | 1.09 |
| S_ditm1 | 13:00-15:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 25% | none | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 443 (564 / 323) | 297 (439 / 154) | +147 (+125 / +169) | 3/4 | 1.19 |
| NIFTY_Buy_premium | 13:00-15:30 | default (template) | NIFTY | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -124 (-66 / -185) | -124 (-66 / -185) | +0 (+0 / +0) | 0/4 | 1.0 |
| SENSEX_Buy_premium | 13:00-15:30 | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | 2 (-18 / 22) | 2 (-18 / 22) | +0 (+0 / +0) | 0/4 | 1.0 |

Gain by entry time (expiry days — 13:00-15:30):

- N_wide 13:00-15:30 pick 1: 13:17 -14, 13:47 -63, 14:02 +211, 14:32 +55
- NIFTY_Widesl_premium 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- S_wide 13:00-15:30 pick 1: 13:17 +85, 13:47 +202, 14:02 +34, 14:32 -21
- SENSEX_Widesl_premium 13:00-15:30 pick 1: 13:17 +269, 13:47 +29, 14:02 -41, 14:32 +511
- SENSEX_Widesl_premium 13:00-15:30 pick 2: 13:17 +272, 13:47 -2, 14:02 +62, 14:32 +272
- N_dir 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- N_ditm1 13:00-15:30 pick 1: 13:17 +2, 13:47 +44, 14:02 +127, 14:32 +118
- S_dir 13:00-15:30 pick 1: 13:17 +196, 13:47 +63, 14:02 +161, 14:32 +198
- S_ditm1 13:00-15:30 pick 1: 13:17 +259, 13:47 -7, 14:02 +65, 14:32 +270
- NIFTY_Buy_premium 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- SENSEX_Buy_premium 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0

## Expiry days — all times

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | all times | default (owner setting) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 150% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 447 (384 / 513) | 390 (362 / 420) | +57 (+22 / +93) | 7/12 | 1.56 |
| NIFTY_Widesl_premium | all times | default (template) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹100 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 502 (464 / 541) | 502 (464 / 541) | +0 (+0 / +0) | 0/12 | 1.0 |
| S_wide | all times | default (template) | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | CE 114% / PE 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 332 (497 / 166) | 332 (497 / 166) | +0 (+0 / +0) | 0/12 | 1.0 |
| SENSEX_Widesl_premium | all times | chosen (2 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹250 | — | 40% | 25%/15% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 671 (882 / 461) | 461 (553 / 369) | +210 (+329 / +92) | 11/12 | 0.87 |
| SENSEX_Widesl_premium (pick 2) | all times | chosen (2 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹400 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 608 (811 / 404) | 461 (553 / 369) | +146 (+258 / +35) | 8/12 | 1.23 |
| N_dir | all times | default (template) | NIFTY | Directional (short straddle, tight SL) | ATM | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 262 (283 / 240) | 262 (283 / 240) | +0 (+0 / +0) | 0/12 | 1.0 |
| N_ditm1 | all times | default (template) | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 337 (380 / 292) | 337 (380 / 292) | +0 (+0 / +0) | 0/12 | 1.0 |
| S_dir | all times | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 25% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 533 (801 / 265) | 434 (664 / 203) | +100 (+138 / +62) | 9/12 | 1.11 |
| S_ditm1 | all times | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 25% | 10%/5% | ₹3,000 | none | COST ×2, no cutoff | 15:28 | 670 (870 / 469) | 591 (821 / 362) | +78 (+50 / +106) | 8/12 | 0.98 |
| NIFTY_Buy_premium | all times | chosen (1 premium) | NIFTY | Buy (range breakout) | closest premium ₹30 | 30 min after entry on instrument, high side, gap 0% | 30% | none | ₹1,000 | 100% | none | 15:14 | -49 (52 / -153) | -139 (-30 / -252) | +90 (+82 / +99) | 8/12 | 0.72 |
| SENSEX_Buy_premium | all times | chosen (1 premium) | SENSEX | Buy (range breakout) | closest premium ₹50 | 30 min after entry on instrument, high side, gap 0% | 20% | 3/3 pts | ₹2,000 | none | none | 15:14 | 33 (48 / 18) | -3 (4 / -10) | +36 (+44 / +28) | 9/12 | 1.17 |

Gain by entry time (expiry days — all times):

- N_wide all times pick 1: 09:17 +278, 09:32 +67, 09:47 +2, 10:17 -27, 10:47 -163, 11:32 +264, 12:17 -110, 13:02 +180, 13:17 -14, 13:47 -63, 14:02 +211, 14:32 +55
- NIFTY_Widesl_premium all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- S_wide all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- SENSEX_Widesl_premium all times pick 1: 09:17 +272, 09:32 +38, 09:47 +328, 10:17 +495, 10:47 +34, 11:32 +535, 12:17 +65, 13:02 +120, 13:17 +150, 13:47 -20, 14:02 +161, 14:32 +344
- SENSEX_Widesl_premium all times pick 2: 09:17 +281, 09:32 -450, 09:47 +1, 10:17 +400, 10:47 +205, 11:32 +630, 12:17 -90, 13:02 +205, 13:17 +310, 13:47 -57, 14:02 -51, 14:32 +372
- N_dir all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- N_ditm1 all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- S_dir all times pick 1: 09:17 -21, 09:32 +233, 09:47 +390, 10:17 -3, 10:47 +162, 11:32 +39, 12:17 +151, 13:02 +19, 13:17 +122, 13:47 +27, 14:02 -28, 14:32 +104
- S_ditm1 all times pick 1: 09:17 -55, 09:32 +288, 09:47 +229, 10:17 -155, 10:47 -207, 11:32 +88, 12:17 +7, 13:02 +244, 13:17 +331, 13:47 +47, 14:02 -99, 14:32 +220
- NIFTY_Buy_premium all times pick 1: 09:17 -28, 09:32 -93, 09:47 +12, 10:17 +254, 10:47 +69, 11:32 +229, 12:17 +217, 13:02 +180, 13:17 -143, 13:47 +261, 14:02 +161, 14:32 -36
- SENSEX_Buy_premium all times pick 1: 09:17 -20, 09:32 +51, 09:47 +112, 10:17 +63, 10:47 -125, 11:32 +23, 12:17 +89, 13:02 +70, 13:17 +121, 13:47 -90, 14:02 +124, 14:32 +14

## Non-expiry days — 09:15-10:30

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 09:15-10:30 | default (owner setting) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 60% | 15%/10% | ₹3,000 | none | none | 15:28 | 73 (108 / 38) | 15 (129 / -101) | +58 (-21 / +140) | 4/4 | 0.94 |
| NIFTY_Widesl_premium | 09:15-10:30 | chosen (2 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹80 | — | 60% | 15%/10% | ₹2,000 | none | COST ×1, no cutoff | 15:10 | 31 (83 / -21) | -60 (-22 / -100) | +91 (+104 / +78) | 3/4 | 0.75 |
| NIFTY_Widesl_premium (pick 2) | 09:15-10:30 | chosen (2 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹60 | — | 80% | 15%/10% | ₹2,000 | none | COST ×1, no cutoff | 15:10 | 5 (43 / -34) | -60 (-22 / -100) | +65 (+64 / +66) | 3/4 | 0.66 |
| S_wide | 09:15-10:30 | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 51 (94 / 7) | -42 (-70 / -14) | +94 (+164 / +21) | 3/4 | 1.1 |
| SENSEX_Widesl_premium | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹480 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 135 (114 / 158) | -70 (-115 / -23) | +205 (+229 / +181) | 3/4 | 1.14 |
| SENSEX_Widesl_premium (pick 2) | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹250 | — | 60% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 92 (72 / 112) | -70 (-115 / -23) | +162 (+187 / +135) | 4/4 | 1.1 |
| SENSEX_Widesl_premium (pick 3) | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹200 | — | 40% | none | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 43 (65 / 19) | -70 (-115 / -23) | +112 (+180 / +42) | 4/4 | 1.04 |
| N_dir | 09:15-10:30 | default (template) | NIFTY | Directional (short straddle, tight SL) | ATM | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 38 (114 / -40) | 38 (114 / -40) | +0 (+0 / +0) | 0/4 | 1.0 |
| N_ditm1 | 09:15-10:30 | default (template) | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 43 (87 / -2) | 43 (87 / -2) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_dir | 09:15-10:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 20% | 10%/5% | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 288 (240 / 337) | 175 (126 / 225) | +113 (+114 / +112) | 4/4 | 1.02 |
| S_ditm1 | 09:15-10:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 10% | 10%/5% | ₹2,000 | none | COST ×2, no cutoff | 15:28 | 324 (357 / 289) | 200 (139 / 262) | +124 (+218 / +27) | 3/4 | 0.77 |
| NIFTY_Buy_premium | 09:15-10:30 | chosen (2 premiums) | NIFTY | Buy (range breakout) | closest premium ₹125 | 10 min after entry on instrument, high side, gap 0% | 20% | 1/1 pts | ₹1,000 | 100% | none | 15:14 | 97 (196 / -5) | 24 (78 / -31) | +73 (+119 / +25) | 4/4 | 1.02 |
| NIFTY_Buy_premium (pick 2) | 09:15-10:30 | chosen (2 premiums) | NIFTY | Buy (range breakout) | closest premium ₹60 | 10 min after entry on instrument, high side, gap 0% | 30% | 1/1 pts | ₹1,000 | none | none | 15:14 | 69 (151 / -15) | 24 (78 / -31) | +45 (+73 / +15) | 4/4 | 0.75 |
| SENSEX_Buy_premium | 09:15-10:30 | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -43 (-28 / -58) | -43 (-28 / -58) | +0 (+0 / +0) | 0/4 | 1.0 |

Gain by entry time (non-expiry days — 09:15-10:30):

- N_wide 09:15-10:30 pick 1: 09:17 +4, 09:32 +77, 09:47 +131, 10:17 +21
- NIFTY_Widesl_premium 09:15-10:30 pick 1: 09:17 +106, 09:32 +91, 09:47 +171, 10:17 -2
- NIFTY_Widesl_premium 09:15-10:30 pick 2: 09:17 -3, 09:32 +25, 09:47 +175, 10:17 +63
- S_wide 09:15-10:30 pick 1: 09:17 -37, 09:32 +37, 09:47 +248, 10:17 +127
- SENSEX_Widesl_premium 09:15-10:30 pick 1: 09:17 -15, 09:32 +262, 09:47 +373, 10:17 +202
- SENSEX_Widesl_premium 09:15-10:30 pick 2: 09:17 +107, 09:32 +134, 09:47 +258, 10:17 +147
- SENSEX_Widesl_premium 09:15-10:30 pick 3: 09:17 +55, 09:32 +11, 09:47 +266, 10:17 +118
- N_dir 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0
- N_ditm1 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0
- S_dir 09:15-10:30 pick 1: 09:17 +98, 09:32 +117, 09:47 +158, 10:17 +79
- S_ditm1 09:15-10:30 pick 1: 09:17 +282, 09:32 +221, 09:47 +4, 10:17 -11
- NIFTY_Buy_premium 09:15-10:30 pick 1: 09:17 +45, 09:32 +39, 09:47 +142, 10:17 +64
- NIFTY_Buy_premium 09:15-10:30 pick 2: 09:17 +15, 09:32 +62, 09:47 +50, 10:17 +52
- SENSEX_Buy_premium 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0

## Non-expiry days — 10:30-13:00

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 10:30-13:00 | default (owner setting) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 60% | 15%/10% | ₹3,000 | none | none | 15:28 | 136 (244 / 26) | 52 (130 / -28) | +85 (+114 / +54) | 4/4 | 0.92 |
| NIFTY_Widesl_premium | 10:30-13:00 | chosen (3 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹180 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 71 (224 / -85) | -6 (103 / -117) | +77 (+121 / +32) | 2/4 | 1.22 |
| NIFTY_Widesl_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹110 | — | 40% | none | ₹3,000 | none | none | 15:10 | 101 (223 / -24) | -6 (103 / -117) | +106 (+120 / +93) | 3/4 | 1.05 |
| NIFTY_Widesl_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹150 | — | 40% | 15%/10% | ₹3,000 | none | none | 15:10 | 47 (200 / -109) | -6 (103 / -117) | +53 (+97 / +8) | 3/4 | 1.1 |
| S_wide | 10:30-13:00 | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 40% | 25%/15% | ₹3,000 | none | none | 15:10 | 59 (94 / 22) | -128 (-133 / -123) | +187 (+228 / +145) | 4/4 | 0.89 |
| SENSEX_Widesl_premium | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹480 | — | 40% | 25%/15% | ₹3,000 | none | none | 15:10 | 69 (49 / 90) | -125 (-155 / -93) | +194 (+204 / +184) | 4/4 | 1.04 |
| SENSEX_Widesl_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹285 | — | 40% | 25%/15% | ₹3,000 | none | none | 15:10 | 60 (23 / 98) | -125 (-155 / -93) | +184 (+178 / +191) | 4/4 | 1.02 |
| SENSEX_Widesl_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹320 | — | 40% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 57 (8 / 107) | -125 (-155 / -93) | +181 (+163 / +200) | 4/4 | 1.21 |
| N_dir | 10:30-13:00 | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 25% | 10%/5% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 223 (280 / 165) | 191 (236 / 145) | +32 (+43 / +20) | 2/4 | 1.14 |
| N_ditm1 | 10:30-13:00 | default (template) | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 241 (264 / 218) | 241 (264 / 218) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_dir | 10:30-13:00 | default (template) | SENSEX | Directional (short straddle, tight SL) | ATM | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 88 (10 / 170) | 88 (10 / 170) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_ditm1 | 10:30-13:00 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 15% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 248 (171 / 328) | 117 (43 / 193) | +131 (+127 / +135) | 3/4 | 1.21 |
| NIFTY_Buy_premium | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹125 | 10 min after entry on instrument, high side, gap 0% | 20% | none | ₹1,000 | none | none | 15:14 | 84 (97 / 71) | -24 (-37 / -10) | +108 (+134 / +81) | 3/4 | 1.25 |
| NIFTY_Buy_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹100 | 10 min after entry on instrument, high side, gap 0% | 30% | none | ₹1,000 | none | none | 15:14 | 70 (87 / 54) | -24 (-37 / -10) | +94 (+124 / +64) | 3/4 | 1.07 |
| NIFTY_Buy_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹50 | 30 min after entry on instrument, high side, gap 0% | 30% | 1/1 pts | ₹2,000 | none | none | 15:14 | 4 (5 / 3) | -24 (-37 / -10) | +28 (+42 / +13) | 3/4 | 1.24 |
| SENSEX_Buy_premium | 10:30-13:00 | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -68 (-84 / -51) | -68 (-84 / -51) | +0 (+0 / +0) | 0/4 | 1.0 |

Gain by entry time (non-expiry days — 10:30-13:00):

- N_wide 10:30-13:00 pick 1: 10:47 +93, 11:32 +159, 12:17 +52, 13:02 +34
- NIFTY_Widesl_premium 10:30-13:00 pick 1: 10:47 +115, 11:32 +244, 12:17 -17, 13:02 -36
- NIFTY_Widesl_premium 10:30-13:00 pick 2: 10:47 +117, 11:32 +274, 12:17 +69, 13:02 -34
- NIFTY_Widesl_premium 10:30-13:00 pick 3: 10:47 +101, 11:32 +101, 12:17 +32, 13:02 -23
- S_wide 10:30-13:00 pick 1: 10:47 +212, 11:32 +374, 12:17 +128, 13:02 +34
- SENSEX_Widesl_premium 10:30-13:00 pick 1: 10:47 +187, 11:32 +432, 12:17 +106, 13:02 +50
- SENSEX_Widesl_premium 10:30-13:00 pick 2: 10:47 +140, 11:32 +412, 12:17 +107, 13:02 +79
- SENSEX_Widesl_premium 10:30-13:00 pick 3: 10:47 +167, 11:32 +390, 12:17 +111, 13:02 +58
- N_dir 10:30-13:00 pick 1: 10:47 +96, 11:32 -53, 12:17 +91, 13:02 -6
- N_ditm1 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0
- S_dir 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0
- S_ditm1 10:30-13:00 pick 1: 10:47 +267, 11:32 +132, 12:17 +137, 13:02 -12
- NIFTY_Buy_premium 10:30-13:00 pick 1: 10:47 +196, 11:32 +102, 12:17 -83, 13:02 +216
- NIFTY_Buy_premium 10:30-13:00 pick 2: 10:47 +150, 11:32 +145, 12:17 -69, 13:02 +150
- NIFTY_Buy_premium 10:30-13:00 pick 3: 10:47 +26, 11:32 -26, 12:17 +56, 13:02 +54
- SENSEX_Buy_premium 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0

## Non-expiry days — 13:00-15:30

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 13:00-15:30 | chosen | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 150% | none | ₹3,000 | none | none | 15:28 | 115 (163 / 66) | 96 (140 / 51) | +19 (+23 / +15) | 3/4 | 1.05 |
| NIFTY_Widesl_premium | 13:00-15:30 | default (template) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹80 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 78 (110 / 44) | 78 (110 / 44) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_wide | 13:00-15:30 | default (template) | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | CE 114% / PE 115% | 15%/10% | ₹2,500 | none | none | 15:28 | -57 (-36 / -78) | -57 (-36 / -78) | +0 (+0 / +0) | 0/4 | 1.0 |
| SENSEX_Widesl_premium | 13:00-15:30 | default (template) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹320 | — | CE 114% / PE 115% | 15%/10% | ₹2,500 | none | none | 15:28 | -15 (-32 / 1) | -15 (-32 / 1) | +0 (+0 / +0) | 0/4 | 1.0 |
| N_dir | 13:00-15:30 | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 25% | 10%/5% | ₹2,000 | none | ASAP ×1, no cutoff | 15:28 | 115 (181 / 47) | 74 (124 / 22) | +41 (+56 / +25) | 4/4 | 0.83 |
| N_ditm1 | 13:00-15:30 | chosen | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 25% | none | ₹3,000 | none | ASAP ×1, no cutoff | 15:28 | 141 (180 / 101) | 93 (132 / 52) | +48 (+48 / +49) | 3/4 | 0.94 |
| S_dir | 13:00-15:30 | default (template) | SENSEX | Directional (short straddle, tight SL) | ATM | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | -34 (-34 / -33) | -34 (-34 / -33) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_ditm1 | 13:00-15:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 15% | 10%/5% | ₹4,000 | none | ASAP ×1, no cutoff | 15:28 | 17 (62 / -29) | -24 (-8 / -40) | +41 (+71 / +11) | 3/4 | 1.07 |
| NIFTY_Buy_premium | 13:00-15:30 | chosen (1 premium) | NIFTY | Buy (range breakout) | closest premium ₹20 | 30 min after entry on instrument, high side, gap 0% | 40% | 3/1 pts | ₹1,000 | none | none | 15:14 | -27 (10 / -64) | -86 (-69 / -104) | +59 (+78 / +40) | 3/4 | 0.55 |
| SENSEX_Buy_premium | 13:00-15:30 | chosen (2 premiums) | SENSEX | Buy (range breakout) | closest premium ₹50 | 30 min after entry on instrument, high side, gap 0% | 20% | none | ₹2,000 | none | none | 15:14 | -34 (-36 / -32) | -76 (-78 / -73) | +42 (+43 / +41) | 4/4 | 1.21 |
| SENSEX_Buy_premium (pick 2) | 13:00-15:30 | chosen (2 premiums) | SENSEX | Buy (range breakout) | closest premium ₹30 | 30 min after entry on instrument, high side, gap 0% | 30% | 9/3 pts | ₹2,000 | 50% | none | 15:14 | -44 (-39 / -50) | -76 (-78 / -73) | +32 (+39 / +24) | 4/4 | 0.94 |

Gain by entry time (non-expiry days — 13:00-15:30):

- N_wide 13:00-15:30 pick 1: 13:17 +56, 13:47 +5, 14:02 -18, 14:32 +32
- NIFTY_Widesl_premium 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- S_wide 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- SENSEX_Widesl_premium 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- N_dir 13:00-15:30 pick 1: 13:17 +7, 13:47 +85, 14:02 +20, 14:32 +52
- N_ditm1 13:00-15:30 pick 1: 13:17 -8, 13:47 +104, 14:02 +68, 14:32 +29
- S_dir 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- S_ditm1 13:00-15:30 pick 1: 13:17 +85, 13:47 +12, 14:02 +78, 14:32 -9
- NIFTY_Buy_premium 13:00-15:30 pick 1: 13:17 +114, 13:47 -2, 14:02 +45, 14:32 +79
- SENSEX_Buy_premium 13:00-15:30 pick 1: 13:17 +59, 13:47 +21, 14:02 +39, 14:32 +49
- SENSEX_Buy_premium 13:00-15:30 pick 2: 13:17 +35, 13:47 +12, 14:02 +33, 14:32 +47

## Non-expiry days — all times

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | all times | default (owner setting) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 60% | 15%/10% | ₹3,000 | none | none | 15:28 | 102 (164 / 39) | 54 (133 / -26) | +48 (+31 / +65) | 9/12 | 0.97 |
| NIFTY_Widesl_premium | all times | default (template) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹100 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 4 (64 / -57) | 4 (64 / -57) | +0 (+0 / +0) | 0/12 | 1.0 |
| S_wide | all times | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 22 (61 / -17) | -76 (-80 / -72) | +98 (+141 / +54) | 10/12 | 1.17 |
| SENSEX_Widesl_premium | all times | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹480 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 74 (67 / 82) | -70 (-101 / -38) | +144 (+168 / +120) | 10/12 | 1.23 |
| SENSEX_Widesl_premium (pick 2) | all times | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹250 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 27 (6 / 50) | -70 (-101 / -38) | +97 (+106 / +88) | 9/12 | 1.04 |
| SENSEX_Widesl_premium (pick 3) | all times | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹100 | — | 60% | none | ₹2,000 | none | none | 15:10 | -5 (-26 / 16) | -70 (-101 / -38) | +65 (+75 / +54) | 10/12 | 0.63 |
| N_dir | all times | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 25% | 10%/5% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 130 (194 / 66) | 101 (158 / 42) | +30 (+36 / +24) | 6/12 | 1.2 |
| N_ditm1 | all times | chosen | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 20% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 166 (223 / 107) | 126 (161 / 90) | +40 (+62 / +18) | 9/12 | 1.2 |
| S_dir | all times | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 15% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 135 (108 / 164) | 77 (34 / 121) | +59 (+74 / +43) | 9/12 | 1.17 |
| S_ditm1 | all times | default (template) | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 98 (58 / 138) | 98 (58 / 138) | +0 (+0 / +0) | 0/12 | 1.0 |
| NIFTY_Buy_premium | all times | chosen (2 premiums) | NIFTY | Buy (range breakout) | closest premium ₹125 | 10 min after entry on instrument, high side, gap 0% | 20% | 1/1 pts | ₹1,000 | none | none | 15:14 | 5 (19 / -9) | -29 (-9 / -48) | +34 (+29 / +39) | 10/12 | 1.05 |
| NIFTY_Buy_premium (pick 2) | all times | chosen (2 premiums) | NIFTY | Buy (range breakout) | closest premium ₹40 | 30 min after entry on instrument, high side, gap 0% | 30% | 1/1 pts | ₹2,000 | none | none | 15:14 | 14 (29 / -1) | -29 (-9 / -48) | +43 (+38 / +48) | 10/12 | 1.02 |
| SENSEX_Buy_premium | all times | chosen (1 premium) | SENSEX | Buy (range breakout) | closest premium ₹50 | 30 min after entry on instrument, high side, gap 0% | 30% | 3/3 pts | ₹1,000 | none | none | 15:14 | -35 (-37 / -33) | -62 (-64 / -61) | +27 (+26 / +28) | 12/12 | 1.19 |

Gain by entry time (non-expiry days — all times):

- N_wide all times pick 1: 09:17 +4, 09:32 +77, 09:47 +131, 10:17 +21, 10:47 +93, 11:32 +159, 12:17 +52, 13:02 +34, 13:17 -1, 13:47 -1, 14:02 -12, 14:32 +20
- NIFTY_Widesl_premium all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- S_wide all times pick 1: 09:17 -37, 09:32 +37, 09:47 +248, 10:17 +127, 10:47 +189, 11:32 +390, 12:17 +131, 13:02 +25, 13:17 +24, 13:47 +13, 14:02 +61, 14:32 -26
- SENSEX_Widesl_premium all times pick 1: 09:17 -15, 09:32 +262, 09:47 +373, 10:17 +202, 10:47 +175, 11:32 +477, 12:17 +144, 13:02 +60, 13:17 +55, 13:47 +1, 14:02 +74, 14:32 -74
- SENSEX_Widesl_premium all times pick 2: 09:17 -21, 09:32 +57, 09:47 +331, 10:17 +168, 10:47 +143, 11:32 +339, 12:17 +88, 13:02 +27, 13:17 -10, 13:47 +7, 14:02 +87, 14:32 -48
- SENSEX_Widesl_premium all times pick 3: 09:17 +4, 09:32 +58, 09:47 +171, 10:17 +113, 10:47 +85, 11:32 +256, 12:17 +87, 13:02 +25, 13:17 +12, 13:47 -8, 14:02 +20, 14:32 -44
- N_dir all times pick 1: 09:17 -13, 09:32 +146, 09:47 -5, 10:17 +66, 10:47 +96, 11:32 -53, 12:17 +91, 13:02 -6, 13:17 -1, 13:47 +44, 14:02 -31, 14:32 +23
- N_ditm1 all times pick 1: 09:17 +90, 09:32 +171, 09:47 +129, 10:17 +2, 10:47 -76, 11:32 +127, 12:17 +78, 13:02 +17, 13:17 -54, 13:47 +16, 14:02 +19, 14:32 -38
- S_dir all times pick 1: 09:17 +38, 09:32 +94, 09:47 +79, 10:17 +117, 10:47 +230, 11:32 +121, 12:17 +34, 13:02 -41, 13:17 -11, 13:47 -25, 14:02 +34, 14:32 +36
- S_ditm1 all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- NIFTY_Buy_premium all times pick 1: 09:17 +44, 09:32 +36, 09:47 +133, 10:17 +54, 10:47 +24, 11:32 +3, 12:17 -45, 13:02 +96, 13:17 +96, 13:47 +38, 14:02 -74, 14:32 +4
- NIFTY_Buy_premium all times pick 2: 09:17 +47, 09:32 +143, 09:47 +8, 10:17 +36, 10:47 +11, 11:32 -29, 12:17 +62, 13:02 +33, 13:17 +105, 13:47 -25, 14:02 +39, 14:32 +83
- SENSEX_Buy_premium all times pick 1: 09:17 +16, 09:32 +28, 09:47 +16, 10:17 +31, 10:47 +50, 11:32 +41, 12:17 +27, 13:02 +16, 13:17 +19, 13:47 +3, 14:02 +32, 14:32 +46

## All days — 09:15-10:30

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 09:15-10:30 | default (template) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 178 (303 / 51) | 178 (303 / 51) | +0 (+0 / +0) | 0/4 | 1.0 |
| NIFTY_Widesl_premium | 09:15-10:30 | chosen (1 premium) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹80 | — | 100% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 173 (233 / 111) | 123 (188 / 56) | +50 (+44 / +55) | 4/4 | 1.22 |
| S_wide | 09:15-10:30 | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 148 (252 / 42) | 53 (103 / 2) | +95 (+149 / +40) | 3/4 | 1.05 |
| SENSEX_Widesl_premium | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹250 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 211 (274 / 146) | 53 (65 / 40) | +158 (+209 / +106) | 4/4 | 0.95 |
| SENSEX_Widesl_premium (pick 2) | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹480 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 249 (246 / 251) | 53 (65 / 40) | +196 (+181 / +211) | 4/4 | 1.21 |
| SENSEX_Widesl_premium (pick 3) | 09:15-10:30 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹150 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 156 (207 / 104) | 53 (65 / 40) | +103 (+142 / +64) | 3/4 | 0.83 |
| N_dir | 09:15-10:30 | default (template) | NIFTY | Directional (short straddle, tight SL) | ATM | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 137 (188 / 84) | 137 (188 / 84) | +0 (+0 / +0) | 0/4 | 1.0 |
| N_ditm1 | 09:15-10:30 | default (template) | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 165 (203 / 126) | 165 (203 / 126) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_dir | 09:15-10:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 20% | 10%/5% | ₹3,000 | none | COST ×2, no cutoff | 15:28 | 360 (394 / 326) | 254 (275 / 232) | +107 (+119 / +94) | 4/4 | 1.04 |
| S_ditm1 | 09:15-10:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 20% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 399 (464 / 332) | 317 (334 / 299) | +82 (+130 / +33) | 3/4 | 1.24 |
| NIFTY_Buy_premium | 09:15-10:30 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹125 | 10 min after entry on instrument, high side, gap 0% | 20% | 1/1 pts | ₹1,000 | 100% | none | 15:14 | 55 (176 / -69) | -1 (76 / -80) | +56 (+100 / +11) | 4/4 | 0.97 |
| NIFTY_Buy_premium (pick 2) | 09:15-10:30 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹100 | 10 min after entry on instrument, high side, gap 0% | 30% | 1/1 pts | ₹1,000 | 100% | none | 15:14 | 53 (108 / -4) | -1 (76 / -80) | +53 (+32 / +76) | 4/4 | 1.01 |
| NIFTY_Buy_premium (pick 3) | 09:15-10:30 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹90 | 10 min after entry on instrument, high side, gap 0% | 30% | 1/1 pts | ₹1,000 | 100% | none | 15:14 | 38 (112 / -38) | -1 (76 / -80) | +38 (+36 / +41) | 4/4 | 0.96 |
| SENSEX_Buy_premium | 09:15-10:30 | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -35 (-17 / -54) | -35 (-17 / -54) | +0 (+0 / +0) | 0/4 | 1.0 |

Gain by entry time (all days — 09:15-10:30):

- N_wide 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0
- NIFTY_Widesl_premium 09:15-10:30 pick 1: 09:17 +16, 09:32 +60, 09:47 +50, 10:17 +73
- S_wide 09:15-10:30 pick 1: 09:17 -48, 09:32 +21, 09:47 +300, 10:17 +107
- SENSEX_Widesl_premium 09:15-10:30 pick 1: 09:17 +25, 09:32 +42, 09:47 +321, 10:17 +244
- SENSEX_Widesl_premium 09:15-10:30 pick 2: 09:17 +77, 09:32 +117, 09:47 +288, 10:17 +301
- SENSEX_Widesl_premium 09:15-10:30 pick 3: 09:17 +34, 09:32 -41, 09:47 +197, 10:17 +222
- N_dir 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0
- N_ditm1 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0
- S_dir 09:15-10:30 pick 1: 09:17 +57, 09:32 +124, 09:47 +131, 10:17 +116
- S_ditm1 09:15-10:30 pick 1: 09:17 -42, 09:32 +162, 09:47 +146, 10:17 +63
- NIFTY_Buy_premium 09:15-10:30 pick 1: 09:17 +51, 09:32 +16, 09:47 +115, 10:17 +43
- NIFTY_Buy_premium 09:15-10:30 pick 2: 09:17 +11, 09:32 +15, 09:47 +43, 10:17 +146
- NIFTY_Buy_premium 09:15-10:30 pick 3: 09:17 +34, 09:32 +5, 09:47 +19, 10:17 +96
- SENSEX_Buy_premium 09:15-10:30 pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0

## All days — 10:30-13:00

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 10:30-13:00 | default (template) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 102 (126 / 78) | 102 (126 / 78) | +0 (+0 / +0) | 0/4 | 1.0 |
| NIFTY_Widesl_premium | 10:30-13:00 | chosen (3 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹180 | — | 40% | 15%/10% | ₹4,000 | none | none | 15:28 | 233 (310 / 153) | 90 (120 / 59) | +143 (+190 / +94) | 3/4 | 1.04 |
| NIFTY_Widesl_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹150 | — | 40% | 15%/10% | ₹4,000 | none | none | 15:28 | 195 (288 / 100) | 90 (120 / 59) | +105 (+168 / +41) | 3/4 | 1.08 |
| NIFTY_Widesl_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹120 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 199 (267 / 130) | 90 (120 / 59) | +109 (+147 / +71) | 3/4 | 1.05 |
| S_wide | 10:30-13:00 | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 40% | none | ₹3,000 | none | COST ×1, no cutoff | 15:10 | 111 (168 / 53) | -39 (-27 / -51) | +150 (+195 / +105) | 4/4 | 0.94 |
| SENSEX_Widesl_premium | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹480 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 266 (313 / 218) | -16 (-10 / -21) | +281 (+323 / +239) | 4/4 | 1.0 |
| SENSEX_Widesl_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹360 | — | 40% | 25%/15% | ₹4,000 | none | none | 15:10 | 188 (210 / 166) | -16 (-10 / -21) | +204 (+220 / +187) | 4/4 | 0.97 |
| SENSEX_Widesl_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹320 | — | 40% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 200 (192 / 209) | -16 (-10 / -21) | +216 (+201 / +231) | 4/4 | 1.02 |
| N_dir | 10:30-13:00 | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 30% | 10%/5% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 276 (301 / 251) | 224 (246 / 202) | +52 (+55 / +49) | 3/4 | 1.12 |
| N_ditm1 | 10:30-13:00 | chosen | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 20% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 319 (339 / 299) | 276 (271 / 281) | +43 (+68 / +18) | 2/4 | 1.02 |
| S_dir | 10:30-13:00 | default (template) | SENSEX | Directional (short straddle, tight SL) | ATM | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 190 (183 / 196) | 190 (183 / 196) | +0 (+0 / +0) | 0/4 | 1.0 |
| S_ditm1 | 10:30-13:00 | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 15% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 347 (320 / 375) | 247 (236 / 259) | +100 (+85 / +116) | 3/4 | 1.15 |
| NIFTY_Buy_premium | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹125 | 10 min after entry on instrument, high side, gap 0% | 40% | 1/1 pts | ₹2,000 | 100% | none | 15:14 | 70 (160 / -22) | -61 (-50 / -73) | +131 (+210 / +51) | 4/4 | 1.25 |
| NIFTY_Buy_premium (pick 2) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹75 | 30 min after entry on instrument, high side, gap 0% | 30% | none | ₹2,000 | 50% | none | 15:14 | -18 (25 / -63) | -61 (-50 / -73) | +43 (+75 / +10) | 3/4 | 1.23 |
| NIFTY_Buy_premium (pick 3) | 10:30-13:00 | chosen (3 premiums) | NIFTY | Buy (range breakout) | closest premium ₹40 | 30 min after entry on instrument, high side, gap 0% | 40% | none | ₹1,000 | 100% | none | 15:14 | -7 (29 / -45) | -61 (-50 / -73) | +54 (+79 / +28) | 4/4 | 0.72 |
| SENSEX_Buy_premium | 10:30-13:00 | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -55 (-66 / -43) | -55 (-66 / -43) | +0 (+0 / +0) | 0/4 | 1.0 |

Gain by entry time (all days — 10:30-13:00):

- N_wide 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0
- NIFTY_Widesl_premium 10:30-13:00 pick 1: 10:47 +185, 11:32 +351, 12:17 +98, 13:02 -64
- NIFTY_Widesl_premium 10:30-13:00 pick 2: 10:47 +105, 11:32 +176, 12:17 +167, 13:02 -28
- NIFTY_Widesl_premium 10:30-13:00 pick 3: 10:47 +132, 11:32 +173, 12:17 +150, 13:02 -17
- S_wide 10:30-13:00 pick 1: 10:47 +139, 11:32 +343, 12:17 +120, 13:02 +0
- SENSEX_Widesl_premium 10:30-13:00 pick 1: 10:47 +253, 11:32 +585, 12:17 +165, 13:02 +122
- SENSEX_Widesl_premium 10:30-13:00 pick 2: 10:47 +105, 11:32 +496, 12:17 +111, 13:02 +103
- SENSEX_Widesl_premium 10:30-13:00 pick 3: 10:47 +125, 11:32 +489, 12:17 +111, 13:02 +138
- N_dir 10:30-13:00 pick 1: 10:47 +46, 11:32 -0, 12:17 +142, 13:02 +22
- N_ditm1 10:30-13:00 pick 1: 10:47 -21, 11:32 +113, 12:17 +93, 13:02 -12
- S_dir 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0
- S_ditm1 10:30-13:00 pick 1: 10:47 +199, 11:32 +119, 12:17 +83, 13:02 -1
- NIFTY_Buy_premium 10:30-13:00 pick 1: 10:47 +77, 11:32 +171, 12:17 +126, 13:02 +152
- NIFTY_Buy_premium 10:30-13:00 pick 2: 10:47 +81, 11:32 -19, 12:17 +53, 13:02 +56
- NIFTY_Buy_premium 10:30-13:00 pick 3: 10:47 +110, 11:32 +32, 12:17 +40, 13:02 +32
- SENSEX_Buy_premium 10:30-13:00 pick 1: 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0

## All days — 13:00-15:30

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | 13:00-15:30 | chosen | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 150% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 126 (150 / 102) | 97 (117 / 76) | +30 (+33 / +26) | 3/4 | 1.13 |
| NIFTY_Widesl_premium | 13:00-15:30 | chosen (1 premium) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹120 | — | 80% | 15%/10% | ₹4,000 | none | none | 15:28 | 138 (166 / 110) | 106 (117 / 95) | +32 (+49 / +15) | 4/4 | 1.17 |
| S_wide | 13:00-15:30 | default (template) | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | CE 114% / PE 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 18 (48 / -12) | 18 (48 / -12) | +0 (+0 / +0) | 0/4 | 1.0 |
| SENSEX_Widesl_premium | 13:00-15:30 | chosen (1 premium) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹225 | — | 60% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 115 (87 / 143) | 57 (36 / 80) | +57 (+51 / +64) | 4/4 | 1.05 |
| N_dir | 13:00-15:30 | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 30% | 10%/5% | ₹2,000 | none | ASAP ×1, no cutoff | 15:28 | 116 (181 / 49) | 45 (121 / -33) | +71 (+60 / +82) | 4/4 | 0.79 |
| N_ditm1 | 13:00-15:30 | chosen | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 30% | 10%/5% | ₹2,000 | none | ASAP ×1, no cutoff | 15:28 | 112 (199 / 23) | 71 (150 / -10) | +41 (+49 / +32) | 3/4 | 0.68 |
| S_dir | 13:00-15:30 | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 30% | none | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 66 (124 / 6) | 15 (41 / -13) | +51 (+83 / +19) | 4/4 | 1.17 |
| S_ditm1 | 13:00-15:30 | chosen (2, low correlation) | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 40% | 10%/5% | ₹4,000 | none | ASAP ×1, no cutoff | 15:28 | 95 (170 / 18) | 44 (86 / 2) | +50 (+84 / +16) | 3/4 | 1.15 |
| S_ditm1 (pick 2) | 13:00-15:30 | chosen (2, low correlation) | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 30% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 116 (149 / 82) | 44 (86 / 2) | +72 (+64 / +80) | 4/4 | 1.07 |
| NIFTY_Buy_premium | 13:00-15:30 | chosen (1 premium) | NIFTY | Buy (range breakout) | closest premium ₹25 | 30 min after entry on instrument, high side, gap 0% | 30% | none | ₹1,000 | 100% | none | 15:14 | -35 (18 / -88) | -94 (-68 / -121) | +60 (+86 / +33) | 4/4 | 0.72 |
| SENSEX_Buy_premium | 13:00-15:30 | chosen (1 premium) | SENSEX | Buy (range breakout) | closest premium ₹50 | 15 min after entry on instrument, high side, gap 0% | 20% | 9/3 pts | ₹2,000 | none | none | 15:14 | -44 (-44 / -45) | -59 (-66 / -53) | +15 (+22 / +8) | 3/4 | 1.02 |

Gain by entry time (all days — 13:00-15:30):

- N_wide 13:00-15:30 pick 1: 13:17 +58, 13:47 -11, 14:02 +21, 14:32 +51
- NIFTY_Widesl_premium 13:00-15:30 pick 1: 13:17 +8, 13:47 +56, 14:02 +41, 14:32 +23
- S_wide 13:00-15:30 pick 1: 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- SENSEX_Widesl_premium 13:00-15:30 pick 1: 13:17 +87, 13:47 +2, 14:02 +74, 14:32 +66
- N_dir 13:00-15:30 pick 1: 13:17 +78, 13:47 +102, 14:02 +43, 14:32 +61
- N_ditm1 13:00-15:30 pick 1: 13:17 -32, 13:47 +72, 14:02 +113, 14:32 +11
- S_dir 13:00-15:30 pick 1: 13:17 +103, 13:47 +32, 14:02 +52, 14:32 +19
- S_ditm1 13:00-15:30 pick 1: 13:17 +125, 13:47 -33, 14:02 +65, 14:32 +43
- S_ditm1 13:00-15:30 pick 2: 13:17 +121, 13:47 +62, 14:02 +47, 14:32 +56
- NIFTY_Buy_premium 13:00-15:30 pick 1: 13:17 +68, 13:47 +38, 14:02 +70, 14:32 +63
- SENSEX_Buy_premium 13:00-15:30 pick 1: 13:17 +21, 13:47 -7, 14:02 +2, 14:32 +44

## All days — all times

| Family | Band | Status | Index | Strategy | Strike | Range | Leg SL | Trail SL | MTM SL | Target | Re-entry | Exit | Net/lot-day (1st / test) | Template (1st / test) | Gain (1st / test) | Times better | Worst day × template |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| N_wide | all times | default (template) | NIFTY | Widesl (short strangle, wide SL) | OTM1 | — | 115% | 15%/10% | ₹2,500 | none | none | 15:28 | 126 (182 / 68) | 126 (182 / 68) | +0 (+0 / +0) | 0/12 | 1.0 |
| NIFTY_Widesl_premium | all times | chosen (1 premium) | NIFTY | Widesl (short strangle, wide SL) | closest premium ₹80 | — | 100% | 15%/10% | ₹4,000 | none | COST ×1, no cutoff | 15:28 | 125 (161 / 88) | 106 (142 / 70) | +19 (+19 / +18) | 8/12 | 1.05 |
| S_wide | all times | chosen | SENSEX | Widesl (short strangle, wide SL) | OTM2 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 86 (155 / 16) | 11 (42 / -20) | +75 (+113 / +36) | 8/12 | 1.17 |
| SENSEX_Widesl_premium | all times | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹480 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 177 (210 / 143) | 32 (30 / 33) | +145 (+180 / +110) | 11/12 | 1.01 |
| SENSEX_Widesl_premium (pick 2) | all times | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹285 | — | 40% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 165 (182 / 148) | 32 (30 / 33) | +134 (+152 / +115) | 11/12 | 1.03 |
| SENSEX_Widesl_premium (pick 3) | all times | chosen (3 premiums) | SENSEX | Widesl (short strangle, wide SL) | closest premium ₹150 | — | 60% | 25%/15% | ₹4,000 | none | COST ×1, no cutoff | 15:10 | 85 (107 / 63) | 32 (30 / 33) | +54 (+77 / +30) | 8/12 | 0.92 |
| N_dir | all times | chosen | NIFTY | Directional (short straddle, tight SL) | ATM | — | 30% | 10%/5% | ₹4,000 | none | ASAP ×1, no cutoff | 15:28 | 172 (225 / 118) | 135 (185 / 84) | +37 (+40 / +34) | 8/12 | 1.13 |
| N_ditm1 | all times | default (template) | NIFTY | Directional (short straddle, tight SL) | ITM1 | — | 21% | none | ₹3,000 | none | COST ×1, no cutoff | 15:28 | 171 (208 / 133) | 171 (208 / 133) | +0 (+0 / +0) | 0/12 | 1.0 |
| S_dir | all times | chosen | SENSEX | Directional (short straddle, tight SL) | ATM | — | 25% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 202 (237 / 167) | 153 (166 / 138) | +50 (+71 / +28) | 12/12 | 1.14 |
| S_ditm1 | all times | chosen | SENSEX | Directional (short straddle, tight SL) | ITM1 | — | 25% | 10%/5% | ₹4,000 | none | COST ×2, no cutoff | 15:28 | 263 (293 / 232) | 203 (219 / 187) | +60 (+74 / +46) | 11/12 | 1.13 |
| NIFTY_Buy_premium | all times | chosen (1 premium) | NIFTY | Buy (range breakout) | closest premium ₹30 | 30 min after entry on instrument, high side, gap 0% | 40% | none | ₹1,000 | 100% | none | 15:14 | -19 (23 / -62) | -52 (-14 / -91) | +33 (+37 / +29) | 9/12 | 0.69 |
| SENSEX_Buy_premium | all times | default (template) | SENSEX | Buy (range breakout) | closest premium ₹50 | 10 min after entry on instrument, high side, gap 0% | 25% | 1/1 pts | ₹2,000 | none | none | 15:14 | -50 (-49 / -50) | -50 (-49 / -50) | +0 (+0 / +0) | 0/12 | 1.0 |

Gain by entry time (all days — all times):

- N_wide all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- NIFTY_Widesl_premium all times pick 1: 09:17 +16, 09:32 +60, 09:47 +50, 10:17 +73, 10:47 +76, 11:32 -9, 12:17 -31, 13:02 -8, 13:17 +3, 13:47 +4, 14:02 -13, 14:32 +2
- S_wide all times pick 1: 09:17 -48, 09:32 +21, 09:47 +300, 10:17 +107, 10:47 +143, 11:32 +347, 12:17 +80, 13:02 +28, 13:17 -13, 13:47 -26, 14:02 +7, 14:32 -43
- SENSEX_Widesl_premium all times pick 1: 09:17 +20, 09:32 +63, 09:47 +235, 10:17 +268, 10:47 +253, 11:32 +585, 12:17 +165, 13:02 +122, 13:17 +64, 13:47 -49, 14:02 +4, 14:32 +13
- SENSEX_Widesl_premium all times pick 2: 09:17 +89, 09:32 +65, 09:47 +304, 10:17 +265, 10:47 +145, 11:32 +438, 12:17 +75, 13:02 +93, 13:17 +27, 13:47 -13, 14:02 +80, 14:32 +35
- SENSEX_Widesl_premium all times pick 3: 09:17 -37, 09:32 -80, 09:47 +179, 10:17 +168, 10:47 +85, 11:32 +280, 12:17 +45, 13:02 -15, 13:17 +1, 13:47 -43, 14:02 +46, 14:32 +18
- N_dir all times pick 1: 09:17 +155, 09:32 +58, 09:47 -113, 10:17 +114, 10:47 -15, 11:32 -84, 12:17 +53, 13:02 -11, 13:17 +82, 13:47 +83, 14:02 +39, 14:32 +83
- N_ditm1 all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0
- S_dir all times pick 1: 09:17 +35, 09:32 +126, 09:47 +76, 10:17 +70, 10:47 +94, 11:32 +2, 12:17 +7, 13:02 +44, 13:17 +44, 13:47 +47, 14:02 +29, 14:32 +25
- S_ditm1 all times pick 1: 09:17 +27, 09:32 +81, 09:47 +97, 10:17 +75, 10:47 +40, 11:32 +50, 12:17 +52, 13:02 +101, 13:17 +110, 13:47 +68, 14:02 -14, 14:32 +33
- NIFTY_Buy_premium all times pick 1: 09:17 -25, 09:32 -9, 09:47 +11, 10:17 +65, 10:47 +51, 11:32 -6, 12:17 +34, 13:02 +37, 13:17 +70, 13:47 +46, 14:02 +68, 14:32 +55
- SENSEX_Buy_premium all times pick 1: 09:17 +0, 09:32 +0, 09:47 +0, 10:17 +0, 10:47 +0, 11:32 +0, 12:17 +0, 13:02 +0, 13:17 +0, 13:47 +0, 14:02 +0, 14:32 +0

# Leaderboards — which strategies work best (descriptive)

Every family's pick (or its default) in each group, ranked by net ₹ per lot-day. Win rate,
max drawdown and worst day are means over the group's entry times. Expiry-day figures cover
about 50 days a year, non-expiry about 190.

## Leaderboard: Expiry days — 09:15-10:30

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | S_ditm1 | ITM1 · SL 40% · TSL 10%/5% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 936 (1286 / 586) | +187 | 2/4 | 69% | -11658 | -4277 | chosen |
| 2 | N_ditm1 | ITM1 · SL 40% · TSL none · MTM ₹3,000 · target none · RE ASAP ×1, no cutoff · exit 15:28 | 897 (918 / 876) | +282 | 3/4 | 62% | -24464 | -4146 | chosen |
| 3 | SENSEX_Widesl_premium | closest premium ₹200 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 838 (1058 / 619) | +301 | 4/4 | 75% | -9798 | -5106 | chosen (3 premiums) |
| 4 | NIFTY_Widesl_premium | closest premium ₹80 · SL 100% · TSL 15%/10% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 829 (964 / 690) | +31 | 3/4 | 63% | -16308 | -4319 | chosen (1 premium) |
| 5 | SENSEX_Widesl_premium | closest premium ₹250 · SL 40% · TSL 25%/15% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 821 (1127 / 514) | +283 | 4/4 | 69% | -12786 | -4610 | chosen (3 premiums) |
| 6 | N_dir | ATM · SL 40% · TSL none · MTM ₹3,000 · target none · RE ASAP ×1, no cutoff · exit 15:28 | 817 (923 / 707) | +314 | 4/4 | 61% | -14989 | -4263 | chosen |
| 7 | N_wide | OTM1 · SL 120% · TSL 25%/15% · MTM ₹3,000 · target none · RE none · exit 15:28 | 797 (956 / 631) | +15 | 3/4 | 54% | -13304 | -3864 | chosen |
| 8 | S_dir | ATM · SL 20% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 723 (1082 / 364) | +179 | 4/4 | 67% | -12566 | -4870 | chosen |
| 9 | SENSEX_Widesl_premium | closest premium ₹360 · SL 40% · TSL 15%/10% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 715 (922 / 508) | +178 | 3/4 | 61% | -20446 | -5722 | chosen (3 premiums) |
| 10 | S_wide | OTM2 · SL 150% · TSL 25%/15% · MTM ₹3,000 · target none · RE none · exit 15:28 | 540 (865 / 215) | +133 | 3/4 | 45% | -14896 | -5541 | chosen (2, low correlation) |
| 11 | S_wide | OTM2 · SL 60% · TSL 15%/10% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 469 (861 / 77) | +62 | 3/4 | 57% | -14373 | -4013 | chosen (2, low correlation) |
| 12 | NIFTY_Buy_premium | closest premium ₹100 · 10 min after entry on instrument, high side, gap 0% · SL 20% · TSL 1/1 pts · MTM ₹1,000 · target 50% · RE none · exit 15:14 | 15 (161 / -136) | +108 | 4/4 | 37% | -23065 | -1979 | chosen (1 premium) |
| 13 | SENSEX_Buy_premium | closest premium ₹50 · 10 min after entry on instrument, high side, gap 0% · SL 25% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | -7 (26 / -40) | +0 | 0/4 | 36% | -5155 | -1104 | default (template) |

## Leaderboard: Non-expiry days — 09:15-10:30

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | S_ditm1 | ITM1 · SL 10% · TSL 10%/5% · MTM ₹2,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 324 (357 / 289) | +124 | 3/4 | 50% | -25513 | -3487 | chosen |
| 2 | S_dir | ATM · SL 20% · TSL 10%/5% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 288 (240 / 337) | +113 | 4/4 | 59% | -24263 | -4355 | chosen |
| 3 | SENSEX_Widesl_premium | closest premium ₹480 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 135 (114 / 158) | +205 | 3/4 | 60% | -28972 | -5263 | chosen (3 premiums) |
| 4 | NIFTY_Buy_premium | closest premium ₹125 · 10 min after entry on instrument, high side, gap 0% · SL 20% · TSL 1/1 pts · MTM ₹1,000 · target 100% · RE none · exit 15:14 | 97 (196 / -5) | +73 | 4/4 | 33% | -36574 | -2126 | chosen (2 premiums) |
| 5 | SENSEX_Widesl_premium | closest premium ₹250 · SL 60% · TSL 15%/10% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 92 (72 / 112) | +162 | 4/4 | 56% | -20747 | -5044 | chosen (3 premiums) |
| 6 | N_wide | OTM1 · SL 60% · TSL 15%/10% · MTM ₹3,000 · target none · RE none · exit 15:28 | 73 (108 / 38) | +58 | 4/4 | 56% | -41305 | -4148 | default (owner setting) |
| 7 | NIFTY_Buy_premium | closest premium ₹60 · 10 min after entry on instrument, high side, gap 0% · SL 30% · TSL 1/1 pts · MTM ₹1,000 · target none · RE none · exit 15:14 | 69 (151 / -15) | +45 | 4/4 | 37% | -32392 | -1566 | chosen (2 premiums) |
| 8 | S_wide | OTM2 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 51 (94 / 7) | +94 | 3/4 | 56% | -35021 | -5241 | chosen |
| 9 | SENSEX_Widesl_premium | closest premium ₹200 · SL 40% · TSL none · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 43 (65 / 19) | +112 | 4/4 | 56% | -22053 | -4800 | chosen (3 premiums) |
| 10 | N_ditm1 | ITM1 · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 43 (87 / -2) | +0 | 0/4 | 51% | -50780 | -5098 | default (template) |
| 11 | N_dir | ATM · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 38 (114 / -40) | +0 | 0/4 | 52% | -51419 | -4593 | default (template) |
| 12 | NIFTY_Widesl_premium | closest premium ₹80 · SL 60% · TSL 15%/10% · MTM ₹2,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 31 (83 / -21) | +91 | 3/4 | 54% | -31794 | -3090 | chosen (2 premiums) |
| 13 | NIFTY_Widesl_premium | closest premium ₹60 · SL 80% · TSL 15%/10% · MTM ₹2,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 5 (43 / -34) | +65 | 3/4 | 51% | -30890 | -2697 | chosen (2 premiums) |
| 14 | SENSEX_Buy_premium | closest premium ₹50 · 10 min after entry on instrument, high side, gap 0% · SL 25% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | -43 (-28 / -58) | +0 | 0/4 | 34% | -19448 | -1032 | default (template) |

## Leaderboard: Expiry days — 10:30-13:00

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | SENSEX_Widesl_premium | closest premium ₹480 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 1043 (1322 / 765) | +546 | 4/4 | 72% | -14769 | -5989 | chosen (3 premiums) |
| 2 | S_ditm1 | ITM1 · SL 25% · TSL none · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 799 (1060 / 539) | +71 | 4/4 | 69% | -9868 | -5095 | chosen |
| 3 | SENSEX_Widesl_premium | closest premium ₹360 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE none · exit 15:28 | 743 (997 / 490) | +246 | 3/4 | 66% | -18530 | -4839 | chosen (3 premiums) |
| 4 | SENSEX_Widesl_premium | closest premium ₹320 · SL 40% · TSL none · MTM ₹4,000 · target none · RE none · exit 15:28 | 738 (991 / 486) | +241 | 3/4 | 68% | -17956 | -5453 | chosen (3 premiums) |
| 5 | S_dir | ATM · SL 25% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 665 (954 / 376) | +102 | 3/4 | 72% | -12890 | -3832 | chosen |
| 6 | S_wide | OTM2 · SL 60% · TSL 25%/15% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 523 (692 / 355) | +233 | 4/4 | 65% | -6189 | -3613 | chosen |
| 7 | NIFTY_Widesl_premium | closest premium ₹80 · SL 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | 479 (330 / 633) | +0 | 0/4 | 70% | -13598 | -5395 | default (template) |
| 8 | N_dir | ATM · SL 30% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 419 (409 / 430) | +74 | 3/4 | 65% | -15093 | -4507 | chosen |
| 9 | N_ditm1 | ITM1 · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 404 (297 / 514) | +0 | 0/4 | 62% | -26270 | -5026 | default (template) |
| 10 | N_wide | OTM1 · SL 150% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 333 (212 / 458) | +43 | 2/4 | 59% | -14916 | -5943 | default (owner setting) |
| 11 | NIFTY_Buy_premium | closest premium ₹125 · 10 min after entry on instrument, high side, gap 0% · SL 30% · TSL 3/1 pts · MTM ₹1,000 · target 100% · RE none · exit 15:14 | 122 (364 / -131) | +321 | 4/4 | 24% | -30190 | -2459 | chosen (3 premiums) |
| 12 | NIFTY_Buy_premium | closest premium ₹90 · 15 min after entry on underlying, high side, gap 0% · SL 40% · TSL 3/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | 102 (354 / -160) | +302 | 4/4 | 25% | -22016 | -3295 | chosen (3 premiums) |
| 13 | NIFTY_Buy_premium | closest premium ₹100 · 15 min after entry on instrument, high side, gap 0% · SL 40% · TSL 1/1 pts · MTM ₹2,000 · target 100% · RE none · exit 15:14 | 41 (361 / -291) | +241 | 4/4 | 38% | -28256 | -2957 | chosen (3 premiums) |
| 14 | SENSEX_Buy_premium | closest premium ₹50 · 10 min after entry on instrument, high side, gap 0% · SL 25% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | -4 (4 / -13) | +0 | 0/4 | 36% | -6123 | -940 | default (template) |

## Leaderboard: Non-expiry days — 10:30-13:00

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | S_ditm1 | ITM1 · SL 15% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 248 (171 / 328) | +131 | 3/4 | 54% | -33177 | -4983 | chosen |
| 2 | N_ditm1 | ITM1 · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 241 (264 / 218) | +0 | 0/4 | 57% | -25610 | -4087 | default (template) |
| 3 | N_dir | ATM · SL 25% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 223 (280 / 165) | +32 | 2/4 | 59% | -32885 | -4922 | chosen |
| 4 | N_wide | OTM1 · SL 60% · TSL 15%/10% · MTM ₹3,000 · target none · RE none · exit 15:28 | 136 (244 / 26) | +85 | 4/4 | 61% | -28005 | -4168 | default (owner setting) |
| 5 | NIFTY_Widesl_premium | closest premium ₹110 · SL 40% · TSL none · MTM ₹3,000 · target none · RE none · exit 15:10 | 101 (223 / -24) | +106 | 3/4 | 61% | -22477 | -4160 | chosen (3 premiums) |
| 6 | S_dir | ATM · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 88 (10 / 170) | +0 | 0/4 | 52% | -38673 | -4180 | default (template) |
| 7 | NIFTY_Buy_premium | closest premium ₹125 · 10 min after entry on instrument, high side, gap 0% · SL 20% · TSL none · MTM ₹1,000 · target none · RE none · exit 15:14 | 84 (97 / 71) | +108 | 3/4 | 27% | -50871 | -2290 | chosen (3 premiums) |
| 8 | NIFTY_Widesl_premium | closest premium ₹180 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 71 (224 / -85) | +77 | 2/4 | 63% | -34766 | -4812 | chosen (3 premiums) |
| 9 | NIFTY_Buy_premium | closest premium ₹100 · 10 min after entry on instrument, high side, gap 0% · SL 30% · TSL none · MTM ₹1,000 · target none · RE none · exit 15:14 | 70 (87 / 54) | +94 | 3/4 | 28% | -51143 | -1962 | chosen (3 premiums) |
| 10 | SENSEX_Widesl_premium | closest premium ₹480 · SL 40% · TSL 25%/15% · MTM ₹3,000 · target none · RE none · exit 15:10 | 69 (49 / 90) | +194 | 4/4 | 61% | -39308 | -3967 | chosen (3 premiums) |
| 11 | SENSEX_Widesl_premium | closest premium ₹285 · SL 40% · TSL 25%/15% · MTM ₹3,000 · target none · RE none · exit 15:10 | 60 (23 / 98) | +184 | 4/4 | 59% | -32495 | -3882 | chosen (3 premiums) |
| 12 | S_wide | OTM2 · SL 40% · TSL 25%/15% · MTM ₹3,000 · target none · RE none · exit 15:10 | 59 (94 / 22) | +187 | 4/4 | 58% | -30351 | -3920 | chosen |
| 13 | SENSEX_Widesl_premium | closest premium ₹320 · SL 40% · TSL 15%/10% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 57 (8 / 107) | +181 | 4/4 | 57% | -29856 | -4620 | chosen (3 premiums) |
| 14 | NIFTY_Widesl_premium | closest premium ₹150 · SL 40% · TSL 15%/10% · MTM ₹3,000 · target none · RE none · exit 15:10 | 47 (200 / -109) | +53 | 3/4 | 60% | -35239 | -4305 | chosen (3 premiums) |
| 15 | NIFTY_Buy_premium | closest premium ₹50 · 30 min after entry on instrument, high side, gap 0% · SL 30% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | 4 (5 / 3) | +28 | 3/4 | 38% | -22903 | -2286 | chosen (3 premiums) |
| 16 | SENSEX_Buy_premium | closest premium ₹50 · 10 min after entry on instrument, high side, gap 0% · SL 25% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | -68 (-84 / -51) | +0 | 0/4 | 31% | -27170 | -744 | default (template) |

## Leaderboard: Expiry days — 13:00-15:30

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | SENSEX_Widesl_premium | closest premium ₹360 · SL 40% · TSL 15%/10% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 541 (620 / 463) | +192 | 3/4 | 65% | -11035 | -5826 | chosen (2 premiums) |
| 2 | SENSEX_Widesl_premium | closest premium ₹250 · SL 40% · TSL 15%/10% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 500 (588 / 412) | +151 | 3/4 | 67% | -10368 | -4027 | chosen (2 premiums) |
| 3 | S_ditm1 | ITM1 · SL 25% · TSL none · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 443 (564 / 323) | +147 | 3/4 | 61% | -9137 | -4727 | chosen |
| 4 | S_wide | OTM2 · SL 120% · TSL 15%/10% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 372 (425 / 319) | +75 | 3/4 | 66% | -4956 | -2790 | chosen |
| 5 | S_dir | ATM · SL 30% · TSL none · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 347 (541 / 154) | +155 | 4/4 | 62% | -9451 | -3673 | chosen |
| 6 | NIFTY_Widesl_premium | closest premium ₹80 · SL 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | 228 (141 / 317) | +0 | 0/4 | 80% | -10055 | -5623 | default (template) |
| 7 | N_wide | OTM1 · SL 150% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 147 (108 / 187) | +47 | 2/4 | 60% | -11252 | -5756 | default (owner setting) |
| 8 | N_ditm1 | ITM1 · SL 20% · TSL none · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 65 (341 / -222) | +73 | 4/4 | 56% | -26005 | -5790 | chosen |
| 9 | SENSEX_Buy_premium | closest premium ₹50 · 10 min after entry on instrument, high side, gap 0% · SL 25% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | 2 (-18 / 22) | +0 | 0/4 | 35% | -5464 | -936 | default (template) |
| 10 | N_dir | ATM · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | -62 (108 / -238) | +0 | 0/4 | 55% | -19978 | -4503 | default (template) |
| 11 | NIFTY_Buy_premium | closest premium ₹50 · 10 min after entry on instrument, high side, gap 0% · SL 25% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | -124 (-66 / -185) | +0 | 0/4 | 36% | -19536 | -2570 | default (template) |

## Leaderboard: Non-expiry days — 13:00-15:30

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | N_ditm1 | ITM1 · SL 25% · TSL none · MTM ₹3,000 · target none · RE ASAP ×1, no cutoff · exit 15:28 | 141 (180 / 101) | +48 | 3/4 | 61% | -17038 | -3732 | chosen |
| 2 | N_wide | OTM1 · SL 150% · TSL none · MTM ₹3,000 · target none · RE none · exit 15:28 | 115 (163 / 66) | +19 | 3/4 | 61% | -23872 | -4045 | chosen |
| 3 | N_dir | ATM · SL 25% · TSL 10%/5% · MTM ₹2,000 · target none · RE ASAP ×1, no cutoff · exit 15:28 | 115 (181 / 47) | +41 | 4/4 | 59% | -17892 | -3090 | chosen |
| 4 | NIFTY_Widesl_premium | closest premium ₹80 · SL 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | 78 (110 / 44) | +0 | 0/4 | 61% | -22281 | -3638 | default (template) |
| 5 | S_ditm1 | ITM1 · SL 15% · TSL 10%/5% · MTM ₹4,000 · target none · RE ASAP ×1, no cutoff · exit 15:28 | 17 (62 / -29) | +41 | 3/4 | 55% | -40452 | -4614 | chosen |
| 6 | SENSEX_Widesl_premium | closest premium ₹320 · SL CE 114% / PE 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | -15 (-32 / 1) | +0 | 0/4 | 54% | -32138 | -3452 | default (template) |
| 7 | NIFTY_Buy_premium | closest premium ₹20 · 30 min after entry on instrument, high side, gap 0% · SL 40% · TSL 3/1 pts · MTM ₹1,000 · target none · RE none · exit 15:14 | -27 (10 / -64) | +59 | 3/4 | 24% | -16617 | -1125 | chosen (1 premium) |
| 8 | S_dir | ATM · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | -34 (-34 / -33) | +0 | 0/4 | 51% | -48382 | -4187 | default (template) |
| 9 | SENSEX_Buy_premium | closest premium ₹50 · 30 min after entry on instrument, high side, gap 0% · SL 20% · TSL none · MTM ₹2,000 · target none · RE none · exit 15:14 | -34 (-36 / -32) | +42 | 4/4 | 21% | -17107 | -824 | chosen (2 premiums) |
| 10 | SENSEX_Buy_premium | closest premium ₹30 · 30 min after entry on instrument, high side, gap 0% · SL 30% · TSL 9/3 pts · MTM ₹2,000 · target 50% · RE none · exit 15:14 | -44 (-39 / -50) | +32 | 4/4 | 18% | -17447 | -661 | chosen (2 premiums) |
| 11 | S_wide | OTM2 · SL CE 114% / PE 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | -57 (-36 / -78) | +0 | 0/4 | 53% | -45936 | -3794 | default (template) |

## Leaderboard: Expiry days — all times

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | SENSEX_Widesl_premium | closest premium ₹250 · SL 40% · TSL 25%/15% · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 671 (882 / 461) | +210 | 11/12 | 68% | -11002 | -4380 | chosen (2 premiums) |
| 2 | S_ditm1 | ITM1 · SL 25% · TSL 10%/5% · MTM ₹3,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 670 (870 / 469) | +78 | 8/12 | 67% | -11057 | -4148 | chosen |
| 3 | SENSEX_Widesl_premium | closest premium ₹400 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 608 (811 / 404) | +146 | 8/12 | 66% | -19196 | -6193 | chosen (2 premiums) |
| 4 | S_dir | ATM · SL 25% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 533 (801 / 265) | +100 | 9/12 | 68% | -10310 | -4393 | chosen |
| 5 | NIFTY_Widesl_premium | closest premium ₹100 · SL 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | 502 (464 / 541) | +0 | 0/12 | 70% | -13516 | -4969 | default (template) |
| 6 | N_wide | OTM1 · SL 150% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 447 (384 / 513) | +57 | 7/12 | 58% | -13609 | -5670 | default (owner setting) |
| 7 | N_ditm1 | ITM1 · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 337 (380 / 292) | +0 | 0/12 | 58% | -24180 | -4960 | default (template) |
| 8 | S_wide | OTM2 · SL CE 114% / PE 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | 332 (497 / 166) | +0 | 0/12 | 56% | -8487 | -3716 | default (template) |
| 9 | N_dir | ATM · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 262 (283 / 240) | +0 | 0/12 | 63% | -17490 | -4286 | default (template) |
| 10 | SENSEX_Buy_premium | closest premium ₹50 · 30 min after entry on instrument, high side, gap 0% · SL 20% · TSL 3/3 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | 33 (48 / 18) | +36 | 9/12 | 31% | -4628 | -1130 | chosen (1 premium) |
| 11 | NIFTY_Buy_premium | closest premium ₹30 · 30 min after entry on instrument, high side, gap 0% · SL 30% · TSL none · MTM ₹1,000 · target 100% · RE none · exit 15:14 | -49 (52 / -153) | +90 | 8/12 | 23% | -19544 | -1798 | chosen (1 premium) |

## Leaderboard: Non-expiry days — all times

| # | Family | Setting | Net/lot-day (1st / test) | Gain vs template | Times better | Win rate | Max DD | Worst day | Status |
|---|---|---|---|---|---|---|---|---|---|
| 1 | N_ditm1 | ITM1 · SL 20% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 166 (223 / 107) | +40 | 9/12 | 55% | -30894 | -5199 | chosen |
| 2 | S_dir | ATM · SL 15% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 135 (108 / 164) | +59 | 9/12 | 52% | -37443 | -4886 | chosen |
| 3 | N_dir | ATM · SL 25% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 130 (194 / 66) | +30 | 6/12 | 57% | -32633 | -5017 | chosen |
| 4 | N_wide | OTM1 · SL 60% · TSL 15%/10% · MTM ₹3,000 · target none · RE none · exit 15:28 | 102 (164 / 39) | +48 | 9/12 | 59% | -30265 | -4122 | default (owner setting) |
| 5 | S_ditm1 | ITM1 · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 98 (58 / 138) | +0 | 0/12 | 53% | -38360 | -4339 | default (template) |
| 6 | SENSEX_Widesl_premium | closest premium ₹480 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 74 (67 / 82) | +144 | 10/12 | 59% | -33957 | -4842 | chosen (3 premiums) |
| 7 | SENSEX_Widesl_premium | closest premium ₹250 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 27 (6 / 50) | +97 | 9/12 | 55% | -28999 | -4158 | chosen (3 premiums) |
| 8 | S_wide | OTM2 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 22 (61 / -17) | +98 | 10/12 | 55% | -34967 | -5009 | chosen |
| 9 | NIFTY_Buy_premium | closest premium ₹40 · 30 min after entry on instrument, high side, gap 0% · SL 30% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | 14 (29 / -1) | +43 | 10/12 | 34% | -20054 | -1999 | chosen (2 premiums) |
| 10 | NIFTY_Buy_premium | closest premium ₹125 · 10 min after entry on instrument, high side, gap 0% · SL 20% · TSL 1/1 pts · MTM ₹1,000 · target none · RE none · exit 15:14 | 5 (19 / -9) | +34 | 10/12 | 35% | -44487 | -2081 | chosen (2 premiums) |
| 11 | NIFTY_Widesl_premium | closest premium ₹100 · SL 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | 4 (64 / -57) | +0 | 0/12 | 60% | -40057 | -3896 | default (template) |
| 12 | SENSEX_Widesl_premium | closest premium ₹100 · SL 60% · TSL none · MTM ₹2,000 · target none · RE none · exit 15:10 | -5 (-26 / 16) | +65 | 10/12 | 51% | -18223 | -2561 | chosen (3 premiums) |
| 13 | SENSEX_Buy_premium | closest premium ₹50 · 30 min after entry on instrument, high side, gap 0% · SL 30% · TSL 3/3 pts · MTM ₹1,000 · target none · RE none · exit 15:14 | -35 (-37 / -33) | +27 | 12/12 | 28% | -17744 | -949 | chosen (1 premium) |

## Works on both day types — all times, all days

Each family's setting chosen on all days (expiry and non-expiry together) across all 12 entry
times, with its gain over the template on each day type. **Both** = it beats the template on
expiry days and on non-expiry days.

| Family | Setting | Net/lot-day all days (1st / test) | Gain all days | Gain on expiry days | Gain on non-expiry days | Both? | Status |
|---|---|---|---|---|---|---|---|
| S_ditm1 | ITM1 · SL 25% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 263 (293 / 232) | +60 | +81 | +54 | yes | chosen |
| S_dir | ATM · SL 25% · TSL 10%/5% · MTM ₹4,000 · target none · RE COST ×2, no cutoff · exit 15:28 | 202 (237 / 167) | +50 | +100 | +36 | yes | chosen |
| SENSEX_Widesl_premium | closest premium ₹480 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 177 (210 / 143) | +145 | +94 | +144 | yes | chosen (3 premiums) |
| N_dir | ATM · SL 30% · TSL 10%/5% · MTM ₹4,000 · target none · RE ASAP ×1, no cutoff · exit 15:28 | 172 (225 / 118) | +37 | +101 | +20 | yes | chosen |
| N_ditm1 | ITM1 · SL 21% · TSL none · MTM ₹3,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 171 (208 / 133) | +0 |  |  | template | default (template) |
| SENSEX_Widesl_premium | closest premium ₹285 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 165 (182 / 148) | +134 | +157 | +113 | yes | chosen (3 premiums) |
| N_wide | OTM1 · SL 115% · TSL 15%/10% · MTM ₹2,500 · target none · RE none · exit 15:28 | 126 (182 / 68) | +0 |  |  | template | default (template) |
| NIFTY_Widesl_premium | closest premium ₹80 · SL 100% · TSL 15%/10% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:28 | 125 (161 / 88) | +19 | +1 | +19 | yes | chosen (1 premium) |
| S_wide | OTM2 · SL 40% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 86 (155 / 16) | +75 | -10 | +98 | no | chosen |
| SENSEX_Widesl_premium | closest premium ₹150 · SL 60% · TSL 25%/15% · MTM ₹4,000 · target none · RE COST ×1, no cutoff · exit 15:10 | 85 (107 / 63) | +54 | -70 | +73 | no | chosen (3 premiums) |
| NIFTY_Buy_premium | closest premium ₹30 · 30 min after entry on instrument, high side, gap 0% · SL 40% · TSL none · MTM ₹1,000 · target 100% · RE none · exit 15:14 | -19 (23 / -62) | +33 | +75 | +22 | yes | chosen (1 premium) |
| SENSEX_Buy_premium | closest premium ₹50 · 10 min after entry on instrument, high side, gap 0% · SL 25% · TSL 1/1 pts · MTM ₹2,000 · target none · RE none · exit 15:14 | -50 (-49 / -50) | +0 |  |  | template | default (template) |
