"""Build the Kritva deck as a Google-Slides-safe PPTX."""
import sys

from kit import *  # noqa: F401,F403

OUT = sys.argv[1] if len(sys.argv) > 1 else "Kritva-deck.pptx"
prs = new_deck()
PAGE = [0]


def page():
    PAGE[0] += 1
    return PAGE[0]


# =====================================================================================  COVER
s = blank(prs)
page()
pic(s, "cover.jpg", 0, 0, 13.333, 7.5)
pic(s, "wordmark_w.png", 0.75, 0.7, h=0.42)
text(s, 0.75, 2.05, 8.2, 2.2, "A control layer for negotiation", size=60, font=SERIF, color=WHITE, line=0.95)
text(s, 0.75, 4.62, 6.6, 0.8,
     "Kritva runs many negotiations at once, inside your limits, and commits only with your approval.",
     size=15, color=RGBColor(0xE7, 0xE5, 0xE4), line=1.2)
hline(s, 0.75, 6.55, 12.583, 6.55, RGBColor(0x5A, 0x2A, 0x10), 0.5)
text(s, 0.75, 6.7, 4, 0.25, "Problem  ·  Who  ·  Market  ·  Product", size=9, color=RGBColor(0xD6, 0xD3, 0xD1))
text(s, 8.58, 6.7, 4, 0.25, "Bangalore  ·  November 2026", size=9, color=RGBColor(0xD6, 0xD3, 0xD1), align="r")
notes(s, "Kritva: a reusable negotiation core. Four main slides (problem, who, market, product) and four appendix slides.")

# =====================================================================================  SLIDE 1
s = blank(prs)
chrome(s, "Problem", page(), "Negotiation does not scale: each offer needs a person",
       "Today, a person does each negotiation: you, your staff or a broker that you pay. "
       "Your time grows with each new negotiation.")

# ---- Exhibit 1 (left): equation + 2x2
LX, LW = 0.5, 5.95
exhibit_label(s, LX, 1.88, LW, 1, "Why your time grows")
pic(s, "eqcard.png", LX, 2.24, LW, 1.32)
text(s, LX + 0.25, 2.32, 5.4, 0.55,
     [[("Your time = ", {}), ("N", {"color": ORANGE}), (" × ", {}), ("H", {"color": ORANGE})]],
     size=30, font=SERIF)
text(s, LX + 0.25, 2.92, 2.6, 0.6,
     [[b("N", color=ORANGE, font=SERIF, size=12), ("  the number of negotiations in a period. Your headcount caps N.", {})]],
     size=8.5, color=S600, line=1.1)
text(s, LX + 3.05, 2.92, 2.7, 0.6,
     [[b("H", color=ORANGE, font=SERIF, size=12),
       ("  your minutes for each negotiation: 30 to 60 (assumption). H does not fall, because each offer needs a person.", {})]],
     size=8.5, color=S600, line=1.1)
text(s, LX, 3.66, LW, 0.22,
     [[b("N grows on two axes: "), ("the number of deals and the number of counterparties for each deal.", {})]],
     size=8.5, color=BLACK)

# 2x2
gx, gy = LX + 0.72, 4.0
cw, chh, gap = (LW - 0.72 - 0.08) / 2, 0.92, 0.08
text(s, gx, gy, cw, 0.2, "1 counterparty", size=7.5, color=S600, bold=True, align="c")
text(s, gx + cw + gap, gy, cw, 0.2, "2 or more counterparties", size=7.5, color=S600, bold=True, align="c")
ry0 = gy + 0.25
text(s, LX, ry0, 0.66, chh, "1 deal", size=7.5, color=S600, bold=True, anchor="m")
text(s, LX, ry0 + chh + gap, 0.66, chh, "2 or more deals", size=7.5, color=S600, bold=True, anchor="m")
cells = [
    (0, 0, "A", "Not in scope", "1 software renewal with 1 vendor.", S100, S600, S300, S600),
    (0, 1, "B", "Built", "1 car, 15 buyers. 1 laptop order, 4 vendors. Parallel sessions: 1 approval locks the item.",
     BLACK, WHITE, ORANGE, WHITE),
    (1, 0, "C", "Roadmap", "300 delivery changes a month with 1 supplier.", O100, BLACK, WHITE, ORANGE_TEXT),
    (1, 1, "D", "Built", "3,000 suppliers. 40 quote requests a day. Built as parallel type B negotiations.",
     BLACK, WHITE, ORANGE, WHITE),
]
for r, c, letter, status, body, fill, fg, chip_fill, chip_fg in cells:
    cx, cy = gx + c * (cw + gap), ry0 + r * (chh + gap)
    rect(s, cx, cy, cw, chh, fill=fill, radius=0.08)
    text(s, cx + 0.12, cy + 0.08, 0.3, 0.3, letter, size=18, font=SERIF, color=fg)
    chip(s, cx + cw - 0.92, cy + 0.11, 0.8, 0.19, status, chip_fill, chip_fg, size=6.5)
    text(s, cx + 0.12, cy + 0.42, cw - 0.24, 0.48, body, size=8, color=fg, line=1.08)
text(s, LX, 6.17, LW, 0.22,
     [[b("Kritva raises N without raising H. "), ("Buyer or seller is 1 field in the mandate.", {"color": S600})]],
     size=8.5)

# ---- Exhibit 2 (right): five gaps
RX, RW = 6.88, 5.953
exhibit_label(s, RX, 1.88, RW, 2, "Five gaps")
gaps = [
    ("clock", "Time", "28%", [("Sales reps spend 28% of their week on selling.", {}), sup("1"),
                              (" Each negotiation adds calls, messages and follow-ups.", {})]),
    ("brain", "Skill", None, [("Assumption: 15 interviews will test this.", {"italic": True})]),
    ("layers", "Capacity", "~20%", [("Walmart left ~20% of its 100,000+ suppliers on standard terms. "
                                     "It did not have the capacity to negotiate with each one.", {}), sup("2")]),
    ("user-check", "Delegation", "8 to 15%", [("A freight broker takes 8 to 15% of the trip cost.", {}), sup("3"),
                                              (" An AI with only a prompt can agree to terms that you did not approve.", {})]),
    ("radar", "Live view of offers", "4.9%", [("Offers arrive one call at a time. With competing bids, one "
                                               "manufacturer cut its freight cost by 4.9%.", {}), sup("4")]),
]
row_h = 0.81
for i, (ic, name, big, body) in enumerate(gaps):
    y = 2.2 + i * row_h
    if i:
        hline(s, RX, y, RX + RW, y, S200, 0.5)
    rect(s, RX, y + 0.13, 0.36, 0.36, fill=O50, radius=0.1)
    pic(s, f"i_{ic}_o.png", RX + 0.07, y + 0.2, 0.22, 0.22)
    text(s, RX + 0.48, y + 0.13, 1.0, 0.36, name, size=9, bold=True, anchor="m", line=1.0)
    if big:
        text(s, RX + 1.55, y + 0.06, 1.6, 0.6, big, size=27, font=SERIF, color=ORANGE, anchor="m")
    else:
        text(s, RX + 1.55, y + 0.1, 1.75, 0.62,
             ["A concession with nothing back.", "Talks on price only.", "The first offer accepted."],
             size=7.5, color=BLACK, bold=True, line=1.05, after=1)
    text(s, RX + 3.3, y + 0.1, RW - 3.3, 0.62, [body], size=8, color=S600, line=1.1, anchor="m")

