# -*- coding: utf-8 -*-
"""Книга «Облік ОП» — запасний шлях обліку посуду, миючих засобів і серветок.

Програма вивантажує в книгу все, що знає про книгу ОП, і приймає її назад: коли програма
недоступна, книгу ведуть руками, а потім програма — навіть чиста — приймає її й має ту саму
базу. Будова — як у «Облік ОП 6.xlsx», якою служба вела облік до програми: ті самі аркуші,
таблиці з A1, ті самі колонки в тому самому порядку (за ними працюють скрипти служби);
колонки, яких у старій книзі не було, — лише після наявних. Формули книги лишаються
формулами (обчислювані колонки таблиць: рядок, вписаний руками, отримує їх сам), але кожна
несе й значення на момент вивантаження: скрипти читають значення.
"""
import datetime
import re
import zipfile
from xml.sax.saxutils import escape

from openpyxl import Workbook
from openpyxl.utils import get_column_letter
from openpyxl.worksheet.datavalidation import DataValidation
from openpyxl.worksheet.table import Table, TableFormula, TableStyleInfo

BOOK = "ОП"
GROUP_OF_TYPE = {"одноразовий посуд": "ОП.1", "серветки": "ОП.2", "миючі засоби": "ОП.3",
                 "господарчі товари": "ОП.4"}
TYPE_OF_GROUP = {v: k for k, v in GROUP_OF_TYPE.items()}
CAT_OF_GROUP = {"ОП.1": "ОП", "ОП.2": "ПС", "ОП.3": "МЗ", "ОП.4": "ГТ"}
GROUP_OF_CAT = {v: k for k, v in CAT_OF_GROUP.items()}
STATUSES = ["немає витяга", "на підписі", "їде на ФЕС", "проведено", "переробка"]
ARCHIVE = "архів"
UNSURE = "уточнити"

ITEM_COLS = ["код", "найменування", "категорія", "од.вим.", "ціна", "поз", "тип", "дободач", "примітка",
             "рядок 2/Прод", "множник", "перевірено"]
IN_COLS = ["док_тип", "док_дата", "док_номер", "від_кого", "кому", "найменування", "код", "найм", "од_вим",
           "ціна", "кількість", "категорія", "сума", "примітка", "скан", "статус", "рапорт", "наказ",
           "графа 2/прод"]
MV_COLS = ["док_тип", "док_дата", "док_номер", "від_кого", "кому", "найменування", "код", "од_вим", "ціна",
           "кількість", "категорія", "зал_відпр", "зал_одерж", "нм", "одвим", "примітка", "статус", "скан"]
WR_COLS = ["док_тип", "док_дата", "док_номер", "підрозділ", "найменування", "код", "транз_найменування",
           "кількість", "категорія", "статус", "примітка", "рапорт", "наказ", "скан", "кому", "графа 2/прод"]
SUB_COLS = ["назва", "підпорядкований", "вид", "закритий", "псевдоніми"]
SHEETS = {"incoming": ("Прибуток", "tblIncoming", IN_COLS), "movement": ("Переміщення", "tblMovement", MV_COLS),
          "writeoffs": ("Списання", "tblWriteoffs", WR_COLS)}


def _me(table, col):
    return f"{table}[[#This Row],[{col}]]"


def _rest_formula(side):
    """Залишок місця з колонки side («від_кого» чи «кому») на дату рядка — «зал_відпр»/«зал_одерж»."""
    code, place, day = _me("tblMovement", "код"), _me("tblMovement", side), _me("tblMovement", "док_дата")
    return (f'SUMIFS(tblIncoming[кількість],tblIncoming[код],{code},tblIncoming[кому],{place},'
            f'tblIncoming[док_дата],"<="&{day})'
            f'+SUMIFS(tblMovement[кількість],tblMovement[код],{code},tblMovement[кому],{place},'
            f'tblMovement[док_дата],"<="&{day})'
            f'-SUMIFS(tblMovement[кількість],tblMovement[код],{code},tblMovement[від_кого],{place},'
            f'tblMovement[док_дата],"<="&{day})'
            f'-SUMIFS(tblWriteoffs[кількість],tblWriteoffs[код],{code},tblWriteoffs[підрозділ],{place},'
            f'tblWriteoffs[док_дата],"<="&{day})')


def _lookup(table, n):
    return f"VLOOKUP({_me(table, 'код')},Номенклатура!$A:$E,{n},FALSE)"


# Обчислювані колонки: та сама формула в описі колонки таблиці й у клітинках.
CALC = {
    "Номенклатура": {"поз": f'{_me("tblItems", "код")}&" "&{_me("tblItems", "найменування")}&" "&'
                            f'{_me("tblItems", "ціна")}'},
    "Прибуток": {"код": f"INT(TRIM(LEFT({_me('tblIncoming', 'найменування')},5)))",
                 "од_вим": _lookup("tblIncoming", 4), "ціна": _lookup("tblIncoming", 5),
                 "категорія": _lookup("tblIncoming", 3),
                 "сума": f"{_me('tblIncoming', 'ціна')}*{_me('tblIncoming', 'кількість')}"},
    "Переміщення": {"код": f"INT(TRIM(LEFT({_me('tblMovement', 'найменування')},5)))",
                    "од_вим": _lookup("tblMovement", 4), "ціна": _lookup("tblMovement", 5),
                    "категорія": _lookup("tblMovement", 3),
                    "зал_відпр": _rest_formula("від_кого"), "зал_одерж": _rest_formula("кому")},
    "Списання": {"код": f"INT(TRIM(LEFT({_me('tblWriteoffs', 'найменування')},5)))",
                 "категорія": _lookup("tblWriteoffs", 3)},
}


def _num(v):
    """Ціле — цілим: у книзі 9000, а не 9000.0."""
    v = float(v or 0)
    return int(v) if v.is_integer() else round(v, 6)


def _code_cell(code):
    return int(code) if str(code).isdigit() else str(code)


def _pos(it):
    """«поз» книги: «код найменування ціна» — ціна з комою, як її показує Excel українською."""
    price = ("%g" % float(it["price"] or 0)).replace(".", ",")
    return f"{it['code']} {it['name']} {price}"


def _checked_text(it):
    """«перевірено»: хто й коли, «уточнити» — прив'язку ще не перевірено, порожньо — прив'язки немає."""
    if it.get("checked"):
        return it["checked"]
    return UNSURE if it.get("row2") else None


