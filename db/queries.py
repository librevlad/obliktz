"""Іменовані запити над проводками.

Дата — завжди параметр, тому це функції, а не подання: залишок «на дату»
потрібен і для звітів, і для журналів 14/47.
"""
import sqlite3

_BALANCE = """
SELECT nomen_id, subdivision_id, SUM(sign * qty_milli) AS qty_milli
FROM posting
WHERE doc_date <= :as_of
  AND (:nomen_id IS NULL OR nomen_id = :nomen_id)
  AND (:subdivision_id IS NULL OR subdivision_id = :subdivision_id)
GROUP BY nomen_id, subdivision_id
HAVING SUM(sign * qty_milli) <> 0
"""

_BY_BATCH = """
SELECT p.batch_line_id, p.subdivision_id, p.nomen_id,
       SUM(p.sign * p.qty_milli) AS qty_milli,
       b.price_kop,
       CAST(ROUND(SUM(p.sign * p.qty_milli) * b.price_kop / 1000.0) AS INTEGER) AS value_kop
FROM posting p
JOIN batch b ON b.batch_line_id = p.batch_line_id
WHERE p.doc_date <= :as_of
  AND (:subdivision_id IS NULL OR p.subdivision_id = :subdivision_id)
  AND (:nomen_id IS NULL OR p.nomen_id = :nomen_id)
GROUP BY p.batch_line_id, p.subdivision_id, p.nomen_id
HAVING SUM(p.sign * p.qty_milli) <> 0
"""

_SUBTREE = """
SELECT p.nomen_id, SUM(p.sign * p.qty_milli) AS qty_milli
FROM posting p
JOIN subdivision_tree t ON t.descendant_id = p.subdivision_id
WHERE t.ancestor_id = :root AND p.doc_date <= :as_of
GROUP BY p.nomen_id
HAVING SUM(p.sign * p.qty_milli) <> 0
"""


def balance(con: sqlite3.Connection, as_of: str, *, nomen_id=None, subdivision_id=None):
    return con.execute(_BALANCE, dict(as_of=as_of, nomen_id=nomen_id,
                                      subdivision_id=subdivision_id)).fetchall()


def balance_by_batch(con: sqlite3.Connection, as_of: str, *,
                     subdivision_id=None, nomen_id=None):
    return con.execute(_BY_BATCH, dict(as_of=as_of, subdivision_id=subdivision_id,
                                       nomen_id=nomen_id)).fetchall()


def available_batches(con: sqlite3.Connection, as_of: str,
                      subdivision_id: int, nomen_id: int):
    """Партії з ненульовим залишком у підрозділі — це і є вибір оператора."""
    rows = balance_by_batch(con, as_of, subdivision_id=subdivision_id, nomen_id=nomen_id)
    return [r for r in rows if r["qty_milli"] > 0]


def subtree_balance(con: sqlite3.Connection, as_of: str, root_subdivision_id: int):
    return con.execute(_SUBTREE, dict(as_of=as_of, root=root_subdivision_id)).fetchall()


def destroyed_open(con: sqlite3.Connection, as_of: str):
    """Знищене, що числиться в обліку: фактична наявність = обліковий − це."""
    return con.execute(
        "SELECT nomen_id, subdivision_id, SUM(qty_milli) AS qty_milli "
        "FROM destroyed_open WHERE doc_date <= :as_of "
        "GROUP BY nomen_id, subdivision_id", dict(as_of=as_of)).fetchall()


_NORM_OWN = """
SELECT nomen_id, report_line_id, SUM(qty_milli) AS qty_milli FROM norm
WHERE subdivision_id = :sub AND valid_from <= :on_date
  AND (valid_to IS NULL OR valid_to > :on_date)
GROUP BY nomen_id, report_line_id
"""

_NORM_TREE = """
SELECT n.nomen_id, n.report_line_id, SUM(n.qty_milli) AS qty_milli
FROM norm n
JOIN subdivision_tree t ON t.descendant_id = n.subdivision_id
WHERE t.ancestor_id = :sub AND n.valid_from <= :on_date
  AND (n.valid_to IS NULL OR n.valid_to > :on_date)
GROUP BY n.nomen_id, n.report_line_id
"""


def norm_at(con: sqlite3.Connection, on_date: str, subdivision_id: int, *,
            with_children: bool = False):
    sql = _NORM_TREE if with_children else _NORM_OWN
    return con.execute(sql, dict(on_date=on_date, sub=subdivision_id)).fetchall()
