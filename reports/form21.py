# -*- coding: utf-8 -*-
"""Форма 21/Прод — потреба та забезпеченість технічними засобами.

Перелік форми табельний: 19 розділів і марки, з яких у частині є майно лише по
небагатьох. Порожні рядки все одно друкуються — бланк здається цілком, і нуль у
ньому теж є відповіддю.

Розділ («Кухні причіпні:») — це підсумок своїх марок, а не окремий рядок обліку.
Тому спершу рахуються марки, потім розділи згортаються з них: інакше майно, яке
служба веде під маркою, у підсумок розділу не потрапить.

Донесення «станом на 1 липня» — це кінець 30 червня: так його складає частина, і так
рахується квартал у назві файла. Документ, датований самою звітною датою, — уже наступного
кварталу. Знищене майно, списане актом пізніше, на звітну дату ще стоїть у графі 21.
Звірено з бланком, який частина здала за II квартал 2026 року.

Категорії І-ІІІ / ІV / V — вимір проводки, а не властивість позиції. Поки актів
технічного стану в базі немає, усе майно стоїть у І-ІІІ категорії поточного
забезпечення, і це видно у графі 14.

Книга будується в самому бланку вищого штабу (`desktop/templates/form21.xlsx` — зразок
за III квартал 2026 року): шапка, розділи, формули розділів і підсумків «Всього ТЗ на
АБШ/ПБШ», примітка під таблицею — усе з бланка. Марка обліку лягає в офіційний рядок із
тією самою назвою; марка, якої в бланку немає, — у вільний рядок свого розділу, а коли
вільних немає — у «Інше майно» (бланк росте на потрібну кількість рядків). Назви
офіційних рядків не змінюються: «Зміна найменувань матеріальних засобів не
допускається».
"""
import datetime
import re
import sys
from copy import copy
from dataclasses import dataclass, field
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from openpyxl import Workbook, load_workbook                     # noqa: E402
from openpyxl.styles import Alignment, Border, Font, Side        # noqa: E402
from openpyxl.utils import get_column_letter                     # noqa: E402

from desktop.excel_names import save_book                        # noqa: E402

FORM_CODE = "21/Прод"
# У зібраній програмі бланки лежать у теці templates поруч із кодом (PyInstaller), з джерел — у desktop/templates.
TEMPLATE = Path(getattr(sys, "_MEIPASS", Path(__file__).resolve().parents[1] / "desktop")) / "templates" / "form21.xlsx"
FIRST_ROW = 9                      # перший рядок таблиці бланка — розділ 1
NEED, HAVE, GONE = "F", "N", "T"   # потреба в/ч на в/час, ПЗ І-ІІІ категорії, примітка (знищено)
LAST = "T"                         # остання графа бланка; U — службова сума рядка
SECTION_COLS = "FGHIKLMNOPQT"      # графи, які розділ підсумовує зі своїх марок
ROMAN = {1: "I", 2: "II", 3: "III", 4: "IV"}


@dataclass
class Line:
    line_id: int
    name: str
    section: str | None
    uom: str
    is_section: bool
    need: int = 0
    have: int = 0
    destroyed: int = 0

    @property
    def surplus(self) -> int:
        return max(0, self.have - self.need)

    @property
    def shortage(self) -> int:
        return max(0, self.need - self.have)


@dataclass
class Report:
    subdivision: str
    as_of: str
    lines: list = field(default_factory=list)
    # Марки, для яких у бланку не знайшлося офіційного рядка: лягли у вільні рядки
    # під власною назвою — щоб служба бачила, що бланк називає їх інакше або не знає.
    unofficial: list = field(default_factory=list)

    @property
    def filled(self) -> list:
        """Рядки, де є хоч що-небудь — для читання очима, не для друку."""
        return [x for x in self.lines if x.need or x.have or x.destroyed]


# Підрозділи охоплення підставляються переліком номерів ({subs}): так рахується і піддерево
# (батальйон з усім підпорядкованим), і «все, крім батальйонів».
# :cut — останній день, який входить у донесення: «станом на 1 липня» — це кінець 30 червня.
_NEED = """
SELECT n.report_line_id AS id, SUM(n.qty_milli) AS qty
FROM norm n
WHERE n.subdivision_id IN ({subs}) AND n.report_line_id IS NOT NULL
  AND n.valid_from <= :cut AND (n.valid_to IS NULL OR n.valid_to > :cut)
GROUP BY n.report_line_id
"""

_HAVE = """
SELECT m.report_line_id AS id, SUM(p.sign * p.qty_milli) AS qty
FROM posting p
JOIN nomen_report_line m ON m.nomen_id = p.nomen_id
WHERE p.subdivision_id IN ({subs}) AND p.doc_date <= :cut
GROUP BY m.report_line_id
"""