def model_from_db(con):
    """Усе, що база знає про книгу ОП, — у вигляді книги."""
    import state_db                                              # noqa: PLC0415 — модуль сервера
    items = []
    for r in con.execute("""
            SELECT n.id, n.code, n.name, g.code AS grp, u.code AS uom, n.per_ration, n.note, n.archived_at,
                   COALESCE(p.price_kop, n.app_price_kop) AS price_kop
              FROM nomen n JOIN nomen_group g ON g.id = n.group_id JOIN uom u ON u.id = n.uom_id
              LEFT JOIN nomen_last_price p ON p.nomen_id = n.id
             WHERE g.book = 'ОП' ORDER BY n.code"""):
        b = con.execute("""SELECT rl.row_no, m.factor, m.checked_by, m.checked_on FROM nomen_report_line m
                             JOIN report_line rl ON rl.id = m.report_line_id JOIN report_form f ON f.id = rl.form_id
                            WHERE m.nomen_id = ? AND f.code = '2/Прод' AND rl.row_no IS NOT NULL""",
                        (r["id"],)).fetchone()
        skip = con.execute("""SELECT s.reason FROM nomen_form_skip s JOIN report_form f ON f.id = s.form_id
                               WHERE s.nomen_id = ? AND f.code = '2/Прод'""", (r["id"],)).fetchone()
        checked = (" ".join(x for x in (b["checked_by"], b["checked_on"]) if x) or None) if b else None
        items.append({"code": r["code"], "name": r["name"], "cat": CAT_OF_GROUP[r["grp"]], "uom": r["uom"],
                      "price": (r["price_kop"] or 0) / 100, "type": TYPE_OF_GROUP[r["grp"]],
                      "archived": bool(r["archived_at"]), "per_ration": r["per_ration"], "note": r["note"] or "",
                      "row2": b["row_no"] if b else None, "factor": b["factor"] if b else 1.0,
                      "checked": checked, "skip2": skip["reason"] if skip else None})
    codes = {i["code"] for i in items}
    subs = [{"name": r["name"], "parent": r["parent"] or "", "kind": r["kind"], "closed": not r["is_active"],
             "aliases": [a[0] for a in con.execute("SELECT name FROM subdivision_alias WHERE subdivision_id = ? "
                                                   "AND source = 'книга ОП' ORDER BY id", (r["id"],))]}
            for r in con.execute("""SELECT s.id, s.name, p.name AS parent, k.code AS kind, s.is_active
                                      FROM subdivision s JOIN subdivision_kind k ON k.id = s.kind_id
                                      LEFT JOIN subdivision p ON p.id = s.parent_id ORDER BY s.sort, s.id""")]
    parties = [{"name": r["name"], "kind": r["kind"]} for r in con.execute(
        "SELECT c.name, k.code AS kind FROM counterparty c JOIN counterparty_kind k ON k.id = c.kind_id ORDER BY c.name")]
    fes, meta = state_db._load_doc_fes(con), state_db._load_doc_meta(con)
    docs, at = [], {}
    for journal, rows in state_db._load_docs(con).items():
        for r in rows:
            date, paper, no, src, dst, code, qty, note = r[:8]
            doc_id = r[10] if len(r) > 10 else None
            if str(code) not in codes:
                continue
            key = (journal, doc_id) if doc_id else (journal, date, no, src, dst)
            d = at.get(key)
            if d is None:
                f, m = fes.get(str(doc_id), {}), meta.get(str(doc_id), {})
                d = at[key] = {"journal": journal, "type": paper or "", "date": date, "no": str(no), "src": src or "",
                               "dst": dst or "", "status": f.get("status", ""), "report": m.get("report", ""),
                               "order": m.get("order", ""), "scan": m.get("scan", ""), "col": m.get("col"),
                               "lines": []}
                docs.append(d)
            same = next((x for x in d["lines"] if x["code"] == str(code) and x["note"] == (note or "")), None)
            if same:                                              # рядки однієї позиції по партіях — один рядок книги
                same["qty"] = _num(float(same["qty"]) + float(qty))
            else:
                d["lines"].append({"code": str(code), "qty": _num(qty), "note": note or ""})
    renames = [[a[0], a[1]] for a in con.execute(
        "SELECT a.name, s.name FROM subdivision_alias a JOIN subdivision s ON s.id = a.subdivision_id "
        "WHERE a.source = 'книга ОП' ORDER BY a.id")]
    return {"items": items, "subs": subs, "parties": parties, "renames": renames, "docs": docs}


def _balances(model, as_of):
    """{(код, місце): к-сть} на кінець дня as_of — як SUMIFS аркуша «Залишки»."""
    out = {}
    for d in model["docs"]:
        if as_of and d["date"] > as_of:
            continue
        for ln in d["lines"]:
            q = float(ln["qty"] or 0)
            if d["journal"] == "incoming":
                out[(ln["code"], d["dst"])] = out.get((ln["code"], d["dst"]), 0) + q
            elif d["journal"] == "movement":
                out[(ln["code"], d["src"])] = out.get((ln["code"], d["src"]), 0) - q
                out[(ln["code"], d["dst"])] = out.get((ln["code"], d["dst"]), 0) + q
            else:
                out[(ln["code"], d["src"])] = out.get((ln["code"], d["src"]), 0) - q
    return out


def _table(ws, name, cols, rows_n, calc=None):
    """Таблиця з A1; колонки з `calc` — обчислювані: Excel сам продовжує їх на новий рядок."""
    ref = f"A1:{get_column_letter(len(cols))}{max(rows_n + 1, 2)}"
    t = Table(displayName=name, ref=ref)
    t.tableStyleInfo = TableStyleInfo(name="TableStyleLight9", showRowStripes=True)
    t._initialise_columns()
    for col, title in zip(t.tableColumns, cols):
        col.name = title
        if calc and title in calc:
            col.calculatedColumnFormula = TableFormula(attr_text=calc[title])
    ws.add_table(t)


def _doc_order(d):
    return (d["date"], d["no"], d["src"], d["dst"])