so_what(s, "No one can hand this work to an agent safely. So each new negotiation needs a person.")
footnotes(s, [
    [b("Terms  ", color=BLACK), b("You", color=BLACK, bold=True), (" = the person or company that Kritva works for.  ", {}),
     b("Counterparty", color=BLACK), (" = the other side of the deal.  ", {}),
     b("Mandate", color=BLACK), (" = your goal, your limits and what Kritva may do.", {})],
    "1. Salesforce, State of Sales, 5th ed.   2. HBR, \"How Walmart Automated Supplier Negotiations.\"   "
    "3. TruckGuru.   4. SuperProcure case study.",
])
notes(s, """
Example: 15 buyers call about one car. The seller calls them back one at a time.
The 4.9% manufacturer reached only 3 transporters by phone.
Pactum (vendor data): 70 to 80% of suppliers get no negotiation. See A3.

Kritva's 4 rules against skill errors:
- Each concession needs a new commitment.
- A repeated offer earns nothing.
- Ask about a non-price reason before you move on price.
- Stop after 3 counteroffers.

Problem statement: "Negotiation does not scale. Each offer needs a person, and no one can hand the work to an agent safely."
""")

# =====================================================================================  SLIDE 2
s = blank(prs)
chrome(s, "Who", page(), "Five personas hit one limit, and counterparties gain from talking",
       "Each persona runs 2 or more negotiations, and each negotiation needs a person. "
       "The counterparty talks to Kritva when that is its best option.")
exhibit_label(s, 0.5, 1.88, 12.333, 1, "Five personas, one limit (loads are illustrative)")
text(s, 6.4, 1.89, 6.433, 0.2,
     [[b("B", color=BLACK), ("  1 deal, 2+ counterparties     ", {"color": S600}),
       b("C", color=BLACK), ("  2+ deals, 1 counterparty     ", {"color": S600}),
       b("D", color=BLACK), ("  2+ deals, 2+ counterparties", {"color": S600})]],
     size=7, align="r")
personas = [
    ("building", "Buyers in companies", "procurement", "3,000",
     "suppliers. The team negotiates with 200 (7%)",
     [("D", "2,800 suppliers on standard terms"), ("B", "500 laptops from 4 vendors"),
      ("C", "300 delivery changes a month with 1 supplier")],
     "Unit price, payment period, warranty, delivery date, price lock"),
    ("briefcase", "Sellers in companies", "B2B sales", "40",
     "quote requests a day for 3 staff (13 each)",
     [("D", "Quote desk"), ("D", "Distributor with 30 retailers"), ("B", "Company group booking at a hotel")],
     "Unit price, minimum order, credit period, delivery"),
    ("truck", "Brokers and agents", "", "10",
     "loads a day, 2 negotiations for each load",
     [("D", "Freight broker"), ("B", "Property broker: 8 landlords for 1 tenant"),
      ("D", "Procurement firm that buys for 50 companies")],
     "Rate, margin inside the client's limit, timing"),
    ("app", "Platforms", "host apps", "6.8 crore",
     "negotiations a year in India meet all 5 conditions (model, A4)",
     [("", "Classifieds site"), ("", "B2B marketplace"), ("", "AI call assistant")],
     "What its users negotiate"),
    ("party", "Individuals", "in a life event", "4 to 15",
     "negotiations from 1 event, in 1 to 4 weeks",
     [("B", "1 car, 15 buyers"), ("B", "1 flat, 12 enquiries"),
      ("3×B", "Wedding: 6 venues, 5 caterers, 4 photographers")],
     "Price, deposit, dates, inclusions"),
]
cw, gap, cy, ch = (12.333 - 4 * 0.12) / 5, 0.12, 2.24, 2.57
for i, (ic, name, sub, big, cap, uses, terms) in enumerate(personas):
    cx = 0.5 + i * (cw + gap)
    rect(s, cx, cy, cw, ch, fill=S50, line=S200, lw=0.5, radius=0.1)
    oval(s, cx + 0.14, cy + 0.14, 0.36, fill=O100)
    pic(s, f"i_{ic}_o.png", cx + 0.215, cy + 0.215, 0.21, 0.21)
    text(s, cx + 0.6, cy + 0.12, cw - 0.7, 0.42,
         [b(name), (("\n" if False else ""), {})] if not sub else [[b(name)], [(sub, {"color": S500})]],
         size=8.5, line=1.0, anchor="m")
    text(s, cx + 0.14, cy + 0.6, cw - 0.28, 0.38, big, size=22, font=SERIF, color=ORANGE)
    text(s, cx + 0.14, cy + 0.98, cw - 0.28, 0.3, cap, size=7, color=S600, line=1.05)
    hline(s, cx + 0.14, cy + 1.34, cx + cw - 0.14, cy + 1.34, S200, 0.5)
    yy = cy + 1.43
    for t, u in uses:
        tw = 0.3 if len(t) > 1 else 0.17
        if t:
            chip(s, cx + 0.14, yy + 0.01, tw, 0.15, t, BLACK, WHITE, size=5.5)
        else:
            oval(s, cx + 0.19, yy + 0.05, 0.07, fill=ORANGE)
        tw_in = cw - 0.34 - tw
        lines = nlines(u, tw_in, 7, em=0.44)
        text(s, cx + 0.14 + tw + 0.06, yy, tw_in, 0.14 * lines + 0.02, u, size=7, line=1.0)
        yy += 0.14 * lines + 0.08
    text(s, cx + 0.14, cy + ch - 0.4, cw - 0.28, 0.34, [[b("Terms  ", color=BLACK), (terms, {})]],
         size=6.5, color=S600, line=1.05, anchor="b")

# ---- Exhibit 2: four pillars
exhibit_label(s, 0.5, 4.88, 12.333, 2, "Why the counterparty talks to Kritva")
text(s, 0.5, 5.18, 10.2, 0.2,
     "The counterparty talks to Kritva when that has a higher value than its next option: "
     "ignore the call, ask for a person, or go elsewhere.", size=8, color=S600)
