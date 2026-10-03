# -*- coding: utf-8 -*-
"""Форма 3/Прод — звіт-заявка про наявність і потребу в технічних засобах.

За період: залишок на початок, надходження, вибуття, залишок на кінець, потреба
за штатом, надлишок і нестача, розклад за категоріями стану. Це та сама оборотка,
яку база вміє з першого дня, вкладена у бланк.

Тотожність «початок + надійшло − вибуло = кінець» тут не рахується окремо, а
випливає з проводок: усі чотири числа — це один і той самий запит із різними
межами дат. У 3.0 ця тотожність була порушена, бо «вибуло» рахувалося без
нижньої межі періоду.
"""
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openpyxl import Workbook                                    # noqa: E402
from openpyxl.styles import Alignment, Border, Font, Side        # noqa: E402
from openpyxl.utils import get_column_letter                     # noqa: E402

from desktop.excel_names import save_book                        # noqa: E402

FORM_CODE = "3/Прод"

COLUMNS = [
    ("A", 1, "№ П/П", 6),
    ("B", 2, "НАЙМЕНУВАННЯ", 34),
    ("C", 3, "Одиниця обліку", 8),
    ("D", 4, "Код", 8),
    ("E", 5, "Потреба згідно зі штатом", 10),
    ("F", 6, "Наявність на початок періоду", 10),
    ("G", 7, "Надійшло усього", 9),
    ("H", 8, "Передано з НЗ на ПЗ", 9),
    ("I", 9, "Отримано за нарядами", 9),
    ("J", 10, "інші надходження", 9),
    ("K", 11, "Вибуло усього", 9),
    ("L", 12, "списано за актами технічного стану", 10),
    ("M", 13, "інші витрати", 9),
    ("N", 14, "Наявність на кінець періоду", 10),
    ("O", 15, "у т.ч. на складах", 9),
    ("P", 16, "І", 6),
    ("Q", 17, "ІІ", 6),
    ("R", 18, "ІІІ", 6),
    ("S", 19, "ІV", 6),
    ("T", 20, "V", 6),
    ("U", 21, "Надлишок", 9),
    ("V", 22, "Не вистачає", 9),
    ("W", 23, "Примітка", 12),
]

THIN = Side(style="thin")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD = Font(name="Times New Roman", size=8, bold=True)
BODY = Font(name="Times New Roman", size=9)
SECT = Font(name="Times New Roman", size=9, bold=True)
TITLE = Font(name="Times New Roman", size=12, bold=True)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)


@dataclass
class Line:
    line_id: int
    name: str
    section: str | None
    uom: str
    need: int = 0
    opening: int = 0
    incoming: int = 0
    outgoing: int = 0
    at_store: int = 0
    destroyed: int = 0          # знищене, але ще не списане

    @property
    def is_section(self) -> bool:
        return self.section is None

    @property
    def closing(self) -> int:
        return self.opening + self.incoming - self.outgoing

    @property
    def surplus(self) -> int:
        return max(0, self.closing - self.need)

    @property
    def shortage(self) -> int:
        return max(0, self.need - self.closing)


@dataclass
class Report:
    subdivision: str
    date_from: str
    date_to: str
    lines: list = field(default_factory=list)

    @property
    def filled(self) -> list:
        return [x for x in self.lines
                if not x.is_section and (x.need or x.opening or x.incoming
                                         or x.outgoing)]


# Дві межі періоду й одна умова «зовнішності».
#
# Вхідний залишок включає документи самої дати початку: «наявність станом на
# 01.01.2026» — це все, що проведено по цю дату включно, а вхідне сальдо саме
# нею й датоване. Рух рахується строго після неї, інакше сальдо потрапило б і в
# залишок, і в надходження.
#
# Переміщення всередині дерева не є ні надходженням, ні вибуттям для того, хто
# це дерево очолює: віддав один підрозділ, отримав інший, у бригади не змінилося
# нічого. Тому рух зараховується лише тоді, коли другий бік поза піддеревом.
_INSIDE = """
    EXISTS (SELECT 1 FROM subdivision_tree t2
            WHERE t2.ancestor_id = :sub AND t2.descendant_id = p.counter_subdivision_id)
"""

