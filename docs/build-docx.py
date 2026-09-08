#!/usr/bin/env python3
"""Собирает Word-версии ТЗ из HTML-исходников в docs/.

Источник правды — HTML. После правок в нём запускать:
    venv/bin/python docs/build-docx.py

Собирает оба документа (см. DOCUMENTS внизу файла):
  tz-mvp.html     -> ТЗ MVP - SaaS для бань и саун.docx   (техническое, для команды)
  tz-prostoe.html -> ТЗ простыми словами.docx             (для владельцев и не-технических)

Разметка у документов разная, поэтому обход структуро-независимый:
блоки распознаются по паре «тег + класс», незнакомые контейнеры просто раскрываются.
"""
from __future__ import annotations

import sys
from html.parser import HTMLParser
from pathlib import Path

try:
    from docx import Document
except ModuleNotFoundError:  # pragma: no cover
    raise SystemExit(
        "Не установлен python-docx.\n"
        "Из корня проекта:\n"
        "    python3 -m venv .venv && .venv/bin/pip install -r docs/requirements.txt\n"
        "затем:\n"
        "    .venv/bin/python docs/build-docx.py"
    )
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, RGBColor

# ── палитра документа (та же, что в HTML, светлая тема) ────────────────────
ACCENT = "0F5F66"
SIGNAL = "A8501C"
INK = "131A20"
INK2 = "4D5B65"
INK3 = "7A888F"
LINE = "D7DFE3"
SHADE = "F4F7F8"
SHADE2 = "E8EEF0"
ACCENT_SOFT = "E4F1F2"
SIGNAL_SOFT = "F8ECE2"

FONT_BODY = "Calibri"
FONT_HEAD = "Georgia"
FONT_MONO = "Consolas"

VOID = {"link", "meta", "br", "hr", "img", "input", "col", "source"}
SKIP_TEXT_IN = {"style", "script"}


# ── мини-DOM ───────────────────────────────────────────────────────────────
class Node:
    __slots__ = ("tag", "attrs", "children", "parent")

    def __init__(self, tag, attrs=None, parent=None):
        self.tag = tag
        self.attrs = attrs or {}
        self.children = []
        self.parent = parent

    @property
    def cls(self):
        return self.attrs.get("class", "").split()

    def find_all(self, tag=None, cls=None):
        out = []
        for ch in self.children:
            if isinstance(ch, Node):
                if (tag is None or ch.tag == tag) and (cls is None or cls in ch.cls):
                    out.append(ch)
                out.extend(ch.find_all(tag, cls))
        return out

    def first(self, tag=None, cls=None):
        found = self.find_all(tag, cls)
        return found[0] if found else None

    def text(self):
        parts = []
        for ch in self.children:
            parts.append(ch if isinstance(ch, str) else ch.text())
        return "".join(parts)


class TreeBuilder(HTMLParser):
    def __init__(self):
        super().__init__(convert_charrefs=True)
        self.root = Node("#root")
        self.cur = self.root
        self.suppress = 0

    def handle_starttag(self, tag, attrs):
        if tag in SKIP_TEXT_IN:
            self.suppress += 1
            return
        if tag == "br":
            self.cur.children.append("\n")
            return
        if tag in VOID:
            return
        node = Node(tag, dict(attrs), self.cur)
        self.cur.children.append(node)
        self.cur = node

    def handle_endtag(self, tag):
        if tag in SKIP_TEXT_IN:
            self.suppress = max(0, self.suppress - 1)
            return
        if tag in VOID:
            return
        node = self.cur
        while node is not self.root and node.tag != tag:
            node = node.parent
        if node is not self.root:
            self.cur = node.parent

    def handle_data(self, data):
        if self.suppress:
            return
        norm = " ".join(data.split())
        if norm:
            # граничные пробелы значимы: они разделяют инлайновые элементы
            if data[:1].isspace():
                norm = " " + norm
            if data[-1:].isspace():
                norm = norm + " "
            self.cur.children.append(norm)
        elif data and self.cur.children:
            last = self.cur.children[-1]
            if not (isinstance(last, str) and last.endswith(" ")):
                self.cur.children.append(" ")