# Знищене, ще не списане на той день: рапорт до дати включно, а акт списання — пізніше або
# його немає. Подання destroyed_open знає лише сьогоднішній стан: списане вже після звітної дати
# воно не показує, хоча на звітну дату це майно ще значилося знищеним. Правило закриття те саме:
# рядок рапорту закриває акт, прив'язаний до цього рядка, а рапорт без таких прив'язок — акт,
# пов'язаний із самим рапортом.
_DESTROYED = """
SELECT m.report_line_id AS id, SUM(l.qty_milli) AS qty
FROM document_line l
JOIN document d ON d.id = l.document_id
JOIN doc_kind k ON k.id = d.kind_id
JOIN nomen_report_line m ON m.nomen_id = l.nomen_id
WHERE k.code = 'report_destroyed' AND d.from_subdivision_id IN ({subs}) AND d.doc_date <= :cut
  AND CASE
    WHEN EXISTS (SELECT 1 FROM report_line_act ra JOIN document_line l2 ON l2.id = ra.line_id
                  WHERE l2.document_id = d.id)
    THEN NOT EXISTS (SELECT 1 FROM report_line_act ra
                       JOIN document a ON a.id = ra.act_id JOIN doc_kind ak ON ak.id = a.kind_id
                      WHERE ra.line_id = l.id AND ak.affects_stock = 1 AND a.doc_date <= :cut)
    ELSE NOT EXISTS (SELECT 1 FROM document_link dl
                       JOIN document a ON a.id = dl.to_document_id JOIN doc_kind ak ON ak.id = a.kind_id
                      WHERE dl.from_document_id = d.id AND ak.affects_stock = 1 AND a.doc_date <= :cut)
  END
GROUP BY m.report_line_id
"""


# Одиниця власного рядка (якого в бланку немає) — та, у якій ведуться його коди: 2420 мисок і
# ложок — «шт», а не «к-т». Коди в різних одиницях або рядок без кодів — «к-т», як у бланку.
_UOM = """
SELECT m.report_line_id AS id, MIN(u.name) AS lo, MAX(u.name) AS hi
FROM nomen_report_line m
JOIN nomen n ON n.id = m.nomen_id
JOIN uom u ON u.id = n.uom_id
GROUP BY m.report_line_id
"""


def last_day(as_of: str) -> str:
    """Останній день, який входить у донесення «станом на» дату, — день перед нею: «станом на
    1 липня» закриває II квартал, а документ від 1 липня — уже III квартал."""
    return (datetime.date.fromisoformat(as_of) - datetime.timedelta(days=1)).isoformat()


def subtree(con, subdivision_id: int) -> list:
    """Підрозділ з усім підпорядкованим — номери записів довідника."""
    return [r[0] for r in con.execute(
        "SELECT descendant_id FROM subdivision_tree WHERE ancestor_id = ?", (subdivision_id,))]


def collect(con, subdivision_id: int, as_of: str) -> Report:
    name = con.execute("SELECT name FROM subdivision WHERE id = ?",
                       (subdivision_id,)).fetchone()[0]
    return collect_subs(con, subtree(con, subdivision_id), as_of, name)


def collect_subs(con, subdivision_ids, as_of: str, name: str) -> Report:
    """Потреба, наявність і знищене за переліком підрозділів станом на дату — на кінець дня перед нею."""
    subs = ",".join(str(int(x)) for x in subdivision_ids) or "NULL"
    p = dict(cut=last_day(as_of))
    need = {r["id"]: r["qty"] for r in con.execute(_NEED.format(subs=subs), p)}
    have = {r["id"]: r["qty"] for r in con.execute(_HAVE.format(subs=subs), p)}
    gone = {r["id"]: r["qty"] for r in con.execute(_DESTROYED.format(subs=subs), p)}
    uoms = {r["id"]: r["lo"] for r in con.execute(_UOM) if r["lo"] and r["lo"] == r["hi"]}

    rep = Report(subdivision=name, as_of=as_of)
    by_section = {}
    for r in con.execute(
            "SELECT rl.id, rl.name, rl.section, rl.sort FROM report_line rl "
            "JOIN report_form f ON f.id = rl.form_id WHERE f.code = ? ORDER BY rl.sort",
            (FORM_CODE,)):
        is_section = r["section"] is None
        line = Line(line_id=r["id"], name=r["name"], section=r["section"],
                    uom=uoms.get(r["id"], "к-т"), is_section=is_section,
                    need=need.get(r["id"], 0), have=have.get(r["id"], 0),
                    destroyed=gone.get(r["id"], 0))
        rep.lines.append(line)
        if is_section:
            by_section[r["name"].rstrip(":")] = line

    # Розділ — підсумок своїх марок, а не самостійний рядок обліку.
    for line in rep.lines:
        if line.is_section or line.section not in by_section:
            continue
        head = by_section[line.section]
        head.need += line.need
        head.have += line.have
        head.destroyed += line.destroyed
    return rep