_SQL = f"""
SELECT m.report_line_id AS id,
       COALESCE(SUM(CASE WHEN p.doc_date <= :d1 THEN p.sign * p.qty_milli END), 0) AS opening,
       COALESCE(SUM(CASE WHEN p.doc_date > :d1 AND p.doc_date <= :d2 AND p.sign > 0
                          AND NOT {_INSIDE} THEN p.qty_milli END), 0) AS incoming,
       COALESCE(SUM(CASE WHEN p.doc_date > :d1 AND p.doc_date <= :d2 AND p.sign < 0
                          AND NOT {_INSIDE} THEN p.qty_milli END), 0) AS outgoing
FROM posting p
JOIN nomen_report_line m ON m.nomen_id = p.nomen_id
JOIN report_line rl ON rl.id = m.report_line_id
JOIN report_form f ON f.id = rl.form_id AND f.code = :form
JOIN subdivision_tree t ON t.descendant_id = p.subdivision_id
WHERE t.ancestor_id = :sub AND p.doc_date <= :d2
GROUP BY m.report_line_id
"""

_STORE = """
SELECT m.report_line_id AS id, SUM(p.sign * p.qty_milli) AS qty
FROM posting p
JOIN nomen_report_line m ON m.nomen_id = p.nomen_id
JOIN report_line rl ON rl.id = m.report_line_id
JOIN report_form f ON f.id = rl.form_id AND f.code = :form
JOIN subdivision s ON s.id = p.subdivision_id
JOIN subdivision_kind k ON k.id = s.kind_id
WHERE p.doc_date <= :d2 AND k.code = 'склад'
GROUP BY m.report_line_id
"""

# Знищене майно числиться в обліку, доки не проведено акт списання. Саме воно
# й стоїть у графі «підлягає списанню в поточному році»: воно ще на балансі, але
# його вже немає.
_DESTROYED = """
SELECT m.report_line_id AS id, SUM(d.qty_milli) AS qty
FROM destroyed_open d
JOIN nomen_report_line m ON m.nomen_id = d.nomen_id
JOIN report_line rl ON rl.id = m.report_line_id
JOIN report_form f ON f.id = rl.form_id AND f.code = :form
JOIN subdivision_tree t ON t.descendant_id = d.subdivision_id
WHERE t.ancestor_id = :sub AND d.doc_date <= :d2
GROUP BY m.report_line_id
"""

_NEED = """
SELECT n.report_line_id AS id, SUM(n.qty_milli) AS qty
FROM norm n
JOIN report_line rl ON rl.id = n.report_line_id
JOIN report_form f ON f.id = rl.form_id AND f.code = :form
JOIN subdivision_tree t ON t.descendant_id = n.subdivision_id
WHERE t.ancestor_id = :sub AND n.valid_from <= :d2
  AND (n.valid_to IS NULL OR n.valid_to > :d2)
GROUP BY n.report_line_id
"""