pillars = [
    ("key", "Access", "Do I get the deal?", [("Kritva acts for the side that holds the order, the item or the flat.", {})]),
    ("timer", "Time", "Is this faster than a call with a salesperson?",
     [("Kritva replies in 10 seconds or less, at any hour.", {}), sup("5")]),
    ("scale", "Outcome", "Are the terms fair?",
     [("Terms can trade: volume for price, pickup day for price. Each counterparty gets the same rules.", {})]),
    ("shield", "Risk", "Will the deal hold? Is this a trick?",
     [("Kritva reads back the exact terms. Approved terms hold. Kritva never invents buyers, prices or deadlines.", {})]),
]
pw, py = (12.333 - 2.0 - 4 * 0.14) / 4, 5.44
for i, (ic, name, q, body) in enumerate(pillars):
    px = 0.5 + i * (pw + 0.14)
    if i:
        hline(s, px - 0.07, py, px - 0.07, py + 0.92, S200, 0.5)
    pic(s, f"i_{ic}_k.png", px, py + 0.01, 0.18, 0.18)
    text(s, px + 0.25, py, pw - 0.3, 0.2, name, size=9, bold=True)
    text(s, px, py + 0.24, pw - 0.05, 0.2, q, size=7.5, color=ORANGE_TEXT, italic=True)
    text(s, px, py + 0.45, pw - 0.05, 0.5, [body], size=7.5, color=S600, line=1.08)
pic(s, "callout_s2.png", 10.983, 5.3, 1.85, 1.08)
text(s, 11.13, 5.36, 1.6, 0.45, "76 to 82%", size=22, font=SERIF, color=ORANGE)
text(s, 11.13, 5.8, 1.62, 0.55,
     [[("of suppliers in Pactum surveys preferred its chat interface (vendor data).", {}), sup("6")]],
     size=6.8, color=BLACK, line=1.05)

so_what(s, "Put Kritva on the side that holds the order. Then the counterparty must talk to Kritva to get the deal.")
footnotes(s, [
    "5. Kritva text turn: 4.8 s median and 7.7 s at the 90th percentile. Voice deal turn: 6 to 10 s (technical doc, 14.2 and 14.4).",
    "6. Pactum (vendor data, enterprise suppliers).",
])
notes(s, """
Other use cases:
- Procurement: 400 contract renewals a year (D).
- Sales: a fleet owner who offers 40 trucks to shippers (D).
- Platforms: procurement or sales software, rental sites.
- Individuals: a renovation with 5 contractors (B).

One core serves the buy side and the sell side. Terms are data, so a new term does not change the schema (technical doc, 4.1).
The side that holds the order: the buyer with the purchase order, the seller with 15 buyers, the landlord with 12 enquiries.
""")

# =====================================================================================  SLIDE 3
s = blank(prs)
chrome(s, "Market", page(), "Negotiation work costs $129B a year; businesses pay 86%",
       "TAM is the money spent on negotiation work today. SOM is Kritva's revenue in year 5, built from customer counts.")

# ---- Exhibit 1: driver tree
LX, LW = 0.5, 6.0
exhibit_label(s, LX, 1.88, LW, 1, "Global TAM")
text(s, LX, 2.18, 4.2, 0.18, "Method: top-down, staff time scaled by GDP. USD.", size=7, color=S500)
for j, (lab, col) in enumerate([("B2B", ORANGE), ("B2C", S600)]):
    rect(s, LX + LW - 1.05 + j * 0.55, 2.2, 0.13, 0.13, fill=col, radius=0.03)
    text(s, LX + LW - 0.88 + j * 0.55, 2.17, 0.4, 0.18, lab, size=7, color=S600, bold=True)


def node(x, y, w, h, kind, label, amount, formula=None):
    fill, bar, fg = {"b2b": (O50, ORANGE, ORANGE), "b2c": (S100, S600, BLACK), "root": (BLACK, ORANGE, WHITE)}[kind]
    rect(s, x, y, w, h, fill=fill, radius=0.06)
    if kind != "root":
        rect(s, x, y + 0.08, 0.04, h - 0.16, fill=bar)
    tc = WHITE if kind == "root" else BLACK
    text(s, x + 0.13, y + 0.07, w - 0.2, 0.18, label, size=7.5, bold=True, color=tc)
    text(s, x + 0.13, y + 0.24, w - 0.2, 0.34, amount, size=18, font=SERIF, color=fg)
    if formula:
        text(s, x + 0.13, y + 0.58, w - 0.2, h - 0.62, formula, size=6.5, color=S600 if kind != "root" else S300, line=1.06)


ROOT = (LX, 3.42, 1.6, 1.32)
node(*ROOT, "root", "Global TAM", "$129B")
text(s, LX + 0.13, ROOT[1] + 0.66, 1.4, 0.6,
     [[b("B2B ", color=ORANGE), ("$111B = 86%", {})], [b("B2C ", color=S300), ("$18B = 14%", {})]],
     size=7.5, color=WHITE, line=1.15)
L2X, L2W = 2.36, 2.35
n_staff = (L2X, 2.5, L2W, 1.5)
n_frt = (L2X, 4.1, L2W, 0.82)
n_ind = (L2X, 5.02, L2W, 1.32)
node(*n_staff, "b2b", "Staff time spent on negotiation", "$107B",
     "Staff × pay × 1.3 overhead × share of time spent on negotiation (buyers 20%, sales reps 10%), US and EU, "
     "scaled to the world by GDP. Midpoint of two methods: $117B and $97B.")
node(*n_frt, "b2b", "40% of freight broker fees", "$3.7B", "$63B revenue × 14.6% net margin × 40%")
node(*n_ind, "b2c", "Individuals' own time", "$18B",
     "Life events × hours × local hourly pay: 120M used-car sales × 4 h, 64M new-car buyers × 2 h, "
     "rental moves × 6 h, weddings")
L3X, L3W = 5.0, 1.5
n_sales = (L3X, 2.5, L3W, 0.7)
n_proc = (L3X, 3.3, L3W, 0.7)
node(*n_sales, "b2b", "Sales", "$67B")
node(*n_proc, "b2b", "Procurement", "$40B")


def elbow(parent, kids, mid):
    px, py = parent[0] + parent[2], parent[1] + parent[3] / 2
    ys = [k[1] + k[3] / 2 for k in kids]
    hline(s, px, py, mid, py, S300, 1)
    hline(s, mid, min(ys + [py]), mid, max(ys + [py]), S300, 1)
    for k, ky in zip(kids, ys):
        hline(s, mid, ky, k[0], ky, S300, 1)


elbow(ROOT, [n_staff, n_frt, n_ind], LX + 1.73)
elbow(n_staff, [n_sales, n_proc], L2X + L2W + 0.14)

# ---- Exhibit 2: India waterfall + SOM close-up
RX, RW = 6.88, 5.953
exhibit_label(s, RX, 1.88, RW, 2, "India: TAM to SAM, and SOM in year 5")
text(s, RX, 2.18, 4.5, 0.18, "Method: bottom-up by domain. ₹ Cr.", size=7, color=S500)
base, top = 5.6, 2.75
scale = (base - top) / 78765
bars = [
    ("India TAM", 0, 78765, "total", "78,765", "75%"),
    ("Not a fit", 41705, 78765, "neg", "−37,060", ""),
    ("Fits Kritva", 0, 41705, "sub", "41,705", "82%"),
    ("Out of reach", 27689, 41705, "neg", "−14,016", ""),
    ("India SAM", 0, 27689, "hero", "27,689", "86%"),
]
slot, bw, x0 = 0.8, 0.56, RX + 0.05
step_notes = {1: "× fit rate: the share that meets all 5 conditions in A4 (20 to 80% by domain)",
              3: "× reach: the share Kritva can reach by phone or WhatsApp (70% for businesses, 50% for individuals)"}
