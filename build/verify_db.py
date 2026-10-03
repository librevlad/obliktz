# -*- coding: utf-8 -*-
"""Приймальна звірка бази за критеріями специфікації."""
import json
import re
import sqlite3
import sys
from dataclasses import dataclass
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from db import queries                       # noqa: E402
from db.connect import open_db, close_db     # noqa: E402

# Початок обліку, коли служба не назвала свого в реквізитах частини.
OPENING_DATE = "2022-02-24"


def _ua(iso: str) -> str:
    """2026-01-31 → 31.01.2026: дати в назвах перевірок — як у програмі."""
    y, m, d = iso.split("-")
    return f"{d}.{m}.{y}"


def _money(kop: int) -> str:
    """1 234 567,89 — як у програмі."""
    return f"{kop / 100:,.2f}".replace(",", " ").replace(".", ",")


def _plural(n: int, one: str, few: str, many: str) -> str:
    n = abs(int(n))
    if n % 10 == 1 and n % 100 != 11:
        return one
    if 2 <= n % 10 <= 4 and not 12 <= n % 100 <= 14:
        return few
    return many


@dataclass
class Check:
    name: str
    ok: bool
    detail: str = ""
    # Порада, а не збій: стан, у якому база буває під час звичайної роботи
    # (нові одиниці ще без інвентарних номерів), — програма показує його як
    # «увага», а не як помилку обліку.
    advisory: bool = False


# Залишок «на сьогодні» — за всіма проведеними документами, хоч якою датою.
LAST_DAY = "9999-12-31"


def _no_negative_balances(con) -> Check:
    neg = [r for r in queries.balance(con, LAST_DAY) if r["qty_milli"] < 0]
    names = con.execute(
        "SELECT id, code, name FROM nomen").fetchall() if neg else []
    by_id = {r["id"]: f"{r['code']} {r['name'][:36]}" for r in names}
    return Check("Немає від’ємних залишків", not neg,
                 "; ".join(f"{by_id.get(r['nomen_id'], r['nomen_id'])}: "
                           f"{r['qty_milli'] / 1000:+g}" for r in neg))


def _outgoing_lines_name_their_batch(con) -> Check:
    n = con.execute(
        "SELECT COUNT(*) FROM document_line l "
        "JOIN document d ON d.id = l.document_id "
        "JOIN doc_kind k ON k.id = d.kind_id "
        "WHERE k.affects_stock = 1 AND d.from_subdivision_id IS NOT NULL "
        "AND l.source_line_id IS NULL").fetchone()[0]
    return Check("Кожен рядок вибуття має партію", n == 0, f"{n} рядків без партії")


def _instance_is_in_one_place(con) -> Check:
    n = con.execute(
        "SELECT COUNT(*) FROM ("
        "  SELECT instance_id, subdivision_id, SUM(sign * qty_milli) AS q FROM posting "
        "  WHERE instance_id IS NOT NULL AND doc_date <= ? "
        "  GROUP BY instance_id, subdivision_id HAVING q NOT IN (0, 1000))",
        (LAST_DAY,)).fetchone()[0]
    return Check("Примірник не числиться у двох місцях", n == 0, f"{n} суперечливих залишків")


def _no_absolute_paths(con) -> Check:
    n = con.execute(
        "SELECT COUNT(*) FROM attachment "
        "WHERE rel_path LIKE '_:%' OR rel_path LIKE '/%'").fetchone()[0]
    return Check("Жодного абсолютного шляху у вкладеннях", n == 0, f"{n} шляхів")


def _opening_date(con) -> str:
    """Початок обліку цієї бази: служба називає свій у реквізитах частини («Початок обліку»),
    і документи між ним і 24.02.2022 — її справжні документи, а не збій."""
    try:
        row = con.execute("SELECT value FROM app_setting WHERE key = 'unit'").fetchone()
        mine = str((json.loads(row[0]) or {}).get("opening") or "") if row else ""
    except (sqlite3.Error, ValueError, TypeError, AttributeError):
        mine = ""
    return mine if re.fullmatch(r"\d{4}-\d{2}-\d{2}", mine) else OPENING_DATE


def _history_is_live(con) -> Check:
    """Уся історія — справжні документи, а не архів паперів.

    Раніше документи до дати відліку мали види з `affects_stock = 0`, бо сальдо
    бралося з ФЕС. Тепер облік починається з першого документа служби, тому
    архівних видів бути не має.
    """
    n = con.execute(
        "SELECT COUNT(*) FROM document d JOIN doc_kind k ON k.id = d.kind_id "
        "WHERE k.code IN ('arch_in', 'arch_move', 'arch_off')").fetchone()[0]
    opening = _opening_date(con)
    early = con.execute("SELECT COUNT(*) FROM posting WHERE doc_date < ?",
                        (opening,)).fetchone()[0]
    return Check("Немає архівних документів і проводок до дати відліку",
                 n == 0 and early == 0,
                 f"архівних документів {n}, проводок до {_ua(opening)}: {early}")


