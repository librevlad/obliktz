# -*- coding: utf-8 -*-
"""Відомість наявності — укомплектованість підрозділів за табелем.

Матриця «табельна позиція × підрозділ», по п'ять граф на підрозділ: штатна
потреба, наявність, технічно справні, некомплект, відсоток. Це той самий штат і
та сама наявність, що й у формі 21/Прод, тільки розкладені поперек, щоб було
видно, у кого чого бракує.

Колонка «упр» — це бригадні підрозділи: склад, роти забезпечення, служби. У
дереві вони діти кореня нарівні з батальйонами, тому рахуються як корінь мінус
батальйони.

«Технічно справні» — це наявність мінус знищене, ще не списане. Знищене
продовжує числитися в обліку, доки не пройде акт списання, але справним воно
вже не є, і саме цю різницю показує графа.
"""
import sys
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openpyxl import Workbook                                    # noqa: E402
from openpyxl.styles import Alignment, Border, Font, Side        # noqa: E402
from openpyxl.utils import get_column_letter                     # noqa: E402
from openpyxl.worksheet.pagebreak import Break                   # noqa: E402

from desktop.excel_names import save_book                        # noqa: E402
from reports.form21 import collect as collect21                  # noqa: E402

SUB_COLUMNS = ["ШТП", "Наявність", "Технічно справні", "Некомплект", "%"]
# Друк: по три підрозділи на сторінку завширшки в масштабі 60 %. Усі дев'ять на одній
# сторінці Excel стискає до 24 % — з аркуша А4 не прочитати. Масштаб сталий, бо з «вмістити
# в N сторінок» Excel не зважає на ручні розриви й рве п'ятірку граф підрозділу між
# сторінками. Графа найменувань (225 пт) і п'ятнадцять граф по 62 пт вміщуються в альбомний
# А4 з полями 0,75" щонайбільше в 64 %; 60 % лишає запас на інший принтер і масштаб екрана.
PER_PAGE = 3
SCALE = 60

THIN = Side(style="thin")
BOX = Border(left=THIN, right=THIN, top=THIN, bottom=THIN)
HEAD = Font(name="Times New Roman", size=9, bold=True)
BODY = Font(name="Times New Roman", size=9)
TOTAL = Font(name="Times New Roman", size=9, bold=True)
TITLE = Font(name="Times New Roman", size=12, bold=True)
CENTER = Alignment(horizontal="center", vertical="center", wrap_text=True)
LEFT = Alignment(horizontal="left", vertical="center", wrap_text=True)


@dataclass
class Cell:
    need: int = 0
    have: int = 0
    destroyed: int = 0

    @property
    def serviceable(self) -> int:
        """Наявність за вирахуванням знищеного, ще не списаного.

        Саме так рахує відомість, яку веде служба: технічно справних термосів у
        неї менше, ніж наявних, а різниця — це втрати, за якими акт списання ще
        не пройшов.
        """
        return self.have - self.destroyed

    @property
    def gap(self) -> int:
        return max(0, self.need - self.have)

    @property
    def ratio(self) -> float:
        return self.have / self.need if self.need else 0.0


@dataclass
class Sheet:
    as_of: str
    columns: list = field(default_factory=list)      # назви підрозділів
    rows: list = field(default_factory=list)         # назви табельних позицій
    cells: dict = field(default_factory=dict)        # (рядок, колонка) -> Cell


def _battalions(con, root_id: int) -> list[tuple[int, str]]:
    return [(r["id"], r["name"]) for r in con.execute(
        "SELECT s.id, s.name FROM subdivision s "
        "JOIN subdivision_kind k ON k.id = s.kind_id "
        "WHERE s.parent_id = ? AND k.code = 'батальйон' ORDER BY s.sort", (root_id,))]


def _root(con) -> str:
    """Корінь дерева підрозділів — уся частина."""
    return con.execute("SELECT name FROM subdivision WHERE parent_id IS NULL "
                       "ORDER BY sort, id LIMIT 1").fetchone()[0]


def collect(con, as_of: str, root: str | None = None) -> Sheet:
    root = root or _root(con)
    root_id = con.execute("SELECT id FROM subdivision WHERE name = ?",
                          (root,)).fetchone()[0]
    bns = _battalions(con, root_id)

    whole = collect21(con, root_id, as_of)
    per_bn = {name: collect21(con, sid, as_of) for sid, name in bns}

    # Рядки — лише ті табельні позиції, де є штат або наявність: відомість
    # читають очима, а не здають, тож 184 порожні марки в ній зайві.
    keep = [x.name for x in whole.lines
            if not x.is_section and (x.need or x.have)]

    sheet = Sheet(as_of=as_of, rows=keep,
                  columns=[root, "упр"] + [n for _, n in bns])
    for rep, col in [(whole, root)] + [(per_bn[n], n) for _, n in bns]:
        by_name = {x.name: x for x in rep.lines}
        for name in keep:
            line = by_name[name]
            sheet.cells[(name, col)] = Cell(need=line.need, have=line.have,
                                            destroyed=line.destroyed)

    for name in keep:
        total = sheet.cells[(name, root)]
        rest_need = sum(sheet.cells[(name, n)].need for _, n in bns)
        rest_have = sum(sheet.cells[(name, n)].have for _, n in bns)
        rest_gone = sum(sheet.cells[(name, n)].destroyed for _, n in bns)
        sheet.cells[(name, "упр")] = Cell(need=total.need - rest_need,
                                          have=total.have - rest_have,
                                          destroyed=total.destroyed - rest_gone)
    return sheet


