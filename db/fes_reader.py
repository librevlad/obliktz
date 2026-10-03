# -*- coding: utf-8 -*-
"""Читання звіту 1С «Залишки необоротних активів».

1С пише `SharedStrings.xml` з великої літери, тому openpyxl такий файл не
відкриває взагалі — доводиться розбирати XML напряму.

Ієрархія звіту — місце зберігання -> актив (інв. №) -> партія, де партія
записана як «02.03.2025 №123/Прод(1 250,00000)». Це дата, номер приходного
документа й ціна: та сама модель партій, що в базі.
"""
import re
import zipfile
import xml.etree.ElementTree as ET
from dataclasses import dataclass
from pathlib import Path

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
BATCH_RE = re.compile(r"^(\d{2}\.\d{2}\.\d{4})\s*№\s*(.+?)\((.+?)\)\s*$")

# Латинські й кириличні двійники: те саме слово в двох довідниках набране
# по-різному («івс контейнер» проти «ibc контейнер»), і без зведення до одного
# алфавіту зіставлення дало б хибні розбіжності.
CONFUSABLE = str.maketrans({
    "a": "а", "b": "в", "c": "с", "e": "е", "h": "н", "i": "і", "k": "к",
    "m": "м", "o": "о", "p": "р", "t": "т", "x": "х", "y": "у",
})


@dataclass(frozen=True)
class FesRow:
    place: str
    asset: str
    inv: str
    uom: str
    batch_date: str
    batch_doc: str
    price_kop: int
    qty_milli: int
    cost_kop: int


def norm_name(s: str) -> str:
    """Назва без пунктуації, номерів, регістру й різниці алфавітів.

    Складаються і українські двійники: «Гастроємність» у реєстрі служби писана
    через «е», у номенклатурі — через «є», і це та сама річ. Так само «ї» та «і».
    """
    s = str(s).lower()
    s = re.sub(r"\d{9,}", " ", s)
    s = (s.replace("'", "").replace("’", "").replace("`", "")
          .replace("ї", "і").replace("є", "е"))
    s = s.translate(CONFUSABLE)
    return re.sub(r"[^a-zа-яієґ0-9]+", "", s)


def _num(s) -> float:
    """У рядку заголовків тут лежить текст — повертаємо 0."""
    if not s:
        return 0.0
    try:
        return float(str(s).replace("\xa0", "").replace(" ", "").replace(",", "."))
    except ValueError:
        return 0.0


def _kop(x: float) -> int:
    return int(round(x * 100))


def _cells(path: Path):
    z = zipfile.ZipFile(path)
    name = next(n for n in z.namelist() if n.lower() == "xl/sharedstrings.xml")
    sst = ["".join(x.text or "" for x in si.iter(NS + "t"))
           for si in ET.fromstring(z.read(name)).iter(NS + "si")]
    root = ET.fromstring(z.read("xl/worksheets/sheet1.xml"))
    for r in root.iter(NS + "row"):
        row = {}
        for c in r.iter(NS + "c"):
            col = re.match(r"([A-Z]+)", c.get("r")).group(1)
            v = c.find(NS + "v")
            if v is None or v.text is None:
                continue
            row[col] = sst[int(v.text)] if c.get("t") == "s" else v.text
        yield row


# Колонки в 1С не на місці: старіші вивантаження на одну колонку вужчі за
# новіші («Кількість» у H замість I). Гірше того, змінюється й порядок групувань:
# в одних звітах це «місце → актив → партія», в інших «місце → партія → актив».
# Тому і графи, і порядок рівнів читаються з шапки, а кількість береться лише з
# найглибшого рівня — інакше та сама одиниця порахується двічі.
HEAD_ROW = "Місце зберігання"
ASSET_ROW = "Необоротний актив"
BATCH_ROW = "Партія"
LEVELS = (HEAD_ROW, ASSET_ROW, BATCH_ROW)


def _header(rows):
    """({назва графи: колонка}, порядок рівнів) із шапки звіту."""
    cols, levels = {}, []
    for cells in rows:
        a = " ".join(str(cells.get("A") or "").split())
        if a in LEVELS:
            levels.append(a)
            for col, v in cells.items():
                key = " ".join(str(v).split()).rstrip(":")
                if col != "A" and key:
                    cols.setdefault(key, col)
        elif levels and a:
            break
    return cols, levels


def read_fes(path) -> list[FesRow]:
    rows = list(_cells(Path(path)))
    cols, levels = _header(rows)
    c_qty = cols.get("Кількість", "I")
    c_cost = cols.get("Вартість", "H")
    c_uom = cols.get("Од. вим.", "E")
    c_inv = cols.get("Інв. №", "F")
    leaf = levels[-1] if levels else BATCH_ROW

    out = []
    place = asset = batch = None
    for cells in rows:
        a = (cells.get("A") or "").strip()
        if not a or a.startswith(("Параметры", "Отбор")) or " ".join(a.split()) in LEVELS:
            continue
        m = BATCH_RE.match(a)
        if m:
            kind = BATCH_ROW
            batch = ("-".join(reversed(m.group(1).split("."))), m.group(2).strip(),
                     _kop(_num(m.group(3))))
        elif c_uom in cells or c_inv in cells:
            kind = ASSET_ROW
            asset = (a, cells.get(c_inv, ""), cells.get(c_uom, ""))
        elif a.startswith("Залишки"):
            continue
        else:
            kind = HEAD_ROW
            place, asset, batch = a, None, None
        if kind != leaf:
            continue
        qty = int(round(_num(cells.get(c_qty)) * 1000))
        if not qty or asset is None:
            continue
        out.append(FesRow(
            place=place, asset=asset[0], inv=asset[1], uom=asset[2],
            batch_date=batch[0] if batch else "", batch_doc=batch[1] if batch else "",
            price_kop=batch[2] if batch else 0,
            qty_milli=qty, cost_kop=_kop(_num(cells.get(c_cost)))))
    return out
