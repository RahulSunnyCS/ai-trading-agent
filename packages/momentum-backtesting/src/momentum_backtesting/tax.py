"""Indian capital-gains tax on each sale, so paid tax stops compounding.

Rates are the FY 2026-27 rules as best I could verify. Listed equity (STCG 20%, LTCG 12.5% after
12 months) and debt funds bought after April 2023 (always slab rate) are confirmed. Gold, silver
and international ETFs are ASSUMED: slab rate for short-term, 12.5% after 12 months. Check
those with a tax adviser - the rates are settings, not facts. Not modelled: the Rs 1.25 lakh
annual LTCG exemption (holds average ~11 weeks so almost every gain is short-term), surcharge,
and the 8-year loss carry-forward limit (the whole history is 9 years).

Loss set-off: a short-term loss offsets any gain; a long-term loss offsets only long-term gains.
Losses carry forward without limit across years, which is slightly generous.
"""

from dataclasses import dataclass

EQUITY, GOLD_SILVER, INTERNATIONAL, DEBT = "equity", "gold_silver", "international", "debt"
TAX_CLASSES = {EQUITY, GOLD_SILVER, INTERNATIONAL, DEBT}


@dataclass(frozen=True)
class TaxRules:
    slab_rate: float = 0.30  # your marginal income-tax rate
    cess: float = 0.04  # health & education cess, added on top of every tax amount
    equity_stcg: float = 0.20
    ltcg: float = 0.125
    long_term_days: int = 365  # more than 12 months


@dataclass
class TaxLedger:
    rules: TaxRules
    short_loss: float = 0.0
    long_loss: float = 0.0
    paid: float = 0.0
    long_term_sales: int = 0
    sales: int = 0

    def sale(self, tax_class: str, gain: float, held_days: int) -> float:
        """Tax due on selling a position (in the same units as `gain`). Updates loss pools."""
        rules = self.rules
        long_term = tax_class != DEBT and held_days > rules.long_term_days
        self.sales += 1
        self.long_term_sales += long_term
        if gain <= 0:
            if long_term:
                self.long_loss -= gain
            else:
                self.short_loss -= gain
            return 0.0

        if long_term:
            used = min(gain, self.long_loss)
            self.long_loss -= used
            gain -= used
        used = min(gain, self.short_loss)
        self.short_loss -= used
        gain -= used

        if long_term:
            rate = rules.ltcg
        elif tax_class == EQUITY:
            rate = rules.equity_stcg
        else:
            rate = rules.slab_rate
        tax = gain * rate * (1 + rules.cess)
        self.paid += tax
        return tax


def benchmark_after_tax(total_return: float, rules: TaxRules) -> float:
    """Buy-and-hold Nifty 50 sold at the end after more than 12 months: LTCG on the whole gain."""
    if total_return <= 0:
        return total_return
    return total_return * (1 - rules.ltcg * (1 + rules.cess))


def cash_after_tax(total_return: float, rules: TaxRules) -> float:
    """A liquid fund held throughout, taxed at the slab rate when finally redeemed."""
    if total_return <= 0:
        return total_return
    return total_return * (1 - rules.slab_rate * (1 + rules.cess))