def write_book(model, path, as_of=None):
    as_of = as_of or datetime.date.today().isoformat()
    items = sorted(model["items"], key=lambda i: (i["archived"], int(i["code"]) if str(i["code"]).isdigit() else 0,
                                                  str(i["code"])))
    by_code = {i["code"]: i for i in items}
    places = [s["name"] for s in model["subs"] if not s["closed"]]
    wb = Workbook()
    cached = {}                                                   # аркуш -> {клітинка: значення}

    def put(ws, ref, formula, value):
        ws[ref] = formula
        cached.setdefault(ws.title, {})[ref] = value

    # Довідка: місця, типи, статуси; перейменування; контрагенти.
    ws = wb.active
    ws.title = "Довідка"
    ws.append(["Підрозділи", "типи", "статус"])
    types = list(GROUP_OF_TYPE) + [ARCHIVE]
    n_ref = max(len(places), len(types), len(STATUSES))
    for n in range(n_ref):
        ws.append([places[n] if n < len(places) else None, types[n] if n < len(types) else None,
                   STATUSES[n] if n < len(STATUSES) else None])
    _table(ws, "Таблиця4", ["Підрозділи", "типи", "статус"], n_ref)
    ws["H1"], ws["I1"] = "стара назва", "нова назва"
    for n, (old, new) in enumerate(model["renames"], 2):
        ws.cell(n, 8, old)
        ws.cell(n, 9, new)
    ws.add_table(Table(displayName="tblRename", ref=f"H1:I{max(len(model['renames']) + 1, 2)}"))
    ws["K1"], ws["L1"] = "контрагент", "вид"
    for n, p in enumerate(model["parties"], 2):
        ws.cell(n, 11, p["name"])
        ws.cell(n, 12, p["kind"])
    ws.add_table(Table(displayName="tblParties", ref=f"K1:L{max(len(model['parties']) + 1, 2)}"))

    # Номенклатура.
    ws = wb.create_sheet("Номенклатура")
    ws.append(ITEM_COLS)
    for r, it in enumerate(items, 2):
        ws.append([_code_cell(it["code"]), it["name"], it["cat"], it["uom"], _num(it["price"]), None,
                   ARCHIVE if it["archived"] else it["type"], it["per_ration"], it["note"] or None,
                   it["skip2"] or it["row2"], _num(it["factor"]) if it["row2"] else None, _checked_text(it)])
        put(ws, f"F{r}", "=" + CALC["Номенклатура"]["поз"], _pos(it))
    _table(ws, "tblItems", ITEM_COLS, len(items), CALC["Номенклатура"])

    # Журнали.
    rest_of = {}
    for journal, (title, table, cols) in SHEETS.items():
        ws = wb.create_sheet(title)
        ws.append(cols)
        f = {k: "=" + v for k, v in CALC[title].items()}
        r = 1
        for d in sorted((d for d in model["docs"] if d["journal"] == journal), key=_doc_order):
            for ln in d["lines"]:
                r += 1
                it = by_code[ln["code"]]
                date = datetime.date.fromisoformat(d["date"])
                code = _code_cell(it["code"])
                if journal == "incoming":
                    ws.append([d["type"], date, d["no"], d["src"], d["dst"], _pos(it), None, _pos(it), None, None,
                               _num(ln["qty"]), None, None, ln["note"] or None, d["scan"] or None,
                               d["status"] or None, d["report"] or None, d["order"] or None, d["col"]])
                    put(ws, f"G{r}", f["код"], code)
                    put(ws, f"I{r}", f["од_вим"], it["uom"])
                    put(ws, f"J{r}", f["ціна"], _num(it["price"]))
                    put(ws, f"L{r}", f["категорія"], it["cat"])
                    put(ws, f"M{r}", f["сума"], round(float(it["price"]) * float(ln["qty"]), 2))
                elif journal == "movement":
                    ws.append([d["type"], date, d["no"], d["src"], d["dst"], _pos(it), None, None, None,
                               _num(ln["qty"]), None, None, None, _pos(it), it["uom"], ln["note"] or None,
                               d["status"] or None, d["scan"] or None])
                    put(ws, f"G{r}", f["код"], code)
                    put(ws, f"H{r}", f["од_вим"], it["uom"])
                    put(ws, f"I{r}", f["ціна"], _num(it["price"]))
                    put(ws, f"K{r}", f["категорія"], it["cat"])
                    bal = rest_of.setdefault(d["date"], _balances(model, d["date"]))
                    put(ws, f"L{r}", f["зал_відпр"], _num(bal.get((ln["code"], d["src"]), 0)))
                    put(ws, f"M{r}", f["зал_одерж"], _num(bal.get((ln["code"], d["dst"]), 0)))
                else:
                    ws.append([d["type"], date, d["no"], d["src"], _pos(it), None, None, _num(ln["qty"]), None,
                               d["status"] or None, ln["note"] or None, d["report"] or None, d["order"] or None,
                               d["scan"] or None, d["dst"] or None, d["col"]])
                    put(ws, f"F{r}", f["код"], code)
                    put(ws, f"I{r}", f["категорія"], it["cat"])
                ws.cell(r, 2).number_format = "dd.mm.yyyy"
        _table(ws, table, cols, r - 1, CALC[title])
        _validations(ws, journal, r)

    _rests_sheet(wb, model, items, places, as_of, put)
    _moves_sheet(wb, model, items, as_of)

    ws = wb.create_sheet("Підрозділи")
    ws.append(SUB_COLS)
    for s in model["subs"]:
        ws.append([s["name"], s["parent"] or None, s["kind"], "так" if s["closed"] else None,
                   ", ".join(s["aliases"]) or None])
    _table(ws, "tblSubs", SUB_COLS, len(model["subs"]))

    wb.calculation.fullCalcOnLoad = True
    wb.save(path)
    _put_cached(path, cached)


def _validations(ws, journal, last):
    """Списки, як у старій книзі: позиції, місця, статуси."""
    def lst(formula):
        return DataValidation(type="list", formula1=formula, allow_blank=True)
    pos = lst("Номенклатура!$F$2:$F$2000")
    place = lst("Довідка!$A$2:$A$200")
    status = lst("Довідка!$C$2:$C$6")
    for dv in (pos, place, status):
        ws.add_data_validation(dv)
    end = max(last, 1) + 500
    name_col = "E" if journal == "writeoffs" else "F"
    pos.add(f"{name_col}2:{name_col}{end}")
    if journal == "incoming":
        place.add(f"E2:E{end}")
        status.add(f"P2:P{end}")
    elif journal == "movement":
        place.add(f"D2:E{end}")
        status.add(f"Q2:Q{end}")
    else:
        place.add(f"D2:D{end}")
        status.add(f"J2:J{end}")


