# -*- coding: utf-8 -*-
"""Суха збірка бази зі спеки й сідів — перевірка, що вони сходяться.

Схема береться просто зі спеки: усі блоки ```sql із CREATE виконуються по
черзі в тимчасовій базі. Це тримає документ і код в одному стані — щойно в
спеці зʼявиться колонка, якої сід не знає (або навпаки), перевірка впаде тут,
а не під час першої справжньої міграції.

Довідники (одиниці виміру, групи, види документів) і номенклатура заводяться
мінімальним набором з extract.json: реальна міграція робить те саме, але тут
важливо не відтворити її, а дати сідам за що зачепитися.
"""
import os
import re
import io
import sys
import json
import sqlite3
import tempfile

sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
SPEC = os.path.join(ROOT, "docs", "superpowers", "specs",
                    "2026-09-10-sqlite-oblik-tz-design.md")
sys.path.insert(0, ROOT)
from db.sqlscript import statements          # noqa: E402

EXTRACT = os.path.join(HERE, "data", "extract.json")
SEEDS = ["subdivisions.sql", "unit.sql", "subdivision_titles.sql", "nomen_enrich.sql", "fes_codes.sql",
         "form21_lines.sql", "form21_map.sql", "form3_lines.sql", "form3_norms.sql",
         "destroyed.sql", "instances.sql", "persons_2025-12-25.sql",
         "people_2025-12-25.sql", "inventories_2022-2026.sql", "people_2026.sql"]

OPENING_DATE = "2022-02-24"




def schema_from_spec() -> list[str]:
    text = io.open(SPEC, encoding="utf-8").read()
    out = []
    for block in re.findall(r"```sql\n(.*?)```", text, re.S):
        if re.search(r"CREATE (TABLE|VIEW|INDEX|TRIGGER)", block):
            out += statements(block)
    return out


def seed_reference(db, D):
    for code in sorted({(it["unit"] or "шт") for it in D["items"]}
                       | {"шт", "кг", "к-т", "кн.", "пач", "рац.", "тис.шт", "л"}):
        db.execute("INSERT INTO uom(code, name) VALUES(?, ?)", (code, code))
    db.execute("INSERT INTO nomen_group(code, name) VALUES('21.09', 'Технічні засоби')")
    for code in ("бригада", "батальйон", "рота", "взвод/відділення", "склад", "служба"):
        db.execute("INSERT INTO subdivision_kind(code, name) VALUES(?, ?)", (code, code))
    db.execute("INSERT INTO doc_kind(code, name, affects_stock) "
               "VALUES('opening', 'Вхідний залишок', 1)")
    for it in D["items"]:
        db.execute(
            "INSERT INTO nomen(code, name, group_id, uom_id) VALUES(?, ?, "
            "(SELECT id FROM nomen_group WHERE code='21.09'), "
            "(SELECT id FROM uom WHERE code=?))",
            (str(it["code"]), it["name"], it["unit"] or "шт"))


