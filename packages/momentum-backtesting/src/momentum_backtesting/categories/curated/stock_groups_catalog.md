# Stock groups catalog — parent groups & subgroups

Source: `stock_groups.csv` in this directory, built 2026-09-29 from the NSE Nifty Total Market universe (755 names = Nifty 500 + Nifty Microcap 250, fetched via `categories/sources.py`'s `fetch_total_market`). Every stock in the 755-name universe gets a **parent group** (broad sector) and at least one **subgroup** (fine-grained sub-industry); a stock can and does belong to more than one subgroup (many-to-many, by design — e.g. a stock tagged in both an official Nifty sub-index and a stockscans.in custom category keeps both tags).

This is a **data file only** — same boundary as `category_extras.csv` and the rest of `categories/`: it is not wired into the ranking engine, the backtest CLI, or the UI. See `categories/__init__.py`'s module docstring.

## Classification provenance (priority order used to build this file)

1. **`category_extras.csv` reuse** — the existing 46-category stockscans.in hand-tagging (remapped into this file's parent/subgroup structure where a name fits, e.g. its "PSU Banks (custom)" category becomes this file's `Financials / PSU Banks`).
2. **Official Nifty sector/thematic index** — the 16 index constituent lists already fetched by `categories/sources.py` (Nifty Bank, Nifty IT, Nifty Metal, etc.), used directly, or split by the NSE Industry field where one official index spans several distinct real subgroups (e.g. Nifty Energy → Power Generation / Oil & Gas / Power Equipment).
3. **NSE Industry field** — the `Industry` column that ships with the Total Market fetch itself (22 distinct values across all 755 names) — real, sourced NSE classification, used as a per-parent catch-all subgroup where a finer split wasn't confidently possible.
4. **Own research** — well-known, easily-defensible large/mid-cap companies manually grouped into named sub-industries (e.g. splitting the 121-name "Financial Services" NSE industry into Life & General Insurance, Housing Finance NBFCs, PSU Banks, etc.). Never applied to an obscure micro-cap with no real basis for a specific call.
5. **Uncategorized catch-all** — a small number of genuinely unclear micro-caps, plus NSE's own temporary placeholder/dummy listings issued during corporate actions (these are not operating companies at all).

## Summary

- **24 parent groups**, **113 subgroups**, covering all **755 of 755** Total Market names
- **825 total (subgroup, symbol) rows** — 65 symbols appear in more than one subgroup (70 extra membership rows)
- Subgroup size ranges from 1 to 25 stocks; no fixed size was forced — a distinct real niche stays its own subgroup even at 1-3 stocks, and a genuinely broad, evenly-supported sector stays large (up to 25) rather than being split arbitrarily

## All parent groups & subgroups

| Parent Group | Subgroup | Stocks | Example tickers | Primary source |
|---|---|---|---|---|
| Financials | Capital Markets & Broking | 17 | 360ONE, ABSLAMC, ANANDRATHI | official Nifty sector/thematic index |
| Financials | Diversified & Retail Lending NBFCs | 13 | ABCAPITAL, BAJAJFINSV, BAJFINANCE | own research (well-known company) |
| Financials | Broking, Wealth & Investment Holding Companies | 12 | AIIL, BAJAJHLDNG, CHOICEIN | own research (well-known company) |
| Financials | Life & General Insurance | 12 | CANHLIFE, GICRE, GODIGIT | own research (well-known company) |
| Financials | PSU Banks | 12 | BANKBARODA, BANKINDIA, CANBK | category_extras.csv (stockscans.in) |
| Financials | Housing Finance NBFCs | 10 | AADHARHFC, AAVAS, APTUS | category_extras.csv (stockscans.in) (+1 more) |
| Financials | Private Banks | 10 | AXISBANK, BANDHANBNK, FEDERALBNK | category_extras.csv (stockscans.in) (+1 more) |
| Financials | Fintech & Digital Payments | 7 | CCAVENUE, JIOFIN, PAYTM | own research (well-known company) |
| Financials | Small & Regional Banks | 7 | CUB, DCBBANK, J&KBANK | own research (well-known company) |
| Financials | Asset Management Companies (AMC) | 6 | ABSLAMC, CRAMC, HDFCAMC | category_extras.csv (stockscans.in) |
| Financials | Gold Loan Finance NBFCs | 5 | CSBBANK, FEDFINA, IIFL | category_extras.csv (stockscans.in) |
| Financials | PSU Development Financial Institutions | 5 | IFCI, IREDA, IRFC | own research (well-known company) |
| Financials | Commercial Vehicle Finance NBFCs | 4 | CHOLAFIN, M&MFIN, SHRIRAMFIN | category_extras.csv (stockscans.in) |
| Financials | Small Finance Banks | 4 | AUBANK, EQUITASBNK, JSFB | category_extras.csv (stockscans.in) |
| Financials | Credit Rating Agencies | 1 | CRISIL | category_extras.csv (stockscans.in) |
| Financials | Microfinance Institutions | 1 | CREDITACC | category_extras.csv (stockscans.in) |
| Capital Goods | Industrial & Precision Engineering Machinery | 23 | ACE, AIAENG, ANUP | own research (well-known company) |
| Capital Goods | Defence Equipment & Shipbuilding | 19 | AEQUS, APOLLO, ASTRAMICRO | official Nifty sector/thematic index |
| Capital Goods | Specialty Steel & Metal Pipes (Capital Goods-classified) | 13 | APLAPOLLO, ELECTCAST, GALLANTT | own research (well-known company) |
| Capital Goods | Power Equipment & Renewables (Large-cap) | 10 | ABB, BHEL, CGPOWER | official Nifty sector/thematic index |
| Capital Goods | Solar & Renewable Energy Equipment Manufacturing | 10 | BORORENEW, EMMVEE, PREMIERENE | category_extras.csv (stockscans.in) (+1 more) |
| Capital Goods | Power Transmission Equipment | 8 | APARINDS, KEI, POLYCAB | category_extras.csv (stockscans.in) |
| Capital Goods | Power Cables | 7 | APARINDS, DIACABS, FINCABLES | category_extras.csv (stockscans.in) (+1 more) |
| Capital Goods | Industrial Pumps & Fluid Control Equipment | 6 | KIRLOSBROS, KIRLOSENG, KIRLPNU | own research (well-known company) |
| Capital Goods | Plastics, Pipes & Industrial Packaging | 6 | ASTRAL, EPL, FINPIPE | own research (well-known company) |
| Capital Goods | Transformers & CRGO Steel | 6 | ABB, CGPOWER, POWERINDIA | category_extras.csv (stockscans.in) |
| Capital Goods | Precision Aerospace, Defence-adjacent & Railway Engineering | 5 | AZAD, BALUFORGE, INOXINDIA | own research (well-known company) |
| Capital Goods | Power Transmission & Electrical Equipment (Other) | 4 | ATLANTAELE, QPOWER, SCHNEIDER | own research (well-known company) |
| Capital Goods | Railway Equipment & Rolling Stock | 4 | HBLENGINE, JWL, RVNL | category_extras.csv (stockscans.in) |
| Capital Goods | Heavy Engineering Equipment | 3 | GMMPFAUDLR, PRAJIND, THERMAX | category_extras.csv (stockscans.in) |
| Healthcare | Hospitals & Diversified Healthcare (Large-cap) | 20 | ABBOTINDIA, ALKEM, APOLLOHOSP | official Nifty sector/thematic index |
| Healthcare | Pharmaceuticals – Large & Mid-cap | 20 | ABBOTINDIA, AJANTPHARM, ALKEM | official Nifty sector/thematic index |
| Healthcare | CDMO (Contract Dev. & Mfg. Organisations) | 18 | ACUTAAS, AKUMS, ANTHEM | category_extras.csv (stockscans.in) (+1 more) |
| Healthcare | Pharmaceuticals – Formulations & Generics (Mid/Small-cap) | 18 | AARTIDRUGS, AARTIPHARM, ADVENZYMES | own research (well-known company) |
| Healthcare | Hospitals | 13 | AGARWALEYE, APOLLOHOSP, ASTERDM | category_extras.csv (stockscans.in) (+1 more) |
| Healthcare | Diagnostics | 6 | INDGN, LALPATHLAB, METROPOLIS | category_extras.csv (stockscans.in) (+1 more) |
| Automobiles & Auto Components | Auto Components – Ancillary & Precision Parts | 25 | ARE&M, ASAHIINDIA, ASKAUTOLTD | own research (well-known company) |
| Automobiles & Auto Components | Automobile OEMs (Large-cap) | 15 | ASHOKLEY, BAJAJ-AUTO, BHARATFORG | official Nifty sector/thematic index |
| Automobiles & Auto Components | Tubes & Tyres | 5 | APOLLOTYRE, BALKRISIND, CEATLTD | category_extras.csv (stockscans.in) |
| Automobiles & Auto Components | Electric Vehicles & New Mobility | 3 | ATHERENERG, OLAELEC, OLECTRA | own research (well-known company) |
| Automobiles & Auto Components | Passenger & Commercial Vehicle OEMs (Other) | 2 | FORCEMOT, HYUNDAI | own research (well-known company) |
| Chemicals | Specialty & Agro Chemicals (Large-cap) | 20 | AARTIIND, ATUL, BAYERCROP | official Nifty sector/thematic index |
| Chemicals | Specialty, Fine & Industrial Chemicals | 16 | ACI, AETHER, ALKYLAMINE | own research (well-known company) |
| Chemicals | Fertilizers & Agrochemicals (PSU/Large-cap) | 8 | DEEPAKFERT, FACT, GSFC | own research (well-known company) |
| Chemicals | Refrigerant & Industrial Gases | 4 | FLUOROCHEM, JUBLINGREA, NAVINFLUOR | category_extras.csv (stockscans.in) |
| Chemicals | PET Waste Recycling | 1 | GRAVITA | category_extras.csv (stockscans.in) |
| Chemicals | Polyester Films & Specialty Polymers | 1 | GRWRHITECH | category_extras.csv (stockscans.in) |
| FMCG | FMCG – Large-cap Staples | 15 | BRITANNIA, COLPAL, DABUR | official Nifty sector/thematic index |
| FMCG | Packaged Foods, Agri-Commodities & Edible Oils | 13 | AVANTIFEED, AWL, BECTORFOOD | own research (well-known company) |
| FMCG | Alcoholic Beverages | 7 | ABDL, INDIAGLYCO, PICCADIL | category_extras.csv (stockscans.in) |
| FMCG | Sugar | 5 | BALRAMCHIN, DCMSHRIRAM, EIDPARRY | category_extras.csv (stockscans.in) |
| FMCG | Personal Care & Home Care | 4 | GILLETTE, HONASA, JYOTHYLAB | own research (well-known company) |
| FMCG | Dairy | 2 | HERITGFOOD, NESTLEIND | category_extras.csv (stockscans.in) |
| FMCG | Stationery & Other FMCG | 2 | CUPID, DOMS | own research (well-known company) |
| FMCG | Tobacco & Allied | 2 | BBTC, GODFRYPHLP | own research (well-known company) |
| Consumer Services | New-age Internet & E-commerce Platforms | 12 | CARTRADE, ETERNAL, FIRSTCRY | own research (well-known company) |
| Consumer Services | Hotels & Hospitality | 7 | CHALET, EIHOTEL, INDHOTEL | category_extras.csv (stockscans.in) (+1 more) |
| Consumer Services | Travel, Tourism & Visa Services | 6 | BLS, CRIZAC, IRCTC | own research (well-known company) |
| Consumer Services | Quick Service Restaurants (QSR) | 5 | DEVYANI, JUBLFOOD, RBA | category_extras.csv (stockscans.in) |
| Consumer Services | Healthcare Retail, Distribution & Edtech | 4 | ENTERO, JSLL, MEDPLUS | own research (well-known company) |
| Consumer Services | Retail – Apparel, Footwear & Lifestyle | 4 | ABFRL, ABLBL, V2RETAIL | own research (well-known company) |
| Consumer Services | Co-working & Flexible Workspace | 3 | AWFIS, SMARTWORKS, WEWORK | category_extras.csv (stockscans.in) |
| Consumer Services | Value/Mass-market Apparel Retail | 3 | ARVINDFASN, MANYAVAR, TRENT | category_extras.csv (stockscans.in) |
| Consumer Services | Electronics & Specialty Retail | 2 | AVL, EMIL | own research (well-known company) |
| Consumer Services | Supermarkets & Hypermarket Retail | 2 | DMART, VMM | own research (well-known company) |
| Consumer Services | Consumer Services — Other/Diversified | 1 | RTNINDIA | NSE Industry field (catch-all) |
| Consumer Durables | Consumer Electricals & Home Appliances | 9 | BAJAJELEC, BLUESTARCO, CROMPTON | own research (well-known company) |
| Consumer Durables | Diamonds, Gems & Jewellery | 9 | BLUESTONE, KALYANKJIL, PCJEWELLER | category_extras.csv (stockscans.in) (+1 more) |
| Consumer Durables | Footwear, Luggage & Lifestyle Accessories | 7 | BATAINDIA, CAMPUS, ETHOSLTD | own research (well-known company) |
| Consumer Durables | Consumer Electronics EMS | 6 | AMBER, AVALON, DIXON | category_extras.csv (stockscans.in) |
| Consumer Durables | Paints | 5 | ASIANPAINT, BERGEPAINT, INDIGOPNTS | category_extras.csv (stockscans.in) (+1 more) |
| Consumer Durables | Contract Manufacturing (Electronics/Durables) | 4 | AMBER, DIXON, OPTIEMUS | category_extras.csv (stockscans.in) |
| Consumer Durables | Tiles, Sanitaryware & Plywood | 3 | CENTURYPLY, CERA, KAJARIACER | own research (well-known company) |
| Consumer Durables | Mattresses & Home Furnishings | 2 | SFL, WAKEFIT | own research (well-known company) |
| Consumer Durables | Opalware & Kitchenware | 1 | CELLO | category_extras.csv (stockscans.in) |
| Information Technology | IT Services – Large-cap | 10 | COFORGE, HCLTECH, INFY | official Nifty sector/thematic index |
| Information Technology | IT Services – Mid & Small-cap | 10 | AURIONPRO, BSOFT, CYIENT | own research (well-known company) |
| Information Technology | Software Products, Analytics & Platforms | 9 | AFFLE, CAPILLARY, INTELLECT | own research (well-known company) |
| Information Technology | Data Centres | 4 | ANANTRAJ, BBOX, NETWEB | category_extras.csv (stockscans.in) |
| Information Technology | IT-Enabled Services & BPM | 4 | HAPPSTMNDS, IKS, SAGILITY | own research (well-known company) |
| Information Technology | Geospatial Technology | 1 | MAPMYINDIA | category_extras.csv (stockscans.in) |
| Metals & Mining | Steel & Non-ferrous Metals (Large-cap) | 15 | ADANIENT, APLAPOLLO, HINDALCO | official Nifty sector/thematic index |
| Metals & Mining | Ferro Alloys, Steel & Mining (Other) | 6 | IMFA, JAIBALAJI, LLOYDSENT | own research (well-known company) |
| Metals & Mining | Mining & Minerals | 5 | ASHAPURMIN, COALINDIA, GMDCLTD | category_extras.csv (stockscans.in) |
| Metals & Mining | Metal Recycling | 1 | JAINREC | own research (well-known company) |
| Services | Diversified Trading, Facilities & Transport Infra Services | 8 | GMRAIRPORT, HEMIPROP, IGIL | own research (well-known company) |
| Services | Logistics, Freight & Supply Chain | 6 | BLACKBUCK, BLUEDART, CONCOR | category_extras.csv (stockscans.in) (+1 more) |
| Services | Business Process Outsourcing & Managed Services | 4 | CMSINFO, ECLERX, FSL | own research (well-known company) |
| Services | Liquid Storage & Handling Terminals | 3 | ADANIPORTS, AEGISLOG, GPPL | category_extras.csv (stockscans.in) |
| Services | Shipping | 2 | GESHIP, SCI | category_extras.csv (stockscans.in) |
| Services | Renewable Energy O&M Services | 1 | INOXGREEN | own research (well-known company) |
| Construction & Infrastructure | Roads, Highways & Civil Construction (EPC) | 9 | AHLUCONT, ASHOKA, DBL | own research (well-known company) |
| Construction & Infrastructure | Railway, PSU Engineering & Specialised EPC | 6 | AFCONS, ENGINERSIN, IRCON | own research (well-known company) |
| Construction & Infrastructure | Water & Environmental EPC | 3 | IONEXCHANG, WABAG, WELENT | category_extras.csv (stockscans.in) |
| Construction & Infrastructure | Power Transmission EPC | 2 | KEC, KPIL | own research (well-known company) |
| Construction & Infrastructure | Construction & Infrastructure — Other/Diversified | 1 | CEMPRO | NSE Industry field (catch-all) |
| Power & Energy | Power Generation & Distribution (Large-cap) | 16 | ADANIENSOL, ADANIGREEN, ADANIPOWER | official Nifty sector/thematic index |
| Power & Energy | Power Generation & Trading (Renewable/Other) | 5 | ACMESOLAR, GMRP&UI, KPIGREEN | own research (well-known company) |
| Construction Materials | Cement | 17 | ACC, AMBUJACEM, BIRLACORPN | category_extras.csv (stockscans.in) (+1 more) |
| Oil, Gas & Consumable Fuels | Oil & Gas – Upstream, Refining & Marketing (Large-cap) | 14 | AEGISLOG, ATGL, BPCL | official Nifty sector/thematic index |
| Oil, Gas & Consumable Fuels | Refining, Storage & Terminals (Other) | 3 | AEGISVOPAK, CHENNPETRO, MRPL | own research (well-known company) |
| Realty | Real Estate Developers (Large/Mid-cap) | 10 | ABREL, ANANTRAJ, BRIGADE | official Nifty sector/thematic index |
| Realty | Real Estate Developers (Other) | 7 | DBREALTY, EMBDL, LOTUSDEV | own research (well-known company) |
| Telecommunications | Telecom Equipment, Networking & Infrastructure | 7 | HFCL, INDUSTOWER, ITI | own research (well-known company) |
| Telecommunications | Telecom Services | 5 | BHARTIARTL, BHARTIHEXA, IDEA | own research (well-known company) |
| Textiles | Apparel, Yarn & Home Textiles | 12 | ALOKINDS, ARVIND, GOKEX | own research (well-known company) |
| Media & Entertainment | Broadcasting, Cinema & Music | 7 | NETWORK18, PFOCUS, PVRINOX | own research (well-known company) |
| Media & Entertainment | Gaming & Digital Entertainment | 1 | NAZARA | own research (well-known company) |
| Diversified | Diversified Conglomerates | 2 | 3MINDIA, GODREJIND | own research (well-known company) |
| Utilities | Environmental & Utility Services (Other) | 2 | EIEL, REFEX | own research (well-known company) |
| Forest Materials | Paper | 1 | JKPAPER | category_extras.csv (stockscans.in) |
| Cross-Sector Themes | PSU / CPSE Stocks | 11 | BEL, COALINDIA, COCHINSHIP | official Nifty sector/thematic index |
| Other | Uncategorized — NSE placeholder/dummy listing | 5 | DUMMYHEG, DUMMYINGL1, DUMMYINGL2 | dummy/placeholder listing |

## Parent group totals

| Parent Group | Subgroups | Total stock-rows |
|---|---|---|
| Financials | 16 | 126 |
| Capital Goods | 14 | 124 |
| Healthcare | 6 | 95 |
| Automobiles & Auto Components | 5 | 50 |
| Chemicals | 6 | 50 |
| FMCG | 8 | 50 |
| Consumer Services | 11 | 49 |
| Consumer Durables | 9 | 46 |
| Information Technology | 6 | 38 |
| Metals & Mining | 4 | 27 |
| Services | 6 | 24 |
| Construction & Infrastructure | 5 | 21 |
| Power & Energy | 2 | 21 |
| Construction Materials | 1 | 17 |
| Oil, Gas & Consumable Fuels | 2 | 17 |
| Realty | 2 | 17 |
| Telecommunications | 2 | 12 |
| Textiles | 1 | 12 |
| Media & Entertainment | 2 | 8 |
| Diversified | 1 | 2 |
| Utilities | 1 | 2 |
| Forest Materials | 1 | 1 |
| Cross-Sector Themes | 1 | 11 |
| Other | 1 | 5 |
