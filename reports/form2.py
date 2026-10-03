# -*- coding: utf-8 -*-
"""Форма 2/Прод — звіт-заявка на посуд, столові прибори, кухонний інвентар і тару.

Найдовший із трьох бланків: 38 розділів і 1790 позицій, з яких частина заповнює
небагато. Порожні рядки друкуються — бланк здається цілком.

Рахується так само, як 3/Прод: оборот за період по рядках форми. Спільний
розрахунок лежить у `reports.form3.collect`; тут лише свій бланк на 29 граф.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openpyxl import Workbook                                    # noqa: E402
from openpyxl.styles import Alignment, Border, Font, Side        # noqa: E402
from openpyxl.utils import get_column_letter                     # noqa: E402

from desktop.excel_names import save_book                        # noqa: E402
from reports.form3 import collect as _collect, _q                # noqa: E402

FORM_CODE = "2/Прод"

COLUMNS = [
    ("A", 1, "№ п/п", 6),
    ("B", 2, "Найменування матеріальних засобів", 44),
    ("C", 3, "Одиниця обліку", 8),
    ("D", 4, "Код", 7),
    ("E", 5, "Потреба за штатом мирного часу", 9),
    ("F", 6, "на створення перехідних запасів", 9),
    ("G", 7, "всього", 8),
    ("H", 8, "Наявність на початок: всього", 9),
    ("I", 9, "у військовій частині", 9),
    ("J", 10, "у використанні суб'єктів", 9),
    ("K", 11, "Прибуло: всього", 8),
    ("L", 12, "від заводу (підприємства)", 9),
    ("M", 13, "отримано за нарядами", 9),
    ("N", 14, "інші надходження", 9),
    ("O", 15, "Вибуло: всього", 8),
    ("P", 16, "списано після закінчення строку", 9),
    ("Q", 17, "інші витрати", 9),
    ("R", 18, "Наявність на кінець: всього", 9),
    ("S", 19, "у військовій частині", 9),
    ("T", 20, "у використанні суб'єктів", 9),
    ("U", 21, "I", 5),
    ("V", 22, "II", 5),
    ("W", 23, "III", 5),
    ("X", 24, "IV", 5),
    ("Y", 25, "V", 5),
    ("Z", 26, "Підлягає списанню в поточному році", 9),
    ("AA", 27, "Надлишок", 8),
    ("AB", 28, "Не вистачає", 9),
    ("AC", 29, "Заплановано для забезпечення", 9),
]

THIN = Side(style="thin")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD = Font(name="Times New Roman", size=8, bold=True)
BODY = Font(name="Times New Roman", size=9)
SECT = Font(name="Times New Roman", size=9, bold=True)
TITLE = Font(name="Times New Roman", size=12, bold=True)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)


def collect(con, subdivision_id: int, date_from: str, date_to: str):
    return _collect(con, subdivision_id, date_from, date_to, FORM_CODE)


def build_form2(con, subdivision_id: int, date_from: str, date_to: str, out_path):
    rep = collect(con, subdivision_id, date_from, date_to)
    wb = Workbook()
    ws = wb.active
    ws.title = "звіт"
    for letter, _, _, width in COLUMNS:
        ws.column_dimensions[letter].width = width
    last = COLUMNS[-1][0]

    ws["A1"] = "ЗВІТ-ЗАЯВКА"
    ws["A2"] = ("про наявність і потребу в посуді, столових приборах, кухонному "
                f"інвентарі та тарі — {rep.subdivision}")
    ws["A3"] = f"за період з {date_from} по {date_to}"
    for r, font in ((1, TITLE), (2, BODY), (3, BODY)):
        ws.merge_cells(f"A{r}:{last}{r}")
        ws[f"A{r}"].font, ws[f"A{r}"].alignment = font, CENTER

    for letter, _, label, _ in COLUMNS:
        c = ws[f"{letter}5"]
        c.value, c.font, c.alignment, c.border = label, HEAD, CENTER, BOX
    ws.row_dimensions[5].height = 52
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
        values = {
            "A": no, "B": line.name, "C": "шт.", "D": "",
            "E": _q(line.need), "F": 0, "G": _q(line.need),
            "H": _q(line.opening), "I": _q(line.opening), "J": 0,
            "K": _q(line.incoming), "L": 0, "M": 0, "N": _q(line.incoming),
            "O": _q(line.outgoing), "P": 0, "Q": _q(line.outgoing),
            "R": _q(line.closing), "S": _q(line.closing), "T": 0,
            "U": 0, "V": _q(line.closing), "W": 0, "X": 0, "Y": 0,
            "Z": _q(line.destroyed), "AA": _q(line.surplus),
            "AB": _q(line.shortage), "AC": 0,
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
