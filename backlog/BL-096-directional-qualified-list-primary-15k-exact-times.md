# BL-096 Directional qualified list — full 15k primary sweep

Top three primary-sweep configurations at every exact entry time, ranked
separately for NIFTY and SENSEX. This uses all 15,000 completed primary rows,
not only the 1,200 detailed-diagnostic shortlist.

The balanced core ranking uses holdout average daily P&L, win rate, maximum
drawdown, worst day and MTM-stop days. Values are holdout results before
brokerage, statutory charges and slippage. The primary sweep has core metrics
only; Ulcer Index, CVaR, expectancy and leg-level diagnostics require a later
detailed run for selected winners.

## NIFTY

| Entry | #1 | #2 | #3 |
|---|---|---|---|
| 09:17 | ITM1 · SL 35% · MTM ₹2,500 · 15:10 (₹384/d; WR 55.8%; DD -₹17,534; stops 69) | ITM1 · SL 35% · MTM ₹2,500 · 15:28 (₹431/d; WR 56.7%; DD -₹22,373; stops 70) | ITM1 · SL 35% · MTM ₹2,500 · 15:00 (₹297/d; WR 54.6%; DD -₹19,734; stops 67) |
| 09:32 | ATM · SL 30% · MTM ₹3,000 · 14:50 (₹163/d; WR 58.8%; DD -₹27,079; stops 42) | ATM · SL 30% · MTM ₹3,000 · 15:00 (₹189/d; WR 58.8%; DD -₹26,312; stops 44) | ATM · SL 30% · MTM ₹3,000 · 15:28 (₹256/d; WR 60.4%; DD -₹26,042; stops 52) |
| 09:47 | ATM · SL 21% · MTM ₹4,000 · 15:28 (₹495/d; WR 60.8%; DD -₹20,374; stops 17) | ATM · SL 30% · MTM ₹4,000 · 15:28 (₹443/d; WR 60.4%; DD -₹20,556; stops 18) | ATM · SL 21% · MTM ₹3,500 · 15:28 (₹480/d; WR 60.4%; DD -₹21,570; stops 26) |
| 10:02 | ATM · SL 25% · MTM ₹4,000 · 15:00 (₹393/d; WR 62.5%; DD -₹12,084; stops 16) | ATM · SL 25% · MTM ₹4,000 · 15:28 (₹457/d; WR 62.9%; DD -₹15,753; stops 21) | ATM · SL 25% · MTM ₹4,000 · 15:10 (₹384/d; WR 62.9%; DD -₹13,741; stops 21) |
| 10:17 | ATM · SL 35% · MTM ₹4,000 · 15:00 (₹314/d; WR 64.2%; DD -₹15,594; stops 17) | ITM1 · SL 30% · MTM ₹3,500 · 15:10 (₹350/d; WR 62.1%; DD -₹13,536; stops 35) | ATM · SL 35% · MTM ₹4,000 · 15:10 (₹319/d; WR 64.6%; DD -₹16,192; stops 18) |
| 10:32 | ITM1 · SL 35% · MTM ₹2,500 · 15:00 (₹352/d; WR 66.2%; DD -₹16,338; stops 52) | ITM1 · SL 35% · MTM ₹2,500 · 15:10 (₹399/d; WR 64.2%; DD -₹17,004; stops 54) | ITM1 · SL 35% · MTM ₹3,000 · 15:10 (₹382/d; WR 65.4%; DD -₹19,194; stops 44) |
| 10:47 | ATM · SL 21% · MTM ₹3,500 · 15:28 (₹508/d; WR 65.4%; DD -₹13,046; stops 23) | ATM · SL 25% · MTM ₹3,000 · 15:28 (₹521/d; WR 67.1%; DD -₹14,748; stops 33) | ATM · SL 25% · MTM ₹2,500 · 15:28 (₹534/d; WR 66.2%; DD -₹13,188; stops 39) |
| 11:02 | ITM1 · SL 25% · MTM ₹4,000 · 15:00 (₹658/d; WR 69.2%; DD -₹12,188; stops 15) | ATM · SL 25% · MTM ₹4,000 · 15:00 (₹523/d; WR 70.8%; DD -₹11,564; stops 12) | ATM · SL 25% · MTM ₹3,500 · 15:00 (₹538/d; WR 70.8%; DD -₹10,709; stops 15) |
| 11:17 | ATM · SL 25% · MTM ₹3,000 · 15:28 (₹552/d; WR 63.3%; DD -₹10,143; stops 21) | ATM · SL 25% · MTM ₹3,500 · 15:28 (₹555/d; WR 63.7%; DD -₹12,392; stops 12) | ATM · SL 25% · MTM ₹3,000 · 15:00 (₹463/d; WR 64.2%; DD -₹10,510; stops 18) |
| 11:32 | ATM · SL 30% · MTM ₹3,000 · 15:28 (₹394/d; WR 62.5%; DD -₹13,800; stops 24) | ATM · SL 35% · MTM ₹4,000 · 15:28 (₹371/d; WR 62.5%; DD -₹16,628; stops 13) | ATM · SL 30% · MTM ₹4,000 · 15:28 (₹388/d; WR 62.5%; DD -₹15,230; stops 10) |
| 11:47 | ATM · SL 25% · MTM ₹3,500 · 15:28 (₹448/d; WR 65.8%; DD -₹9,861; stops 12) | ATM · SL 25% · MTM ₹3,000 · 15:28 (₹451/d; WR 65.4%; DD -₹9,861; stops 18) | ATM · SL 25% · MTM ₹4,000 · 15:28 (₹503/d; WR 67.1%; DD -₹10,523; stops 6) |
| 12:02 | ATM · SL 30% · MTM ₹3,500 · 15:28 (₹455/d; WR 67.5%; DD -₹11,697; stops 12) | ATM · SL 30% · MTM ₹4,000 · 15:28 (₹444/d; WR 67.5%; DD -₹12,870; stops 10) | ATM · SL 30% · MTM ₹3,500 · 15:00 (₹347/d; WR 64.6%; DD -₹10,900; stops 9) |
| 12:17 | ITM1 · SL 30% · MTM ₹2,500 · 15:28 (₹444/d; WR 62.9%; DD -₹13,819; stops 33) | ITM1 · SL 30% · MTM ₹3,000 · 15:28 (₹460/d; WR 64.2%; DD -₹15,125; stops 25) | ATM · SL 35% · MTM ₹4,000 · 15:28 (₹329/d; WR 63.3%; DD -₹14,970; stops 9) |
| 12:32 | ATM · SL 30% · MTM ₹4,000 · 15:28 (₹299/d; WR 66.7%; DD -₹20,300; stops 11) | ATM · SL 21% · MTM ₹4,000 · 15:28 (₹254/d; WR 62.1%; DD -₹12,987; stops 12) | ATM · SL 30% · MTM ₹3,000 · 15:28 (₹274/d; WR 65.8%; DD -₹23,946; stops 22) |
| 12:47 | ATM · SL 35% · MTM ₹3,500 · 15:28 (₹339/d; WR 66.7%; DD -₹15,697; stops 10) | ATM · SL 30% · MTM ₹3,000 · 15:28 (₹349/d; WR 64.2%; DD -₹13,747; stops 16) | ATM · SL 35% · MTM ₹4,000 · 15:28 (₹332/d; WR 66.7%; DD -₹17,176; stops 6) |
| 13:02 | ATM · SL 35% · MTM ₹3,500 · 15:28 (₹376/d; WR 65.0%; DD -₹21,483; stops 7) | ATM · SL 25% · MTM ₹2,500 · 15:28 (₹388/d; WR 67.1%; DD -₹19,822; stops 22) | ATM · SL 21% · MTM ₹4,000 · 15:28 (₹415/d; WR 66.7%; DD -₹14,606; stops 9) |
| 13:17 | ATM · SL 30% · MTM ₹3,000 · 15:28 (₹267/d; WR 63.3%; DD -₹12,613; stops 13) | ATM · SL 35% · MTM ₹4,000 · 15:28 (₹312/d; WR 64.2%; DD -₹13,169; stops 3) | ATM · SL 35% · MTM ₹3,500 · 15:28 (₹301/d; WR 64.2%; DD -₹15,662; stops 7) |
| 13:32 | ATM · SL 30% · MTM ₹4,000 · 15:28 (₹190/d; WR 60.8%; DD -₹14,880; stops 5) | ATM · SL 25% · MTM ₹4,000 · 15:28 (₹200/d; WR 58.8%; DD -₹18,099; stops 5) | ATM · SL 21% · MTM ₹2,500 · 15:00 (₹79/d; WR 59.2%; DD -₹19,950; stops 12) |
| 13:47 | ATM · SL 25% · MTM ₹3,500 · 15:20 (₹172/d; WR 63.3%; DD -₹7,638; stops 3) | ATM · SL 25% · MTM ₹3,000 · 15:00 (₹140/d; WR 63.3%; DD -₹8,541; stops 3) | ATM · SL 30% · MTM ₹3,500 · 15:20 (₹199/d; WR 66.2%; DD -₹10,232; stops 4) |
| 14:02 | ATM · SL 21% · MTM ₹4,000 · 15:00 (₹61/d; WR 57.1%; DD -₹14,560; stops 0) | ATM · SL 21% · MTM ₹4,000 · 15:28 (₹127/d; WR 57.9%; DD -₹17,163; stops 1) | ATM · SL 15% · MTM ₹3,000 · 15:00 (₹75/d; WR 52.5%; DD -₹13,042; stops 2) |
| 14:17 | ATM · SL 35% · MTM ₹3,500 · 15:20 (₹165/d; WR 64.2%; DD -₹9,100; stops 1) | ATM · SL 35% · MTM ₹3,000 · 15:28 (₹254/d; WR 64.6%; DD -₹8,456; stops 4) | ITM1 · SL 35% · MTM ₹4,000 · 15:10 (₹148/d; WR 62.5%; DD -₹7,543; stops 0) |
| 14:32 | ATM · SL 10% · MTM ₹3,500 · 15:28 (₹54/d; WR 45.4%; DD -₹15,363; stops 0) | ATM · SL 10% · MTM ₹4,000 · 15:28 (₹54/d; WR 45.4%; DD -₹15,363; stops 0) | ITM1 · SL 21% · MTM ₹4,000 · 15:10 (-₹7/d; WR 53.8%; DD -₹13,074; stops 0) |
| 14:47 | ATM · SL 30% · MTM ₹4,000 · 15:10 (₹178/d; WR 66.2%; DD -₹4,313; stops 0) | ATM · SL 25% · MTM ₹3,500 · 15:10 (₹171/d; WR 64.6%; DD -₹5,324; stops 0) | ATM · SL 25% · MTM ₹4,000 · 15:10 (₹171/d; WR 64.6%; DD -₹5,324; stops 0) |
| 15:02 | ATM · SL 21% · MTM ₹2,500 · 15:28 (₹197/d; WR 62.9%; DD -₹3,789; stops 0) | ATM · SL 21% · MTM ₹3,000 · 15:28 (₹197/d; WR 62.9%; DD -₹3,789; stops 0) | ATM · SL 21% · MTM ₹3,500 · 15:28 (₹197/d; WR 62.9%; DD -₹3,789; stops 0) |
| 15:17 | ATM · SL 25% · MTM ₹2,000 · 15:28 (₹167/d; WR 68.8%; DD -₹2,499; stops 0) | ATM · SL 25% · MTM ₹2,500 · 15:28 (₹167/d; WR 68.8%; DD -₹2,499; stops 0) | ATM · SL 25% · MTM ₹3,000 · 15:28 (₹167/d; WR 68.8%; DD -₹2,499; stops 0) |