def _rest_cell(col, r):
    """Залишок позиції рядка r у місці з шапки колонки col на дату D2 — як аркуш «Залишки» старої книги."""
    return (f"=SUMIFS(Прибуток!$K:$K,Прибуток!$G:$G,$A{r},Прибуток!$E:$E,{col}$4,Прибуток!$B:$B,\"<=\"&$D$2)"
            f"+SUMIFS(Переміщення!$J:$J,Переміщення!$G:$G,$A{r},Переміщення!$E:$E,{col}$4,Переміщення!$B:$B,\"<=\"&$D$2)"
            f"-SUMIFS(Переміщення!$J:$J,Переміщення!$G:$G,$A{r},Переміщення!$D:$D,{col}$4,Переміщення!$B:$B,\"<=\"&$D$2)"
            f"-SUMIFS(Списання!$H:$H,Списання!$F:$F,$A{r},Списання!$D:$D,{col}$4,Списання!$B:$B,\"<=\"&$D$2)")


def _rests_sheet(wb, model, items, places, as_of, put):
    """«Залишки»: D2 — дата, шапка в рядку 4 (за нею працюють скрипти служби й ручна картка)."""
    ws = wb.create_sheet("Залишки")
    ws["D1"] = "Залишки на дату:"
    ws["D2"] = datetime.date.fromisoformat(as_of)
    ws["D2"].number_format = "dd.mm.yyyy"
    for c, title in enumerate(["код", "кат", "найм", "разом"] + places, 1):
        ws.cell(4, c, title)
    bal = _balances(model, as_of)
    last = get_column_letter(4 + len(places))
    for r, it in enumerate([i for i in items if not i["archived"]], 5):
        ws.cell(r, 1, _code_cell(it["code"]))
        ws.cell(r, 2, it["cat"])
        ws.cell(r, 3, _pos(it))
        tot = 0.0
        for c, place in enumerate(places, 5):
            col = get_column_letter(c)
            v = bal.get((it["code"], place), 0)
            tot += v
            put(ws, f"{col}{r}", _rest_cell(col, r), _num(v))
        put(ws, f"D{r}", f"=SUM(E{r}:{last}{r})" if places else "=0", _num(tot))


def _moves_sheet(wb, model, items, as_of, place="склад"):
    """«Рух ТМЦ»: місце й період — початковий, надійшло, вибуло, кінцевий (як у старій книзі).
    Значення без формул: ручна картка бере звідси лише підсумки."""
    ws = wb.create_sheet("Рух ТМЦ")
    start = as_of[:4] + "-01-01"
    ws["C3"], ws["D3"], ws["E3"], ws["F3"] = "період", datetime.date.fromisoformat(start), \
        datetime.date.fromisoformat(as_of), place
    ws["D3"].number_format = ws["E3"].number_format = "dd.mm.yyyy"
    for c, title in enumerate(["код", "кат", "найм", "початковий", "надійшло", "вибуло", "кінцевий"], 1):
        ws.cell(4, c, title)
    before = (datetime.date.fromisoformat(start) - datetime.timedelta(days=1)).isoformat()
    a, b = _balances(model, before), _balances(model, as_of)
    got, gone = {}, {}
    for d in model["docs"]:
        if not start <= d["date"] <= as_of:
            continue
        for ln in d["lines"]:
            q = float(ln["qty"] or 0)
            if d["journal"] in ("incoming", "movement") and d["dst"] == place:
                got[ln["code"]] = got.get(ln["code"], 0) + q
            if d["journal"] in ("movement", "writeoffs") and d["src"] == place:
                gone[ln["code"]] = gone.get(ln["code"], 0) + q
    for r, it in enumerate([i for i in items if not i["archived"]], 5):
        c = it["code"]
        for col, v in enumerate([_code_cell(c), it["cat"], it["name"], _num(a.get((c, place), 0)),
                                 _num(got.get(c, 0)), _num(gone.get(c, 0)), _num(b.get((c, place), 0))], 1):
            ws.cell(r, col, v)


_CELL = re.compile(r'<c r="(?P<ref>[A-Z]+\d+)"(?P<attrs>[^>]*)><f>(?P<f>.*?)</f><v></v></c>', re.S)


def _put_cached(path, cached):
    """openpyxl пише формули без значень (`<f>…</f><v></v>`): дописуємо значення, які порахувала
    програма, — книга, ще не відкрита в Excel, дає скриптам числа й текст, а не порожнечу."""
    with zipfile.ZipFile(path) as z:
        files = {n: z.read(n) for n in z.namelist()}
    sheets = _sheet_paths(files)
    for title, values in cached.items():
        part = sheets[title]
        xml = files[part].decode("utf-8")

        def fill(m, values=values):
            v = values.get(m.group("ref"))
            if v is None:
                return m.group(0)
            if isinstance(v, str):
                return f'<c r="{m.group("ref")}"{m.group("attrs")} t="str"><f>{m.group("f")}</f><v>{escape(v)}</v></c>'
            return f'<c r="{m.group("ref")}"{m.group("attrs")}><f>{m.group("f")}</f><v>{v}</v></c>'

        files[part] = _CELL.sub(fill, xml).encode("utf-8")
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as z:
        for n, data in files.items():
            z.writestr(n, data)


def _sheet_paths(files):
    """Назва аркуша → шлях його XML у книзі (атрибути тегу <sheet> — у будь-якому порядку)."""
    wbx = files["xl/workbook.xml"].decode("utf-8")
    rels = files["xl/_rels/workbook.xml.rels"].decode("utf-8")
    target = {}
    for tag in re.findall(r"<Relationship\b[^>]*>", rels):
        rid, tgt = re.search(r'\bId="([^"]+)"', tag), re.search(r'\bTarget="([^"]+)"', tag)
        if rid and tgt:
            target[rid.group(1)] = tgt.group(1)
    out = {}
    for tag in re.findall(r"<sheet\b[^>]*>", wbx):
        name, rid = re.search(r'\bname="([^"]+)"', tag), re.search(r'\br:id="([^"]+)"', tag)
        if name and rid:
            t = target[rid.group(1)].lstrip("/")
            out[_unescape(name.group(1))] = t if t.startswith("xl/") else "xl/" + t
    return out


def _unescape(s):
    return s.replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'").replace("&amp;", "&")


def export_book(con, path, as_of=None):
    m = model_from_db(con)
    write_book(m, path, as_of)
    return {"path": str(path), "items": len(m["items"]), "docs": len(m["docs"]),
            "lines": sum(len(d["lines"]) for d in m["docs"])}


# ---------------------------------------------------------------- читання й прийом

class BookError(ValueError):
    """Книга не приймається: перелік причин з аркушем і рядком («Прибуток, рядок 12: …»)."""

    def __init__(self, problems):
        super().__init__("; ".join(problems[:5]))
        self.problems = list(problems)