# ── низкоуровневые помощники OOXML ─────────────────────────────────────────
def shade(element, color):
    pr = element.get_or_add_tcPr() if element.tag.endswith("}tc") else element.get_or_add_pPr()
    sh = OxmlElement("w:shd")
    sh.set(qn("w:val"), "clear")
    sh.set(qn("w:color"), "auto")
    sh.set(qn("w:fill"), color)
    pr.append(sh)


def cell_shade(cell, color):
    sh = OxmlElement("w:shd")
    sh.set(qn("w:val"), "clear")
    sh.set(qn("w:color"), "auto")
    sh.set(qn("w:fill"), color)
    cell._tc.get_or_add_tcPr().append(sh)


def cell_borders(cell, left=None, box=None, size=8):
    tcPr = cell._tc.get_or_add_tcPr()
    borders = OxmlElement("w:tcBorders")
    for edge in ("top", "left", "bottom", "right"):
        el = OxmlElement(f"w:{edge}")
        if left and edge == "left":
            el.set(qn("w:val"), "single")
            el.set(qn("w:sz"), "24")
            el.set(qn("w:color"), left)
        elif box:
            el.set(qn("w:val"), "single")
            el.set(qn("w:sz"), str(size))
            el.set(qn("w:color"), box)
        else:
            el.set(qn("w:val"), "nil")
        borders.append(el)
    tcPr.append(borders)


def full_width(table):
    """Растянуть таблицу на всю ширину полосы набора."""
    tblPr = table._tbl.tblPr
    for existing in tblPr.findall(qn("w:tblW")):
        tblPr.remove(existing)
    w = OxmlElement("w:tblW")
    w.set(qn("w:type"), "pct")
    w.set(qn("w:w"), "5000")
    tblPr.append(w)


def repeat_header(row):
    """Повторять строку-шапку на каждой новой странице."""
    trPr = row._tr.get_or_add_trPr()
    el = OxmlElement("w:tblHeader")
    el.set(qn("w:val"), "true")
    trPr.append(el)


def table_borders(table, color=LINE, size=4):
    tblPr = table._tbl.tblPr
    borders = OxmlElement("w:tblBorders")
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        el = OxmlElement(f"w:{edge}")
        el.set(qn("w:val"), "single")
        el.set(qn("w:sz"), str(size))
        el.set(qn("w:color"), color)
        borders.append(el)
    tblPr.append(borders)


def keep_with_next(paragraph):
    pPr = paragraph._p.get_or_add_pPr()
    el = OxmlElement("w:keepNext")
    pPr.append(el)


def page_number_field(paragraph):
    run = paragraph.add_run()
    for kind, text in (("begin", None), (None, "PAGE"), ("end", None)):
        if kind:
            fld = OxmlElement("w:fldChar")
            fld.set(qn("w:fldCharType"), kind)
            run._r.append(fld)
        else:
            instr = OxmlElement("w:instrText")
            instr.set(qn("xml:space"), "preserve")
            instr.text = f" {text} "
            run._r.append(instr)
    run.font.size = Pt(8.5)
    run.font.name = FONT_BODY
    run.font.color.rgb = RGBColor.from_string(INK3)