def _norms_reach_the_nomenclature(con) -> Check:
    """Норма на табельний рядок без жодного коду під ним нічого не показує."""
    total, linked = con.execute("""
        SELECT COUNT(*), SUM(EXISTS (SELECT 1 FROM nomen_report_line m
                                     WHERE m.report_line_id = rl.id))
        FROM report_line rl""").fetchone()
    return Check("Табельні позиції прив’язані до номенклатури", (linked or 0) > 0,
                 f"{linked or 0} із {total} рядків форми мають коди служби")


def _every_batch_has_a_price(con) -> Check:
    """Партія без ціни робить вартість у звітах неповною — і мовчки.

    Журнали 3.0 ціну в прибутку не ведуть узагалі, тому надходження після знімка
    ФЕС прийшли без неї. Це не нуль: вартість невідома, і поки її не проставлять
    руками, підсумки описів занижені рівно на ці партії.
    """
    n = con.execute(
        "SELECT COUNT(*) FROM document_line l "
        "JOIN document d ON d.id = l.document_id "
        "JOIN doc_kind k ON k.id = d.kind_id "
        "WHERE k.affects_stock = 1 AND d.from_subdivision_id IS NULL "
        "AND l.price_kop IS NULL").fetchone()[0]
    return Check("Кожна партія має ціну", n == 0,
                 f"{n} приходних рядків без ціни")


def _folder_is_copyable(con) -> Check:
    """Після закриття поруч не має лишатися -wal: інакше копія теки неповна."""
    mode = con.execute("PRAGMA journal_mode").fetchone()[0]
    return Check("База в режимі WAL",
                 mode.lower() == "wal", f"journal_mode={mode}")


def _every_unit_has_an_inventory_number(con) -> Check:
    """Номер на кожній одиниці залишку — і рівно один на одиницю.

    Інвентарні номери видано на фізичні одиниці, тому їхня кількість має
    збігатися з контрольною сумою обліку. Розбіжність означає або пропущену
    позицію, або номер, виданий двічі.
    """
    stock = con.execute(
        "SELECT COALESCE(SUM(sign * qty_milli), 0) / 1000 FROM posting").fetchone()[0]
    numbered = con.execute(
        "SELECT COUNT(*) FROM instance WHERE inv_no IS NOT NULL").fetchone()[0]
    dup = con.execute(
        "SELECT COUNT(*) FROM (SELECT inv_no FROM instance WHERE inv_no IS NOT NULL "
        "GROUP BY inv_no HAVING COUNT(*) > 1)").fetchone()[0]
    return Check("Кожна одиниця має інвентарний номер", numbered == stock and dup == 0,
                 f"{numbered} {_plural(numbered, 'номер', 'номери', 'номерів')} на "
                 f"{stock} {_plural(stock, 'одиницю', 'одиниці', 'одиниць')}"
                 + (f", повторів {dup}" if dup else "")
                 + ("" if numbered >= stock or dup else ", нові одиниці ще без номера"),
                 advisory=not dup)


def _numbers_sit_where_the_property_is(con) -> Check:
    """Бирки там, де майно: у підрозділі номерів позиції не більше, ніж там її
    одиниць. Накладна кількістю номерів не називає — після неї номери лишаються
    у відправника, доки їх не перенесуть у програмі («Інвентарні номери», ⇄)."""
    bad = con.execute("""
        WITH num AS (SELECT i.nomen_id, a.subdivision_id AS sub, COUNT(*) AS n FROM instance i
                       JOIN instance_assignment a ON a.instance_id = i.id
                      WHERE i.inv_no IS NOT NULL GROUP BY 1, 2),
             bal AS (SELECT nomen_id, subdivision_id AS sub, SUM(sign * qty_milli) / 1000.0 AS q FROM posting
                      GROUP BY 1, 2)
        SELECT COUNT(*) FROM num LEFT JOIN bal ON bal.nomen_id = num.nomen_id AND bal.sub = num.sub
         WHERE num.n > COALESCE(bal.q, 0)""").fetchone()[0]
    return Check("Інвентарні номери там, де майно", bad == 0,
                 f"{bad} {_plural(bad, 'пара', 'пари', 'пар')} «позиція × підрозділ» з номерами понад майно",
                 advisory=True)


def _assignment_agrees_with_documents(con) -> Check:
    """Закріплення примірника не суперечить тому, що кажуть документи."""
    bad = con.execute("""
        SELECT COUNT(*) FROM instance i
          JOIN instance_assignment a ON a.instance_id = i.id
          JOIN subdivision s ON s.id = a.subdivision_id
         WHERE EXISTS (SELECT 1 FROM posting p WHERE p.instance_id = i.id)
           AND s.id <> (SELECT p.subdivision_id FROM posting p
                         WHERE p.instance_id = i.id
                         GROUP BY p.subdivision_id
                        HAVING SUM(p.sign * p.qty_milli) > 0 LIMIT 1)
        """).fetchone()[0]
    return Check("Закріплення примірників не суперечить документам", bad == 0,
                 f"{bad} суперечливих закріплень")