for i, (lab, lo, hi, kind, val, share) in enumerate(bars):
    bx = x0 + i * slot
    ytop, ybot = base - hi * scale, base - lo * scale
    fill = {"total": BLACK, "sub": S600, "neg": S300, "hero": ORANGE}[kind]
    rect(s, bx, ytop, bw, ybot - ytop, fill=fill)
    text(s, bx - 0.15, ytop - 0.22, bw + 0.3, 0.18, val, size=8, bold=True, align="c",
         color=ORANGE if kind == "hero" else BLACK)
    text(s, bx - 0.12, base + 0.06, bw + 0.24, 0.3, lab, size=7, align="c", color=BLACK, bold=kind == "hero", line=1.0)
    if share:
        text(s, bx - 0.12, base + 0.34, bw + 0.24, 0.16, f"B2B {share}", size=6.5, align="c", color=S500)
    if i < len(bars) - 1:
        nxt_y = base - (bars[i + 1][2] if bars[i + 1][3] == "neg" else bars[i + 1][2]) * scale
        link_y = base - (lo if kind == "neg" else hi) * scale
        hline(s, bx + bw, link_y, bx + slot, link_y, S300, 0.5, dash=True)
    if i in step_notes:
        text(s, bx - 0.1, ybot + 0.08, slot - 0.02, base - ybot - 0.1, step_notes[i], size=6, color=S600,
             italic=True, line=1.03)
hline(s, RX, base, x0 + 4 * slot + bw + 0.05, base, BLACK, 0.75)

# close-up column on its own scale
cx_div = x0 + 4 * slot + bw + 0.22
hline(s, cx_div, 2.45, cx_div, base + 0.5, S300, 0.75, dash=True)
som = [("Procurement", 164, ORANGE), ("B2B sales desks", 118, ORANGE), ("Freight", 111, ORANGE),
       ("Other B2B", 22, ORANGE), ("Individuals", 30, S600)]
sx, sw = cx_div + 0.2, 0.42
s_top = 3.0
sscale = (base - s_top) / 445
yb = base
label_slots = []
for nm, v, col in som:
    h = v * sscale
    rect(s, sx, yb - h, sw, h - 0.015, fill=col)
    label_slots.append((nm, v, yb - h / 2))
    yb -= h
# zoom lines from SAM bar to the close-up
sam_x = x0 + 4 * slot + bw
hline(s, sam_x, base - 27689 * scale, sx, s_top, O200, 0.75, dash=True)
text(s, sx - 0.1, 2.42, 1.75, 0.2, [[b("SOM, year 5: "), b("₹444 Cr", color=ORANGE)]], size=8)
text(s, sx - 0.1, 2.6, 1.75, 0.34, "1.6% of SAM · B2B 93% · own scale", size=6.5, color=S500)
# label positions: keep at least 0.26in apart, bottom-up
ly = []
last = base + 0.1
for nm, v, cyy in label_slots:
    y = min(cyy, last - 0.27)
    ly.append(y)
    last = y
for (nm, v, cyy), y in zip(label_slots, ly):
    extra = "\n27 through platforms, 3 direct" if nm == "Individuals" else ""
    text(s, sx + sw + 0.08, y - 0.09, 1.2, 0.4,
         [[b(f"{v} ", color=ORANGE if nm != "Individuals" else BLACK), (nm, {})]] +
         ([[(extra.strip(), {"color": S500, "size": 6})]] if extra else []),
         size=7, line=1.0)
text(s, sx - 0.1, base + 0.08, 1.85, 0.42,
     "Customers × share won by year 5 × revenue per customer per year", size=6, color=S500, italic=True, line=1.05)

so_what(s, "Sell to companies first: procurement and sales desks are 63% of SOM. "
           "Reach individuals through platforms: 1 contract reaches every user.")
footnotes(s, [
    "Sources: BLS · Cedefop · Eurostat · IMF via Gallup · Salesforce · Expert Market Research · C.H. Robinson 10-K · "
    "S&P Global · Probe42 · Udyam · NITI Aayog · World Bank · NSSO.",
    "Inputs are in A1. Domain detail and SOM rows are in A2. Numbers may not add up because of rounding.",
])
notes(s, """
Why 10% and 20%: sales reps spend 28% of their week on selling, and negotiation is a part of that.

Kritva's price is 15% of the value it creates. Example: ₹5 lakh order × 1.5% saved + ₹700 of buyer time = ₹8,200 of value. Kritva's price = ₹1,230.

Priority:
1. Companies (procurement + sales: 83% of global TAM, 63% of SOM).
2. Platforms (₹27 Cr of SOM).
3. Brokers (1.5 lakh freight brokers in India; ₹3 lakh of revenue per broker a year).
4. Individuals direct (₹3 Cr of SOM).

If a judge asks why India TAM is 7% of global TAM when India is 3% of world GDP: the two models use different methods. The India model is bottom-up. It counts informal freight brokers, rentals, weddings and MSME trade. The global model is top-down.

India counts: 1,63,870 companies above ₹10 Cr revenue · 5.42 crore MSMEs · 4M trucks · 134M urban households.
""")

# =====================================================================================  SLIDE 4
s = blank(prs)
chrome(s, "Product", page(), "A control layer, not a prompt, that Equal can host",
       "A prompt cannot hold your limits across 2 or more counterparties. "
       "Kritva holds them in code and plugs into Equal's call assistant.")
LX, LW = 0.5, 6.1
exhibit_label(s, LX, 1.88, LW, 1, "Who negotiates for you, and what each option can do")
lx = LX
for tag, lab in [("full", "yes"), ("half", "only if trusted"), ("quarter", "price only"), ("empty", "no")]:
    pic(s, f"hb_{tag}_k.png", lx, 2.22, 0.14, 0.14)
    text(s, lx + 0.19, 2.2, 1.2, 0.18, lab, size=7, color=S600)
    lx += 0.33 + 0.065 * len(lab)
cols = ["Changes terms during the talk", "Runs 2+ negotiations at once", "Shows you all live offers",
        "Keeps your limits private", "Agrees only inside your limits", "Commits only with your approval"]