# ── рендер текста с инлайновым форматированием ─────────────────────────────
def add_runs(paragraph, node, *, bold=False, mono=False, color=None, size=None, _top=True):
    for ch in node.children:
        if isinstance(ch, str):
            if not ch:
                continue
            segments = ch.split("\n")
            for idx, seg in enumerate(segments):
                run = paragraph.add_run(seg)
                run.bold = bold
                run.font.name = FONT_MONO if mono else FONT_BODY
                run.font.size = Pt(9.5) if mono else (size or Pt(10.5))
                run.font.color.rgb = RGBColor.from_string(color or INK)
                if idx < len(segments) - 1:
                    run.add_break()
            continue
        if ch.tag in ("strong", "b"):
            add_runs(paragraph, ch, bold=True, mono=mono, color=color, size=size, _top=False)
        elif ch.tag == "code":
            add_runs(paragraph, ch, bold=bold, mono=True, color=ACCENT, size=size, _top=False)
        elif ch.tag == "em":
            add_runs(paragraph, ch, bold=bold, mono=mono, color=color, size=size, _top=False)
        elif ch.tag == "span" and "pill" in ch.cls:
            label = ch.text().strip()
            run = paragraph.add_run(f"[{label}] ")
            run.bold = True
            run.font.name = FONT_BODY
            run.font.size = Pt(8.5)
            run.font.color.rgb = RGBColor.from_string(
                SIGNAL if "risk" in ch.cls else (ACCENT if "now" in ch.cls else INK3)
            )
        elif ch.tag == "span" and "note" in ch.cls:
            paragraph.add_run("\n")
            add_runs(paragraph, ch, color=INK2, size=Pt(9.5), _top=False)
        else:
            add_runs(paragraph, ch, bold=bold, mono=mono, color=color, size=size, _top=False)
    if _top:
        runs = paragraph.runs
        if runs:
            runs[0].text = runs[0].text.lstrip()
            runs[-1].text = runs[-1].text.rstrip()


def para(doc, node=None, *, text=None, style=None, size=10.5, color=INK,
         space_after=6, space_before=0, italic=False, mono=False, indent=None):
    p = doc.add_paragraph(style=style)
    pf = p.paragraph_format
    pf.space_after = Pt(space_after)
    pf.space_before = Pt(space_before)
    if indent is not None:
        pf.left_indent = Cm(indent)
    if text is not None:
        run = p.add_run(text)
        run.font.name = FONT_MONO if mono else FONT_BODY
        run.font.size = Pt(size)
        run.font.color.rgb = RGBColor.from_string(color)
        run.italic = italic
    elif node is not None:
        add_runs(p, node, color=color, size=Pt(size), mono=mono)
        for run in p.runs:
            run.italic = italic or run.italic
    return p


# ── рендер блоков ──────────────────────────────────────────────────────────
def render_table(doc, tbl_node):
    head = tbl_node.first("thead")
    body = tbl_node.first("tbody")
    header_cells = head.find_all("th") if head else []
    rows = [r for r in (body.find_all("tr") if body else []) if r.find_all("td")]
    ncols = len(header_cells) or max((len(r.find_all("td")) for r in rows), default=0)
    if not ncols:
        return
    table = doc.add_table(rows=0, cols=ncols)
    table.alignment = WD_TABLE_ALIGNMENT.LEFT
    table.autofit = True
    table_borders(table)
    full_width(table)

    if header_cells:
        row = table.add_row()
        repeat_header(row)
        for cell, th in zip(row.cells, header_cells):
            cell_shade(cell, SHADE2)
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(2)
            add_runs(p, th, bold=True, color=INK, size=Pt(9))
            keep_with_next(p)

    for tr in rows:
        tds = tr.find_all("td")
        row = table.add_row()
        for cell, td in zip(row.cells, tds):
            p = cell.paragraphs[0]
            p.paragraph_format.space_after = Pt(2)
            p.paragraph_format.space_before = Pt(2)
            classes = set(td.cls)
            # «Сейчас/Сходится» — акцентом, «Потом» — приглушённо
            color = ACCENT if "yes" in classes else (INK3 if "later" in classes else None)
            add_runs(p, td, mono="mono" in classes, color=color, size=Pt(9.5))
            if color:
                for run in p.runs:
                    run.bold = True
    doc.add_paragraph().paragraph_format.space_after = Pt(4)