def _q(milli: int):
    if milli == 0:
        return 0
    return milli // 1000 if milli % 1000 == 0 else milli / 1000


def _norm(text) -> str:
    """Назва для збігу: без зайвих пробілів, регістру, двокрапки й різниці апострофів."""
    s = str(text or "").replace("’", "'").replace("ʼ", "'").replace("‘", "'")
    return re.sub(r"\s+", " ", s).strip().lower().rstrip(":").strip()


# ------------------------------------------------------------------ бланк
@dataclass
class Block:
    """Розділ бланка: рядок заголовка, рядки марок (офіційні назви) і вільні рядки."""
    no: int
    name: str
    row: int
    rows: list = field(default_factory=list)       # усі рядки марок розділу по порядку
    marks: dict = field(default_factory=dict)      # норм. назва → рядок
    spares: list = field(default_factory=list)     # рядки без назви


def _blocks(ws):
    """Розділи бланка від першого рядка таблиці до «Всього ТЗ на АБШ»; повертає їх і
    рядок цього підсумку."""
    blocks, cur, r = [], None, FIRST_ROW
    while r <= ws.max_row:
        a, b = ws[f"A{r}"].value, ws[f"B{r}"].value
        text = str(b or "").strip()
        if text.startswith("Всього ТЗ"):
            return blocks, r
        if a not in (None, "") and text:
            cur = Block(no=int(a), name=text, row=r)
            blocks.append(cur)
        elif cur is not None:
            cur.rows.append(r)
            if text:
                cur.marks.setdefault(_norm(text), r)
            else:
                cur.spares.append(r)
        r += 1
    raise ValueError("у бланку немає рядка «Всього ТЗ на АБШ»")


def _row_formulas(ws, r):
    """Формули рядка марки — як у бланку: потреба й наявність разом, надлишок і нестача,
    службова сума в U."""
    ws[f"D{r}"] = f"=F{r}+H{r}"
    ws[f"E{r}"] = f"=G{r}+I{r}"
    ws[f"J{r}"] = f"=SUM(K{r}:Q{r})"
    ws[f"R{r}"] = f"=IF(J{r}-D{r}<0,0,J{r}-D{r})"
    ws[f"S{r}"] = f"=IF(D{r}-J{r}<0,0,D{r}-J{r})"
    ws[f"U{r}"] = f"=SUM(D{r}:T{r})"


def _section_formulas(ws, block):
    """Розділ підсумовує всі свої марки — і ті, що бланк забув включити, і дописані."""
    for col in SECTION_COLS:
        ws[f"{col}{block.row}"] = "=" + "+".join(f"{col}{r}" for r in block.rows) if block.rows else None
    _row_formulas(ws, block.row)


def _grow(ws, block, total_row: int, n: int) -> int:
    """Дописати n вільних рядків у кінець розділу (перед «Всього ТЗ»): злиття, висоти й
    стилі рядків нижче зсуваються разом із ними."""
    below = [m for m in list(ws.merged_cells.ranges) if m.min_row >= total_row]
    for m in below:
        ws.unmerge_cells(str(m))
    heights = {r: ws.row_dimensions[r].height for r in range(total_row, ws.max_row + 1)}
    ws.insert_rows(total_row, n)
    for r, h in sorted(heights.items(), reverse=True):
        ws.row_dimensions[r + n].height = h
    for m in below:
        ws.merge_cells(start_row=m.min_row + n, start_column=m.min_col, end_row=m.max_row + n, end_column=m.max_col)
    sample = block.rows[-1] if block.rows else block.row
    for r in range(total_row, total_row + n):
        ws.row_dimensions[r].height = ws.row_dimensions[sample].height
        for col in "ABCDEFGHIJKLMNOPQRSTU":
            src, dst = ws[f"{col}{sample}"], ws[f"{col}{r}"]
            dst.font, dst.border, dst.alignment = copy(src.font), copy(src.border), copy(src.alignment)
            dst.number_format = src.number_format
            dst.value = None
        block.rows.append(r)
        block.spares.append(r)
    return total_row + n


def _unit_code(con) -> str:
    row = con.execute("SELECT value FROM settings WHERE key = 'unit_legal_name'").fetchone()
    m = re.search(r"\b([А-ЯA-Z]\d{4})\b", str(row[0] if row else ""))
    return m.group(1) if m else ""


def quarter_title(as_of: str) -> str:
    """«III кв 2026 р» — квартал того дня, на який складено форму: «станом на 1 жовтня»
    закриває третій квартал, тож береться день перед датою."""
    d = datetime.date.fromisoformat(last_day(as_of))
    return f"{ROMAN[(d.month - 1) // 3 + 1]} кв {d.year} р"


def file_name(as_of: str, unit: str = "") -> str:
    return f"{unit or 'А0000'} - 21 Прод {quarter_title(as_of)}.xlsx"


