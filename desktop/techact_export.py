# -*- coding: utf-8 -*-
"""Акт якісного (технічного) стану — Додаток 1 до Порядку списання військового майна у Збройних
Силах України та Державній спеціальній службі транспорту (пункт 5 розділу I) — у Word.

Сторінка програми передає збережений документ; модуль складає редагований .docx у композиції
бланка: альбомний А4, реквізити-коди, таблиця на 17 граф у двох частинах («Списати» й
«Оприбуткувати»), висновок комісії з підписами, висновок старшого начальника. Таблиці лишаються
таблицями Word: рядки й підписи можна дописати, шапка великої таблиці повторюється на кожній
сторінці, рядок не рветься між сторінками. Чого в документі немає — те порожнє: жодного факту зі
зразка в бланк не переходить.

    {"kind": "tech_act", "file": "...", "unit": "А0000", "no": "ПРОД-001/26", "date": "2026-10-03",
     "title": "найменування в заголовку", "purpose": "підстава (мета) операції", "service": "…",
     "op_date": "", "codes": {"infoMark", "regNo", "sheetNo", "docCode", "opCode"},
     "nomen_no": "", "acc_main": "", "acc_corr": "",
     "off": [{"name", "code", "uom", "cat", "qty", "price", "sum", "norm", "fact"}],
     "income": [{"name", "code", "uom", "cat", "qty", "price", "sum"}],
     "off_total": {"qty", "sum", "ok"}, "in_total": {...},
     "text": {"complete", "storage", "defects", "repair", "catNew", "conclusion", "grounds", "senior"},
     "approver": {"pos", "rank", "name"}, "head": {...}, "members": [...]}
"""
import os
from datetime import datetime
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation

from docx import Document
from docx.enum.section import WD_ORIENT
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_ROW_HEIGHT_RULE, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_TAB_ALIGNMENT, WD_TAB_LEADER
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Pt, Twips

from excel_export import safe_name

FONT = "Times New Roman"
ALIGN = {"center": WD_ALIGN_PARAGRAPH.CENTER, "left": WD_ALIGN_PARAGRAPH.LEFT, "right": WD_ALIGN_PARAGRAPH.RIGHT,
         "justify": WD_ALIGN_PARAGRAPH.JUSTIFY}
# Ширини граф бланка у двадцятих пункта: разом — ширина тексту альбомного аркуша (26,7 см).
W_HEAD = [2329, 1544, 2258]
W_TITLE = [5101, 4950, 5086]
W_CODES = [1327, 2113, 971, 1293, 1293, 1293, 1655, 1061, 1061, 1662, 1408]
# Графи «Оприбуткувати» ширші, ніж у зразку: там вони порожні, а назві й залишковій вартості потрібне місце.
W_MAIN = [450, 2050, 900, 600, 450, 600, 1150, 1250, 900, 900, 1650, 650, 500, 430, 580, 1037, 1040]
CODES = [("Ознака інформації", "000", "infoMark"), ("Реєстраційний номер", "001", "regNo"), ("Номер аркуша", "002", "sheetNo"),
         ("Код документа", "003", "docCode"), ("Номер документа", "005", None), ("Дата документа", "032", None),
         ("Підстава (мета) операції", "045", None), ("Код операції", "004", "opCode"), ("Дата операції", "034", None),
         ("Служба", "046", None), ("Військова частина", None, None)]
OFF_HEAD = ["найменування військового майна, заводський номер", "код номенклатури", "одиниця виміру", "категорія", "кількість",
            "ціна за одиницю, грн", "сума, грн"]
IN_HEAD = ["найменування озброєння (техніки, майна)", "код номенклатури", "одиниця виміру", "категорія", "кількість",
           "залишкова вартість за одиницю, грн", "сума, грн"]
TURNED = {2, 3, 4, 5, 11, 12, 13, 14}          # вузькі графи: заголовок стоїть знизу вгору
TEXTS = [("complete", "Комплектність"), ("storage", "Умови зберігання"), ("defects", "Виявлені дефекти й пошкодження"),
         ("repair", "Можливість і доцільність відновлення"), ("catNew", "Запропонована категорія"),
         ("conclusion", "Висновок комісії"), ("grounds", "Підстави висновку")]