def render_rule(doc, node):
    warn = "warn" in node.cls
    accent = SIGNAL if warn else ACCENT
    tbl = doc.add_table(rows=1, cols=1)
    tbl.autofit = True
    full_width(tbl)
    cell = tbl.cell(0, 0)
    cell_borders(cell, left=accent)
    cell_shade(cell, SHADE)

    h5 = node.first("h5")
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(3)
    if h5:
        tag = h5.first("em")
        if tag is not None:
            run = p.add_run(tag.text().strip() + "  ")
            run.bold = True
            run.font.name = FONT_MONO
            run.font.size = Pt(9)
            run.font.color.rgb = RGBColor.from_string(accent)
        title = "".join(c for c in h5.children if isinstance(c, str)).strip()
        run = p.add_run(title)
        run.bold = True
        run.font.name = FONT_BODY
        run.font.size = Pt(10.5)
        run.font.color.rgb = RGBColor.from_string(INK)

    for pn in node.find_all("p"):
        cp = cell.add_paragraph()
        cp.paragraph_format.space_after = Pt(3)
        color = SIGNAL if "else" in pn.cls else INK2
        add_runs(cp, pn, color=color, size=Pt(10))
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def render_callout(doc, node):
    calm = "calm" in node.cls
    accent = ACCENT if calm else SIGNAL
    tbl = doc.add_table(rows=1, cols=1)
    full_width(tbl)
    cell = tbl.cell(0, 0)
    cell_borders(cell, box=accent, size=6)
    cell_shade(cell, ACCENT_SOFT if calm else SIGNAL_SOFT)

    # подпись врезки: class="tag" в техническом ТЗ, class="t" в версии простыми словами
    tag = next((sp for sp in node.find_all("span") if set(sp.cls) & CALLOUT_TAG), None)
    p = cell.paragraphs[0]
    p.paragraph_format.space_after = Pt(3)
    if tag is not None:
        run = p.add_run(tag.text().strip().upper())
        run.bold = True
        run.font.name = FONT_BODY
        run.font.size = Pt(8.5)
        run.font.color.rgb = RGBColor.from_string(accent)
    for i, pn in enumerate(node.find_all("p")):
        cp = cell.add_paragraph() if (tag is not None or i) else p
        cp.paragraph_format.space_after = Pt(3)
        add_runs(cp, pn, color=INK, size=Pt(10))
    doc.add_paragraph().paragraph_format.space_after = Pt(2)


def render_entity(doc, node):
    h5 = node.first("h5")
    p = doc.add_paragraph()
    p.paragraph_format.space_after = Pt(1)
    p.paragraph_format.space_before = Pt(4)
    p.paragraph_format.left_indent = Cm(0.3)
    keep_with_next(p)
    if h5:
        run = p.add_run(h5.text().strip())
        run.bold = True
        run.font.name = FONT_MONO
        run.font.size = Pt(10)
        run.font.color.rgb = RGBColor.from_string(ACCENT)
    for pn in node.find_all("p"):
        fp = doc.add_paragraph()
        fp.paragraph_format.space_after = Pt(5)
        fp.paragraph_format.left_indent = Cm(0.3)
        add_runs(fp, pn, mono=True, color=INK2)


def render_list(doc, ul):
    for li in [c for c in ul.children if isinstance(c, Node) and c.tag == "li"]:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.space_after = Pt(3)
        p.paragraph_format.left_indent = Cm(0.75)
        add_runs(p, li, size=Pt(10.5))


# ── словарь классов: два документа используют разные имена ─────────────────
NUM_SPANS = {"num", "n"}          # номер раздела внутри h2
LEDE_P = {"lede", "sub"}          # вводный абзац под заголовком
NOTE_P = {"end", "fin", "hint"}   # мелкая заключительная ремарка
CALLOUT_DIV = {"callout", "box"}  # врезка
CALLOUT_TAG = {"tag", "t"}        # подпись врезки
CONTAINERS = {"wrap", "scroll", "split", "panel", "two", "card", "tldr", "grid"}


