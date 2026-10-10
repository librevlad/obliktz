# -*- coding: utf-8 -*-
"""Звірка книги ОП з ФЕС: кількість по кодах книги (позиція ФЕС = код ФЕС + ціна партії),
партії ФЕС проти залишку партій обліку і документи, які ще не дійшли до ФЕС. Результат —
книга Excel у теці звірок; ручний файл звірки програма не чіпає."""
import datetime
import os
import re

from openpyxl import Workbook

PENDING = ("на підписі", "їде на ФЕС")


def _kop(price):
    return int(round(float(price or 0) * 100))


def _map(con):
    return {(r["fes_code"], r["price_kop"]): r["code"] for r in con.execute(
        "SELECT m.fes_code, m.price_kop, n.code FROM fes_item_map m LEFT JOIN nomen n ON n.id = m.nomen_id")}


def _no(text):
    return re.sub(r"[^0-9A-Za-zА-Яа-яІіЇїЄєҐґ]", "", str(text or ""))


def compare(con, report, as_of=None, places=None):
    import state_db                                              # noqa: PLC0415
    as_of = as_of or report.get("date") or datetime.date.today().isoformat()
    ours = state_db.op_codes(con)
    mp = _map(con)
    names = dict(con.execute("SELECT code, name FROM nomen"))
    book = {}
    for code, sub, q in con.execute("""SELECT n.code, s.name, SUM(p.sign * p.qty_milli) FROM posting p
                                         JOIN nomen n ON n.id = p.nomen_id JOIN subdivision s ON s.id = p.subdivision_id
                                        WHERE p.doc_date <= ? GROUP BY n.code, s.name""", (as_of,)):
        if code in ours:
            book[(code, sub)] = q / 1000
    fes, by_place, unmapped, batches = {}, [], {}, []
    for place in report["places"]:
        for it in place["items"]:
            key = (it["code"], _kop(it["price"]))
            if key not in mp:
                unmapped[key] = {"code": it["code"], "name": it["name"], "price": it["price"]}
                continue
            code = mp[key]
            if not code:
                continue                                            # позначено «не з книги ОП»
            fes[code] = fes.get(code, 0) + it["qty"]
            sub = (places or {}).get(place["name"])
            by_place.append({"place": place["name"], "sub": sub or "", "code": code, "fes": it["qty"],
                             "book": book.get((code, sub), 0) if sub else None})
            for b in it["batches"]:
                batches.append({"code": code, "date": b["date"], "doc": b["doc"], "price": b["price"],
                                "fes": b["qty"], "book": None})
    # Партія ФЕС — прихідний документ обліку з тим самим номером: ФЕС тримає партію, поки в нього
    # не проведено списання, а облік знає її залишок (партії розкладено за надходженням).
    lots = {}
    for r in con.execute("""SELECT n.code, b.number, b.doc_date,
                                   (SELECT COALESCE(SUM(p.sign * p.qty_milli), 0) FROM posting p
                                     WHERE p.batch_line_id = b.batch_line_id AND p.doc_date <= ?) AS rest
                              FROM batch b JOIN nomen n ON n.id = b.nomen_id WHERE b.doc_date <= ?""", (as_of, as_of)):
        if r["code"] in ours:
            lot = lots.setdefault((r["code"], _no(r["number"])), {"date": r["doc_date"], "rest": 0.0, "seen": False})
            lot["rest"] += r["rest"] / 1000
    for b in batches:
        m = re.match(r"\s*([^/\s]+)", b["doc"])
        lot = lots.get((b["code"], _no(m.group(1) if m else "")))
        if lot:
            b["book"], lot["seen"] = round(lot["rest"], 3), True
    for (code, no), lot in sorted(lots.items()):
        if not lot["seen"] and lot["rest"] > 1e-9 and code in fes:
            batches.append({"code": code, "date": lot["date"], "doc": f"№{no}", "price": None, "fes": None,
                            "book": round(lot["rest"], 3)})
    totals = {}
    for (code, _sub), q in book.items():
        totals[code] = totals.get(code, 0) + q
    rows = []
    for code in sorted(set(fes) | {c for c, q in totals.items() if abs(q) > 1e-9}):
        f, b = fes.get(code, 0), round(totals.get(code, 0), 3)
        rows.append({"code": code, "name": names.get(code, ""), "fes": f, "book": b, "diff": round(f - b, 3)})
    pending = []
    for r in con.execute("""SELECT d.id, d.number, d.doc_date, f.status, f.changed_on FROM document_fes f
                              JOIN document d ON d.id = f.document_id WHERE f.status IN (?, ?) ORDER BY d.doc_date""", PENDING):
        codes = {c for (c,) in con.execute("SELECT n.code FROM document_line l JOIN nomen n ON n.id = l.nomen_id "
                                           "WHERE l.document_id = ?", (r["id"],))}
        if codes & ours:
            since = r["changed_on"] or r["doc_date"]
            pending.append({"id": r["id"], "no": r["number"], "date": r["doc_date"], "status": r["status"],
                            "days": (datetime.date.fromisoformat(as_of) - datetime.date.fromisoformat(since)).days})
    return {"as_of": as_of, "rows": rows, "unmapped": sorted(unmapped.values(), key=lambda x: (x["code"], x["price"])),
            "byPlace": by_place, "batches": batches, "pending": pending}


def write_result(result, folder):
    """Книга «Звірка ОП з ФЕС <дата> (програма).xlsx»: розбіжності, місця, партії, документи в дорозі."""
    from desktop.excel_names import save_book                    # noqa: PLC0415
    wb = Workbook()
    sheets = [("Розбіжності", ["код", "найменування", "ФЕС", "облік", "різниця"],
               [[r["code"], r["name"], r["fes"], r["book"], r["diff"]] for r in result["rows"]]),
              ("Місця", ["місце ФЕС", "підрозділ", "код", "ФЕС", "облік"],
               [[r["place"], r["sub"], r["code"], r["fes"], r["book"]] for r in result["byPlace"]]),
              ("Партії", ["код", "дата", "документ", "ціна", "ФЕС", "облік"],
               [[b["code"], b["date"], b["doc"], b["price"], b["fes"], b["book"]] for b in result["batches"]]),
              ("Не дійшли до ФЕС", ["№", "дата", "статус", "днів"],
               [[p["no"], p["date"], p["status"], p["days"]] for p in result["pending"]]),
              ("Позиції ФЕС без відповідності", ["код ФЕС", "найменування", "ціна"],
               [[u["code"], u["name"], u["price"]] for u in result["unmapped"]])]
    for n, (title, head, rows) in enumerate(sheets):
        ws = wb.active if n == 0 else wb.create_sheet()
        ws.title = title
        ws.append(head)
        for row in rows:
            ws.append(row)
        ws.freeze_panes = "A2"
    os.makedirs(folder, exist_ok=True)
    path = os.path.join(folder, f"Звірка ОП з ФЕС {result['as_of']} (програма).xlsx")
    try:
        save_book(wb, path)
    except PermissionError:
        path = path[:-5] + f" {datetime.datetime.now():%H%M%S}.xlsx"
        save_book(wb, path)
    return path