rows = [
    ("You", "FEEEFF"[::1].replace("E", "0"), None),
]
grid = [
    ("You", ["full", "empty", "empty", "full", "full", "full"]),
    ("Human broker or agent", ["full", "empty", "empty", "half", "half", "half"]),
    ("Price list or auction", ["quarter", "full", "full", "full", "full", "full"]),
    ("Prompt in ChatGPT voice mode", ["full", "empty", "empty", "empty", "empty", "empty"]),
    ("Kritva", ["full"] * 6),
]
lab_w = 1.5
colw = (LW - lab_w) / 6
hy = 2.48
for j, c in enumerate(cols):
    text(s, LX + lab_w + j * colw + 0.03, hy, colw - 0.06, 0.48, c, size=6.8, color=S600, bold=True,
         align="c", anchor="b", line=1.0)
hline(s, LX, hy + 0.53, LX + LW, hy + 0.53, BLACK, 0.75)
rh = 0.42
for i, (name, vals) in enumerate(grid):
    ry = hy + 0.58 + i * rh
    kr = name == "Kritva"
    if kr:
        rect(s, LX - 0.06, ry - 0.02, LW + 0.12, rh, fill=O50, line=ORANGE, lw=1, radius=0.06)
    elif i:
        hline(s, LX, ry - 0.02, LX + LW, ry - 0.02, S200, 0.5)
    text(s, LX + (0.06 if kr else 0), ry, lab_w - 0.1, rh - 0.04, name, size=8, bold=True,
         color=ORANGE_TEXT if kr else BLACK, anchor="m", line=1.0)
    for j, v in enumerate(vals):
        d = 0.21
        bx = LX + lab_w + j * colw + (colw - d) / 2
        by = ry + (rh - 0.04 - d) / 2 - (0.04 if kr and j == 2 else 0)
        pic(s, f"hb_{v}_{'o' if kr else 'k'}.png", bx, by, d, d)
        if kr and j == 2:
            text(s, LX + lab_w + j * colw, by + d + 0.0, colw, 0.12, "real offers only", size=5.5,
                 color=ORANGE_TEXT, align="c")
# callout: prompt vs Kritva
cy0 = 5.2
pic(s, "callout_s4.png", LX, cy0, LW, 1.0)
text(s, LX + 0.22, cy0 + 0.1, 2.0, 0.8, "Same model,\n7 test scenarios", size=9, bold=True, color=BLACK, anchor="m",
     line=1.1)
text(s, LX + 2.0, cy0 + 0.08, 0.5, 0.8, "2", size=44, font=SERIF, color=S600, anchor="m")
text(s, LX + 2.5, cy0 + 0.1, 1.35, 0.8, "invalid agreements\nPrompt only", size=8, color=S600, anchor="m", line=1.1)
hline(s, LX + 3.85, cy0 + 0.22, LX + 3.85, cy0 + 0.78, O200, 0.75)
text(s, LX + 4.05, cy0 + 0.08, 0.5, 0.8, "0", size=44, font=SERIF, color=ORANGE, anchor="m")
text(s, LX + 4.55, cy0 + 0.1, 1.45, 0.8, [[("invalid agreements", {})], [b("Kritva", color=ORANGE), sup("7", ORANGE)]],
     size=8, color=BLACK, anchor="m", line=1.1)

# ---- Exhibit 2: Equal strip + swimlane
RX, RW = 6.95, 5.883
exhibit_label(s, RX, 1.88, RW, 2, "Kritva inside Equal's call assistant")
strip = [("Today", "Equal answers each incoming call for its user"), ("1M+", "monthly active users"),
         ("350,000", "daily active users"), ("1 tap", "to join a call, or send messages during it")]
sw_ = RW / 4
for j, (big, cap) in enumerate(strip):
    sx_ = RX + j * sw_
    if j:
        hline(s, sx_ - 0.06, 2.22, sx_ - 0.06, 2.66, S200, 0.5)
    text(s, sx_, 2.17, sw_ - 0.12, 0.3, big, size=16, font=SERIF, color=BLACK)
    text(s, sx_, 2.45, sw_ - 0.12, 0.26, [[(cap, {})] + ([sup("8")] if j == 3 else [])], size=6.5, color=S600, line=1.0)
lanes = ["Counterparty", "Equal", "Kritva", "You"]
LWS = [1.3, 1.7, 1.6, RW - 4.6]
LXS = [RX + sum(LWS[:j]) for j in range(4)]
ly0 = 2.8
steps = [
    (1, 0, 1, False, [("The counterparty calls you. Equal answers, as it does today.", {})]),
    (2, 1, 1, False, [("Equal finds a negotiation: a buyer asks about your listing, or a vendor quotes a price.", {})]),
    (3, 1, 2, True, [("Equal sends the case, your mandate and the live call to Kritva.", {})]),
    (4, 1, 2, True, [("Kritva sets each amount and term. Equal speaks the words.", {}), sup("9")]),
    (5, 0, 2, True, [("Kritva reads back the terms and ends the call: \u201cI\u2019ll check with {{name}} and get back to you.\u201d", {})]),
    (6, 2, 3, True, [("You approve, counter or decline in the Equal app, next to the call transcript. "
                      "Kritva calls back with your answer. Changed terms cancel the approval.", {})]),
]
sg, fs = 0.08, 6.7
layout = []
by = ly0 + 0.3
for n, a, z, kr, body in steps:
    bx = LXS[a] + 0.06
    bw_ = LXS[z] + LWS[z] - LXS[a] - 0.12
    tw_in = bw_ - 0.36
    sh = 0.14 + 0.125 * nlines("".join(t for t, _ in body), tw_in, fs)
    layout.append((n, kr, body, bx, by, bw_, tw_in, sh))
    by += sh + sg
lane_bottom = by + 0.02
for j, nm in enumerate(lanes):
    rect(s, LXS[j] + 0.02, ly0, LWS[j] - 0.04, lane_bottom - ly0, fill=O50 if nm == "Kritva" else S50, radius=0.06)
    text(s, LXS[j], ly0 + 0.05, LWS[j], 0.2, nm, size=7.5, bold=True, align="c",
         color=ORANGE_TEXT if nm == "Kritva" else BLACK)
for n, kr, body, bx, by, bw_, tw_in, sh in layout:
    rect(s, bx, by, bw_, sh, fill=WHITE, line=ORANGE if kr else S300, lw=0.75, radius=0.06)
    oval(s, bx + 0.06, by + 0.07, 0.19, fill=ORANGE if kr else BLACK)
    text(s, bx + 0.06, by + 0.07, 0.19, 0.19, str(n), size=7, bold=True, color=WHITE, align="c", anchor="m")
    text(s, bx + 0.31, by + 0.05, tw_in, sh - 0.08, [body], size=fs, color=BLACK, anchor="m", line=1.0)
print("swimlane bottom", round(lane_bottom, 2))
uy = lane_bottom + 0.04
text(s, RX, uy, 1.2, 0.3, "Use cases in Equal", size=7, bold=True, anchor="m")
uses = [("Incoming (B)", "you sell a scooter, and 15 buyers call"),
        ("Outgoing (B)", "you need quotes from 3 movers or 4 electricians"),
        ("Concierge", "a booking where the price can change")]
