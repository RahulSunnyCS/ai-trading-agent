"""Tags for the stocks outside the 755-name Total Market (`curated/stock_groups_wide.csv`).

The curated file (`stock_groups.csv`) tags only the Nifty Total Market names, so in category mode
the other ~2,000 liquid NSE stocks can never be bought. This builds the missing tags from BSE's
own four-level classification (Sector > Industry > Industry Group > Sub-group), fetched once per
company by ISIN. Rules, in order:

1. A stock whose BSE class matches an already-curated category with a clear majority of curated
   stocks (>= MIN_VOTERS of them, >= MIN_PURITY agreeing) joins that category.
2. Otherwise it joins a new category named after its BSE class, at the finest level that has at
   least MIN_MEMBERS stocks (sub-group, then industry group, then industry, then sector).

Tags are the CURRENT classification applied to every year, the same convention as the curated
file's `constant_current` tier; a stock that later changed business keeps its present tag.
"""

from __future__ import annotations

import csv
from collections import Counter, defaultdict
from collections.abc import Iterable
from pathlib import Path

MIN_VOTERS = 4  # curated stocks needed before a BSE class can be mapped onto a curated category
MIN_PURITY = 0.7  # share of those voters that must sit in the same curated category
MIN_MEMBERS = 4  # smallest category the wider file will create
WIDE_SUFFIX = " (wider universe)"
NOTE = "BSE classification (current), applied to all years"
COLUMNS = ("parent_group", "subgroup", "symbol", "company_name", "note")

# A BSE class is (sector, industry, industry_group, sub_group); empty strings are allowed.
Klass = tuple[str, str, str, str]


def _levels(k: Klass) -> list[Klass]:
    """Finest to coarsest: the class itself, then the same with the lower levels blanked."""
    sector, industry, group, sub = k
    return [
        (sector, industry, group, sub),
        (sector, industry, group, ""),
        (sector, industry, "", ""),
        (sector, "", "", ""),
    ]


def _label(k: Klass) -> str:
    return next(x for x in reversed(k) if x)


def build_rows(
    classes: dict[str, Klass],
    curated: dict[str, set[str]],
    names: dict[str, str],
    candidates: Iterable[str],
) -> list[dict[str, str]]:
    """Rows for `stock_groups_wide.csv`.

    `classes`: symbol -> BSE class, for every symbol that has one (curated and candidate alike).
    `curated`: category id ("parent :: subgroup") -> its curated members.
    `candidates`: the symbols to tag (those with no curated tag). Symbols without a BSE class are
    left untagged."""
    tagged = {s for members in curated.values() for s in members}
    # votes[level_key] -> Counter of curated category ids, over curated stocks with that class
    votes: dict[Klass, Counter[str]] = defaultdict(Counter)
    voters: dict[Klass, set[str]] = defaultdict(set)
    for cid, members in curated.items():
        for s in members:
            if s in classes:
                for lv in _levels(classes[s]):
                    votes[lv][cid] += 1
                    voters[lv].add(s)

    todo = sorted(s for s in set(candidates) if s in classes and s not in tagged)
    assigned: dict[str, tuple[str, str]] = {}
    for s in todo:
        for lv in _levels(classes[s]):
            n = len(voters.get(lv, ()))
            if n >= MIN_VOTERS:
                cid, count = votes[lv].most_common(1)[0]
                if count / n >= MIN_PURITY:
                    parent, _, sub = cid.partition(" :: ")
                    assigned[s] = (parent, sub)
                    break
            # an impure class at this level will not get purer when blurred to a coarser one in a
            # useful way, but a coarser level can still be a clear majority, so keep going
    rest = [s for s in todo if s not in assigned]

    # Size each BSE class among the unassigned stocks, then pick the finest level with enough.
    size: Counter[Klass] = Counter()
    for s in rest:
        for lv in _levels(classes[s]):
            size[lv] += 1
    for s in rest:
        chosen = _levels(classes[s])[-1]
        for lv in _levels(classes[s]):
            if size[lv] >= MIN_MEMBERS:
                chosen = lv
                break
        sector = chosen[0] or "Unclassified"
        assigned[s] = (sector, (_label(chosen) if any(chosen[1:]) else "General") + WIDE_SUFFIX)

    return [
        {
            "parent_group": parent,
            "subgroup": sub,
            "symbol": s,
            "company_name": names.get(s, s),
            "note": NOTE,
        }
        for s, (parent, sub) in sorted(assigned.items())
    ]


