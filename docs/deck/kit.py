"""Kritva deck kit: brand tokens and Google-Slides-safe drawing helpers.

Rules that keep Google Slides import lossless:
- Only Google Fonts by name: "EB Garamond" (headings, big numbers) and "Geist" (everything else).
- No theme styles on shapes (p:style removed), so nothing inherits a shadow or theme colour.
- Charts are drawn from native rectangles, lines and text, so they stay editable after import.
- Gradients and patterns are PNG, never gradient fills.
"""
import os

from pptx import Presentation
from pptx.dml.color import RGBColor
from pptx.enum.dml import MSO_LINE
from pptx.enum.shapes import MSO_CONNECTOR, MSO_SHAPE
from pptx.enum.text import MSO_ANCHOR, MSO_AUTO_SIZE, PP_ALIGN
from pptx.oxml.ns import qn
from pptx.util import Emu, Inches, Pt
from lxml import etree

HERE = os.path.dirname(os.path.abspath(__file__))
A = lambda name: os.path.join(HERE, "assets", name)

# ---- brand tokens (apps/web/src/styles.css)
BLACK = RGBColor(0x0A, 0x0A, 0x0A)
ORANGE = RGBColor(0xCC, 0x55, 0x00)
ORANGE_TEXT = RGBColor(0x9A, 0x3F, 0x00)
O50 = RGBColor(0xFF, 0xF4, 0xEC)
O100 = RGBColor(0xFF, 0xE8, 0xD6)
O200 = RGBColor(0xF6, 0xCF, 0xB1)
S50 = RGBColor(0xFA, 0xFA, 0xF9)
S100 = RGBColor(0xF5, 0xF5, 0xF4)
S200 = RGBColor(0xE7, 0xE5, 0xE4)
S300 = RGBColor(0xD6, 0xD3, 0xD1)
S500 = RGBColor(0x6B, 0x6B, 0x6B)
S600 = RGBColor(0x52, 0x52, 0x52)
WHITE = RGBColor(0xFF, 0xFF, 0xFF)

SERIF = "EB Garamond"
SANS = "Geist"

I = Inches
WORDMARK_RATIO = float(open(A("wordmark_ratio.txt")).read())


def new_deck():
    prs = Presentation()
    prs.slide_width = I(13.333)
    prs.slide_height = I(7.5)
    return prs


def blank(prs):
    return prs.slides.add_slide(prs.slide_layouts[6])


def _strip_style(shape):
    st = shape._element.find(qn("p:style"))
    if st is not None:
        shape._element.remove(st)


# ---------------------------------------------------------------- text
def _apply_run(run, text, size, font, color, bold, italic, sup):
    run.text = text
    f = run.font
    f.name = font
    f.size = Pt(size)
    f.bold = bold
    f.italic = italic
    f.color.rgb = color
    rpr = run._r.get_or_add_rPr()
    # set east-asian and complex-script faces too, so no theme font leaks in
    for tag in ("a:ea", "a:cs"):
        el = rpr.find(qn(tag))
        if el is None:
            el = etree.SubElement(rpr, qn(tag))
        el.set("typeface", font)
    if sup:
        rpr.set("baseline", "30000")


def text(slide, x, y, w, h, content, size=9, font=SANS, color=BLACK, bold=False, italic=False,
         align="l", anchor="t", line=None, after=0, before=0):
    """content: str (\n = new paragraph) or list of paragraphs; a paragraph is str or list of runs;
    a run is str or (str, dict(size,font,color,bold,italic,sup))."""
    tb = slide.shapes.add_textbox(I(x), I(y), I(w), I(h))
    tf = tb.text_frame
    tf.word_wrap = True
    tf.auto_size = MSO_AUTO_SIZE.NONE
    tf.margin_left = tf.margin_right = tf.margin_top = tf.margin_bottom = 0
    tf.vertical_anchor = {"t": MSO_ANCHOR.TOP, "m": MSO_ANCHOR.MIDDLE, "b": MSO_ANCHOR.BOTTOM}[anchor]
    paras = content.split("\n") if isinstance(content, str) else content
    for i, para in enumerate(paras):
        p = tf.paragraphs[0] if i == 0 else tf.add_paragraph()
        p.alignment = {"l": PP_ALIGN.LEFT, "c": PP_ALIGN.CENTER, "r": PP_ALIGN.RIGHT}[align]
        if line:
            p.line_spacing = line
        p.space_after = Pt(after)
        p.space_before = Pt(before if i else 0)
        runs = [para] if isinstance(para, (str, tuple)) else para
        for r in runs:
            t, o = (r, {}) if isinstance(r, str) else r
            _apply_run(p.add_run(), t, o.get("size", size), o.get("font", font), o.get("color", color),
                       o.get("bold", bold), o.get("italic", italic), o.get("sup", False))
    return tb


