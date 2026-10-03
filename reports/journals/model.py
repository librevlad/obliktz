# -*- coding: utf-8 -*-
"""Модель книг обліку: період книги (том за рік або квартал, книга поточного року), документи періоду,
картка позиції форми 46/47 (усі місця), рядки складу форми 13/14. Перенесено з книг сухпаю й продуктів
(tools/kp_book/jr у iprod) — розкладка, погоджена власником."""
import collections
import datetime
import re

from .data import party

EPS = 1e-9
_SUFFIX = re.compile(r"^(.*) \((\d\d)\.(\d\d)\.(\d{4})\)$")
ROMAN = ("I", "II", "III", "IV")
DAY = datetime.timedelta(days=1)


class Period:
    """Період книги: том за рік (q = None, паперові книги техзасобів — руху на рік небагато) або за
    квартал (q = 1…4); межі d1..d2 включно, `d_to` обрізає кінець (книга поточного року).
    Попередня книга — том за попередній рік чи квартал."""

    def __init__(self, year, q=None, d_to=None):
        self.year, self.q = year, q
        if q is None:
            self.d1, self.d2 = datetime.date(year, 1, 1), datetime.date(year, 12, 31)
        else:
            self.d1 = datetime.date(year, 3 * q - 2, 1)
            self.d2 = datetime.date(year, 3 * q + 1, 1) - DAY if q < 4 else datetime.date(year, 12, 31)
        if d_to and d_to < self.d2:
            self.d2 = d_to

    @property
    def label(self):
        """«I квартал 2024 року» / «2024 рік»"""
        return "%s квартал %d року" % (ROMAN[self.q - 1], self.year) if self.q else "%d рік" % self.year

    @property
    def volume(self):
        """«Том 1 (I квартал 2024 року)» / «за 2024 рік»"""
        return "Том %d (%s)" % (self.q, self.label) if self.q else "за %d рік" % self.year

    @property
    def total(self):
        return "Разом за %s" % self.label

    @property
    def opening_day(self):
        """кінець дня перед періодом — залишки перенесення"""
        return self.d1 - DAY

    def prev(self):
        if self.q:
            return Period(self.year, self.q - 1) if self.q > 1 else Period(self.year - 1, 4)
        return Period(self.year - 1)

    def next_year(self):
        return self.year + 1 if self.q in (None, 4) else self.year


def disp_num(num, d):
    """номер документа без « (дд.мм.рррр)», доданого для розрізнення повторів, якщо дата та сама"""
    m = _SUFFIX.match(num or "")
    if m and datetime.date(int(m.group(4)), int(m.group(3)), int(m.group(2))) == d:
        return m.group(1)
    return num or ""


def cap_first(s):
    return s[:1].upper() + s[1:] if s else s


def docs_of(D, per):
    """документи періоду: [{date, kind, typ, num, frm, to, party, lines {код: {місце: зміна}}, places}];
    документ — один рядок книги (його позиції — рядки картки кожної позиції)"""
    groups = collections.OrderedDict()
    for e in D.period_events(per.d1, per.d2):
        key = (e["date"], e["kind"], e["doc"])
        g = groups.get(key)
        if g is None:
            g = groups[key] = dict(date=e["date"], kind=e["kind"], typ=e["typ"], num=e["num"],
                                   frm=D.canon(e["frm"], per.year), to=D.canon(e["to"], per.year), party=e["party"],
                                   lines=collections.defaultdict(lambda: collections.defaultdict(float)), places=set())
        for p, q in e["deltas"].items():
            cp = D.canon(p, per.year)
            g["lines"][e["code"]][cp] += q
            g["places"].add(cp)
    return list(groups.values())


def opening(D, per):
    """залишки перенесення періоду {(місце, код): к-ть}"""
    return D.balances(per.opening_day, per.year)


def doc_party(D, g, place=None):
    """«Постачальник (одержувач)»: прихід — постачальник; переміщення — друга сторона щодо місця книги
    (картка 47 — щодо складу служби); списання — кому передано, якщо вказано"""
    ref = place or D.head
    if g["kind"] == "in":
        return party(g["party"]) or party(g["frm"])
    if g["kind"] == "mv":
        f, t = g["frm"], g["to"]
        if f == ref:
            return party(t)
        if t == ref:
            return party(f)
        return "%s → %s" % (party(f), party(t))
    return party(g.get("party") or "")