def _date(v):
    if isinstance(v, datetime.datetime):
        return v.date().isoformat()
    if isinstance(v, datetime.date):
        return v.isoformat()
    s = str(v or "").strip()
    m = re.match(r"^(\d{1,2})\.(\d{1,2})\.(\d{4})$", s)
    if m:
        return f"{m.group(3)}-{int(m.group(2)):02d}-{int(m.group(1)):02d}"
    if re.match(r"^\d{4}-\d{2}-\d{2}", s):
        return s[:10]
    return ""


def _text(v):
    if v is None:
        return ""
    if isinstance(v, float) and v.is_integer():
        v = int(v)
    return " ".join(str(v).split())


def _code_of(name, fallback=None):
    """Код — з початку тексту «найменування» (як INT(LEFT(…,5)) у книзі), інакше з колонки «код»."""
    m = re.match(r"\s*(\d+)", str(name or ""))
    if m:
        return m.group(1)
    return _text(fallback) if fallback not in (None, "") else ""


def _rows(ws):
    it = ws.iter_rows(values_only=True)
    head = [_text(h).lower() for h in next(it, [])]
    for n, row in enumerate(it, 2):
        yield n, {h: row[i] if i < len(row) else None for i, h in enumerate(head) if h}


def _number(v):
    try:
        return float(str(v).replace(",", ".")) if v not in (None, "") else None
    except (TypeError, ValueError):
        return None


def _price(v):
    """Ціна позиції: облік веде ціни в копійках — частки копійки книга не несе."""
    x = _number(v)
    return None if x is None else x


HEAD_NAMES = {"type": "док_тип", "status": "статус", "report": "рапорт", "order": "наказ", "scan": "скан",
              "col": "графа 2/прод"}


def _comma(v, places=None):
    """Число з комою, як його пише людина: 0,07474; з places — рівно стільки знаків."""
    text = f"{v:.{places}f}" if places is not None else ("%.10g" % v)
    return text.replace(".", ",")


def _split_checked(text):
    """«перевірено» книги → (хто, коли): «Влад 2026-10-08» → («Влад», «2026-10-08»); «уточнити» — ніхто."""
    t = _text(text)
    if not t or t.lower() == UNSURE:
        return None, None
    m = re.match(r"^(.*?)\s*(\d{4}-\d{2}-\d{2})$", t)
    if m and m.group(1):
        return m.group(1).strip(), m.group(2)
    return t, None


def read_book(data, legacy=False):
    """Модель з книги «Облік ОП» (значення клітинок, не формули). Помилки — з аркушем і рядком.

    `legacy` — перше перенесення старої книги: розбіжні поля документа зводяться до першого
    непорожнього, статус з «примітки» переходить у «статус», «транз_найменування» — у
    «примітку», ціна з частками копійки округлюється; кожна така правка — у model["report"]."""
    import io                                                    # noqa: PLC0415
    from openpyxl import load_workbook                           # noqa: PLC0415
    try:
        wb = load_workbook(io.BytesIO(data), data_only=True, read_only=True)
    except Exception as e:                                       # noqa: BLE001 — будь-який зіпсований файл
        raise BookError([f"файл не читається як книга Excel: {e}"]) from e
    problems, report = [], []
    missing = [s for s in ("Номенклатура", "Прибуток", "Переміщення", "Списання") if s not in wb.sheetnames]
    if missing:
        raise BookError([f"немає аркуша «{s}»" for s in missing])
    renames, parties, subs = [], [], []
    if "Довідка" in wb.sheetnames:
        renames, parties = _reference(wb["Довідка"])
    alias = {old: new for old, new in renames if old and new} if legacy else {}
    items = []
    for n, r in _rows(wb["Номенклатура"]):
        code = _code_of(r.get("код"))
        if not code:
            continue
        where = f"Номенклатура, рядок {n}"
        kind = _text(r.get("тип")).lower()
        cat = _text(r.get("категорія")).upper()
        archived = kind == ARCHIVE
        grp = GROUP_OF_TYPE.get(kind) or GROUP_OF_CAT.get(cat)
        if grp is None:
            problems.append(f"{where}: невідомий тип «{_text(r.get('тип'))}» і категорія «{_text(r.get('категорія'))}»")
            continue
        price = _price(r.get("ціна"))
        if price is None:
            price = 0.0
        if abs(price * 100 - round(price * 100)) > 1e-6:
            if legacy:
                report.append(f"{where}: ціна {_comma(price)} — до копійок {_comma(round(price, 2), 2)} "
                              "(облік веде ціни в копійках)")
                price = round(price, 2)
            else:
                problems.append(f"{where}: ціна {_comma(price)} з частками копійки — облік веде ціни в копійках")
        row2 = r.get("рядок 2/прод")
        skip = None
        if isinstance(row2, str) and not row2.strip().isdigit():
            skip, row2 = row2.strip() or None, None
        per = _number(r.get("дободач"))
        items.append({"code": code, "name": _text(r.get("найменування")), "cat": CAT_OF_GROUP[grp],
                      "uom": _text(r.get("од.вим.")) or "шт", "price": price,
                      "type": TYPE_OF_GROUP[grp], "archived": archived, "per_ration": per,
                      "note": _text(r.get("примітка")),
                      "row2": int(row2) if row2 not in (None, "") else None,
                      "factor": _number(r.get("множник")) or 1.0,
                      "checked": None if _text(r.get("перевірено")).lower() == UNSURE else (_text(r.get("перевірено")) or None),
                      "skip2": skip})
    codes = {i["code"] for i in items}
    docs, at = [], {}
    for journal, (title, _table_name, _cols) in SHEETS.items():
        for n, r in _rows(wb[title]):
            name = r.get("найменування")
            if not _text(name) and not r.get("док_дата") and not _text(r.get("док_номер")):
                continue
            where = f"{title}, рядок {n}"
            code = _code_of(name, r.get("код"))
            date = _date(r.get("док_дата"))
            no = _text(r.get("док_номер"))
            qty = _number(r.get("кількість")) or 0
            if not date:
                problems.append(f"{where}: немає дати")
            if not no:
                problems.append(f"{where}: немає номера документа")
            if qty <= 0:
                problems.append(f"{where}: кількість має бути більшою за нуль")
            elif not legacy and abs(qty * 1000 - round(qty * 1000)) > 1e-6:
                problems.append(f"{where}: кількість {_comma(qty)} — облік веде кількість до тисячних")
            if code not in codes:
                problems.append(f"{where}: позиції «{_text(name)}» немає в «Номенклатура»")
            status = _text(r.get("статус"))
            note = _text(r.get("примітка"))
            if legacy and not status and note in STATUSES:
                report.append(f"{where}: статус «{note}» стояв у «примітка» — перенесено в «статус»")
                status, note = note, ""
            if status and status not in STATUSES:
                problems.append(f"{where}: невідомий статус «{status}»")
            alt = _text(r.get("транз_найменування"))
            if alt:
                if legacy:
                    report.append(f"{where}: «транз_найменування» «{alt}» перенесено в «примітка»")
                    note = (note + " " + alt).strip()
                else:
                    problems.append(f"{where}: колонку «транз_найменування» програма не веде — перенесіть текст у «примітка»")
            if journal == "incoming":
                src, dst = _text(r.get("від_кого")), _text(r.get("кому")) or "склад"
            elif journal == "movement":
                src, dst = _text(r.get("від_кого")), _text(r.get("кому"))
            else:
                src, dst = _text(r.get("підрозділ")), _text(r.get("кому"))
            if journal != "incoming" and src in alias:
                src = alias[src]
            if journal != "writeoffs" and dst in alias:
                dst = alias[dst]
            col = r.get("графа 2/прод")
            col = int(col) if str(col or "").strip().isdigit() else None
            head = {"type": _text(r.get("док_тип")), "status": status, "report": _text(r.get("рапорт")),
                    "order": _text(r.get("наказ")), "scan": _text(r.get("скан")), "col": col}
            key = (journal, date, no, src, dst)
            d = at.get(key)
            if d is None:
                d = at[key] = {"journal": journal, "date": date, "no": no, "src": src, "dst": dst, **head, "lines": []}
                docs.append(d)
            elif any(d[k] != v for k, v in head.items()):
                differ = [HEAD_NAMES[k] for k, v in head.items() if d[k] != v]
                if legacy:
                    for k, v in head.items():
                        if not d[k] and v:
                            d[k] = v
                    report.append(f"{where}: у рядках документа №{no} різні {', '.join(differ)} — узято перше непорожнє")
                else:
                    problems.append(f"{where}: у рядках одного документа різні {', '.join(differ)}")
            d["lines"].append({"code": code, "qty": _num(qty), "note": note})
    if "Підрозділи" in wb.sheetnames:
        for n, r in _rows(wb["Підрозділи"]):
            name = _text(r.get("назва"))
            if name:
                subs.append({"name": name, "parent": _text(r.get("підпорядкований")),
                             "kind": _text(r.get("вид")) or "склад", "closed": bool(_text(r.get("закритий"))),
                             "aliases": [a.strip() for a in _text(r.get("псевдоніми")).split(",") if a.strip()]})
    if problems:
        raise BookError(problems)
    model = {"items": items, "subs": subs, "parties": parties, "renames": renames, "docs": docs}
    if legacy:
        for old, new in sorted(alias.items()):
            report.append(f"місце «{old}» → «{new}» за tblRename")
        model["report"] = report
    return model