def _q(milli: int):
    if milli == 0:
        return 0
    return milli // 1000 if milli % 1000 == 0 else milli / 1000


def build_vidomist(con, as_of: str, out_path, root: str | None = None) -> Sheet:
    sheet = collect(con, as_of, root)
    wb = Workbook()
    ws = wb.active
    ws.title = "Відомість"

    ws.column_dimensions["A"].width = 40
    width = 1 + len(sheet.columns) * len(SUB_COLUMNS)
    for i in range(2, width + 1):
        ws.column_dimensions[get_column_letter(i)].width = 11
    last = get_column_letter(width)
    page_width = PER_PAGE * len(SUB_COLUMNS)        # граф підрозділів на сторінці друку

    ws["A1"] = f"Відомість наявності станом на {as_of}"
    # На екрані заголовок стоїть над графами першої сторінки друку (над усіма 46 його
    # середина за межами екрана). У друк він іде верхнім колонтитулом — на кожній сторінці
    # й у справжні 12 пт, а не стиснуті масштабом; рядок 1 з області друку виходить, щоб на
    # першій сторінці не подвоюватися.
    ws.merge_cells(f"A1:{get_column_letter(min(width, 1 + page_width))}1")
    ws["A1"].font, ws["A1"].alignment = TITLE, CENTER

    ws["A2"] = "Найменування"
    ws.merge_cells("A2:A3")
    ws["A2"].font, ws["A2"].alignment, ws["A2"].border = HEAD, CENTER, BOX
    col = 2
    for name in sheet.columns:
        ws.cell(row=2, column=col, value=name).font = HEAD
        ws.merge_cells(start_row=2, start_column=col,
                       end_row=2, end_column=col + len(SUB_COLUMNS) - 1)
        ws.cell(row=2, column=col).alignment = CENTER
        for i, label in enumerate(SUB_COLUMNS):
            c = ws.cell(row=3, column=col + i, value=label)
            c.font, c.alignment, c.border = HEAD, CENTER, BOX
        col += len(SUB_COLUMNS)
    ws.row_dimensions[3].height = 34

    row = 4
    for name in sheet.rows:
        c = ws.cell(row=row, column=1, value=name)
        c.font, c.alignment, c.border = BODY, LEFT, BOX
        col = 2
        for sub in sheet.columns:
            cell = sheet.cells[(name, sub)]
            for i, value in enumerate((_q(cell.need), _q(cell.have),
                                       _q(cell.serviceable), _q(cell.gap),
                                       round(cell.ratio, 4))):
                x = ws.cell(row=row, column=col + i, value=value)
                x.font, x.alignment, x.border = BODY, CENTER, BOX
                if i == 4:
                    x.number_format = "0%"
            col += len(SUB_COLUMNS)
        row += 1

    c = ws.cell(row=row, column=1, value="Всього згідно штатної потреби")
    c.font, c.alignment, c.border = TOTAL, LEFT, BOX
    col = 2
    for sub in sheet.columns:
        need = sum(sheet.cells[(n, sub)].need for n in sheet.rows)
        have = sum(sheet.cells[(n, sub)].have for n in sheet.rows)
        ok = sum(sheet.cells[(n, sub)].serviceable for n in sheet.rows)
        gap = sum(sheet.cells[(n, sub)].gap for n in sheet.rows)
        for i, value in enumerate((_q(need), _q(have), _q(ok), _q(gap),
                                   round(have / need, 4) if need else 0)):
            x = ws.cell(row=row, column=col + i, value=value)
            x.font, x.alignment, x.border = TOTAL, CENTER, BOX
            if i == 4:
                x.number_format = "0%"
        col += len(SUB_COLUMNS)

    ws.page_setup.orientation = "landscape"
    ws.page_setup.paperSize = ws.PAPERSIZE_A4
    # По PER_PAGE підрозділів на сторінку завширшки, заввишки — скільки треба. Графа
    # найменувань і шапка — на кожній сторінці, розриви — на межах підрозділів.
    ws.page_setup.scale = SCALE
    ws.print_title_rows = "2:3"
    ws.print_title_cols = "A:A"
    for page in range(1, -(-len(sheet.columns) // PER_PAGE)):
        ws.col_breaks.append(Break(id=1 + page * page_width))
    ws.oddHeader.center.text = ws["A1"].value
    ws.oddHeader.center.font = "Times New Roman,Bold"
    ws.oddHeader.center.size = 12
    ws.HeaderFooter.scaleWithDoc = False    # інакше Excel стискає й колонтитул до 60 %
    ws.print_area = f"A2:{last}{row}"
    ws.freeze_panes = "B4"
    save_book(wb, out_path)
    return sheet