# --- semantic merges ----------------------------------------------------------------------------
# BSE splits industries finely (e.g. "Auto Components" and "Auto Components & Equipments"), and
# many of its groups are the same industry as an original curated category. Each entry maps a BSE
# category (parent, label without WIDE_SUFFIX) to where its stocks should go: an existing curated
# category id ("Parent :: Subgroup"), or a new wider-universe name (parent, label). Reviewed by hand
# member-by-member; anything not listed keeps its own category. The curated file itself is never
# changed (arm A's results and every saved favourite depend on it).
C = "Consumer Discretionary"
MERGES: dict[tuple[str, str], str | tuple[str, str]] = {
    # Auto
    (
        C,
        "Auto Components & Equipments",
    ): "Automobiles & Auto Components :: Auto Components – Ancillary & Precision Parts",
    (
        C,
        "Auto Components",
    ): "Automobiles & Auto Components :: Auto Components – Ancillary & Precision Parts",
    (
        C,
        "Automobiles",
    ): "Automobiles & Auto Components :: Passenger & Commercial Vehicle OEMs (Other)",
    (
        "Industrials",
        "Agricultural, Commercial & Construction Vehicles",
    ): "Automobiles & Auto Components :: Passenger & Commercial Vehicle OEMs (Other)",
    # Textiles, building products, durables
    (C, "Other Textile Products"): "Textiles :: Apparel, Yarn & Home Textiles",
    (C, "Garments & Apparels"): "Textiles :: Apparel, Yarn & Home Textiles",
    (C, "Textiles & Apparels"): "Textiles :: Apparel, Yarn & Home Textiles",
    (C, "Residential, Commercial Projects"): "Realty :: Real Estate Developers (Other)",
    (C, "Paints"): "Consumer Durables :: Paints",
    (C, "Gems, Jewellery And Watches"): "Consumer Durables :: Diamonds, Gems & Jewellery",
    (C, "Household Appliances"): "Consumer Durables :: Consumer Electricals & Home Appliances",
    (C, "Consumer Electronics"): "Consumer Durables :: Consumer Electricals & Home Appliances",
    (C, "Ceramics"): "Consumer Durables :: Tiles, Sanitaryware & Plywood",
    (C, "Plywood Boards/ Laminates"): "Consumer Durables :: Tiles, Sanitaryware & Plywood",
    (C, "Consumer Durables"): (C, "Consumer Durables - Other"),
    ("Commodities", "Other Construction Materials"): "Construction Materials :: Cement",
    ("Commodities", "Cement & Cement Products"): "Construction Materials :: Cement",
    # Consumer services and media
    (C, "Hotels & Resorts"): "Consumer Services :: Hotels & Hospitality",
    (C, "Restaurants"): "Consumer Services :: Quick Service Restaurants (QSR)",
    (C, "Retailing"): "Consumer Services :: New-age Internet & E-commerce Platforms",
    (C, "Diversified Retail"): (C, "Retail (Diversified & Specialty)"),
    (C, "Speciality Retail"): (C, "Retail (Diversified & Specialty)"),
    (C, "Leisure Services"): (C, "Leisure & Recreation"),
    (C, "Amusement Parks/ Other Recreation"): (C, "Leisure & Recreation"),
    (C, "Education"): (C, "Education & Other Consumer Services"),
    (C, "Other Consumer Services"): (C, "Education & Other Consumer Services"),
    (
        C,
        "TV Broadcasting & Software Production",
    ): "Media & Entertainment :: Broadcasting, Cinema & Music",
    (C, "Entertainment"): "Media & Entertainment :: Broadcasting, Cinema & Music",
    (C, "Media & Entertainment"): "Media & Entertainment :: Broadcasting, Cinema & Music",
    (C, "Print Media"): (C, "Print, Publishing & Advertising"),
    (C, "Media"): (C, "Print, Publishing & Advertising"),
    (C, "Media, Entertainment & Publication"): (C, "Print, Publishing & Advertising"),
    # Industrials
    (
        "Industrials",
        "Civil Construction",
    ): "Construction & Infrastructure :: Roads, Highways & Civil Construction (EPC)",
    (
        "Industrials",
        "Iron & Steel Products",
    ): "Capital Goods :: Specialty Steel & Metal Pipes (Capital Goods-classified)",
    ("Industrials", "Packaging"): "Capital Goods :: Plastics, Pipes & Industrial Packaging",
    (
        "Industrials",
        "Plastic Products - Industrial",
    ): "Capital Goods :: Plastics, Pipes & Industrial Packaging",
    (
        "Industrials",
        "Heavy Electrical Equipment",
    ): "Capital Goods :: Power Transmission & Electrical Equipment (Other)",
    (
        "Industrials",
        "Other Electrical Equipment",
    ): "Capital Goods :: Power Transmission & Electrical Equipment (Other)",
    ("Industrials", "Cables - Electricals"): "Capital Goods :: Power Cables",
    ("Industrials", "Aluminium, Copper & Zinc Products"): "Capital Goods :: Power Cables",
    ("Industrials", "Aerospace & Defense"): "Capital Goods :: Defence Equipment & Shipbuilding",
    (
        "Industrials",
        "Compressors, Pumps & Diesel Engines",
    ): "Capital Goods :: Industrial Pumps & Fluid Control Equipment",
    (
        "Industrials",
        "Castings & Forgings",
    ): "Capital Goods :: Industrial & Precision Engineering Machinery",
    (
        "Industrials",
        "Industrial Manufacturing",
    ): "Capital Goods :: Railway Equipment & Rolling Stock",
    ("Industrials", "Industrial Products"): ("Industrials", "Industrial Products (General)"),
    ("Industrials", "Other Industrial Products"): ("Industrials", "Industrial Products (General)"),
    ("Industrials", "Electrodes & Refractories"): (
        "Industrials",
        "Refractories, Electrodes & Rubber Products",
    ),
    ("Industrials", "Rubber"): ("Industrials", "Refractories, Electrodes & Rubber Products"),
    # Commodities and chemicals
    ("Commodities", "Specialty Chemicals"): "Chemicals :: Specialty, Fine & Industrial Chemicals",
    (
        "Commodities",
        "Pesticides & Agrochemicals",
    ): "Chemicals :: Fertilizers & Agrochemicals (PSU/Large-cap)",
    ("Commodities", "Fertilizers"): "Chemicals :: Fertilizers & Agrochemicals (PSU/Large-cap)",
    ("Commodities", "Commodity Chemicals"): ("Commodities", "Commodity Chemicals & Petrochemicals"),
    ("Commodities", "Chemicals & Petrochemicals"): (
        "Commodities",
        "Commodity Chemicals & Petrochemicals",
    ),
    ("Commodities", "Petrochemicals"): ("Commodities", "Commodity Chemicals & Petrochemicals"),
    ("Commodities", "Dyes And Pigments"): ("Commodities", "Commodity Chemicals & Petrochemicals"),
    ("Commodities", "Paper & Paper Products"): "Forest Materials :: Paper",
    ("Commodities", "Ferrous Metals"): "Metals & Mining :: Ferro Alloys, Steel & Mining (Other)",
    (
        "Commodities",
        "Non - Ferrous Metals",
    ): "Metals & Mining :: Ferro Alloys, Steel & Mining (Other)",
    ("Commodities", "Metals & Mining"): "Metals & Mining :: Ferro Alloys, Steel & Mining (Other)",
    # FMCG
    ("Fast Moving Consumer Goods", "Sugar"): "FMCG :: Sugar",
    ("Fast Moving Consumer Goods", "Dairy Products"): "FMCG :: Dairy",
    ("Fast Moving Consumer Goods", "Breweries & Distilleries"): "FMCG :: Alcoholic Beverages",
    ("Fast Moving Consumer Goods", "Stationary"): "FMCG :: Stationery & Other FMCG",
    (
        "Fast Moving Consumer Goods",
        "Packaged Foods",
    ): "FMCG :: Packaged Foods, Agri-Commodities & Edible Oils",
    (
        "Fast Moving Consumer Goods",
        "Food Products",
    ): "FMCG :: Packaged Foods, Agri-Commodities & Edible Oils",
    (
        "Fast Moving Consumer Goods",
        "Other Agricultural Products",
    ): "FMCG :: Packaged Foods, Agri-Commodities & Edible Oils",
    (
        "Fast Moving Consumer Goods",
        "Agricultural Food & other Products",
    ): "FMCG :: Packaged Foods, Agri-Commodities & Edible Oils",
    (
        "Fast Moving Consumer Goods",
        "Tea & Coffee",
    ): "FMCG :: Packaged Foods, Agri-Commodities & Edible Oils",
    ("Fast Moving Consumer Goods", "Fast Moving Consumer Goods"): (
        "Fast Moving Consumer Goods",
        "FMCG - Other",
    ),
    ("Fast Moving Consumer Goods", "Household Products"): (
        "Fast Moving Consumer Goods",
        "FMCG - Other",
    ),
    # Financials
    (
        "Financial Services",
        "Non Banking Financial Company (NBFC)",
    ): "Financials :: Diversified & Retail Lending NBFCs",
    ("Financial Services", "Housing Finance Company"): "Financials :: Housing Finance NBFCs",
    ("Financial Services", "Microfinance Institutions"): "Financials :: Microfinance Institutions",
    ("Financial Services", "Stockbroking & Allied"): "Financials :: Capital Markets & Broking",
    ("Financial Services", "Capital Markets"): "Financials :: Capital Markets & Broking",
    ("Financial Services", "Other Financial Services"): "Financials :: Capital Markets & Broking",
    (
        "Financial Services",
        "Investment Company",
    ): "Financials :: Broking, Wealth & Investment Holding Companies",
    (
        "Financial Services",
        "Holding Company",
    ): "Financials :: Broking, Wealth & Investment Holding Companies",
    ("Financial Services", "Banks"): "Financials :: Small & Regional Banks",
    ("Financial Services", "Other Bank"): "Financials :: Small Finance Banks",
    (
        "Financial Services",
        "Financial Technology (Fintech)",
    ): "Financials :: Fintech & Digital Payments",
    ("Financial Services", "Finance"): "Financials :: PSU Development Financial Institutions",
    ("Financial Services", "Financial Services"): "Financials :: Life & General Insurance",
    # Healthcare
    (
        "Healthcare",
        "Pharmaceuticals",
    ): "Healthcare :: Pharmaceuticals – Formulations & Generics (Mid/Small-cap)",
    ("Healthcare", "Hospital"): "Healthcare :: Hospitals",
    ("Healthcare", "Healthcare Service Provider"): "Healthcare :: Diagnostics",
    ("Healthcare", "Medical Equipment & Supplies"): (
        "Healthcare",
        "Medical Equipment & Healthcare Services",
    ),
    ("Healthcare", "Healthcare Services"): (
        "Healthcare",
        "Medical Equipment & Healthcare Services",
    ),
    # IT, services
    (
        "Information Technology",
        "Computers - Software & Consulting",
    ): "Information Technology :: IT Services – Mid & Small-cap",
    (
        "Information Technology",
        "IT Enabled Services",
    ): "Information Technology :: IT-Enabled Services & BPM",
    (
        "Information Technology",
        "Software Products",
    ): "Information Technology :: Software Products, Analytics & Platforms",
    (
        "Services",
        "Business Process Outsourcing (BPO)/ Knowledge Process Outsourcing (KPO)",
    ): "Services :: Business Process Outsourcing & Managed Services",
    ("Services", "Logistics Solution Provider"): "Services :: Logistics, Freight & Supply Chain",
    ("Services", "Shipping"): "Services :: Shipping",
    (
        "Services",
        "Transport Infrastructure",
    ): "Services :: Diversified Trading, Facilities & Transport Infra Services",
    (
        "Services",
        "Transport Services",
    ): "Services :: Diversified Trading, Facilities & Transport Infra Services",
    (
        "Services",
        "Trading & Distributors",
    ): "Services :: Diversified Trading, Facilities & Transport Infra Services",
    (
        "Services",
        "Diversified Commercial Services",
    ): "Services :: Diversified Trading, Facilities & Transport Infra Services",
    (
        "Services",
        "Commercial Services & Supplies",
    ): "Services :: Diversified Trading, Facilities & Transport Infra Services",
    (
        "Services",
        "Services",
    ): "Services :: Diversified Trading, Facilities & Transport Infra Services",
    # Energy, utilities, telecom, diversified
    (
        "Energy",
        "Lubricants",
    ): "Oil, Gas & Consumable Fuels :: Refining, Storage & Terminals (Other)",
    ("Energy", "Oil Exploration & Production"): ("Energy", "Oil Exploration, Drilling & Services"),
    ("Energy", "Offshore Support Solution Drilling"): (
        "Energy",
        "Oil Exploration, Drilling & Services",
    ),
    ("Energy", "Oil"): ("Energy", "Oil Exploration, Drilling & Services"),
    ("Energy", "LPG/CNG/PNG/LNG Supplier"): ("Energy", "Gas Distribution & Fuel Trading"),
    ("Energy", "Gas"): ("Energy", "Gas Distribution & Fuel Trading"),
    ("Energy", "Oil, Gas & Consumable Fuels"): ("Energy", "Gas Distribution & Fuel Trading"),
    (
        "Utilities",
        "Power Generation",
    ): "Power & Energy :: Power Generation & Trading (Renewable/Other)",
    ("Utilities", "Power"): "Power & Energy :: Power Generation & Distribution (Large-cap)",
    ("Utilities", "Other Utilities"): "Utilities :: Environmental & Utility Services (Other)",
    ("Telecommunication", "Telecom - Services"): "Telecommunications :: Telecom Services",
    (
        "Telecommunication",
        "Telecommunication",
    ): "Telecommunications :: Telecom Equipment, Networking & Infrastructure",
    ("Diversified", "General"): "Diversified :: Diversified Conglomerates",
}


def apply_merges(rows: list[dict[str, str]], curated_ids: set[str]) -> list[dict[str, str]]:
    """Re-home each row per MERGES. Unlisted categories are kept as they are. A curated target must
    exist in the curated file (raises otherwise, so a typo cannot silently create a lookalike)."""
    out = []
    for r in rows:
        base = r["subgroup"].removesuffix(WIDE_SUFFIX)
        target = MERGES.get((r["parent_group"], base))
        if target is None:
            out.append(r)
        elif isinstance(target, str):
            if target not in curated_ids:
                raise KeyError(f"merge target is not a curated category: {target!r}")
            parent, _, sub = target.partition(" :: ")
            out.append({**r, "parent_group": parent, "subgroup": sub})
        else:
            parent, sub = target
            out.append({**r, "parent_group": parent, "subgroup": sub + WIDE_SUFFIX})
    return out


def write_rows(rows: list[dict[str, str]], path: Path) -> None:
    with path.open("w", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=COLUMNS)
        writer.writeheader()
        writer.writerows(rows)
