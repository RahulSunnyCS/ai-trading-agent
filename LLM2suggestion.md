# LLM Evaluation: Trading Strategy Constraints & Constructive Feedback

This document outlines the core structural issues within the proposed AI-Powered Options Trading Optimization System and provides actionable, quantitative recommendations for resolving them.

---

## 1. The Execution Illusion: Slippage & Liquidity Assumptions

**The Assertion:** *Nifty and Sensex options are highly liquid near the ATM, therefore a static 0.5% - 0.8% slippage model is safe to assume in backtesting.*

### The Problem
While ATM Nifty/Sensex options are globally among the most liquid derivatives under **normal** conditions, your specific strategy targets the most abnormal conditions possible: **momentum exhaustion**. 
By definition, you are attempting to execute trades immediately following a sudden >10% straddle expansion when acceleration is peaking and sharply reversing.

1.  **The Liquidity Vacuum:** During sudden breakouts or gamma squeezes, High-Frequency Trading (HFT) liquidity providers pull their quotes to avoid adverse selection. The "normal" 1-tick bid-ask spread vanishes.
2.  **Averages Mask Tail Risks:** A 0.8% slippage assumption is accurate for 95% of trades (regular entries and exits). However, short-option strategies are destroyed by the 5% of trades that trigger a stop loss during a tail-risk event. 
3.  **Stop-Loss Execution:** When your short straddle gets caught in a 50-point violent spike, your 15% stop loss is triggered. Sending a market order into a thinned-out order book during a momentum surge means you will not get filled at 15%. Slippage in these specific tail moments will frequently exceed 5% to 15% of the option premium. 

### The Solution
*   **Dynamic Slippage Modeling:** Do not use a flat percentage. Use a dynamic slippage model that increases slippage proportionally to the 1-minute Rate of Change (ROC). 
*   **Level-2 Tick Data Validation:** Paper trading APIs (like Quantiply) will give you fills matching the Last Traded Price (LTP). This is dangerously misleading. You must validate the strategy by running it against historical Level-2 depth-of-market tick data to calculate exactly what bid-price was available when your exhaustion signal fired.

---

## 2. The Overfitting Engine: Machine "Learning" vs. Parameter Drift

**The Assertion:** *Over a 3-year timeline, the automated retrospection engine will learn from its victories and mistakes, continually evolving "better" personality parameters (like a human trader).*

### The Problem
The retrospection engine described in the Tech Specs is an automated parameter-tweaking loop, not true learning. It is actively harmful to long-term adaptability.

1.  **Trailing PnL Optimization (Chasing Ghosts):** The system adjusts parameters (e.g., minimum probability, maximum trades) based on trailing 30-day performance. Because global markets are **non-stationary**, they transition through distinct, unpredictable regimes (High Vol, Low Vol, Trending, Mean-Reverting).
2.  **Optimizing for the Past:** If the system suffers a 30-day drawdown due to a highly directional trend, the engine will aggressively tighten trade frequencies and probabilities. If the very next month shifts to a range-bound, mean-reverting environment (ideal for straddles), the system will sit idle because its parameters are optimized to survive the *previous* regime.
3.  **Correlation vs. Causality:** A human trader internalizes context (e.g., "Implied volatility was over-priced because of the budget, so I sat out"). The bot merely sees "Win rate was 30%." It tries to fix the outcome by randomly throttling parameters up and down. Over three years, the bot won't ascend to a higher intelligence; it will perform a "random walk" in parameter space, consistently lagging behind market regime shifts.

### The Solution
*   **Regime-Conditioned Parameters:** Disable trailing-performance adjustments. Define 3 to 5 permanent, hard-coded "regimes" using structural market features (e.g., VIX Term Structure, ATR, Gap Magnitude thresholds).
*   **Dynamic Swapping:** Do not let the bot "evolve" parameters. Instead, the bot should detect the current macroeconomic sandbox (e.g., "VIX is expanding, ATR is elevated") and instantly deploy the personality specifically pre-built for that environment. Adaptation comes from correctly identifying the regime, not moving the goalposts of the strategy.

---

## 3. Structural Risk Recommendations

*   **Implement Greek-Based Stops:** Relying purely on a flat `maxLossPerTrade` (e.g., ₹4000) or a 15% option premium stop loss ignores structurally lethal positions. Calculate and monitor portfolio Delta and Gamma. If net Delta exceeds a hard threshold due to a directional breakout, exit the position immediately to cap compounding gamma risk—do not wait for the INR threshold to be breached.
*   **Minimize Infrastructure Complexity:** For a strategy generating ~10-15 trades per day analyzing 1-minute ticks, the currently proposed infrastructure (TimescaleDB, Redis Streams, Kafka equivalents, Bun) is dramatically over-engineered. Use a resilient monolithic worker script (Python/TypeScript) with an in-memory SQL database (like SQLite). Reducing network hops and point-of-failure dependencies guarantees a more robust production trading environment.
