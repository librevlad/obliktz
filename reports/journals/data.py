# -*- coding: utf-8 -*-
"""Рух для книг обліку з бази програми: позиції, події з місцями (підрозділами), залишки на дату.

Подія — рядок документа, що рухає залишки (posting): прихід ззовні (в т. ч. перенесення залишків)
— «in», накладна між підрозділами — «mv», акт списання чи передача в іншу частину — «wo». Місце —
підрозділ, що тримає майно; головне місце книги служби — «склад»."""
import collections
import datetime
import re

KIND_ORDER = {"in": 0, "mv": 1, "wo": 2}
UNIT_RE = re.compile(r"^(?:в/ч\s*)?[АA]\d{4}$")
HEAD = "склад"
EPS = 1e-9


def party(name):
    """постачальник/одержувач для граф книги: в/ч — з «в/ч», решта як у документі"""
    name = (name or "").strip()
    if UNIT_RE.match(name):
        return "в/ч " + name.replace("в/ч", "").strip()
    return name


def _date(s):
    return datetime.date.fromisoformat(str(s)[:10])


class Data:
    """Модель руху для книг: `items` {код: {code, name, unit, price, order}}, `events` за датою,
    `places` — підрозділи в порядку дерева, `warehouses` — ті, що тримають майно (не бригада)."""

    def __init__(self, con, unit_name="", book="ТЗ"):
        """`book` — книга обліку: «ТЗ» (техзасоби) чи «ОП» (посуд одноразового використання,
        миючі засоби, серветки); у книги лише позиції своїх груп і їхній рух."""
        self.unit = unit_name
        self.book = book
        self.head = HEAD
        rows = con.execute("""
            SELECT s.name, s.sort, s.is_active, k.code AS kind, p.name AS parent
              FROM subdivision s JOIN subdivision_kind k ON k.id = s.kind_id
              LEFT JOIN subdivision p ON p.id = s.parent_id
             ORDER BY s.sort, s.id""").fetchall()
        self.places = [r["name"] for r in rows]
        self.warehouses = [r["name"] for r in rows if r["kind"] != "бригада"]
        self.items = collections.OrderedDict()
        price = {}
        for r in con.execute("""
            SELECT l.nomen_id, l.price_kop FROM document_line l JOIN document d ON d.id = l.document_id
              JOIN doc_kind k ON k.id = d.kind_id
             WHERE k.affects_stock = 1 AND l.source_line_id IS NULL AND l.price_kop IS NOT NULL
               AND d.to_subdivision_id IS NOT NULL AND d.from_subdivision_id IS NULL
             ORDER BY d.doc_date, d.id, l.line_no"""):
            price[r["nomen_id"]] = r["price_kop"] / 100.0
        for i, r in enumerate(con.execute("""
            SELECT n.id, n.code, n.name, u.code AS unit, n.app_price_kop
              FROM nomen n JOIN uom u ON u.id = n.uom_id JOIN nomen_group g ON g.id = n.group_id
             WHERE g.book = ?
             ORDER BY g.sort, n.code""", (book,))):
            self.items[r["code"]] = dict(code=r["code"], name=r["name"], unit=r["unit"],
                                         price=price.get(r["id"], (r["app_price_kop"] or 0) / 100.0), order=i)
        ev = []
        for r in con.execute("""
            SELECT d.id, k.code AS kind, k.name AS kname, d.paper, d.number, d.doc_date, d.note,
                   fs.name AS frm, ts.name AS tos, cp.name AS cparty, n.code, l.qty_milli, l.line_no
              FROM document d JOIN doc_kind k ON k.id = d.kind_id
              JOIN document_line l ON l.document_id = d.id
              JOIN nomen n ON n.id = l.nomen_id
              LEFT JOIN subdivision fs ON fs.id = d.from_subdivision_id
              LEFT JOIN subdivision ts ON ts.id = d.to_subdivision_id
              LEFT JOIN counterparty cp ON cp.id = d.counterparty_id
             WHERE k.affects_stock = 1 AND (d.from_subdivision_id IS NOT NULL OR d.to_subdivision_id IS NOT NULL)
             ORDER BY d.doc_date, d.id, l.line_no"""):
            if r["code"] not in self.items:
                continue                                  # рух позиції іншої книги
            frm, tos = r["frm"] or "", r["tos"] or ""
            if frm and tos:
                kind, prt = "mv", ""
            elif tos:
                kind = "in"
                prt = r["cparty"] or ("Перенесення залишків" if r["kind"] == "opening" else "")
            else:
                kind, prt = "wo", (r["cparty"] or "")
            typ = (r["paper"] or r["kname"] or "").strip()
            ev.append(dict(kind=kind, typ=typ, date=_date(r["doc_date"]), num=str(r["number"] or ""), id="%d/%d" % (r["id"], r["line_no"]),
                           doc=r["id"], frm=frm, to=tos, code=r["code"], qty=r["qty_milli"] / 1000.0, party=prt))
        for e in ev:
            e["deltas"] = self._deltas(e)
        ev.sort(key=lambda e: (e["date"], KIND_ORDER[e["kind"]], e["doc"], e["id"]))
        self.events = ev

    @staticmethod
    def _deltas(e):
        if e["kind"] == "in":
            return {e["to"]: e["qty"]}
        if e["kind"] == "mv":
            return {e["frm"]: -e["qty"], e["to"]: e["qty"]} if e["frm"] != e["to"] else {}
        return {e["frm"]: -e["qty"]}

    def canon(self, place, year):          # noqa: ARG002 — назви підрозділів у базі одні на всі роки
        return place

    def balances(self, upto, year_names=None):      # noqa: ARG002
        """залишки на кінець дня `upto` включно: {(місце, код): к-ть}"""
        bal = collections.defaultdict(float)
        for e in self.events:
            if e["date"] > upto:
                break
            for p, q in e["deltas"].items():
                bal[(p, e["code"])] += q
        return {k: round(v, 6) for k, v in bal.items() if abs(v) > EPS}

    def period_events(self, d1, d2):
        return [e for e in self.events if d1 <= e["date"] <= d2]

    def place_key(self, name):
        try:
            return (0 if name == self.head else 1, self.places.index(name), name)
        except ValueError:
            return (2, 999, name)

    def unit_of(self, place, year):        # noqa: ARG002
        return self.unit

    def years(self):
        """роки, у яких є рух"""
        return sorted({e["date"].year for e in self.events})

    def warehouses_of(self, per):
        """підрозділи з рухом або залишком у періоді (`model.Period`)"""
        ob = self.balances(per.d1 - datetime.timedelta(days=1))
        got = {p for (p, c), q in ob.items() if abs(q) > EPS}
        for e in self.period_events(per.d1, per.d2):
            got.update(p for p, q in e["deltas"].items() if abs(q) > EPS)
        wh = set(self.warehouses)
        return sorted((p for p in got if p in wh), key=self.place_key)