def _fill(ws, rep: Report) -> None:
    """Аркуш бланка — числами звіту: марки в офіційні рядки, решта у вільні, формули розділів."""
    blocks, total_row = _blocks(ws)
    by_section = {_norm(b.name): b for b in blocks}
    other = blocks[-1]
    used = set()
    # Підсумкові рядки бланка («Всього ТЗ на АБШ/ПБШ») — формули з розділів; у переліку
    # форми вони теж є, але в таблицю як марки не йдуть.
    totals = {_norm(ws[f"B{r}"].value) for r in range(total_row, ws.max_row + 1) if ws[f"B{r}"].value}

    def put(r, line, official):
        if not official:
            ws[f"B{r}"] = line.name
            ws[f"C{r}"] = line.uom
        for col, milli in ((NEED, line.need), (HAVE, line.have), (GONE, line.destroyed)):
            ws[f"{col}{r}"] = _q(milli) if milli else None
        _row_formulas(ws, r)
        used.add(r)

    # Спершу — офіційні рядки за назвою, потім решта у вільні рядки: вільний рядок не
    # має дістатися марці, для якої нижче є свій офіційний.
    pending = []
    for line in rep.lines:
        if line.is_section or _norm(line.name) in totals:
            continue
        block = by_section.get(_norm(line.section), other)
        r = block.marks.get(_norm(line.name))
        if r is not None and r not in used:
            put(r, line, official=True)
        else:
            pending.append((block, line))
    for block, line in pending:
        spare = next((s for s in block.spares if s not in used), None)
        if spare is None:
            spare = next((s for s in other.spares if s not in used), None)
        if spare is None:
            total_row = _grow(ws, other, total_row, 1)
            spare = other.spares[-1]
        put(spare, line, official=False)
        rep.unofficial.append(line.name)
    for block in blocks:
        _section_formulas(ws, block)
    ws.print_area = f"A1:{LAST}{ws.max_row}"
    # Бланк на одну сторінку завширшки й на стільки заввишки, скільки треба; шапка (3:7) — з бланка.
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True


def _sheet_title(text: str) -> str:
    return re.sub(r"[\\/*?:\[\]]", " ", str(text))[:31].strip()


def _file_part(text: str) -> str:
    """Назва підрозділу в імені файлу — без знаків, яких не приймає Windows."""
    return re.sub(r'[<>:"/\\|?*]', " ", str(text)).strip(" .")


def _root_id(con) -> int:
    return con.execute("SELECT id FROM subdivision WHERE parent_id IS NULL ORDER BY id LIMIT 1").fetchone()[0]


def build_form21(con, subdivision_id: int, as_of: str, out_path) -> Report:
    rep = collect(con, subdivision_id, as_of)
    wb = load_workbook(TEMPLATE)
    ws = wb.active
    _fill(ws, rep)
    unit = _unit_code(con)
    whole = _root_id(con) == subdivision_id
    if whole and unit:
        ws.title = unit
    elif not whole:
        ws.title = _sheet_title(rep.subdivision) or ws.title
    save_book(wb, out_path)
    return rep


def save_form21(con, spec: dict, folder) -> str:
    """Книга для вивантаження з програми: `spec` — {sub: назва підрозділу (порожньо —
    уся частина), date: станом на}. Повертає шлях файла."""
    as_of = str(spec.get("date") or datetime.date.today().isoformat())
    name = str(spec.get("sub") or "").strip()
    if name:
        row = con.execute("SELECT id FROM subdivision WHERE name = ?", (name,)).fetchone()
        if not row:
            raise ValueError(f"підрозділу «{name}» немає")
        sub = row[0]
    else:
        sub = con.execute("SELECT id FROM subdivision WHERE parent_id IS NULL ORDER BY id LIMIT 1").fetchone()[0]
    unit = _unit_code(con)
    base = file_name(as_of, unit)
    if name:
        base = base.replace(".xlsx", f" — {_file_part(name)}.xlsx")
    Path(folder).mkdir(parents=True, exist_ok=True)
    path = Path(folder) / base
    build_form21(con, sub, as_of, path)
    return str(path)


# ------------------------------------------------------------------ комплект
HQ = "Управління"                  # усе, що не входить до жодного батальйону


def scopes(con) -> list:
    """Охоплення комплекту: [(назва, [номери підрозділів], чинний)]. Перша — уся частина (назва
    порожня), далі управління — усе поза батальйонами, далі кожен батальйон з усім підпорядкованим.
    Батальйон, що стоїть усередині іншого (колишня назва після переформування), окремо не йде:
    його майно й штат рахуються за тим, до якого він увійшов."""
    whole = subtree(con, _root_id(con))
    bats = [(r[0], r[1], bool(r[2])) for r in con.execute(
        "SELECT s.id, s.name, s.is_active FROM subdivision s JOIN subdivision_kind k ON k.id = s.kind_id "
        "WHERE k.code = 'батальйон' ORDER BY s.sort, s.id")]
    inside = {b[0]: set(subtree(con, b[0])) for b in bats}
    top = [b for b in bats if b[0] in whole and not any(b[0] in inside[o[0]] for o in bats if o[0] != b[0])]
    taken = set().union(*(inside[b[0]] for b in top)) if top else set()
    return ([("", whole, True), (HQ, [x for x in whole if x not in taken], True)]
            + [(name, sorted(inside[bid]), active) for bid, name, active in top])


