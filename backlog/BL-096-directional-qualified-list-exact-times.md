# BL-096 Directional qualified list — exact entry times

Top three Directional configurations at every tested entry time, ranked
separately for NIFTY and SENSEX. The ranking is a balanced descriptive score
using holdout net P&L, win rate, drawdown, Ulcer Index, CVaR, expectancy and
MTM-stop frequency. The compact cells show average daily P&L and win rate;
full diagnostics remain in `results/diagnostic_metrics.csv`.

All figures are holdout averages and **before brokerage, statutory charges and
slippage**. `C1` and `C2` mean RE COST×1 and RE COST×2. `none` means no trail;
`10%/5%` and `15%/5%` are the trailing settings.

Starting at 09:17 in exact 15-minute increments ends at 15:17. An exact 15:15
entry is not part of the existing 1,200-row sweep.

## NIFTY

| Entry | #1 | #2 | #3 |
|---|---|---|---|
| 09:17 | ITM1 30%/₹4,000/C1/none (₹256/d, 54.2% WR) | ITM1 30%/₹4,000/C2/none (₹239/d, 52.9% WR) | ITM1 25%/₹4,000/C2/none (₹249/d, 52.1% WR) |
| 09:32 | ATM 30%/₹4,000/C2/none (₹278/d, 60.0% WR) | ATM 25%/₹3,500/C2/none (₹303/d, 55.8% WR) | ATM 25%/₹4,000/C2/none (₹293/d, 55.8% WR) |
| 09:47 | ATM 30%/₹4,000/C1/10%/5% (₹456/d, 63.3% WR) | ATM 30%/₹4,000/C1/none (₹443/d, 60.4% WR) | ITM1 25%/₹3,500/C1/none (₹528/d, 62.1% WR) |
| 10:02 | ATM 25%/₹4,000/C1/none (₹457/d, 62.9% WR) | ATM 25%/₹4,000/C2/none (₹418/d, 60.8% WR) | ATM 25%/₹4,000/C1/15%/5% (₹394/d, 62.1% WR) |
| 10:17 | ATM 30%/₹4,000/C2/none (₹401/d, 59.2% WR) | ATM 25%/₹3,500/C2/none (₹371/d, 59.6% WR) | ITM1 30%/₹4,000/C1/none (₹414/d, 63.3% WR) |
| 10:32 | ATM 30%/₹4,000/C1/10%/5% (₹390/d, 61.7% WR) | ITM1 30%/₹4,000/C2/none (₹450/d, 64.2% WR) | ATM 21%/₹3,000/C1/10%/5% (₹364/d, 60.4% WR) |
| 10:47 | ATM 30%/₹4,000/C1/10%/5% (₹590/d, 67.1% WR) | ATM 25%/₹3,500/C1/none (₹549/d, 68.3% WR) | ATM 25%/₹4,000/C1/15%/5% (₹548/d, 66.7% WR) |
| 11:02 | ITM1 25%/₹4,000/C2/none (₹778/d, 70.0% WR) | ITM1 25%/₹3,500/C2/none (₹757/d, 69.2% WR) | ITM1 25%/₹4,000/C1/none (₹763/d, 69.6% WR) |
| 11:17 | ATM 25%/₹4,000/C2/none (₹619/d, 63.7% WR) | ATM 25%/₹3,500/C2/none (₹607/d, 63.3% WR) | ITM1 25%/₹4,000/C2/none (₹662/d, 62.1% WR) |
| 11:32 | ITM1 30%/₹4,000/C1/10%/5% (₹550/d, 60.4% WR) | ITM1 25%/₹4,000/C1/15%/5% (₹593/d, 57.9% WR) | ATM 25%/₹4,000/C2/none (₹444/d, 60.0% WR) |
| 11:47 | ATM 25%/₹4,000/C2/none (₹536/d, 68.3% WR) | ATM 25%/₹4,000/C1/none (₹503/d, 67.1% WR) | ATM 25%/₹3,500/C2/none (₹478/d, 67.1% WR) |
| 12:02 | ATM 30%/₹4,000/C1/none (₹444/d, 67.5% WR) | ITM1 30%/₹4,000/C1/none (₹537/d, 65.0% WR) | ITM1 30%/₹4,000/C2/none (₹516/d, 63.3% WR) |
| 12:17 | ITM1 30%/₹4,000/C1/10%/5% (₹499/d, 65.0% WR) | ITM1 25%/₹4,000/C2/none (₹508/d, 64.2% WR) | ITM1 25%/₹4,000/C1/15%/5% (₹465/d, 64.2% WR) |
| 12:32 | ATM 30%/₹4,000/C1/none (₹299/d, 66.7% WR) | ITM1 30%/₹4,000/C1/10%/5% (₹332/d, 64.6% WR) | ATM 30%/₹4,000/C1/10%/5% (₹265/d, 61.7% WR) |
| 12:47 | ATM 30%/₹4,000/C2/none (₹342/d, 64.2% WR) | ATM 30%/₹4,000/C1/none (₹342/d, 64.2% WR) | ITM1 25%/₹4,000/C2/none (₹391/d, 61.7% WR) |
| 13:02 | ATM 30%/₹4,000/C1/10%/5% (₹355/d, 66.7% WR) | ATM 30%/₹4,000/C1/none (₹358/d, 68.8% WR) | ATM 21%/₹3,000/C1/none (₹380/d, 65.8% WR) |
| 13:17 | ATM 30%/₹4,000/C1/10%/5% (₹278/d, 60.0% WR) | ATM 30%/₹4,000/C1/none (₹290/d, 63.7% WR) | ITM1 25%/₹3,500/C1/none (₹333/d, 63.3% WR) |
| 13:32 | ATM 30%/₹4,000/C1/none (₹190/d, 60.8% WR) | ATM 25%/₹4,000/C1/none (₹200/d, 58.8% WR) | ATM 30%/₹4,000/C1/10%/5% (₹162/d, 58.8% WR) |
| 13:47 | ATM 30%/₹4,000/C1/none (₹277/d, 67.1% WR) | ATM 30%/₹4,000/C2/none (₹280/d, 67.1% WR) | ATM 25%/₹3,500/C1/none (₹237/d, 64.6% WR) |
| 14:02 | ITM1 30%/₹4,000/C2/none (₹180/d, 60.4% WR) | ITM1 30%/₹4,000/C1/none (₹159/d, 60.8% WR) | ITM1 30%/₹4,000/C1/10%/5% (₹147/d, 58.3% WR) |
| 14:17 | ATM 30%/₹4,000/C1/10%/5% (₹218/d, 62.9% WR) | ATM 25%/₹4,000/C1/none (₹198/d, 62.5% WR) | ITM1 25%/₹4,000/C2/none (₹281/d, 61.7% WR) |
| 14:32 | ATM 25%/₹3,500/C1/15%/5% (₹142/d, 57.1% WR) | ATM 25%/₹4,000/C1/15%/5% (₹138/d, 57.1% WR) | ITM1 30%/₹4,000/C2/none (₹208/d, 61.7% WR) |
| 14:47 | ATM 30%/₹4,000/C2/none (₹365/d, 72.1% WR) | ATM 30%/₹4,000/C1/none (₹349/d, 72.5% WR) | ATM 30%/₹4,000/C1/10%/5% (₹341/d, 70.4% WR) |
| 15:02 | ATM 21%/₹3,000/C1/none (₹197/d, 62.9% WR) | ATM 21%/₹3,000/C2/none (₹193/d, 62.9% WR) | ATM 21%/₹3,000/C1/10%/5% (₹202/d, 62.1% WR) |
| 15:17 | ATM 30%/₹4,000/C1/10%/5% (₹180/d, 68.8% WR) | ATM 30%/₹4,000/C2/none (₹179/d, 68.8% WR) | ITM1 21%/₹3,000/C1/10%/5% (₹170/d, 72.9% WR) |