ux = RX + 1.12
for lab, desc in uses:
    w = [1.45, 1.85, 1.4][uses.index((lab, desc))]
    text(s, ux, uy, w, 0.3, [[b(lab + ": "), (desc, {"color": S600})]], size=6.5, anchor="m", line=1.0)
    ux += w + 0.05

so_what(s, "Code decides. The model words. Equal keeps the voice, and Kritva holds the limits.")
footnotes(s, [
    "7. Kritva test: 7 scenarios, same model, simulated buyers, 1 run.   8. Equal public statements, June 2026.   "
    "9. Kritva technical documentation, sections 2.1 and 2.3.",
])
notes(s, """
How Kritva earns each full ball:

Private limits. The model never sees your limits; code holds them. Counterparty words are data, never instructions. A voice-mode prompt puts the minimum inside the prompt, so a counterparty can ask for it or say "ignore your instructions."
Inside limits. Code checks each amount before Kritva sends it.
Your approval. Kritva reads back the terms, the counterparty confirms, then you approve the same terms hash. Changed terms cancel the approval.
2+ counterparties. A shared offer list covers the parallel sessions. 1 approval locks the item, and Kritva closes the other sessions.
Concession rules as data. Each concession needs a new commitment. Kritva makes 3 counteroffers at most.
Phone line. The counterparty gets a phone number, browser voice and chat. A voice-mode prompt runs inside your own app, so the counterparty cannot call it.
Record. An append-only event log ties each offer, approval and agreement to a terms hash and a mandate version.
Price list or auction gets a full ball for approval because you set the rules before it starts.

Equal's stated direction: communications, concierge, shopping and commerce, financial services, lifestyle, and outbound calls to book appointments. The outgoing use case depends on these outbound calls.
""")

# =====================================================================================  APPENDIX DIVIDER
s = blank(prs)
page()
pic(s, "divider.jpg", 0, 0, 13.333, 7.5)
pic(s, "wordmark_w.png", 0.75, 0.7, h=0.3)
text(s, 6.9, 1.6, 5.9, 1.2, "Appendix", size=60, font=SERIF, color=WHITE)
items = [("A1", "Market model: inputs, sources and assumptions to test"), ("A2", "India TAM, SAM and SOM detail"),
         ("A3", "How negotiation is done today, by segment"), ("A4", "Fit: when Kritva runs a negotiation, and when it does not")]
for k, (code, t) in enumerate(items):
    y = 3.0 + k * 0.62
    hline(s, 6.9, y, 12.583, y, RGBColor(0x5A, 0x2A, 0x10), 0.5)
    text(s, 6.9, y + 0.14, 0.6, 0.3, code, size=11, color=RGBColor(0xFF, 0x9A, 0x55), bold=True)
    text(s, 7.55, y + 0.12, 5.0, 0.36, t, size=15, font=SERIF, color=WHITE)
notes(s, "Appendix: reference slides for the market model, domain detail, how negotiation is done today, and fit.")

# =====================================================================================  A1
s = blank(prs)
chrome(s, "Appendix", page(), "A1. Market model: inputs, sources and assumptions to test")
STAR = ("  *", {"color": ORANGE, "bold": True})
a1 = [
    ("US buyers and purchasing agents", "477,980; median pay $75,650", "Sourced", "BLS OES 2023, OOH 2024", False),
    ("US wholesale and manufacturing sales reps", "1,613,600; pay $75,000 (blend of $66,780 and $100,070)",
     "Sourced + blend", "BLS OOH 2024", False),
    ("EU sales and purchasing agents", "4.1M. Sales workers (13.7M) ≈ 7% of jobs, office associate professionals ≈ 7%, "
     "and 30% of those are agents", "Derived", "Cedefop", False),
    ("EU average pay", "€39,800 ≈ $43,000", "Sourced", "Eurostat 2024", False),
    ("Share of world GDP", "US 26%, EU 18%, India 3%", "Sourced", "IMF via Gallup, Fed", False),
    ("Time spent on negotiation", "Buyers 20%, sales reps 10%", "Assumption",
     "Anchor: reps sell 28% of their week (Salesforce)", True),
    ("Overhead on pay", "× 1.3", "Assumption", "", False),
    ("Human minutes per negotiation", "30 to 60", "Assumption", "", True),
    ("Freight brokerage", "$63B revenue × 14.6% net margin", "Sourced", "Expert Market Research; C.H. Robinson Q4 2025", False),
    ("Negotiation share of a broker fee", "40%", "Assumption", "", True),
    ("India companies", "1,63,870 above ₹10 Cr; 61,477 at ₹50 to 5,000 Cr; 1,500 above ₹5,000 Cr",
     "Sourced + assumption (last value)", "Probe42", False),
    ("Negotiations per company a year", "Procurement 150 / 1,500 / 20,000; sales 300 / 3,000 / 30,000, by tier",
     "Assumption", "", True),
    ("India MSMEs", "5.42 crore × 67% in manufacturing or trade × 10% that sell on negotiated quotes",
     "Sourced + assumption (10%)", "Udyam, D&B", True),
    ("India freight", "4M trucks × 4 trips a month × 50% spot. $154B market × 65% full-truck × 50% through brokers × 10% margin",
     "Sourced + assumptions", "NITI Aayog, Credence, TruckGuru", True),
    ("India individuals", "5.9M used cars; 10.7M used two-wheelers (0.5 × 21.4M new); 4.64M new cars; 134M urban "
     "households (535M ÷ 4); 1 in 3 rent; a move every 3 years; 69 lakh weddings (46 lakh in one season × 1.5)",
     "Sourced + assumptions", "Business Standard, Autocar, IBEF, World Bank, NSSO, CAIT", False),
    ("Value of an hour, individual", "₹300", "Assumption", "", False),
    ("Fit rate by domain", "20 to 80%", "Assumption", "A2", True),
    ("Reach", "70% for businesses, 50% for individuals", "Assumption", "", True),
    ("Share won by year 5", "0.2 to 3%", "Assumption", "A2", True),
    ("Kritva price", "15% of the value created in each negotiation", "Assumption", "", False),
]
rows = [["Input", "Value", "Type", "Source"]]
for inp, val, typ, src, star in a1:
    rows.append([[(inp, {"bold": True})] + ([STAR] if star else []), val,
                 [(typ, {"color": ORANGE_TEXT if typ.startswith("Assumption") else (S600 if typ == "Derived" else BLACK),
                         "bold": typ == "Assumption"})], [(src, {"color": S600})]])
table(s, 0.5, 1.42, [2.75, 5.6, 1.6, 2.383], rows, size=7.3, row_h=0.235)
footnotes(s, [
    [b("*", color=ORANGE, size=8), ("  15 interviews will test the 9 rows marked *: 5 procurement managers, 5 sales heads and 5 brokers.", {})],
    "Method: the global model is top-down and the India model is bottom-up. So India TAM ($9.0B) is 7% of global TAM, "
    "although India is 3% of world GDP.",
], y=6.9)
notes(s, "Reference slide. The 9 rows marked * are the assumptions the 15 interviews will test.")