def _money(v) -> str:
    """«25020.5» → «25 020,50»; порожнє й нечислове — порожньо."""
    try:
        d = Decimal(str(v).replace(",", ".").replace(" ", "")).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    except (InvalidOperation, ValueError):
        return ""
    whole, frac = f"{d:,.2f}".split(".")
    return whole.replace(",", " ") + "," + frac


def _qty(v) -> str:
    return str(v or "").strip().replace(".", ",")


def _date(iso) -> str:
    try:
        return datetime.strptime(str(iso or ""), "%Y-%m-%d").strftime("%d.%m.%Y")
    except ValueError:
        return ""


def _run(par, text, size, bold=False):
    run = par.add_run(text)
    run.font.name, run.font.size, run.font.bold = FONT, Pt(size), bold
    rfonts = run._r.get_or_add_rPr().get_or_add_rFonts()                     # noqa: SLF001
    for attr in ("w:eastAsia", "w:cs"):
        rfonts.set(qn(attr), FONT)
    return run


def _par(par, text="", size=12, bold=False, align="left", after=0):
    par.alignment = ALIGN[align]
    par.paragraph_format.space_after, par.paragraph_format.space_before = Pt(after), Pt(0)
    par.paragraph_format.line_spacing = 1.0
    if text:
        _run(par, text, size, bold)
    return par


def _cell(cell, text, size=10, bold=False, align="center", valign="center", turned=False):
    """Текст клітинки: рядки, розділені «\\n», — окремими абзацами."""
    cell.vertical_alignment = {"center": WD_CELL_VERTICAL_ALIGNMENT.CENTER, "top": WD_CELL_VERTICAL_ALIGNMENT.TOP,
                               "bottom": WD_CELL_VERTICAL_ALIGNMENT.BOTTOM}[valign]
    lines = str(text if text is not None else "").split("\n")
    for i, line in enumerate(lines):
        par = cell.paragraphs[0] if i == 0 else cell.add_paragraph()
        _par(par, line, size, bold, align)
    if turned:
        direction = OxmlElement("w:textDirection")
        direction.set(qn("w:val"), "btLr")
        cell._tc.get_or_add_tcPr().append(direction)                         # noqa: SLF001
    return cell


def _table(doc, rows, widths, borders=True, align=None):
    table = doc.add_table(rows=rows, cols=len(widths))
    if borders:
        table.style = "Table Grid"
    table.autofit = False
    if align:
        table.alignment = align
    layout = OxmlElement("w:tblLayout")
    layout.set(qn("w:type"), "fixed")
    table._tbl.tblPr.append(layout)                                          # noqa: SLF001
    for row in table.rows:
        for cell, w in zip(row.cells, widths):
            cell.width = Twips(w)
    return table


def _row_flags(row, header=False, keep=True, height=None):
    """Рядок не рветься між сторінками; рядки шапки повторюються на кожній."""
    pr = row._tr.get_or_add_trPr()                                           # noqa: SLF001
    if keep:
        pr.append(OxmlElement("w:cantSplit"))
    if header:
        pr.append(OxmlElement("w:tblHeader"))
    if height is not None:
        row.height, row.height_rule = Cm(height), WD_ROW_HEIGHT_RULE.AT_LEAST


def _signer(doc, rank, name, size=12):
    """«звання ____________ Ім'я ПРІЗВИЩЕ»: ім'я — на позиції табуляції праворуч."""
    par = _par(doc.add_paragraph(), size=size)
    par.paragraph_format.tab_stops.add_tab_stop(Cm(17))
    par.paragraph_format.left_indent = Cm(1.5)
    _run(par, f"{rank or ''}\t{name or ''}", size)
    return par