def _blank_copy(wb, src):
    """Ще один чистий аркуш бланка в тій самій книзі — з його шапкою для друку й закріпленням."""
    ws = wb.copy_worksheet(src)
    ws.print_title_rows = src.print_title_rows
    ws.freeze_panes = src.freeze_panes
    ws.sheet_view.zoomScale = src.sheet_view.zoomScale
    ws.oddHeader.center.text, ws.oddFooter.center.text = src.oddHeader.center.text, src.oddFooter.center.text
    return ws


def _name_sheet(ws, title: str, unit: str) -> None:
    """Назва аркуша й рядок над заголовком бланка: чий це примірник. Зведена за частину — як
    звичайна форма: аркуш зветься умовним найменуванням, рядок над заголовком порожній."""
    if not title:
        if unit:
            ws.title = unit
        return
    ws.title = _sheet_title(title) or ws.title
    ws["A1"] = title
    ws["A1"].font = copy(ws["A2"].font)
    ws["A1"].alignment = copy(ws["A2"].alignment)


def save_form21_set(con, spec: dict, folder) -> str:
    """Комплект форми 21/Прод одним рухом: зведена за частину, управління (усе поза батальйонами)
    і кожен батальйон. У теці «21 Прод <квартал>» лягає книга-комплект з аркушем на кожного й ті
    самі форми окремими файлами. `spec` — {date: станом на}. Повертає шлях книги-комплекту."""
    as_of = str(spec.get("date") or datetime.date.today().isoformat())
    unit = _unit_code(con)
    parts = []
    for title, ids, active in scopes(con):
        rep = collect_subs(con, ids, as_of, title or unit or "Військова частина")
        # Розформований батальйон без штату й майна на цю дату у комплект не йде.
        if active or rep.filled:
            parts.append((title, rep))
    out = Path(folder) / f"21 Прод {quarter_title(as_of)}"
    out.mkdir(parents=True, exist_ok=True)
    base = file_name(as_of, unit)
    path = out / base.replace(".xlsx", " — комплект.xlsx")
    notes = out / base.replace(".xlsx", " — розшифровка.xlsx")
    save_breakdown(con, as_of, notes)
    taken = {path.name.lower(), notes.name.lower()}
    for title, rep in parts:
        wb = load_workbook(TEMPLATE)
        _fill(wb.active, rep)
        _name_sheet(wb.active, title, unit)
        name, n = (base if not title else base.replace(".xlsx", f" — {_file_part(title)}.xlsx")), 1
        while name.lower() in taken:        # назви різняться лише регістром чи знаками — файл той самий
            n += 1
            name = base.replace(".xlsx", f" — {_file_part(title)} ({n}).xlsx")
        taken.add(name.lower())
        save_book(wb, out / name)
    wb = load_workbook(TEMPLATE)
    first = wb.active
    sheets = [first] + [_blank_copy(wb, first) for _ in parts[1:]]     # копії — поки бланк чистий
    for ws, (title, rep) in zip(sheets, parts):
        _fill(ws, rep)
        _name_sheet(ws, title, unit)
    save_book(wb, path)
    return str(path)


# ------------------------------------------------------------------ розшифровка
# Бланк вимагає до донесення пояснювальну записку: причини зміни наявності й потреби порівняно з
# попереднім кварталом. Частина складала її окремою книгою — надходження за актами, витрати за
# актами, втрачене майно, зміни потреби, — з підписами начальника логістики й начальника служби.
# Майно — лише те, що входить у форму (код прив'язано до її рядка): майно інших служб сюди не йде.
_IN_FORM = """EXISTS (SELECT 1 FROM nomen_report_line m JOIN report_line rl ON rl.id = m.report_line_id
                      JOIN report_form f ON f.id = rl.form_id WHERE m.nomen_id = n.id AND f.code = '21/Прод')"""

_RECEIPTS = f"""
SELECT d.id AS doc, d.number, d.doc_date, COALESCE(d.paper, k.name) AS paper, COALESCE(cp.name, '') AS who,
       n.id AS nomen, n.name, COALESCE(u.name, '') AS uom, SUM(l.qty_milli) AS qty
FROM document d
JOIN doc_kind k ON k.id = d.kind_id AND k.code = 'act_in'
JOIN document_line l ON l.document_id = d.id
JOIN nomen n ON n.id = l.nomen_id
LEFT JOIN uom u ON u.id = n.uom_id
LEFT JOIN counterparty cp ON cp.id = d.counterparty_id
WHERE d.doc_date BETWEEN :start AND :cut AND {_IN_FORM}
GROUP BY d.id, n.id
ORDER BY d.doc_date, d.number, n.name
"""