# =====================================================================================  A2
s = blank(prs)
chrome(s, "Appendix", page(), "A2. India TAM, SAM and SOM detail")
LX, LW = 0.5, 6.15
exhibit_label(s, LX, 1.42, LW, 1, "India SAM by domain, ₹ Cr, largest first")
dom = [("Road freight", 11210, "20,018", "80%", "70%"), ("Corporate procurement", 4289, "10,212", "60%", "70%"),
       ("B2B sales desks", 3974, "11,354", "50%", "70%"), ("Small B2B traders", 2621, "9,532", "25 to 50%", "70%"),
       ("Home rentals", 1858, "9,288", "40%", "50%"), ("Weddings and events", 1294, "5,951", "40%", "50 to 70%"),
       ("Professional services", 1260, "6,000", "30%", "70%"), ("Vehicles", 760, "3,386", "30 to 60%", "50 to 70%"),
       ("Home renovation", 222, "1,025", "40%", "50 to 70%"), ("Used goods", 200, "1,998", "20%", "50%")]
c_lab, c_bar, bar_max = LX, LX + 1.45, 2.1
c_tam, c_fit, c_rch = LX + 4.25, LX + 4.95, LX + 5.6
hy = 1.75
for x_, t_, w_ in [(c_bar, "SAM", 1.0), (c_tam, "TAM", 0.62), (c_fit, "Fit rate", 0.62), (c_rch, "Reach", 0.55)]:
    text(s, x_, hy, w_, 0.16, t_, size=6.8, color=S600, bold=True, align="l" if x_ == c_bar else "r")
rh = 0.335
for i, (nm, sam, tam, fit, rch) in enumerate(dom):
    y = hy + 0.24 + i * rh
    col = ORANGE if i == 0 else (BLACK if i in (1, 2, 3) else S300)
    text(s, c_lab, y, 1.42, rh - 0.06, nm, size=7.5, anchor="m", bold=i == 0)
    bl = bar_max * sam / 11210
    rect(s, c_bar, y + 0.05, bl, rh - 0.16, fill=col)
    text(s, c_bar + bl + 0.05, y, 0.6, rh - 0.06, f"{sam:,}", size=7.5, bold=True, anchor="m",
         color=ORANGE if i == 0 else BLACK)
    for x_, v_, w_ in [(c_tam, tam, 0.62), (c_fit, fit, 0.62), (c_rch, rch, 0.55)]:
        text(s, x_, y, w_, rh - 0.06, v_, size=7, color=S600, anchor="m", align="r")
ty = hy + 0.24 + 10 * rh
hline(s, LX, ty, LX + LW, ty, BLACK, 0.75)
text(s, c_lab, ty + 0.04, 1.4, 0.22, "Total", size=7.5, bold=True, anchor="m")
text(s, c_bar, ty + 0.04, 1.4, 0.22, "27,689", size=7.5, bold=True, anchor="m")
text(s, c_tam, ty + 0.04, 0.62, 0.22, "78,765", size=7, bold=True, anchor="m", align="r")
# bracket for the three company domains
bx_ = c_bar + bar_max * 4289 / 11210 + 0.55
y1, y2 = hy + 0.24 + 1 * rh + 0.04, hy + 0.24 + 4 * rh - 0.08
text(s, LX, ty + 0.38, LW, 0.5, [
    [b("Road freight", color=ORANGE), (" is the largest domain because brokers take 8 to 15% of each trip.", {"color": S600})],
    [b("Procurement + sales desks + small traders"), (" = ₹10,884 Cr of SAM.", {"color": S600})],
], size=7.5, line=1.1, after=2)

RX, RW = 6.95, 5.883
exhibit_label(s, RX, 1.42, RW, 2, "SOM in year 5, by segment")
som_rows = [
    ("Procurement, ₹50 to 5,000 Cr", "61,477", "1.5%", "₹11.07 lakh (1,500 × 60% × ₹1,230)", "102"),
    ("Procurement, above ₹5,000 Cr", "1,500", "2%", "₹1.98 Cr (20,000 × 60% × ₹1,650)", "59"),
    ("Procurement, ₹10 to 50 Cr", "1,00,893", "0.5%", "₹47,250", "2"),
    ("Sales desks, ₹50 to 5,000 Cr", "36,886", "1.5%", "₹12.83 lakh (3,000 × 50% × ₹855)", "71"),
    ("Sales desks, above ₹5,000 Cr", "900", "2%", "₹2.48 Cr", "45"),
    ("Sales desks, ₹10 to 50 Cr", "60,536", "0.5%", "₹78,750", "2"),
    ("Freight brokers", "1,50,000", "2%", "₹3 lakh (10 loads × 300 days × 2 × ₹50)", "90"),
    ("Fleet owners + shippers", "4,76,190 + 82,000", "2% / 3%", "₹11,612 / ₹38,400", "21"),
    ("MSME sellers, freelancers, dealers, vendors", "36.3 lakh + 1.5 crore + 3 lakh", "0.5% / 0.2% / 2%",
     "₹6,750 / ₹720 / ₹12,000", "22"),
    ("Platforms", "6.8 crore negotiations", "10%", "₹40 for each negotiation", "27"),
    ("Individuals, direct", "3.2 crore life events", "0.2%", "₹500 for each event", "3"),
]
rows = [["Segment", "Customers", "Share by year 5", "Revenue per customer a year", "₹ Cr"]]
for seg, cu, sh_, rev, cr in som_rows:
    rows.append([[(seg, {"bold": True})], cu, sh_, [(rev, {"color": S600})], [(cr, {"bold": True})]])
rows.append([[("Total", {"bold": True})], "", "", "", [("444", {"bold": True, "color": ORANGE})]])


def som_style(r, c):
    if r == len(rows) - 1:
        return {"fill": O50}
    return {}


g = table(s, RX, 1.75, [1.7, 1.12, 0.82, 1.79, 0.453], rows, size=6.8, row_h=0.27, style_fn=som_style)
for r in range(len(rows)):
    g.table.cell(r, 4).text_frame.paragraphs[0].alignment = PP_ALIGN.RIGHT
text(s, RX, 5.62, RW, 0.75, [
    [b("Checks")],
    [("Freight volume: 19.2 crore loads × ₹30,000 = ₹5.8 lakh Cr. This is inside a $154B market.", {})],
    [("Fleet owners: the model puts 18% of trucks with owners of fewer than 5 trucks. CRISIL gives below 25%.", {})],
    [("Global used cars: the model uses 120M. The published range is 100M to 186M.", {})],
    [("SOM ÷ SAM: 1.6%.", {})],
], size=6.8, color=S600, line=1.08)
footnotes(s, ["Numbers may not add up because of rounding."], y=7.05)
notes(s, "Reference slide. SAM by domain on the left; the SOM build by segment on the right, with four sanity checks.")