def card47(D, per, code, docs, opening, carry):
    """рядки картки позиції: перенесення залишку, операції, «Разом за <період>». opening {місце: к-ть}.
    carry — (номер книги, сторінка) або None. -> (місця картки, рядки)"""
    act = {p for p, q in opening.items() if abs(q) > EPS}
    for g in docs:
        for p, q in g["lines"].get(code, {}).items():
            if abs(q) > EPS:
                act.add(p)
    subs = sorted((p for p in act if p != D.head), key=D.place_key)
    places = [D.head] + subs
    bal = collections.defaultdict(float)
    for p, q in opening.items():
        bal[p] += q
    rows = []
    if any(abs(q) > EPS for q in opening.values()):
        rows.append(dict(kind="carry", date=per.d1, typ="Книга обліку",
                         num="за %s" % per.prev().label, ddate="с. %s" % carry[1] if carry and carry[1] else "",
                         party="Перенесення залишку", inq=None, outq=None, total=sum(bal.values()),
                         places={p: bal[p] for p in places if abs(bal[p]) > EPS}))
    tin = tout = 0.0
    for g in docs:
        ln = g["lines"].get(code)
        if not ln:
            continue
        changed = {}
        for p, q in ln.items():
            if abs(q) > EPS:
                bal[p] += q
                changed[p] = bal[p]
        if not changed:
            continue
        inq = outq = None
        s = sum(ln.values())
        if g["kind"] == "in":
            inq = s
            tin += s
        elif g["kind"] == "wo":
            outq = -s
            tout += -s
        rows.append(dict(kind="op", date=g["date"], typ=cap_first(g["typ"]), num=disp_num(g["num"], g["date"]),
                         ddate=g["date"], party=doc_party(D, g), inq=inq, outq=outq, total=sum(bal.values()),
                         places=changed))
    rows.append(dict(kind="total", date=None, typ=per.total, num="", ddate="", party="",
                     inq=tin, outq=tout, total=sum(bal.values()), places={p: bal[p] for p in places}))
    return places, rows


def rows13(D, per, codes, docs, opening, carry, place):
    """рядки групи позицій книги підрозділу: перенесення залишку, операції місця, «Разом за <період>».
    opening {код: к-ть у місці}; carry — сторінка попередньої книги або None"""
    bal = collections.defaultdict(float, {c: opening.get(c, 0.0) for c in codes})
    rows = []
    if any(abs(opening.get(c, 0.0)) > EPS for c in codes):
        rows.append(dict(kind="carry", date=per.d1, typ="Книга обліку",
                         num="за %s%s" % (per.prev().label, (", с. %s" % carry) if carry else ""),
                         party="Перенесення залишку",
                         items={c: (None, None, bal[c]) for c in codes if abs(bal[c]) > EPS}))
    tn = collections.defaultdict(float)
    tv = collections.defaultdict(float)
    for g in docs:
        cells = {}
        for c in codes:
            q = g["lines"].get(c, {}).get(place, 0.0)
            if abs(q) <= EPS:
                continue
            bal[c] += q
            if q > 0:
                tn[c] += q
                cells[c] = (q, None, bal[c])
            else:
                tv[c] += -q
                cells[c] = (None, -q, bal[c])
        if not cells:
            continue
        num = disp_num(g["num"], g["date"])
        rows.append(dict(kind="op", date=g["date"], typ=cap_first(g["typ"]),
                         num=("№ %s від %s" % (num, g["date"].strftime("%d.%m.%Y"))) if num else
                         "від %s" % g["date"].strftime("%d.%m.%Y"),
                         party=doc_party(D, g, place), items=cells))
    rows.append(dict(kind="total", date=None, typ=per.total, num="", party="",
                     items={c: (tn[c], tv[c], bal[c]) for c in codes}))
    return rows, dict(bal)