# Вибуття з частини: акти списання (і передачі за актом) та накладні назовні, на іншу частину.
_OUTGOING = f"""
SELECT d.id AS doc, d.number, d.doc_date, COALESCE(d.paper, k.name) AS paper,
       COALESCE(cp.name, s.name, '') AS who, n.id AS nomen, n.name, COALESCE(u.name, '') AS uom, SUM(l.qty_milli) AS qty
FROM document d
JOIN doc_kind k ON k.id = d.kind_id
JOIN document_line l ON l.document_id = d.id
JOIN nomen n ON n.id = l.nomen_id
LEFT JOIN uom u ON u.id = n.uom_id
LEFT JOIN counterparty cp ON cp.id = d.counterparty_id
LEFT JOIN subdivision s ON s.id = d.from_subdivision_id
WHERE d.doc_date BETWEEN :start AND :cut AND {_IN_FORM}
  AND (k.code = 'writeoff' OR (k.code = 'invoice' AND d.to_subdivision_id IS NULL AND d.counterparty_id IS NOT NULL))
GROUP BY d.id, n.id
ORDER BY d.doc_date, d.number, n.name
"""

# Знищене, ще не списане на кінець звітного дня, — те саме, що графа 21 форми, але рапортами.
_LOSSES = f"""
SELECT d.id AS doc, d.number, d.doc_date, COALESCE(d.note, '') AS note, d.from_subdivision_id AS sub,
       n.name, COALESCE(u.name, '') AS uom, SUM(l.qty_milli) AS qty
FROM document_line l
JOIN document d ON d.id = l.document_id
JOIN doc_kind k ON k.id = d.kind_id
JOIN nomen n ON n.id = l.nomen_id
LEFT JOIN uom u ON u.id = n.uom_id
WHERE k.code = 'report_destroyed' AND d.doc_date <= :cut AND {_IN_FORM}
  AND CASE
    WHEN EXISTS (SELECT 1 FROM report_line_act ra JOIN document_line l2 ON l2.id = ra.line_id
                  WHERE l2.document_id = d.id)
    THEN NOT EXISTS (SELECT 1 FROM report_line_act ra
                       JOIN document a ON a.id = ra.act_id JOIN doc_kind ak ON ak.id = a.kind_id
                      WHERE ra.line_id = l.id AND ak.affects_stock = 1 AND a.doc_date <= :cut)
    ELSE NOT EXISTS (SELECT 1 FROM document_link dl
                       JOIN document a ON a.id = dl.to_document_id JOIN doc_kind ak ON ak.id = a.kind_id
                      WHERE dl.from_document_id = d.id AND ak.affects_stock = 1 AND a.doc_date <= :cut)
  END
GROUP BY d.id, n.id
ORDER BY d.doc_date, d.number, n.name
"""

# Перенос залишків — не надходження, як і в «Закупівлях» та відомості МТЗ.
_CARRY = re.compile(r"перен[ео]с(ення)?\s+(початкових\s+)?залишк", re.I)
_CARRY_FROM = re.compile(r"^(початков\S*\s+залишк\S*|залишк\S*\s+на\s+початок.*)$", re.I)
_ISO = re.compile(r"\b(\d{4})-(\d{2})-(\d{2})\b")
_THIN = Side(style="thin")
_BOX = Border(left=_THIN, right=_THIN, top=_THIN, bottom=_THIN)
_WRAP = Alignment(wrap_text=True, vertical="center")
_CENTER = Alignment(wrap_text=True, vertical="center", horizontal="center")