def nlines(t, width_in, size_pt, em=0.47):
    """Rough wrapped line count for Geist at size_pt in a box width_in wide (word-aware)."""
    cpl = max(1, int(width_in * 72 / (size_pt * em)))
    lines, cur = 1, 0
    for word in t.split():
        need = len(word) + (1 if cur else 0)
        if cur + need > cpl:
            lines, cur = lines + 1, len(word)
        else:
            cur += need
    return lines


def sup(t, color=None):
    d = {"sup": True}
    if color is not None:
        d["color"] = color
    return (t, d)


def b(t, **kw):
    kw.setdefault("bold", True)
    return (t, kw)


# ---------------------------------------------------------------- shapes
def rect(slide, x, y, w, h, fill=None, line=None, lw=0.75, radius=None, dash=False):
    kind = MSO_SHAPE.ROUNDED_RECTANGLE if radius else MSO_SHAPE.RECTANGLE
    s = slide.shapes.add_shape(kind, I(x), I(y), I(w), I(h))
    _strip_style(s)
    if radius:
        s.adjustments[0] = min(0.5, radius / min(w, h))
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(lw)
        if dash:
            s.line.dash_style = MSO_LINE.DASH
    s.text_frame.text = ""
    return s


def oval(slide, x, y, d, fill=None, line=None, lw=0.75):
    s = slide.shapes.add_shape(MSO_SHAPE.OVAL, I(x), I(y), I(d), I(d))
    _strip_style(s)
    if fill is None:
        s.fill.background()
    else:
        s.fill.solid()
        s.fill.fore_color.rgb = fill
    if line is None:
        s.line.fill.background()
    else:
        s.line.color.rgb = line
        s.line.width = Pt(lw)
    return s


def hline(slide, x1, y1, x2, y2, color=S200, lw=0.75, dash=False):
    c = slide.shapes.add_connector(MSO_CONNECTOR.STRAIGHT, I(x1), I(y1), I(x2), I(y2))
    _strip_style(c)
    c.line.color.rgb = color
    c.line.width = Pt(lw)
    if dash:
        c.line.dash_style = MSO_LINE.DASH
    return c


def pic(slide, name, x, y, w=None, h=None):
    return slide.shapes.add_picture(A(name), I(x), I(y), I(w) if w else None, I(h) if h else None)


def chip(slide, x, y, w, h, label, fill, color, size=7, bold=True, line=None):
    rect(slide, x, y, w, h, fill=fill, radius=h / 2, line=line)
    text(slide, x, y, w, h, label, size=size, color=color, bold=bold, align="c", anchor="m")


def notes(slide, body):
    slide.notes_slide.notes_text_frame.text = body.strip()


# ---------------------------------------------------------------- tables
def _cell_border(cell, side, color, w_pt):
    tcPr = cell._tc.get_or_add_tcPr()
    tag = {"L": "a:lnL", "R": "a:lnR", "T": "a:lnT", "B": "a:lnB"}[side]
    old = tcPr.find(qn(tag))
    if old is not None:
        tcPr.remove(old)
    ln = etree.SubElement(tcPr, qn(tag), w=str(int(Pt(w_pt))), cap="flat", cmpd="sng", algn="ctr")
    if color is None:
        etree.SubElement(ln, qn("a:noFill"))
    else:
        sf = etree.SubElement(ln, qn("a:solidFill"))
        etree.SubElement(sf, qn("a:srgbClr"), val=str(color))
    # schema order: lnL lnR lnT lnB ... fill; move fills after borders
    for fill_tag in ("a:solidFill", "a:noFill"):
        for el in tcPr.findall(qn(fill_tag)):
            tcPr.remove(el)
            tcPr.append(el)