def _reference(ws):
    """tblRename (стара назва → нова назва) і tblParties (контрагент → вид) з аркуша «Довідка»."""
    grid = [list(r) for r in ws.iter_rows(values_only=True)]
    head = grid[0] if grid else []
    pos = {_text(h).lower(): i for i, h in enumerate(head) if h}
    renames, parties = [], []

    def cell(row, key):
        i = pos.get(key)
        return _text(row[i]) if i is not None and i < len(row) else ""

    for row in grid[1:]:
        if cell(row, "стара назва"):
            renames.append([cell(row, "стара назва"), cell(row, "нова назва")])
        if cell(row, "контрагент"):
            parties.append({"name": cell(row, "контрагент"), "kind": cell(row, "вид") or "інше"})
    return renames, parties


def _doc_label(d):
    return f"{SHEETS[d['journal']][0]} · {d['date']} · №{d['no']} · {d['src'] or '—'} → {d['dst'] or '—'}"


def _doc_sig(d):
    return (d["type"], d["status"], d["report"], d["order"], d["scan"], d["col"],
            tuple(sorted((ln["code"], float(ln["qty"]), ln["note"]) for ln in d["lines"])))


def _doc_key(d):
    return (d["journal"], d["date"], d["no"], d["src"], d["dst"])


def _names(con):
    """Назва підрозділу за назвою чи псевдонімом."""
    out = {r[0]: r[0] for r in con.execute("SELECT name FROM subdivision")}
    for alias, name in con.execute("SELECT a.name, s.name FROM subdivision_alias a "
                                   "JOIN subdivision s ON s.id = a.subdivision_id"):
        out.setdefault(alias, name)
    return out


def _resolved(con, model):
    """Модель з назвами місць, як їх знає база (псевдонім → назва підрозділу)."""
    names = _names(con)

    def fix(d):
        d = dict(d)
        if d["journal"] != "incoming":
            d["src"] = names.get(d["src"], d["src"])
        if d["journal"] != "writeoffs":
            d["dst"] = names.get(d["dst"], d["dst"])
        return d
    return dict(model, docs=[fix(d) for d in model["docs"]])


def diff(con, model):
    """Що зміниться в базі, коли прийняти книгу: документи, позиції, нові місця й контрагенти."""
    have = model_from_db(con)
    model = _resolved(con, model)
    mine, theirs = {_doc_key(d): d for d in model["docs"]}, {_doc_key(d): d for d in have["docs"]}
    out = {"docs": {"new": [_doc_label(d) for k, d in mine.items() if k not in theirs],
                    "changed": [_doc_label(d) for k, d in mine.items() if k in theirs and _doc_sig(d) != _doc_sig(theirs[k])],
                    "removed": [_doc_label(d) for k, d in theirs.items() if k not in mine]}}
    hi = {i["code"]: i for i in have["items"]}
    out["items"] = {"new": [i["code"] for i in model["items"] if i["code"] not in hi],
                    "changed": [i["code"] for i in model["items"] if i["code"] in hi and i != hi[i["code"]]],
                    "removed": [c for c in hi if c not in {i["code"] for i in model["items"]}]}
    names = _names(con)
    used = {d["dst"] for d in model["docs"] if d["journal"] != "writeoffs"} | {
        d["src"] for d in model["docs"] if d["journal"] != "incoming"}
    out["subs"] = sorted(n for n in used if n and n not in names)
    hp = {p["name"]: p["kind"] for p in have["parties"]}
    out["parties"] = sorted(p["name"] for p in model["parties"] if hp.get(p["name"]) != p["kind"])
    out["same"] = not any(out["docs"][k] for k in out["docs"]) and not any(
        out["items"][k] for k in out["items"]) and not out["subs"] and not out["parties"]
    return out


