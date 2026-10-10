# -*- coding: utf-8 -*-
"""Звіт ФЕС «Залишки товарно-матеріальних цінностей» (1С) — у дерево місце → ТМЦ → партія.

openpyxl такі файли не відкриває (рядки inline, sharedStrings з великої літери), тож XML
читається напряму. Будова — рівні групування рядків (outlineLevel): 0 — місце зберігання
(A — назва, H — сума, I — кількість), 1 — ТМЦ (A — найменування, E — код ФЕС, G — од. вим.,
H, I, J — сума, кількість, ціна), 2 — партія («19.11.2025 №7/…/посуд(8,88000)»), 3 — договір.
Шапка — до рядка «Партія.Документ.Договір»; дата звіту — з «Кінець періоду: дд.мм.рррр».
"""
import io
import re
import xml.etree.ElementTree as ET
import zipfile

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
RNS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
BATCH = re.compile(r"^(\d{2})\.(\d{2})\.(\d{4})\s*№\s*(.*?)\s*\(([\d\s.,]+)\)\s*$")


def _num(v):
    try:
        x = float(str(v).replace(" ", "").replace(",", "."))
    except (TypeError, ValueError):
        return 0
    return int(x) if x.is_integer() else round(x, 6)


def _rows(z):
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    rels = ET.fromstring(z.read("xl/_rels/workbook.xml.rels"))
    target = {r.get("Id"): r.get("Target") for r in rels}
    first = next(wb.iter(NS + "sheet"))
    t = target[first.get(RNS + "id")].lstrip("/")
    path = t if t.startswith("xl/") else "xl/" + t
    name = next((n for n in z.namelist() if n.lower() == "xl/sharedstrings.xml"), None)
    sst = ["".join(x.text or "" for x in si.iter(NS + "t")) for si in ET.fromstring(z.read(name)).iter(NS + "si")] \
        if name else []
    for r in ET.fromstring(z.read(path)).iter(NS + "row"):
        cells = {}
        for c in r.iter(NS + "c"):
            col = re.match(r"([A-Z]+)", c.get("r")).group(1)
            if c.get("t") == "inlineStr":
                v = "".join(x.text or "" for x in c.iter(NS + "t"))
            else:
                node = c.find(NS + "v")
                if node is None or node.text is None:
                    continue
                v = sst[int(node.text)] if c.get("t") == "s" else node.text
            if v not in ("", None):
                cells[col] = v
        yield int(r.get("outlineLevel") or 0), cells


def read_report(data):
    """{"date": "YYYY-MM-DD"|"", "places": [{"name", "items": [{"code", "name", "uom", "qty", "sum", "price",
    "batches": [{"date", "doc", "price", "qty"}]}]}]}"""
    try:
        with zipfile.ZipFile(io.BytesIO(data)) as z:
            rows = list(_rows(z))
    except (zipfile.BadZipFile, KeyError, ET.ParseError, StopIteration) as e:
        raise ValueError(f"файл не читається як звіт ФЕС: {e}") from e
    date, start = "", None
    for i, (_lvl, c) in enumerate(rows):
        m = re.search(r"Кінець періоду:\s*(\d{2})\.(\d{2})\.(\d{4})", " ".join(str(v) for v in c.values()))
        if m:
            date = f"{m.group(3)}-{m.group(2)}-{m.group(1)}"
        if str(c.get("A", "")).strip() == "Партія.Документ.Договір":
            start = i + 1
            break
    if start is None:
        raise ValueError("це не звіт ФЕС «Залишки ТМЦ»: немає шапки «Партія.Документ.Договір»")
    places, place, item = [], None, None
    for lvl, c in rows[start:]:
        if lvl == 0 and c.get("A"):
            place = {"name": c["A"].strip(), "items": []}
            places.append(place)
            item = None
        elif lvl == 1 and place is not None and c.get("A"):
            raw = str(c.get("E", "")).strip()
            code = re.sub(r"\D", "", raw).lstrip("0") or raw
            item = {"code": code, "name": c["A"].strip(), "uom": str(c.get("G", "")).strip(), "qty": _num(c.get("I")),
                    "sum": _num(c.get("H")), "price": _num(c.get("J")), "batches": []}
            place["items"].append(item)
        elif lvl == 2 and item is not None:
            m = BATCH.match(str(c.get("A", "")).strip())
            item["batches"].append({"date": f"{m.group(3)}-{m.group(2)}-{m.group(1)}" if m else "",
                                    "doc": m.group(4) if m else str(c.get("A", "")).strip(),
                                    "price": _num(m.group(5)) if m else _num(c.get("J")), "qty": _num(c.get("I"))})
    return {"date": date, "places": places}