def render_heading2(doc, node):
    num = None
    for ch in node.children:
        if isinstance(ch, Node) and ch.tag == "span" and set(ch.cls) & NUM_SPANS:
            num = ch.text().strip()
    title = "".join(c for c in node.children if isinstance(c, str)).strip()
    heading = doc.add_heading(f"{num}. {title}" if num else title, level=1)
    keep_with_next(heading)


def render_block(doc, node):
    tag, cls = node.tag, set(node.cls)

    if tag in ("header", "nav", "dl", "h1"):
        return
    if tag == "h2":
        render_heading2(doc, node)
    elif tag == "h3":
        keep_with_next(doc.add_heading(node.text().strip(), level=2))
    elif tag in ("h4", "h5"):
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(10)
        p.paragraph_format.space_after = Pt(3)
        run = p.add_run(node.text().strip().upper())
        run.bold = True
        run.font.name = FONT_BODY
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor.from_string(INK3)
        keep_with_next(p)
    elif tag == "p" and cls & LEDE_P:
        para(doc, node, size=11, color=INK2, italic=True, space_after=10)
    elif tag == "p" and cls & NOTE_P:
        para(doc, node, size=9.5, color=ACCENT if "fin" in cls else INK3,
             italic="hint" in cls, space_before=8)
    elif tag == "p":
        para(doc, node, space_after=7)
    elif tag in ("ul", "ol"):
        render_list(doc, node)
    elif tag == "table":
        render_table(doc, node)
    elif tag == "div" and "rules" in cls:
        for ch in node.children:
            if isinstance(ch, Node) and "rule" in ch.cls:
                render_rule(doc, ch)
    elif tag == "div" and "rule" in cls:
        render_rule(doc, node)
    elif tag == "div" and cls & CALLOUT_DIV:
        render_callout(doc, node)
    elif tag == "div" and "entity" in cls:
        render_entity(doc, node)
    elif tag in ("div", "section", "main", "article") :
        for ch in node.children:
            if isinstance(ch, Node):
                render_block(doc, ch)


# ── стили документа ────────────────────────────────────────────────────────
def setup_styles(doc):
    normal = doc.styles["Normal"]
    normal.font.name = FONT_BODY
    normal.font.size = Pt(10.5)
    normal.font.color.rgb = RGBColor.from_string(INK)
    normal.paragraph_format.space_after = Pt(6)
    normal.paragraph_format.line_spacing = 1.15
    rfonts = normal.element.get_or_add_rPr().get_or_add_rFonts()
    rfonts.set(qn("w:eastAsia"), FONT_BODY)
    rfonts.set(qn("w:cs"), FONT_BODY)

    for level, size in ((1, 16), (2, 12.5), (3, 11)):
        st = doc.styles[f"Heading {level}"]
        st.font.name = FONT_HEAD if level == 1 else FONT_BODY
        st.font.size = Pt(size)
        st.font.bold = True
        st.font.color.rgb = RGBColor.from_string(INK if level == 1 else ACCENT)
        st.paragraph_format.space_before = Pt(18 if level == 1 else 12)
        st.paragraph_format.space_after = Pt(6 if level == 1 else 4)
        st.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:cs"), st.font.name)

    bullet = doc.styles["List Bullet"]
    bullet.font.name = FONT_BODY
    bullet.font.size = Pt(10.5)
    bullet.font.color.rgb = RGBColor.from_string(INK)


def setup_page(doc):
    for section in doc.sections:
        section.page_width = Cm(21)
        section.page_height = Cm(29.7)
        section.top_margin = Cm(2.2)
        section.bottom_margin = Cm(2.0)
        section.left_margin = Cm(2.2)
        section.right_margin = Cm(1.8)
        footer = section.footer.paragraphs[0]
        footer.alignment = WD_ALIGN_PARAGRAPH.CENTER
        page_number_field(footer)