def collect(con, subdivision_id: int, date_from: str, date_to: str,
            form_code: str = FORM_CODE) -> Report:
    """Оборот за період по рядках указаної форми.

    Форми 3/Прод і 2/Прод відрізняються переліком і бланком, але рахуються
    однаково, тож розрахунок один на обидві.
    """
    name = con.execute("SELECT name FROM subdivision WHERE id = ?",
                       (subdivision_id,)).fetchone()[0]
    p = dict(sub=subdivision_id, d1=date_from, d2=date_to, form=form_code)
    moves = {r["id"]: r for r in con.execute(_SQL, p)}
    store = {r["id"]: r["qty"] for r in con.execute(_STORE, p)}
    need = {r["id"]: r["qty"] for r in con.execute(_NEED, p)}
    gone = {r["id"]: r["qty"] for r in con.execute(_DESTROYED, p)}

    rep = Report(subdivision=name, date_from=date_from, date_to=date_to)
    for r in con.execute(
            "SELECT rl.id, rl.name, rl.section, rl.sort FROM report_line rl "
            "JOIN report_form f ON f.id = rl.form_id WHERE f.code = ? ORDER BY rl.sort",
            (form_code,)):
        m = moves.get(r["id"])
        rep.lines.append(Line(
            line_id=r["id"], name=r["name"], section=r["section"], uom="к-т",
            need=need.get(r["id"], 0),
            opening=m["opening"] if m else 0,
            incoming=m["incoming"] if m else 0,
            outgoing=m["outgoing"] if m else 0,
            at_store=store.get(r["id"], 0),
            destroyed=gone.get(r["id"], 0)))
    return rep


def _q(milli: int):
    if milli == 0:
        return 0
    return milli // 1000 if milli % 1000 == 0 else milli / 1000


def build_form3(con, subdivision_id: int, date_from: str, date_to: str, out_path) -> Report:
    rep = collect(con, subdivision_id, date_from, date_to)
    wb = Workbook()
    ws = wb.active
    ws.title = "звіт ф3"
    for letter, _, _, width in COLUMNS:
        ws.column_dimensions[letter].width = width
    last = get_column_letter(len(COLUMNS))

    ws["A1"] = "ЗВІТ-ЗАЯВКА"
    ws["A2"] = ("про наявність і потребу в технічних засобах продовольчої служби "
                f"{rep.subdivision}")
    ws["A3"] = f"за період з {date_from} по {date_to}"
    for r, font in ((1, TITLE), (2, BODY), (3, BODY)):
        ws.merge_cells(f"A{r}:{last}{r}")
        ws[f"A{r}"].font, ws[f"A{r}"].alignment = font, CENTER

    for letter, _, label, _ in COLUMNS:
        c = ws[f"{letter}5"]
        c.value, c.font, c.alignment, c.border = label, HEAD, CENTER, BOX
    ws.row_dimensions[5].height = 46
    for letter, number, _, _ in COLUMNS:
        c = ws[f"{letter}6"]
        c.value, c.font, c.alignment, c.border = number, HEAD, CENTER, BOX

    row, no = 7, 0
    for line in rep.lines:
        if line.is_section:
            ws[f"A{row}"] = line.name
            ws[f"A{row}"].font = SECT
            ws.merge_cells(f"A{row}:{last}{row}")
            ws[f"A{row}"].alignment = LEFT
            for letter, _, _, _ in COLUMNS:
                ws[f"{letter}{row}"].border = BOX
            row += 1
            continue
        no += 1
        # Категорії І-V поки не заповнюються: акта технічного стану в базі немає,
        # а вигадувати категорію позиції — це вигадувати дані.
        values = {
            "A": no, "B": line.name, "C": line.uom, "D": "",
            "E": _q(line.need), "F": _q(line.opening),
            "G": _q(line.incoming), "H": 0, "I": 0, "J": _q(line.incoming),
            "K": _q(line.outgoing), "L": 0, "M": _q(line.outgoing),
            "N": _q(line.closing), "O": _q(line.at_store),
            "P": 0, "Q": _q(line.closing), "R": 0, "S": 0, "T": 0,
            "U": _q(line.surplus), "V": _q(line.shortage), "W": "",
        }
        for letter, _, _, _ in COLUMNS:
            c = ws[f"{letter}{row}"]
            c.value = values[letter]
            c.font, c.border = BODY, BOX
            c.alignment = LEFT if letter == "B" else CENTER
        row += 1

    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0       # заввишки — скільки треба, а не один аркуш
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    ws.print_title_rows = "5:6"
    ws.print_area = f"A1:{last}{row - 1}"
    ws.freeze_panes = "C7"
    save_book(wb, out_path)
    return rep