def table(slide, x, y, col_w, rows, size=7.5, header_fill=None, row_h=0.26, zebra=False,
          style_fn=None, header_color=BLACK):
    """rows[0] is the header. A cell is str or list of runs. style_fn(r, c) -> dict(fill, color, bold)."""
    nr, nc = len(rows), len(col_w)
    gs = slide.shapes.add_table(nr, nc, I(x), I(y), I(sum(col_w)), I(row_h * nr))
    tbl = gs.table
    tblPr = gs._element.graphic.graphicData.tbl.tblPr
    for attr in ("firstRow", "bandRow", "firstCol", "lastRow", "lastCol", "bandCol"):
        tblPr.set(attr, "0")
    sid = tblPr.find(qn("a:tableStyleId"))
    if sid is not None:
        tblPr.remove(sid)
    for c, w in enumerate(col_w):
        tbl.columns[c].width = I(w)
    for r in range(nr):
        tbl.rows[r].height = I(row_h)
        for c in range(nc):
            cell = tbl.cell(r, c)
            st = style_fn(r, c) if style_fn else {}
            fill = st.get("fill", header_fill if r == 0 else (S50 if zebra and r % 2 == 0 else None))
            if fill is None:
                cell.fill.background()
            else:
                cell.fill.solid()
                cell.fill.fore_color.rgb = fill
            cell.margin_left = I(0.06)
            cell.margin_right = I(0.06)
            cell.margin_top = I(0.035)
            cell.margin_bottom = I(0.035)
            cell.vertical_anchor = MSO_ANCHOR.TOP if r else MSO_ANCHOR.BOTTOM
            tf = cell.text_frame
            tf.word_wrap = True
            content = rows[r][c]
            if content == "" or content == []:
                content = " "  # an empty cell falls back to 18 pt in Google Slides and grows the row
            runs = [content] if isinstance(content, (str, tuple)) else content
            p = tf.paragraphs[0]
            p.line_spacing = 1.0
            for run in runs:
                t, o = (run, {}) if isinstance(run, str) else run
                _apply_run(p.add_run(), t, o.get("size", size if r else size - 0.5), o.get("font", SANS),
                           o.get("color", st.get("color", header_color if r == 0 else BLACK)),
                           o.get("bold", st.get("bold", r == 0)), o.get("italic", False), o.get("sup", False))
            end = p._p.get_or_add_endParaRPr()
            end.set("sz", str(int((size if r else size - 0.5) * 100)))
            for side in "LRT":
                _cell_border(cell, side, None, 0)
            _cell_border(cell, "B", BLACK if r == 0 else S200, 1.0 if r == 0 else 0.5)
    return gs


# ---------------------------------------------------------------- slide chrome
SECTIONS = [("01", "Problem"), ("02", "Who"), ("03", "Market"), ("04", "Product"), ("", "Appendix")]


def chrome(slide, active, page, title, lead=None):
    x = 0.5
    for num, name in SECTIONS:
        on = name == active
        label = f"{num}  {name}" if num else name
        w = 0.17 + 0.075 * len(label)
        text(slide, x, 0.3, w, 0.2, label, size=8, color=BLACK if on else S500, bold=on)
        if on:
            rect(slide, x, 0.53, w - 0.12, 0.025, fill=ORANGE)
        x += w + 0.12
    pic(slide, "wordmark_k.png", 12.833 - 0.2 * WORDMARK_RATIO, 0.29, h=0.2)
    hline(slide, 0.5, 0.555, 12.833, 0.555, S200, 0.5)
    text(slide, 0.5, 0.74, 12.333, 0.55, title, size=26, font=SERIF, color=BLACK)
    if lead:
        text(slide, 0.5, 1.3, 11.4, 0.45, lead, size=11.5, color=S600, line=1.1)
    text(slide, 12.333, 7.17, 0.5, 0.18, str(page), size=7, color=S500, align="r")


def exhibit_label(slide, x, y, w, num, label, right=None):
    text(slide, x, y, w, 0.2, [[b(f"EXHIBIT {num}", color=ORANGE, size=7.5), ("   " + label, {"color": BLACK, "bold": True})]],
         size=8.5)
    hline(slide, x, y + 0.24, x + w, y + 0.24, BLACK, 0.75)


def so_what(slide, body, y=6.47):
    pic(slide, "sowhat.png", 0.5, y, 12.333, 0.40)
    text(slide, 0.72, y, 0.9, 0.40, "So what", size=8, color=ORANGE, bold=True, anchor="m")
    text(slide, 1.45, y, 10.9, 0.40, body, size=10.5, color=WHITE, bold=True, anchor="m")


def footnotes(slide, paras, y=6.95):
    text(slide, 0.5, y, 11.6, 0.42, paras, size=6.5, color=S500, line=1.05, after=1)