def _dates_have_full_years(con) -> Check:
    """Рік, набраний у полі дати не повністю (0026 замість 2026): така дата не діє на жоден
    документ, а призначення чи звання з нею «зникає». Нову програма не запише, давню — називає."""
    odd = "({c} < '1950' OR {c} >= '2101')"
    found = []
    for words, sql in (
            ("звання й посада", f"SELECT p.full_name, h.on_date FROM person_history h JOIN person p ON p.id = h.person_id "
                                f"WHERE {odd.format(c='h.on_date')}"),
            ("МВО", f"SELECT s.name, r.valid_from FROM responsible r JOIN subdivision s ON s.id = r.subdivision_id "
                    f"WHERE {odd.format(c='r.valid_from')} OR (r.valid_to IS NOT NULL AND {odd.format(c='r.valid_to')})"),
            ("командир", f"SELECT s.name, r.valid_from FROM commander r JOIN subdivision s ON s.id = r.subdivision_id "
                         f"WHERE {odd.format(c='r.valid_from')} OR (r.valid_to IS NOT NULL AND {odd.format(c='r.valid_to')})"),
            ("посадовець", f"SELECT r.role, r.valid_from FROM official r "
                           f"WHERE {odd.format(c='r.valid_from')} OR (r.valid_to IS NOT NULL AND {odd.format(c='r.valid_to')})"),
            ("штат", f"SELECT s.name, n.valid_from FROM norm n JOIN subdivision s ON s.id = n.subdivision_id "
                     f"WHERE (n.valid_from IS NOT NULL AND {odd.format(c='n.valid_from')}) "
                     f"OR (n.valid_to IS NOT NULL AND {odd.format(c='n.valid_to')})"),
            ("документ", f"SELECT d.number, d.doc_date FROM document d WHERE {odd.format(c='d.doc_date')}"),
            ("категорія стану", f"SELECT COALESCE(i.serial_no, i.chassis_no, i.inv_no, ''), c.on_date FROM instance_condition c "
                                f"JOIN instance i ON i.id = c.instance_id WHERE {odd.format(c='c.on_date')}")):
        try:
            rows = con.execute(sql).fetchall()
        except sqlite3.Error:
            continue                                   # таблиці чи графи в цій базі немає
        found += [f"{words} «{r[0]}» — {_ua(r[1]) if r[1] else '—'}" for r in rows]
    return Check("Дати мають повний рік", not found,
                 "; ".join(found[:4]) + (f" і ще {len(found) - 4}" if len(found) > 4 else "") if found
                 else "дат із роком поза 1950–2100 немає", advisory=True)


def check_all(con) -> list[Check]:
    return [_history_is_live(con),
            _outgoing_lines_name_their_batch(con), _instance_is_in_one_place(con),
            _norms_reach_the_nomenclature(con), _no_absolute_paths(con),
            _every_batch_has_a_price(con),
            _folder_is_copyable(con), _no_negative_balances(con),
            _every_unit_has_an_inventory_number(con),
            _numbers_sit_where_the_property_is(con),
            _assignment_agrees_with_documents(con), _dates_have_full_years(con)]


def migration_checks(con) -> list[Check]:
    """Перевірки переносу з книг служби — з файла поруч, якого в поставці немає. Зібрана
    програма його не має й не шукає: завантаження за шляхом, а не імпортом."""
    path = Path(__file__).with_name("verify_migration.py")
    if getattr(sys, "frozen", False) or not path.exists():
        return []
    import importlib.util                                     # noqa: PLC0415
    spec = importlib.util.spec_from_file_location("verify_migration", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod.check_all(con)


def main(argv=None) -> int:
    """Перевіряє базу, задану аргументом, інакше — робочу в «Дані обліку».

    Кореневу `oblik.sqlite` (свіжозібрану) перевіряти за замовчуванням не можна:
    програма працює не з нею, і після першої ж операції вони розходяться —
    перевірка сказала б «усе гаразд» не про ті дані. Її шлях лишається, але
    його треба назвати."""
    sys.stdout.reconfigure(encoding="utf-8")
    argv = sys.argv[1:] if argv is None else argv
    from db.paths import db_path                              # noqa: PLC0415
    path = Path(argv[0]) if argv else Path(db_path())
    if not path.exists():
        print(f"немає бази: {path}")
        return 1
    print(f"база: {path}")
    con = open_db(path, migrate=False)
    try:
        checks = check_all(con) + migration_checks(con)
    finally:
        close_db(con)
    for c in checks:
        print(f"  {'ok  ' if c.ok else 'note' if c.advisory else 'FAIL'}  {c.name}"
              + (f" — {c.detail}" if c.detail else ""))
    # Порада (нові одиниці ще без номерів) не робить перевірку проваленою.
    failed = [c for c in checks if not c.ok and not c.advisory]
    print("\n" + ("усі перевірки пройдено" if not failed
                  else f"провалено: {len(failed)}"))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