# =====================================================================================  A3
s = blank(prs)
chrome(s, "Appendix", page(), "A3. How negotiation is done today, by segment")
a3 = [
    ("Procurement", "Email requests for quotes. A buyer negotiates with the top suppliers",
     "Walmart: ~20% of 100,000+ suppliers on standard terms. Pactum: 70 to 80% get no negotiation (vendor)",
     "Suppliers outside the top tier get no negotiation"),
    ("B2B sales", "Phone, email, WhatsApp. Each salesperson sets the discount", "Reps sell 28% of their week",
     "Slow replies. Discounts differ from one person to the next"),
    ("Small B2B traders", "The owner, on WhatsApp and phone", "80%+ of SMBs say WhatsApp is essential",
     "One person, one chat at a time"),
    ("Freight", "Phone, WhatsApp groups, brokers, reverse auctions",
     "70 to 80% of mid-market manufacturers buy freight by phone and Excel. One manufacturer reached 3 transporters by phone",
     "3 parties reached instead of 10+. The broker takes 8 to 15%"),
    ("Reverse auctions", "Bids on a platform", "Freight cost fell 4.9% in one case and 7 to 8% in another",
     "Price only. Results need enough bidders"),
    ("Individuals", "Classified chats, brokers, phone", "No published Indian data",
     "Time. No reply from the other side. Broker fees"),
]
rows = [["Segment", "Method today", "Evidence", "Point of failure"]]
for seg, m, e, f in a3:
    rows.append([[(seg, {"bold": True})], m, [(e, {"color": S600})], [(f, {"color": ORANGE_TEXT, "bold": True})]])
table(s, 0.5, 1.42, [1.75, 3.35, 4.3, 2.933], rows, size=8.5, row_h=0.56)
by = 5.45
rect(s, 0.5, by, 12.333, 1.05, fill=S50, line=S200, lw=0.5, radius=0.1)
text(s, 0.72, by + 0.14, 6, 0.2, "Two items that the evidence does not support", size=9, bold=True)
for k, (t1, t2) in enumerate([
    ("Empty trucks on 25 to 30% of return trips.", "This cost comes from finding loads, and Kritva does not find loads."),
    ("Late MSME payments (₹7.34 lakh Cr).", "The main cause is the buyer's power over the supplier, not the difficulty of negotiation."),
]):
    x_ = 0.72 + k * 6.05
    pic(s, "i_x_k.png", x_, by + 0.48, 0.2, 0.2)
    text(s, x_ + 0.3, by + 0.44, 5.6, 0.5, [[b(t1 + " "), (t2, {"color": S600})]], size=8.5, line=1.1)
notes(s, "Reference slide. Each segment's method today, the evidence, and where it fails.")

# =====================================================================================  A4
s = blank(prs)
chrome(s, "Appendix", page(), "A4. Fit: when Kritva runs a negotiation, and when it does not")
LX, LW = 0.5, 7.7
exhibit_label(s, LX, 1.42, LW, 1, "Conditions and exclusions")
a4 = [
    ("1", "At least 1 term can change", "No term can change", "Printed fixed price; government fee; train fare"),
    ("2", "The counterparty agrees to talk to an AI", "The counterparty refuses an AI",
     "A supplier policy that bans automated negotiation"),
    ("3", "The deal needs judgment, not a fixed rule or an auction", "A fixed method works",
     "Sealed-bid tender; open auction; volume-discount table"),
    ("4", "2 or more negotiations under one mandate (type B, C or D)", "There is only 1 negotiation (type A)",
     "1 software renewal with 1 vendor"),
    ("5", "You can write the limits as numbers or yes/no rules", "You cannot write the limits",
     "A partnership where the terms are not yet defined"),
]
rows = [["#", "Kritva needs", "It fails when", "Examples"]]
for n, need, fail, ex in a4:
    rows.append([[(n, {"bold": True, "color": ORANGE, "font": SERIF, "size": 11})], [(need, {"bold": True})],
                 fail, [(ex, {"color": S600})]])
table(s, LX, 1.75, [0.35, 2.75, 2.1, 2.5], rows, size=7.8, row_h=0.4)
text(s, LX, 4.38, LW, 0.2, [[b("Other limits. "), ("Kritva does not run these:", {"color": S600})]], size=8.5)
rows = [["Root cause", "Examples"],
        [[("The relationship is the point", {"bold": True})], "Salary with your own manager; founder share split; family property"],
        [[("A licensed professional must decide", {"bold": True})], "Legal settlement; medical decision"],
        [[("No valid authority, or unfair use", {"bold": True})],
         "No consent from you; staff above their limit; competing sellers who share one agent (competition-law risk); "
         "false offers or deadlines"]]
table(s, LX, 4.62, [2.6, 5.1], rows, size=7.8, row_h=0.36)

RX, RW = 8.6, 4.233
exhibit_label(s, RX, 1.42, RW, 2, "Fit 2x2 (conditions 4 and 5)")
gx, gy = RX + 0.95, 1.85
cw, ch = (RW - 0.95 - 0.08) / 2, 1.55
text(s, gx, gy, cw, 0.36, "1 negotiation under one mandate", size=7.2, bold=True, color=S600, align="c", anchor="b", line=1.0)
text(s, gx + cw + 0.08, gy, cw, 0.36, "2 or more negotiations under one mandate", size=7.2, bold=True, color=S600,
     align="c", anchor="b", line=1.0)
gy += 0.44
text(s, RX, gy, 0.88, ch, "Limits written as numbers or yes/no rules", size=7.2, bold=True, color=S600, anchor="m", line=1.05)
text(s, RX, gy + ch + 0.08, 0.88, ch, "Limits not written", size=7.2, bold=True, color=S600, anchor="m", line=1.05)
fit = [
    (0, 0, "Do it yourself", "The setup takes longer than the time it saves.", S100, BLACK, S600, None),
    (0, 1, "Kritva runs it", "You approve.", BLACK, WHITE, S300, "check"),
    (1, 0, "A person leads", "", S100, BLACK, S600, None),
    (1, 1, "Kritva prepares and compares", "A person talks.", O100, BLACK, ORANGE_TEXT, None),
]
for r, c, h_, sub, fill, fg, subc, ic in fit:
    x_, y_ = gx + c * (cw + 0.08), gy + r * (ch + 0.08)
    rect(s, x_, y_, cw, ch, fill=fill, radius=0.1)
    if ic:
        pic(s, "i_check_o.png", x_ + 0.15, y_ + 0.15, 0.3, 0.3)
    text(s, x_ + 0.15, y_ + 0.55, cw - 0.3, 0.6, h_, size=15, font=SERIF, color=fg, line=1.0)
    text(s, x_ + 0.15, y_ + 1.05, cw - 0.3, 0.4, sub, size=7.5, color=subc, line=1.05)
notes(s, "Reference slide. Kritva fits when all 5 conditions hold. The 2x2 shows conditions 4 and 5.")

prs.save(OUT)
print("saved", OUT, len(prs.slides), "slides")
