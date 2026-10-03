# -*- coding: utf-8 -*-
"""Друковані й електронні книги обліку № 47 і № 14 з бази програми.

Паперові книги — томами за рік: форма 46/47 (картки позицій служби з місцями) і форма 13/14
(книга кожного підрозділу, що тримає майно); сторінка книги = аркуш Excel, розворотами, з
титулом, змістом і засвідчувальним написом, рік починається перенесенням залишків із
посиланням на сторінки минулорічної книги. Електронні книги поточного року — ті самі форми
з формулами залишків і узагальнюючою відомістю для подальшого ведення.

spec: {"year": 2025, "paper": true, "electronic": true, "pdf": false, "as_of": "2026-10-01",
       "unit": "А0000"} — рік паперових книг; електронні будуються за рік `as_of`."""
import datetime
import json
import os

from .data import Data
from .electronic import electronic_year
from .paper import export_pdf, paper_year

FOLDER = "Книги обліку"


def _refs_path(root, year):
    return os.path.join(root, "journal_refs_%d.json" % year)


def save_journals(con, spec, folder):
    """Книги в теку «вивантаження/Книги обліку/<рік>/»; -> шлях книги № 47 (решта поруч)."""
    root = os.path.join(folder, FOLDER)
    os.makedirs(root, exist_ok=True)
    D = Data(con, str(spec.get("unit") or "").strip())
    made = []
    year = int(spec.get("year") or 0)
    if spec.get("paper") and year:
        refs = {}
        p = _refs_path(root, year - 1)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                refs = json.load(f)
        books, refs_now = paper_year(D, year, os.path.join(root, str(year)), refs)
        with open(_refs_path(root, year), "w", encoding="utf-8") as f:
            json.dump(refs_now, f, ensure_ascii=False, indent=1)
        made += [b[0] for b in books]
        if spec.get("pdf") and books:
            export_pdf([b[0] for b in books])
    if spec.get("electronic"):
        as_of = datetime.date.fromisoformat(str(spec.get("as_of") or datetime.date.today().isoformat())[:10])
        refs = {}
        p = _refs_path(root, as_of.year - 1)
        if os.path.exists(p):
            with open(p, encoding="utf-8") as f:
                refs = json.load(f)
        books = electronic_year(D, as_of.year, as_of, os.path.join(root, "%d (електронні)" % as_of.year), refs)
        made += [b[0] for b in books]
    if not made:
        raise ValueError("за цей рік у книгах немає ні руху, ні залишків")
    # Книга № 47 — головна; її й відкриваємо, решта лежить поруч.
    return next((p for p in made if os.path.basename(p).startswith(("47 ", "46 "))), made[0])