def build_tech_act(spec: dict):
    off, income = spec.get("off") or [], spec.get("income") or []
    text = spec.get("text") or {}
    approver, head = spec.get("approver") or {}, spec.get("head") or {}
    year = str(spec.get("date") or "")[:4] or "20__"
    doc = Document()
    normal = doc.styles["Normal"]
    normal.font.name, normal.font.size = FONT, Pt(12)
    normal.element.get_or_add_rPr().get_or_add_rFonts().set(qn("w:eastAsia"), FONT)
    sec = doc.sections[0]
    sec.orientation, sec.page_width, sec.page_height = WD_ORIENT.LANDSCAPE, Cm(29.7), Cm(21.0)
    sec.top_margin, sec.right_margin, sec.bottom_margin, sec.left_margin = Cm(0.5), Cm(1.0), Cm(0.5), Cm(2.0)
    core = doc.core_properties
    core.author = core.last_modified_by = "Облік ТЗ ПС"
    core.title = core.comments = ""

    # Назва додатка — праворуч угорі.
    t = _table(doc, 1, [9937, 5200], borders=False)
    _cell(t.cell(0, 1), "Додаток 1\nдо Порядку списання військового майна у Збройних Силах України та Державній "
          "спеціальній службі транспорту\n(пункт 5 розділу I)", 10, align="left", valign="top")

    # Номенклатурний номер і рахунки.
    t = _table(doc, 2, W_HEAD)
    for c, (label, key) in enumerate((("Номенклатурний номер", "nomen_no"), ("Основний рахунок", "acc_main"),
                                      ("Кореспондентський рахунок", "acc_corr"))):
        _cell(t.cell(0, c), label, 9)
        _cell(t.cell(1, c), str(spec.get(key) or ""), 10, bold=True)

    # Заголовок акта й гриф затвердження.
    t = _table(doc, 1, W_TITLE, borders=False)
    _cell(t.cell(0, 1), f"АКТ № {spec.get('no') or '________'}\nякісного (технічного) стану\n{spec.get('title') or ''}".rstrip("\n"),
          12, bold=True, valign="top")
    grif = ["ЗАТВЕРДЖУЮ", approver.get("pos") or "", f"{approver.get('rank') or ''} ____________ {approver.get('name') or ''}".strip(),
            f"«___» ____________ {year} року", "М.П."]
    _cell(t.cell(0, 2), "\n".join(grif), 12, align="left", valign="top")
    _par(doc.add_paragraph(), size=4)

    # Реквізити-коди.
    t = _table(doc, 3, W_CODES, align=WD_TABLE_ALIGNMENT.CENTER)
    codes = spec.get("codes") or {}
    values = {"Номер документа": spec.get("no") or "", "Дата документа": _date(spec.get("date")),
              "Підстава (мета) операції": spec.get("purpose") or "", "Дата операції": _date(spec.get("op_date")),
              "Служба": spec.get("service") or ""}
    for c, (label, code, key) in enumerate(CODES):
        _cell(t.cell(0, c), label, 9)
        _cell(t.cell(1, c), code if code else str(spec.get("unit") or ""), 9)
        _cell(t.cell(2, c), str(codes.get(key) or "") if key else str(values.get(label) or ""), 9, bold=True)
    _par(doc.add_paragraph(), "У результаті огляду встановлено:", 12, align="center", after=2)

    # Таблиця на 17 граф: «Списати» (графи 2–10) і «Оприбуткувати» (графи 11–17).
    n = max(len(off), len(income))
    t = _table(doc, 4 + n + 1, W_MAIN)
    for c, w in enumerate(W_MAIN):
        t.columns[c].width = Twips(w)
    _cell(t.cell(0, 0).merge(t.cell(2, 0)), "№ з/п", 9)
    _cell(t.cell(0, 1).merge(t.cell(0, 9)), "Списати", 10, bold=True)
    _cell(t.cell(0, 10).merge(t.cell(0, 16)), "Оприбуткувати", 10, bold=True)
    for k, label in enumerate(OFF_HEAD):
        c = 1 + k
        _cell(t.cell(1, c).merge(t.cell(2, c)), label, 9, turned=c in TURNED)
    _cell(t.cell(1, 8).merge(t.cell(1, 9)), "експлуатується", 9)
    _cell(t.cell(2, 8), "за нормою", 9)
    _cell(t.cell(2, 9), "фактично", 9)
    for k, label in enumerate(IN_HEAD):
        c = 10 + k
        _cell(t.cell(1, c).merge(t.cell(2, c)), label, 9, turned=c in TURNED)
    for c in range(17):
        _cell(t.cell(3, c), str(c + 1), 8)
    for r, h in ((0, None), (1, 0.6), (2, 2.1), (3, None)):
        _row_flags(t.rows[r], header=True, height=h)
    for i in range(n):
        row = t.rows[4 + i]
        _row_flags(row)
        _cell(row.cells[0], str(i + 1), 10)
        a = off[i] if i < len(off) else None
        if a:
            cells = [(a.get("name"), "left"), (a.get("code"), "center"), (a.get("uom"), "center"), (a.get("cat"), "center"),
                     (_qty(a.get("qty")), "center"), (_money(a.get("price")), "right"), (_money(a.get("sum")), "right"),
                     (a.get("norm") or "—", "center"), (a.get("fact") or "—", "center")]
            for k, (v, al) in enumerate(cells):
                _cell(row.cells[1 + k], v or "", 10, align=al)
        b = income[i] if i < len(income) else None
        if b:
            cells = [(b.get("name"), "left"), (b.get("code"), "center"), (b.get("uom"), "center"), (b.get("cat"), "center"),
                     (_qty(b.get("qty")), "center"), (_money(b.get("price")), "right"), (_money(b.get("sum")), "right")]
            for k, (v, al) in enumerate(cells):
                _cell(row.cells[10 + k], v or "", 10, align=al)
    total = t.rows[4 + n]
    _row_flags(total)
    _cell(total.cells[1], "Усього", 10, bold=True, align="left")
    for start, part, rows in ((5, spec.get("off_total") or {}, off), (14, spec.get("in_total") or {}, income)):
        if rows:
            _cell(total.cells[start], _qty(part.get("qty")), 10, bold=True)
            _cell(total.cells[start + 2], _money(part.get("sum")) if part.get("ok") else "", 10, bold=True, align="right")

    # Технічний стан і висновок комісії: лише те, що написала комісія.
    _par(doc.add_paragraph(), size=4)
    for key, label in TEXTS:
        body = str(text.get(key) or "").strip()
        if not body:
            continue
        paras = body.split("\n")
        par = _par(doc.add_paragraph(), align="justify", after=2)
        _run(par, f"{label}: ", 12, bold=True)
        _run(par, paras[0], 12)
        for more in paras[1:]:
            _par(doc.add_paragraph(), more, 12, align="justify", after=2)

    # Підписи комісії: посада рядком, під нею — звання й ім'я.
    par = _par(doc.add_paragraph(), align="left")
    par.paragraph_format.space_before = Pt(6)
    par.paragraph_format.keep_with_next = True
    _run(par, "Голова комісії: ", 12, bold=True)
    _run(par, head.get("pos") or "", 12)
    _signer(doc, head.get("rank"), head.get("name"))
    members = [m for m in (spec.get("members") or []) if (m.get("name") or "").strip()]
    if members:
        _par(doc.add_paragraph(), "Члени комісії:", 12, bold=True).paragraph_format.keep_with_next = True
    for m in members:
        par = _par(doc.add_paragraph(), m.get("pos") or "", 12)
        par.paragraph_format.left_indent = Cm(1.5)
        par.paragraph_format.keep_with_next = True
        _signer(doc, m.get("rank"), m.get("name"))

    # Висновок старшого начальника — рядками для запису, якщо його ще немає.
    senior = str(text.get("senior") or "").strip()
    par = _par(doc.add_paragraph(), align="justify" if senior else "left")
    par.paragraph_format.space_before = Pt(6)
    par.paragraph_format.keep_with_next = True
    _run(par, "Висновок старшого начальника ", 12, bold=True)
    if senior:
        _run(par, senior, 12)
    else:
        # Місце для запису від руки: лінія до правого поля й ще один рядок під нею.
        for line in (par, _par(doc.add_paragraph(), size=12)):
            line.paragraph_format.tab_stops.add_tab_stop(Twips(sum(W_MAIN)), WD_TAB_ALIGNMENT.RIGHT, WD_TAB_LEADER.LINES)
            line.paragraph_format.keep_with_next = True
            _run(line, "	", 12)
    _par(doc.add_paragraph(), "(посада, військове звання, підпис, Ім’я, ПРІЗВИЩЕ)", 8, align="center").paragraph_format.keep_with_next = True
    _par(doc.add_paragraph(), "М.П.", 12).paragraph_format.keep_with_next = True
    _par(doc.add_paragraph(), f"«___» ____________ {year} року.", 12)
    return doc


def save_tech_act(spec: dict, folder: str) -> str:
    """Записує .docx у теку вивантажень і повертає шлях; файл, відкритий у Word, не затирається."""
    os.makedirs(folder, exist_ok=True)
    name = safe_name(spec.get("file") or "Акт якісного (технічного) стану")
    path = os.path.join(folder, name + ".docx")
    doc = build_tech_act(spec)
    try:
        doc.save(path)
    except PermissionError:
        path = os.path.join(folder, f"{name} {datetime.now():%H%M%S}.docx")
        doc.save(path)
    return path