def quarter_start(as_of: str) -> str:
    """Перший день кварталу, який закриває звітна дата («станом на 1 жовтня» — 1 липня)."""
    d = datetime.date.fromisoformat(last_day(as_of))
    return datetime.date(d.year, 3 * ((d.month - 1) // 3) + 1, 1).isoformat()


def _ua(iso: str) -> str:
    y, m, d = str(iso)[:10].split("-")
    return f"{d}.{m}.{y}"


def _signers(con, cut: str) -> list:
    """Хто підписує: начальник логістики й начальник служби, чинні на кінець звітного дня
    («МВО й посадовці»). Кого немає — порожні рядки під підпис."""
    out = []
    for role in ("начальник логістики", "начальник служби"):
        r = con.execute("""SELECT p.position, p.rank, p.full_name FROM official o JOIN person p ON p.id = o.person_id
                            WHERE o.role = ? AND o.valid_from <= ? AND (o.valid_to IS NULL OR o.valid_to > ?)
                            ORDER BY o.valid_from DESC LIMIT 1""", (role, cut, cut)).fetchone()
        out.append(tuple(str(x or "") for x in r) if r else ("", "", ""))
    return out


def _sign_block(ws, row: int, last: int, signers) -> None:
    """Підписи під таблицею — як у розшифровці частини: посада, звання й ім'я, підказка дрібно."""
    small = Font(size=8, italic=True)
    for position, rank, name in signers:
        row += 1
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=last)
        ws.cell(row, 1, position or "_" * 60)
        ws.cell(row + 1, 1, rank or "_" * 15)
        ws.cell(row + 1, last, name or "_" * 20).alignment = Alignment(horizontal="right")
        ws.merge_cells(start_row=row + 2, start_column=1, end_row=row + 2, end_column=last)
        ws.cell(row + 2, 1, "(посада, військове звання, підпис, прізвище та ініціали)").font = small
        row += 3


def _sheet(wb, title: str, heading: str, period: str):
    ws = wb.create_sheet(title)
    ws["A1"] = f"РОЗШИФРОВКА «{heading}»"
    ws["A1"].font = Font(bold=True, size=14)
    ws["A2"] = period
    ws.page_setup.orientation = "landscape"
    ws.page_setup.fitToWidth = 1
    ws.page_setup.fitToHeight = 0
    ws.sheet_properties.pageSetUpPr.fitToPage = True
    return ws


def _head(ws, row: int, texts) -> None:
    for c, text in enumerate(texts, 1):
        cell = ws.cell(row, c, text)
        cell.border, cell.alignment, cell.font = _BOX, _CENTER, Font(bold=True, size=9)


def _by_acts(ws, rows, empty: str, signers) -> int:
    """Матриця «майно × акти», як у розшифровці частини: акт — стовпець із назвою, номером, датою
    й тим, від кого (кому) майно; рядок — позиція з одиницею й кількістю за кожним актом.
    Повертає кількість позицій."""
    acts, items = {}, {}
    for r in rows:
        acts.setdefault(r["doc"], (r["paper"], r["number"], r["doc_date"], r["who"]))
        item = items.setdefault(r["nomen"], {"name": r["name"], "uom": r["uom"], "by": {}})
        item["by"][r["doc"]] = item["by"].get(r["doc"], 0) + r["qty"]
    docs = list(acts)
    cols = 5 + len(docs)                    # стовпці таблиці; заголовок і підписи — не вужчі за 7
    last = max(cols, 7)
    for c, text in enumerate(("№ з/п", "Найменування матеріальних засобів", "Одиниця обліку", "Категорія", "Всього"), 1):
        ws.merge_cells(start_row=4, start_column=c, end_row=8, end_column=c)
        ws.cell(4, c, text)
    for i, doc in enumerate(docs):
        paper, number, date, who = acts[doc]
        for r, text in ((4, paper), (5, f"№ {number}"), (6, "від"), (7, _ua(date)), (8, who)):
            ws.cell(r, 6 + i, text)
    for c in range(1, cols + 1):
        ws.cell(9, c, c)
        for r in range(4, 10):
            cell = ws.cell(r, c)
            cell.border, cell.alignment = _BOX, _CENTER
            cell.font = Font(bold=r < 9, size=9 if r < 9 else 8)
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last)
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=last)
    row = 9
    first, end = get_column_letter(6), get_column_letter(max(6, 5 + len(docs)))
    for n, item in enumerate(sorted(items.values(), key=lambda x: x["name"].lower()), 1):
        row += 1
        values = [n, item["name"], item["uom"], None, f"=SUM({first}{row}:{end}{row})"]
        values += [_q(item["by"][d]) if d in item["by"] else "-" for d in docs]
        for c, v in enumerate(values, 1):
            cell = ws.cell(row, c, v)
            cell.border = _BOX
            cell.alignment = _WRAP if c == 2 else _CENTER
    if not items:
        row += 1
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=cols)
        ws.cell(row, 1, empty).alignment = _WRAP
    widths = {1: 6, 2: 42, 3: 9, 4: 10, 5: 9}
    for c in range(1, last + 1):
        ws.column_dimensions[get_column_letter(c)].width = widths.get(c, 14)
    ws.print_title_rows = "4:9"
    ws.freeze_panes = "C10"
    _sign_block(ws, row + 1, last, signers)
    return len(items)