## SENSEX

| Entry | #1 | #2 | #3 |
|---|---|---|---|
| 09:17 | ITM1 · SL 15% · MTM ₹3,000 · 15:28 (₹614/d; WR 61.3%; DD -₹13,873; stops 57) | ITM1 · SL 15% · MTM ₹3,000 · 14:50 (₹416/d; WR 60.4%; DD -₹15,867; stops 51) | ITM1 · SL 15% · MTM ₹3,000 · 15:20 (₹517/d; WR 59.6%; DD -₹14,406; stops 57) |
| 09:32 | ATM · SL 10% · MTM ₹4,000 · 15:28 (₹357/d; WR 58.3%; DD -₹17,832; stops 14) | ATM · SL 21% · MTM ₹3,500 · 15:28 (₹380/d; WR 63.3%; DD -₹19,022; stops 32) | ATM · SL 10% · MTM ₹3,500 · 15:28 (₹353/d; WR 57.5%; DD -₹17,331; stops 21) |
| 09:47 | ATM · SL 35% · MTM ₹3,000 · 15:28 (₹492/d; WR 64.6%; DD -₹11,911; stops 36) | ITM1 · SL 30% · MTM ₹2,000 · 15:28 (₹566/d; WR 62.5%; DD -₹13,048; stops 68) | ITM1 · SL 30% · MTM ₹3,500 · 15:28 (₹568/d; WR 66.2%; DD -₹15,151; stops 37) |
| 10:02 | ITM1 · SL 35% · MTM ₹2,500 · 15:10 (₹477/d; WR 65.0%; DD -₹15,817; stops 51) | ITM1 · SL 21% · MTM ₹4,000 · 15:10 (₹402/d; WR 60.8%; DD -₹16,542; stops 20) | ITM1 · SL 35% · MTM ₹3,500 · 15:10 (₹395/d; WR 65.0%; DD -₹20,453; stops 36) |
| 10:17 | ATM · SL 15% · MTM ₹3,500 · 15:00 (₹530/d; WR 63.3%; DD -₹12,691; stops 17) | ATM · SL 25% · MTM ₹3,500 · 15:28 (₹472/d; WR 65.0%; DD -₹12,481; stops 25) | ATM · SL 25% · MTM ₹2,500 · 15:10 (₹437/d; WR 63.3%; DD -₹11,888; stops 43) |
| 10:32 | ATM · SL 30% · MTM ₹3,500 · 15:28 (₹498/d; WR 70.8%; DD -₹11,907; stops 22) | ATM · SL 30% · MTM ₹3,000 · 15:28 (₹492/d; WR 70.8%; DD -₹11,373; stops 33) | ATM · SL 30% · MTM ₹3,500 · 15:10 (₹445/d; WR 68.3%; DD -₹13,418; stops 20) |
| 10:47 | ITM1 · SL 10% · MTM ₹3,500 · 15:28 (₹696/d; WR 62.9%; DD -₹16,174; stops 15) | ATM · SL 10% · MTM ₹3,500 · 15:28 (₹588/d; WR 62.1%; DD -₹13,232; stops 14) | ITM1 · SL 10% · MTM ₹4,000 · 15:28 (₹742/d; WR 63.7%; DD -₹16,511; stops 10) |
| 11:02 | ATM · SL 25% · MTM ₹3,500 · 15:28 (₹547/d; WR 66.7%; DD -₹12,126; stops 16) | ATM · SL 25% · MTM ₹4,000 · 15:28 (₹571/d; WR 67.1%; DD -₹12,107; stops 9) | ATM · SL 25% · MTM ₹3,500 · 15:00 (₹425/d; WR 66.7%; DD -₹10,392; stops 14) |
| 11:17 | ITM1 · SL 15% · MTM ₹3,500 · 15:10 (₹662/d; WR 65.0%; DD -₹15,848; stops 15) | ATM · SL 15% · MTM ₹3,000 · 15:28 (₹550/d; WR 63.7%; DD -₹14,252; stops 18) | ITM1 · SL 15% · MTM ₹3,500 · 15:00 (₹593/d; WR 62.5%; DD -₹12,764; stops 13) |
| 11:32 | ITM1 · SL 35% · MTM ₹2,500 · 15:28 (₹632/d; WR 71.2%; DD -₹15,010; stops 28) | ITM1 · SL 35% · MTM ₹3,000 · 15:28 (₹658/d; WR 72.1%; DD -₹13,965; stops 22) | ITM1 · SL 35% · MTM ₹2,500 · 15:10 (₹533/d; WR 71.7%; DD -₹14,488; stops 26) |
| 11:47 | ATM · SL 15% · MTM ₹3,500 · 15:10 (₹531/d; WR 65.4%; DD -₹8,262; stops 9) | ATM · SL 15% · MTM ₹3,500 · 15:00 (₹482/d; WR 63.7%; DD -₹8,453; stops 7) | ITM1 · SL 30% · MTM ₹3,500 · 15:28 (₹551/d; WR 67.9%; DD -₹11,564; stops 13) |
| 12:02 | ATM · SL 21% · MTM ₹3,500 · 15:28 (₹400/d; WR 63.3%; DD -₹16,907; stops 9) | ATM · SL 25% · MTM ₹4,000 · 15:28 (₹404/d; WR 62.5%; DD -₹12,299; stops 4) | ITM1 · SL 21% · MTM ₹3,500 · 15:10 (₹403/d; WR 63.3%; DD -₹13,578; stops 13) |
| 12:17 | ATM · SL 21% · MTM ₹3,000 · 15:28 (₹440/d; WR 66.2%; DD -₹17,340; stops 16) | ATM · SL 21% · MTM ₹3,500 · 15:28 (₹455/d; WR 66.2%; DD -₹19,262; stops 8) | ATM · SL 21% · MTM ₹3,000 · 15:10 (₹359/d; WR 63.7%; DD -₹17,207; stops 15) |
| 12:32 | ITM1 · SL 25% · MTM ₹3,500 · 15:10 (₹252/d; WR 65.0%; DD -₹11,806; stops 12) | ITM1 · SL 25% · MTM ₹4,000 · 15:10 (₹244/d; WR 65.0%; DD -₹12,477; stops 8) | ITM1 · SL 25% · MTM ₹3,500 · 15:28 (₹346/d; WR 63.3%; DD -₹12,577; stops 14) |
| 12:47 | ATM · SL 25% · MTM ₹3,500 · 15:28 (₹394/d; WR 65.0%; DD -₹15,852; stops 7) | ATM · SL 25% · MTM ₹3,000 · 15:28 (₹393/d; WR 65.0%; DD -₹16,038; stops 12) | ATM · SL 25% · MTM ₹3,500 · 15:10 (₹283/d; WR 65.0%; DD -₹15,488; stops 6) |
| 13:02 | ATM · SL 35% · MTM ₹3,000 · 15:00 (₹227/d; WR 67.1%; DD -₹13,391; stops 8) | ATM · SL 35% · MTM ₹3,000 · 15:10 (₹234/d; WR 68.3%; DD -₹15,412; stops 11) | ATM · SL 35% · MTM ₹3,000 · 15:28 (₹327/d; WR 67.5%; DD -₹18,651; stops 13) |
| 13:17 | ITM1 · SL 35% · MTM ₹2,000 · 15:10 (₹219/d; WR 67.5%; DD -₹23,890; stops 28) | ATM · SL 35% · MTM ₹2,500 · 15:10 (₹161/d; WR 65.0%; DD -₹24,119; stops 18) | ATM · SL 30% · MTM ₹3,000 · 15:10 (₹176/d; WR 66.7%; DD -₹27,426; stops 11) |
| 13:32 | ATM · SL 30% · MTM ₹3,000 · 15:10 (₹232/d; WR 63.3%; DD -₹9,586; stops 6) | ATM · SL 30% · MTM ₹2,500 · 15:10 (₹228/d; WR 63.3%; DD -₹8,306; stops 8) | ATM · SL 30% · MTM ₹3,000 · 15:28 (₹329/d; WR 62.5%; DD -₹11,358; stops 8) |
| 13:47 | ITM1 · SL 35% · MTM ₹2,000 · 15:28 (₹245/d; WR 63.7%; DD -₹10,342; stops 33) | ITM1 · SL 35% · MTM ₹2,000 · 15:10 (₹161/d; WR 61.7%; DD -₹9,437; stops 26) | ATM · SL 35% · MTM ₹2,000 · 15:28 (₹196/d; WR 61.7%; DD -₹12,580; stops 24) |
| 14:02 | ITM1 · SL 35% · MTM ₹2,500 · 15:10 (₹150/d; WR 66.7%; DD -₹10,371; stops 13) | ATM · SL 35% · MTM ₹2,500 · 15:10 (₹84/d; WR 63.3%; DD -₹9,198; stops 13) | ATM · SL 35% · MTM ₹2,500 · 15:28 (₹130/d; WR 63.3%; DD -₹10,439; stops 19) |
| 14:17 | ATM · SL 25% · MTM ₹4,000 · 15:10 (₹101/d; WR 59.2%; DD -₹10,780; stops 0) | ATM · SL 25% · MTM ₹2,000 · 15:10 (₹98/d; WR 59.2%; DD -₹9,098; stops 10) | ATM · SL 25% · MTM ₹3,500 · 15:10 (₹94/d; WR 59.2%; DD -₹12,000; stops 1) |
| 14:32 | ATM · SL 21% · MTM ₹4,000 · 15:10 (₹64/d; WR 60.0%; DD -₹13,228; stops 0) | ITM1 · SL 15% · MTM ₹3,500 · 15:10 (₹109/d; WR 55.8%; DD -₹18,556; stops 0) | ITM1 · SL 15% · MTM ₹4,000 · 15:10 (₹109/d; WR 55.8%; DD -₹18,556; stops 0) |
| 14:47 | ATM · SL 21% · MTM ₹4,000 · 15:00 (₹132/d; WR 72.5%; DD -₹2,660; stops 0) | ATM · SL 15% · MTM ₹3,000 · 15:00 (₹117/d; WR 68.8%; DD -₹3,523; stops 0) | ATM · SL 15% · MTM ₹3,500 · 15:00 (₹117/d; WR 68.8%; DD -₹3,523; stops 0) |
| 15:02 | ATM · SL 25% · MTM ₹2,000 · 15:10 (₹74/d; WR 60.8%; DD -₹4,193; stops 0) | ATM · SL 25% · MTM ₹2,500 · 15:10 (₹74/d; WR 60.8%; DD -₹4,193; stops 0) | ATM · SL 25% · MTM ₹3,000 · 15:10 (₹74/d; WR 60.8%; DD -₹4,193; stops 0) |
| 15:17 | ITM1 · SL 10% · MTM ₹2,000 · 15:28 (₹170/d; WR 67.1%; DD -₹2,952; stops 0) | ITM1 · SL 10% · MTM ₹2,500 · 15:28 (₹170/d; WR 67.1%; DD -₹2,952; stops 0) | ITM1 · SL 10% · MTM ₹3,000 · 15:28 (₹170/d; WR 67.1%; DD -₹2,952; stops 0) |

These are primary-sweep screening candidates. The exact-time selection is
highly exposed to multiple-testing/data-snooping risk; candidates should be
validated with the detailed diagnostic run, transaction costs and a separate
forward period before any live change.