def main() -> int:
    D = json.load(open(EXTRACT, encoding="utf-8"))
    path = os.path.join(tempfile.gettempdir(), "oblik_seed_check.db")
    if os.path.exists(path):
        os.remove(path)
    db = sqlite3.connect(path)
    db.execute("PRAGMA foreign_keys=ON")

    problems = []
    ddl = schema_from_spec()
    for st in ddl:
        try:
            db.execute(st)
        except sqlite3.Error as e:
            problems.append(f"схема: {e} || {st.splitlines()[0][:70]}")
    print(f"схема зі спеки: {len(ddl)} операторів, помилок {len(problems)}")

    seed_reference(db, D)
    db.commit()

    for name in SEEDS:
        ok = err = 0
        for st in statements(io.open(os.path.join(ROOT, "db", "seed", name),
                                     encoding="utf-8").read()):
            try:
                db.execute(st)
                ok += 1
            except sqlite3.Error as e:
                err += 1
                problems.append(f"{name}: {e} || {st[:90]}")
        db.commit()
        print(f"  {name:28} {ok:>5} операторів, помилок {err}")

    q = db.execute
    one = lambda sql: q(sql).fetchone()[0]                       # noqa: E731

    print()
    print(f"  підрозділів {one('SELECT COUNT(*) FROM subdivision')}"
          f" | псевдонімів {one('SELECT COUNT(*) FROM subdivision_alias')}"
          f" | номенклатури {one('SELECT COUNT(*) FROM nomen')}")
    print(f"  документів {one('SELECT COUNT(*) FROM document')}"
          f" | рядків {one('SELECT COUNT(*) FROM document_line')}"
          f" | екземплярів {one('SELECT COUNT(*) FROM instance')}")
    print(f"  табельних рядків {one('SELECT COUNT(*) FROM report_line')}"
          f" | привʼязок {one('SELECT COUNT(*) FROM nomen_report_line')}"
          f" | норм {one('SELECT COUNT(*) FROM norm')}")
    print(f"  одиниць у вхідному залишку "
          f"{one('SELECT SUM(qty_milli) FROM document_line') / 1000:g}")

    checks = [
        ("рядків без кількості",
         "SELECT COUNT(*) FROM document_line WHERE qty_milli <= 0", 0),
        # Сіди більше не містять вхідного сальдо: єдині документи тут — рапорти
        # про знищення, і в них є лише сторона, що втратила майно.
        ("документів раніше за дату відліку",
         f"SELECT COUNT(*) FROM document WHERE doc_date < '{OPENING_DATE}'", 0),
        ("документів без жодної сторони",
         "SELECT COUNT(*) FROM document "
         "WHERE from_subdivision_id IS NULL AND to_subdivision_id IS NULL", 0),
        ("рядків без позиції номенклатури",
         "SELECT COUNT(*) FROM document_line WHERE nomen_id IS NULL", 0),
        ("норм без табельного рядка й без коду",
         "SELECT COUNT(*) FROM norm WHERE nomen_id IS NULL AND report_line_id IS NULL", 0),
        # Примірник має бути чимось названий. Зазвичай це заводський номер, але
        # причіп-цистерна ЦВ-1,2 його не має взагалі — у книгах служби вона
        # значиться «б/н, шасі №…», і номер шасі й є її іменем.
        ("екземплярів без жодного номера",
         "SELECT COUNT(*) FROM instance "
         "WHERE serial_no IS NULL AND chassis_no IS NULL AND inv_no IS NULL", 0),
        ("категорій стану без екземпляра",
         "SELECT COUNT(*) FROM instance_condition c WHERE NOT EXISTS "
         "(SELECT 1 FROM instance i WHERE i.id = c.instance_id)", 0),
        ("підрозділів без батька, крім кореня",
         "SELECT COUNT(*) - 1 FROM subdivision WHERE parent_id IS NULL", 0),
        ("псевдонімів, що вказують у нікуди",
         "SELECT COUNT(*) FROM subdivision_alias a WHERE NOT EXISTS "
         "(SELECT 1 FROM subdivision s WHERE s.id = a.subdivision_id)", 0),
    ]
    print()
    for label, sql, want in checks:
        got = one(sql)
        mark = "OK  " if got == want else "ЗБІЙ"
        if got != want:
            problems.append(f"{label}: {got}, очікували {want}")
        print(f"  {mark} {label:44} {got}")

    print()
    print("  забезпеченість за табелем 21/Прод (лише рядки зі штатом):")
    for name, need, have in q("""
        SELECT rl.name,
               COALESCE((SELECT SUM(qty_milli) / 1000 FROM norm n
                         WHERE n.report_line_id = rl.id), 0),
               COALESCE((SELECT SUM(l.qty_milli) / 1000.0 FROM document_line l
                         JOIN nomen_report_line m ON m.nomen_id = l.nomen_id
                         WHERE m.report_line_id = rl.id), 0)
        FROM report_line rl
        WHERE EXISTS (SELECT 1 FROM norm n WHERE n.report_line_id = rl.id)
        ORDER BY rl.sort"""):
        gap = have - need
        print(f"    {name[:42]:42} штат {need:>5}  наявно {have:>6,.0f}  "
              f"{gap:>+7,.0f}".replace(",", " "))

    db.close()
    os.remove(path)                      # тимчасова база не лишається в %TEMP%
    print()
    if problems:
        print(f"ПРОБЛЕМИ: {len(problems)}")
        for p in problems:
            print(f"  {p}")
        return 1
    print("усе сходиться")
    return 0


if __name__ == "__main__":
    sys.exit(main())