def apply(con, model):
    """Книга ОП у базі стає точно такою, як у файлі. Облік ТЗ не змінюється; місця й контрагенти
    лише додаються. Усе або нічого: відмова лишає базу як була."""
    import state_db                                              # noqa: PLC0415
    plan = diff(con, model)
    con.execute("BEGIN IMMEDIATE")
    try:
        _ensure_subs(con, model)
        model = _resolved(con, model)
        _ensure_items(con, model)
        state_db._save_parties(con, {p["name"]: p["kind"] for p in model["parties"]})
        before = state_db.negative_days(con)
        ours = {i["code"] for i in model["items"]} | state_db.op_codes(con)
        docs = {j: [r for r in rows if str(r[5]) not in ours] for j, rows in state_db._load_docs(con).items()}
        price = {i["code"]: i["price"] for i in model["items"]}
        for d in model["docs"]:
            for ln in d["lines"]:
                docs[d["journal"]].append([d["date"], d["type"], d["no"], d["src"], d["dst"], ln["code"], ln["qty"],
                                           ln["note"], price[ln["code"]] if d["journal"] == "incoming" else 0])
        try:
            state_db._save_docs(con, docs, seed_drop_limit=False)
        except state_db.SaveError as e:
            raise BookError([str(e)]) from e
        new = {k: v for k, v in state_db.negative_days(con).items() if k not in before}
        if new:
            raise BookError([state_db._negative_words(con, new)])
        _apply_doc_fields(con, model)
        edits = {}
        for i in model["items"]:
            by, on = _split_checked(i["checked"])
            edits[i["code"]] = {"row": i["row2"], "factor": i["factor"], "checked": by, "checkedOn": on,
                                "skip": i["skip2"]}
        state_db._save_form2_map(con, edits)
        _drop_unused_items(con, {i["code"] for i in model["items"]})
        con.execute("COMMIT")
    except BaseException:
        con.execute("ROLLBACK")
        raise
    return plan


def _ensure_subs(con, model):
    """Місця з аркуша «Підрозділи» (у чистій програмі — усе дерево) і назви з документів."""
    kinds = dict(con.execute("SELECT code, id FROM subdivision_kind"))
    have = dict(con.execute("SELECT name, id FROM subdivision"))
    aliases = {r[0] for r in con.execute("SELECT name FROM subdivision_alias")}
    sort = con.execute("SELECT COALESCE(MAX(sort), 0) FROM subdivision").fetchone()[0] or 0
    for s in model["subs"]:
        if s["name"] in have:
            continue
        if s["kind"] not in kinds:
            kinds[s["kind"]] = con.execute("INSERT INTO subdivision_kind(code, name) VALUES(?, ?)",
                                           (s["kind"], s["kind"])).lastrowid
        sort += 1
        have[s["name"]] = con.execute(
            "INSERT INTO subdivision(name, kind_id, parent_id, sort, is_active) VALUES(?, ?, ?, ?, ?)",
            (s["name"], kinds[s["kind"]], have.get(s["parent"]), sort, 0 if s["closed"] else 1)).lastrowid
        for a in s["aliases"]:
            if a not in aliases and a not in have:
                con.execute("INSERT INTO subdivision_alias(subdivision_id, name, source) VALUES(?, ?, 'книга ОП')",
                            (have[s["name"]], a))
                aliases.add(a)
    for old, new in model["renames"]:
        if new in have and old not in have and old not in aliases:
            con.execute("INSERT INTO subdivision_alias(subdivision_id, name, source) VALUES(?, ?, 'книга ОП')",
                        (have[new], old))
            aliases.add(old)
    # Назва з документа, якої немає ні в довіднику, ні серед псевдонімів, — помилка, а не новий підрозділ.
    unknown = set()
    for d in model["docs"]:
        names = (d["dst"],) if d["journal"] == "incoming" else (d["src"], d["dst"]) if d["journal"] == "movement" \
            else (d["src"],)
        unknown |= {n for n in names if n and n not in have and n not in aliases}
    if unknown:
        raise BookError([f"невідоме місце «{n}»: додайте його в аркуш «Підрозділи» чи зіставте"
                         for n in sorted(unknown)])


def _ensure_items(con, model):
    groups = dict(con.execute("SELECT code, id FROM nomen_group"))
    uoms = dict(con.execute("SELECT code, id FROM uom"))
    for it in model["items"]:
        if it["uom"] not in uoms:
            uoms[it["uom"]] = con.execute("INSERT INTO uom(code, name) VALUES(?, ?)", (it["uom"], it["uom"])).lastrowid
        grp = groups[GROUP_OF_TYPE[it["type"]]]
        row = con.execute("SELECT id, archived_at FROM nomen WHERE code = ?", (it["code"],)).fetchone()
        archived = ((row["archived_at"] if row and row["archived_at"] else datetime.date.today().isoformat())
                    if it["archived"] else None)
        vals = (it["name"], grp, uoms[it["uom"]], it["per_ration"], it["note"] or None, archived,
                int(round(float(it["price"]) * 100)) or None)
        if row is None:
            con.execute("INSERT INTO nomen(code, name, group_id, uom_id, per_ration, note, archived_at, app_price_kop, "
                        "source) VALUES(?, ?, ?, ?, ?, ?, ?, ?, 'program')", (it["code"], *vals))
        else:
            con.execute("UPDATE nomen SET name = ?, group_id = ?, uom_id = ?, per_ration = ?, note = ?, archived_at = ?, "
                        "app_price_kop = ? WHERE id = ?", (*vals, row["id"]))


def _doc_id(con, d):
    """id документа бази за ключем книги (журнал, дата, номер, сторони)."""
    import state_db                                              # noqa: PLC0415
    for journal, date, no, src, dst, doc in state_db.doc_ids(con):
        if (journal, date, str(no), src, dst) == _doc_key(d):
            return doc
    return None


def _op_doc_ids(con):
    return {r[0] for r in con.execute("""SELECT DISTINCT l.document_id FROM document_line l
                                           JOIN nomen n ON n.id = l.nomen_id JOIN nomen_group g ON g.id = n.group_id
                                          WHERE g.book = 'ОП'""")}