## SENSEX

| Entry | #1 | #2 | #3 |
|---|---|---|---|
| 09:17 | ATM 25%/₹3,500/C1/15%/5% (₹449/d, 66.2% WR) | ATM 25%/₹4,000/C1/15%/5% (₹450/d, 66.7% WR) | ITM1 21%/₹3,000/C1/10%/5% (₹548/d, 60.0% WR) |
| 09:32 | ATM 25%/₹4,000/C1/15%/5% (₹546/d, 64.2% WR) | ATM 21%/₹3,000/C1/10%/5% (₹494/d, 60.8% WR) | ATM 25%/₹3,500/C1/15%/5% (₹453/d, 62.1% WR) |
| 09:47 | ATM 21%/₹3,000/C1/10%/5% (₹678/d, 62.1% WR) | ITM1 30%/₹4,000/C2/none (₹617/d, 67.1% WR) | ITM1 30%/₹4,000/C1/none (₹587/d, 67.1% WR) |
| 10:02 | ITM1 25%/₹3,500/C2/none (₹499/d, 63.3% WR) | ATM 30%/₹4,000/C2/none (₹473/d, 62.5% WR) | ITM1 25%/₹4,000/C2/none (₹481/d, 63.3% WR) |
| 10:17 | ITM1 25%/₹3,500/C2/none (₹625/d, 64.2% WR) | ATM 25%/₹3,500/C2/none (₹571/d, 63.7% WR) | ATM 25%/₹4,000/C2/none (₹568/d, 64.2% WR) |
| 10:32 | ITM1 25%/₹4,000/C2/none (₹671/d, 68.3% WR) | ITM1 25%/₹4,000/C1/15%/5% (₹701/d, 67.9% WR) | ITM1 25%/₹3,500/C1/15%/5% (₹667/d, 67.1% WR) |
| 10:47 | ITM1 30%/₹4,000/C1/10%/5% (₹656/d, 66.7% WR) | ITM1 25%/₹4,000/C2/none (₹577/d, 64.2% WR) | ITM1 25%/₹3,500/C1/15%/5% (₹625/d, 64.2% WR) |
| 11:02 | ITM1 30%/₹4,000/C2/none (₹622/d, 68.3% WR) | ITM1 30%/₹4,000/C1/10%/5% (₹644/d, 67.9% WR) | ATM 25%/₹4,000/C1/none (₹571/d, 67.1% WR) |
| 11:17 | ATM 30%/₹4,000/C1/10%/5% (₹558/d, 66.2% WR) | ITM1 30%/₹4,000/C1/10%/5% (₹577/d, 66.7% WR) | ATM 30%/₹4,000/C2/none (₹472/d, 66.2% WR) |
| 11:32 | ITM1 30%/₹4,000/C2/none (₹698/d, 71.7% WR) | ITM1 30%/₹4,000/C1/10%/5% (₹701/d, 68.3% WR) | ITM1 25%/₹3,500/C2/none (₹657/d, 68.8% WR) |
| 11:47 | ITM1 30%/₹4,000/C2/none (₹555/d, 67.5% WR) | ITM1 30%/₹4,000/C1/none (₹552/d, 68.3% WR) | ITM1 21%/₹3,000/C1/10%/5% (₹606/d, 63.7% WR) |
| 12:02 | ATM 25%/₹4,000/C1/none (₹404/d, 62.5% WR) | ATM 21%/₹3,000/C1/10%/5% (₹456/d, 63.3% WR) | ITM1 21%/₹3,000/C1/10%/5% (₹505/d, 61.7% WR) |
| 12:17 | ATM 21%/₹3,000/C1/none (₹440/d, 66.2% WR) | ITM1 21%/₹3,000/C2/none (₹502/d, 64.6% WR) | ATM 30%/₹4,000/C1/10%/5% (₹384/d, 62.9% WR) |
| 12:32 | ATM 30%/₹4,000/C1/10%/5% (₹382/d, 64.2% WR) | ITM1 21%/₹3,000/C1/10%/5% (₹375/d, 58.8% WR) | ITM1 25%/₹3,500/C1/none (₹346/d, 63.3% WR) |
| 12:47 | ATM 25%/₹3,500/C1/none (₹394/d, 65.0% WR) | ITM1 30%/₹4,000/C2/none (₹409/d, 65.0% WR) | ATM 25%/₹4,000/C1/none (₹378/d, 65.0% WR) |
| 13:02 | ITM1 30%/₹4,000/C1/10%/5% (₹304/d, 61.3% WR) | ITM1 30%/₹4,000/C2/none (₹353/d, 65.8% WR) | ATM 30%/₹4,000/C2/none (₹298/d, 63.7% WR) |
| 13:17 | ITM1 30%/₹4,000/C1/10%/5% (₹348/d, 61.3% WR) | ITM1 30%/₹4,000/C2/none (₹353/d, 62.9% WR) | ITM1 25%/₹4,000/C2/none (₹343/d, 63.3% WR) |
| 13:32 | ATM 30%/₹4,000/C1/10%/5% (₹324/d, 61.3% WR) | ATM 30%/₹4,000/C2/none (₹334/d, 62.5% WR) | ATM 30%/₹4,000/C1/none (₹322/d, 62.5% WR) |
| 13:47 | ITM1 25%/₹4,000/C1/none (₹193/d, 60.8% WR) | ATM 25%/₹4,000/C1/15%/5% (₹178/d, 60.4% WR) | ITM1 25%/₹3,500/C1/none (₹198/d, 60.8% WR) |
| 14:02 | ATM 25%/₹4,000/C2/none (₹160/d, 61.3% WR) | ITM1 25%/₹4,000/C2/none (₹176/d, 61.7% WR) | ATM 21%/₹3,000/C2/none (₹133/d, 57.5% WR) |
| 14:17 | ATM 25%/₹4,000/C1/none (₹150/d, 62.5% WR) | ATM 25%/₹3,500/C1/none (₹147/d, 62.5% WR) | ATM 25%/₹4,000/C2/none (₹148/d, 60.8% WR) |
| 14:32 | ATM 25%/₹4,000/C2/none (₹132/d, 62.9% WR) | ITM1 25%/₹4,000/C2/none (₹159/d, 64.2% WR) | ATM 21%/₹3,000/C2/none (₹153/d, 62.5% WR) |
| 14:47 | ITM1 25%/₹3,500/C2/none (₹374/d, 68.3% WR) | ITM1 25%/₹4,000/C2/none (₹374/d, 68.3% WR) | ITM1 30%/₹4,000/C1/10%/5% (₹386/d, 66.7% WR) |
| 15:02 | ATM 30%/₹4,000/C2/none (₹202/d, 65.8% WR) | ATM 25%/₹3,500/C2/none (₹193/d, 67.1% WR) | ATM 25%/₹4,000/C2/none (₹193/d, 67.1% WR) |
| 15:17 | ATM 25%/₹3,500/C1/15%/5% (₹169/d, 66.2% WR) | ATM 25%/₹4,000/C1/15%/5% (₹169/d, 66.2% WR) | ITM1 25%/₹3,500/C1/15%/5% (₹163/d, 72.9% WR) |

These are selection candidates, not automatic live rules. Selecting a separate
winner for every 15-minute slot increases data-snooping risk, so the broader
time-band and fit-to-holdout stability checks should remain the deployment
gate.