def save_breakdown(con, as_of: str, path) -> dict:
    """Розшифровка до форми за квартал, який закриває звітна дата: книга з аркушами «Надходження»,
    «Витрати», «Втрати», «Потреба». Повертає кількість рядків кожного аркуша."""
    cut, start = last_day(as_of), quarter_start(as_of)
    unit = _unit_code(con)
    period = (f"до форми 21/Прод{(' військової частини ' + unit) if unit else ''} за {quarter_title(as_of)}: "
              f"з {_ua(start)} по {_ua(cut)}")
    signers = _signers(con, cut)
    p = dict(start=start, cut=cut)

    def fetch(sql):
        return [dict(r) for r in con.execute(sql, p)]

    receipts = [r for r in fetch(_RECEIPTS)
                if not (_CARRY.search(f"{r['paper']}|{r['who']}") or _CARRY_FROM.match(r["who"].strip()))]
    wb = Workbook()
    wb.remove(wb.active)
    counts = {"Надходження": _by_acts(_sheet(wb, "Надходження", "Надходження", period), receipts,
                                      "За квартал надходжень не було.", signers),
              "Витрати": _by_acts(_sheet(wb, "Витрати", "Витрат", period), fetch(_OUTGOING),
                                  "За квартал витрат не було.", signers)}

    # Втрати: підрозділ так, як у формі, — батальйон з усім підпорядкованим або сама частина.
    label = {}
    for title, ids, _active in scopes(con):
        for sub in ids:
            if title and title != HQ:
                label[sub] = f"{title} {unit}".strip()
            else:
                label.setdefault(sub, unit or "Військова частина")
    ws = _sheet(wb, "Втрати", "Втраченого майна", f"{period}; знищене, ще не списане на {_ua(cut)}")
    _head(ws, 4, ("Підрозділ", "Найменування", "Кількість знищених", "Одиниця обліку", "Примітка"))
    losses = fetch(_LOSSES)
    row = 4
    for r in sorted(losses, key=lambda x: (label.get(x["sub"], ""), x["name"].lower())):
        row += 1
        note = r["note"].split(". ")[0] if r["note"].lower().startswith("рапорт") else f"рапорт №{r['number']}"
        for c, v in enumerate((label.get(r["sub"], unit), r["name"], _q(r["qty"]), r["uom"], _ISO.sub(r"\3.\2.\1", note)), 1):
            cell = ws.cell(row, c, v)
            cell.border = _BOX
            cell.alignment = _CENTER if c in (3, 4) else _WRAP
    if not losses:
        row += 1
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
        ws.cell(row, 1, "Знищеного, ще не списаного майна немає.")
    for c, w in zip("ABCDE", (18, 46, 12, 10, 40)):
        ws.column_dimensions[c].width = w
    ws.merge_cells("A1:E1")
    ws.merge_cells("A2:E2")
    ws.print_title_rows = "4:4"
    ws.freeze_panes = "A5"
    _sign_block(ws, row + 1, 5, signers[:1])
    counts["Втрати"] = len(losses)

    # Потреба: штат на кінець попереднього кварталу й на кінець цього — лише рядки, де він змінився.
    subs = ",".join(str(int(x)) for x in subtree(con, _root_id(con))) or "NULL"
    before = (datetime.date.fromisoformat(start) - datetime.timedelta(days=1)).isoformat()

    def need_at(day):
        return {r["id"]: r["qty"] for r in con.execute(_NEED.format(subs=subs), dict(cut=day))}

    was, now = need_at(before), need_at(cut)
    ws = _sheet(wb, "Потреба", "Потреби", period)
    _head(ws, 4, ("Найменування", f"Потреба на {_ua(before)}", f"Потреба на {_ua(cut)}", "Зміна", "Підстава"))
    row = 4
    for lid, name in con.execute("SELECT rl.id, rl.name FROM report_line rl JOIN report_form f ON f.id = rl.form_id "
                                 "WHERE f.code = ? ORDER BY rl.sort", (FORM_CODE,)).fetchall():
        a, b = was.get(lid, 0), now.get(lid, 0)
        if a == b:
            continue
        basis = sorted({str(x[0]).strip() for x in con.execute(
            f"SELECT COALESCE(NULLIF(basis, ''), note) FROM norm WHERE report_line_id = ? AND subdivision_id IN ({subs}) "
            "AND ((valid_from > ? AND valid_from <= ?) OR (valid_to > ? AND valid_to <= ?))",
            (lid, before, cut, before, cut)) if x[0]})
        row += 1
        for c, v in enumerate((name, _q(a), _q(b), _q(b - a), "; ".join(basis)), 1):
            cell = ws.cell(row, c, v)
            cell.border = _BOX
            cell.alignment = _WRAP if c in (1, 5) else _CENTER
    counts["Потреба"] = row - 4
    if row == 4:
        row += 1
        ws.merge_cells(start_row=row, start_column=1, end_row=row, end_column=5)
        ws.cell(row, 1, "Потреба порівняно з попереднім кварталом не змінилася.")
    for c, w in zip("ABCDE", (46, 14, 14, 10, 46)):
        ws.column_dimensions[c].width = w
    ws.merge_cells("A1:E1")
    ws.merge_cells("A2:E2")
    ws.print_title_rows = "4:4"
    _sign_block(ws, row + 1, 5, signers[1:])
    save_book(wb, path)
    return counts