def _apply_doc_fields(con, model):
    """Статус ФЕС і поля документів книги ОП — як у книзі; документів ТЗ не чіпає."""
    import state_db                                              # noqa: PLC0415
    ops = _op_doc_ids(con)
    fes = {k: v for k, v in state_db._load_doc_fes(con).items() if int(k) not in ops}
    meta = {k: v for k, v in state_db._load_doc_meta(con).items() if int(k) not in ops}
    ids = {(j, dt, str(no), s, t): doc for j, dt, no, s, t, doc in state_db.doc_ids(con)}
    for d in model["docs"]:
        doc = ids.get(_doc_key(d))
        if doc is None:
            continue
        if d["status"]:
            fes[str(doc)] = {"status": d["status"]}
        if d["report"] or d["order"] or d["scan"] or d["col"]:
            meta[str(doc)] = {"report": d["report"], "order": d["order"], "scan": d["scan"], "col": d["col"]}
    state_db._save_doc_fes(con, fes)
    state_db._save_doc_meta(con, meta)


def _drop_unused_items(con, keep):
    """Позиції книги ОП, яких у книзі немає й на які не посилається жоден документ, — геть."""
    for nid, code in con.execute("""SELECT n.id, n.code FROM nomen n JOIN nomen_group g ON g.id = n.group_id
                                     WHERE g.book = 'ОП'""").fetchall():
        if code in keep or con.execute("SELECT 1 FROM document_line WHERE nomen_id = ? LIMIT 1", (nid,)).fetchone():
            continue
        con.execute("DELETE FROM nomen_report_line WHERE nomen_id = ?", (nid,))
        con.execute("DELETE FROM nomen_form_skip WHERE nomen_id = ?", (nid,))
        con.execute("DELETE FROM fes_item_map WHERE nomen_id = ?", (nid,))
        con.execute("DELETE FROM nomen WHERE id = ?", (nid,))


def canonical(con):
    """Порівнювана проєкція книги ОП у базі: модель і залишки по кодах і місцях на кожну дату руху.
    Партії книги ОП програма розкладає сама за порядком надходження — у порівняння вони не входять."""
    m = model_from_db(con)
    dates = sorted({d["date"] for d in m["docs"]})
    rests = {dt: sorted((k, round(v, 3)) for k, v in _balances(m, dt).items() if abs(v) > 1e-9) for dt in dates}
    docs = sorted((_doc_key(d), _doc_sig(d)) for d in m["docs"])
    return {"items": sorted(m["items"], key=lambda i: i["code"]), "docs": docs, "rests": rests,
            "parties": m["parties"], "subs": [(s["name"], s["parent"], s["kind"], s["closed"]) for s in m["subs"]]}


# ---------------------------------------------------------------- перше перенесення

def legacy_places(model):
    """Назви місць, які називають документи старої книги (після tblRename), за абеткою."""
    used = set()
    for d in model["docs"]:
        if d["journal"] == "incoming":
            used.add(d["dst"])
        elif d["journal"] == "movement":
            used.update((d["src"], d["dst"]))
        else:
            used.add(d["src"])
    return sorted(n for n in used if n)


def _group_by_code(code):
    """Група архівної позиції — за діапазоном коду книги: 9xxx — серветки, 80xx/81xx — миючі,
    82xx — господарчі, решта — одноразовий посуд (категорія архіву в старій книзі ненадійна)."""
    c = str(code)
    if c.startswith("9"):
        return "ОП.2"
    if c.startswith(("80", "81")):
        return "ОП.3"
    if c.startswith("82"):
        return "ОП.4"
    return "ОП.1"


def _round_quantities(model, report):
    """Облік веде кількість до тисячних, а стара книга мала й п'ять знаків (19,00313 кг). Рядок
    округлюється до тисячних; вибуття, яке в книзі забирало все до нуля, забирає рівно стільки,
    скільки після округлення лишилося (інакше залишок ішов би в мінус на 0,001)."""
    order = {"incoming": 0, "movement": 1, "writeoffs": 2}
    exact, rounded = {}, {}
    for d in sorted(model["docs"], key=lambda d: (d["date"], order[d["journal"]])):
        for ln in d["lines"]:
            q = float(ln["qty"])
            r = round(q + 1e-12, 3)
            src = None if d["journal"] == "incoming" else (ln["code"], d["src"])
            dst = (ln["code"], d["dst"]) if d["journal"] != "writeoffs" else None
            if src is not None:
                have_r, have_e = rounded.get(src, 0.0), exact.get(src, 0.0)
                if r > have_r + 1e-9 and q <= have_e + 1e-9 and r - have_r <= 0.0015:
                    r = round(have_r, 3)
            if abs(r - q) > 1e-9:
                report.append(f"{SHEETS[d['journal']][0]} №{d['no']} від {d['date']}, код {ln['code']}: "
                              f"кількість {_comma(q)} → {_comma(r)} (облік веде тисячні)")
                ln["qty"] = _num(r)
            if src is not None:
                rounded[src] = rounded.get(src, 0.0) - r
                exact[src] = exact.get(src, 0.0) - q
            if dst is not None:
                rounded[dst] = rounded.get(dst, 0.0) + r
                exact[dst] = exact.get(dst, 0.0) + q


def normalize_legacy(model, mapping):
    """Стара книга → модель програми: місця — за таблицею, яку погодив власник (стара назва →
    підрозділ програми; порожнє — лишити як є); архівні позиції — у групу за діапазоном коду.
    Кожна правка — у model["report"]."""
    report = list(model.get("report", []))
    mapping = {k: v for k, v in (mapping or {}).items() if v and k != v}
    for d in model["docs"]:
        for side in ("src", "dst"):
            if d[side] in mapping and not (d["journal"] == "incoming" and side == "src") \
                    and not (d["journal"] == "writeoffs" and side == "dst"):
                d[side] = mapping[d[side]]
    for old, new in sorted(mapping.items()):
        report.append(f"місце «{old}» → «{new}»")
    for it in model["items"]:
        if it["archived"]:
            grp = _group_by_code(it["code"])
            if TYPE_OF_GROUP[grp] != it["type"]:
                report.append(f"позиція {it['code']}: група «{TYPE_OF_GROUP[grp]}» замість «{it['type']}» (архів)")
                it["type"], it["cat"] = TYPE_OF_GROUP[grp], CAT_OF_GROUP[grp]
    _round_quantities(model, report)
    model["report"] = report
    return model