# ── сборка ─────────────────────────────────────────────────────────────────
def render_cover(doc, header):
    kicker = header.first("p", "kicker")
    if kicker is not None:
        p = doc.add_paragraph()
        p.paragraph_format.space_before = Pt(60)
        p.paragraph_format.space_after = Pt(14)
        run = p.add_run(kicker.text().strip().upper())
        run.bold = True
        run.font.size = Pt(9)
        run.font.color.rgb = RGBColor.from_string(ACCENT)

    h1 = header.first("h1")
    if h1 is not None:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(12)
        run = p.add_run(h1.text().strip())
        run.bold = True
        run.font.name = FONT_HEAD
        run.font.size = Pt(28)
        run.font.color.rgb = RGBColor.from_string(INK)

    dek = header.first("p", "dek")
    if dek is not None:
        para(doc, dek, size=12, color=INK2, space_after=24)

    meta = header.first("dl", "meta")
    if meta is None:
        return
    pairs = []
    for block in [c for c in meta.children if isinstance(c, Node) and c.tag == "div"]:
        dt, dd = block.first("dt"), block.first("dd")
        if dt is not None and dd is not None:
            pairs.append((dt.text().strip(), dd.text().strip()))
    if not pairs:
        return
    mt = doc.add_table(rows=0, cols=2)
    table_borders(mt, color=LINE, size=2)
    full_width(mt)
    for key, val in pairs:
        row = mt.add_row()
        kp = row.cells[0].paragraphs[0]
        kr = kp.add_run(key)
        kr.bold = True
        kr.font.size = Pt(9.5)
        kr.font.color.rgb = RGBColor.from_string(INK3)
        cell_shade(row.cells[0], SHADE)
        vr = row.cells[1].paragraphs[0].add_run(val)
        vr.font.size = Pt(10)


def render_toc(doc, headings):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)
    keep_with_next(doc.add_heading("Содержание", level=1))
    for num, title in headings:
        p = doc.add_paragraph()
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.left_indent = Cm(0.2)
        nr = p.add_run(f"{num}.".ljust(5) if num else "     ")
        nr.font.name = FONT_MONO
        nr.font.size = Pt(10)
        nr.font.color.rgb = RGBColor.from_string(ACCENT)
        tr = p.add_run(title)
        tr.font.size = Pt(10.5)


def build(src: Path, dst: Path):
    parser = TreeBuilder()
    parser.feed(src.read_text(encoding="utf-8"))
    root = parser.root

    header = root.first("header")
    content = root.first("main") or root.first("div", "wrap")
    if content is None:
        raise SystemExit(f"{src.name}: не найден контейнер содержимого")

    headings = []
    for h2 in content.find_all("h2"):
        num = None
        for ch in h2.children:
            if isinstance(ch, Node) and ch.tag == "span" and set(ch.cls) & NUM_SPANS:
                num = ch.text().strip()
        headings.append((num, "".join(c for c in h2.children if isinstance(c, str)).strip()))

    doc = Document()
    setup_styles(doc)
    setup_page(doc)
    if header is not None:
        render_cover(doc, header)
    render_toc(doc, headings)
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)

    for child in content.children:
        if isinstance(child, Node):
            render_block(doc, child)

    dst.parent.mkdir(parents=True, exist_ok=True)
    doc.save(str(dst))
    return len(headings)


DOCUMENTS = [
    ("tz-mvp.html", "ТЗ MVP - SaaS для бань и саун.docx"),
    ("tz-prostoe.html", "ТЗ простыми словами.docx"),
]

if __name__ == "__main__":
    here = Path(__file__).resolve().parent
    jobs = [(Path(sys.argv[1]), Path(sys.argv[2]))] if len(sys.argv) > 2 else \
           [(here / a, here / b) for a, b in DOCUMENTS]
    for source, target in jobs:
        if not source.exists():
            print(f"пропуск: нет {source.name}")
            continue
        count = build(source, target)
        print(f"OK  {target.name} — разделов: {count}, {target.stat().st_size} байт")
