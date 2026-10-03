# -*- coding: utf-8 -*-
"""Перенесення «Облік ТЗ 3.0» у базу — уся історія з 24.02.2022.

Дата відліку — 24.02.2022, і на неї в частині немає нічого: облік починається з
першого документа служби, акта приймання з типом «Перенос залишків». Тому
вхідного сальдо як окремого документа немає взагалі — його роль грає той самий
перший акт, який служба й склала.

Наслідок: усі рядки журналів 3.0 — справжні документи, що рухають залишок.
Кожне вибуття мусить назвати партію, з якої майно пішло. У 3.0 партій немає, тому
вони підбираються за фактичною наявністю в підрозділі на дату документа, від
найдавнішої. Вибір однозначний скрізь, де в підрозділі лежить одна партія
позиції; решта потрапляє у звіт поіменно.

Вивантаження ФЕС при цьому не зникають: вони лишаються перевіркою. Якщо облік
служби ведеться правильно, він мусить відтворити знімок ФЕС на будь-яку дату —
і `build/check_history.py` це перевіряє.
"""
import json
import shutil
import re
import sys
from collections import defaultdict
from dataclasses import dataclass, field
from pathlib import Path

# db лежить у корені проєкту, а model/export_app_data — тут, у build:
# на шляху потрібні обидві теки.
ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "build")]

from db.connect import open_db, close_db
from db.sqlscript import statements          # noqa: E402
import model as M                                 # noqa: E402
from nomen_groups import GROUPS, FALLBACK, group_of   # noqa: E402

OPENING_DATE = "2022-02-24"
SEED_DIR = ROOT / "db" / "seed"
RULES_DIR = ROOT / "db" / "rules"
REGISTER = Path(__file__).parent / "data" / "register.json"

# Перевірено: внесення цих накладних подвоює вже враховані одиниці й ламає
# збіг із ФЕС. Прапорець лишається, щоб перевірку можна було повторити.
ADD_MISSING_INVOICES = False

# Порядок значущий: псевдоніми підрозділів потрібні вхідним залишкам, щоб
# розвʼязати ярлики 1С; табельні рядки форми створюються разом із нормами.
# Штат частини за 3/Прод і підпис під бланком 2/Прод лежать окремо від переліків
# форм: переліки їдуть у дистрибутив, а це — дані частини.
SEEDS = ["unit.sql", "subdivision_titles.sql", "nomen_enrich.sql", "fes_codes.sql",
         "form21_lines.sql", "form21_map.sql", "form3_lines.sql", "form3_norms.sql",
         "form2_lines.sql", "form2_sign.sql", "destroyed.sql", "instances.sql", "persons_2025-12-25.sql",
         "people_2025-12-25.sql", "inventories_2022-2026.sql", "people_2026.sql"]

# Інвентарні номери видані на залишок, тому їх заводять останніми: до кінця
# перенесення залишку ще немає. Фото й паспорти майна — після сканів приходів:
# файл, уже підшитий до документа, вдруге не кріпиться.
LATE_SEEDS = ["inventory.sql", "attachments.sql", "files.sql", "reconciliations.sql"]

DOC_KINDS = [
    ("arch_in", "Архів: прибуток", 0),
    ("arch_move", "Архів: переміщення", 0),
    ("arch_off", "Архів: списання", 0),
    ("opening", "Перенесення залишків", 1),
    ("act_in", "Акт приймання", 1),
    ("invoice", "Накладна", 1),
    ("writeoff", "Акт списання", 1),
    ("report_destroyed", "Рапорт про знищення", 0),
    ("tech_state", "Акт технічного стану", 0),
]


@dataclass
class MigrationReport:
    nomen: int = 0
    subdivisions: int = 0
    documents: int = 0
    lines: int = 0
    counterparties: int = 0
    instances: int = 0
    merged_codes: dict = field(default_factory=dict)
    ambiguous_batches: list = field(default_factory=list)
    no_batch: list = field(default_factory=list)
    moved_route: list = field(default_factory=list)
    short: list = field(default_factory=list)
    negative: list = field(default_factory=list)
    date_fixes: list = field(default_factory=list)
    instance_lines: list = field(default_factory=list)
    instance_bound: int = 0
    grouped_by_form: int = 0
    destroyed_linked: list = field(default_factory=list)
    added_invoices: list = field(default_factory=list)
    skipped_invoices: list = field(default_factory=list)
    warnings: list = field(default_factory=list)


def _doc_key(no) -> str:
    return str(no or "").strip().lstrip("№").replace(" ", "").upper()


def _apply_register(D, rep) -> dict:
    """Правки з «Реєстру техзасобів»: справжні дати документів і первинка.

    У журналах 3.0 частина старих документів датована днем, коли рядок
    вводили, а не днем документа: накладна стоїть під датою внесення, яка
    буває вже наступного року. Реєстр веде первинку й дає справжню дату.
    Виправляються лише ті, де рік у журналі суперечить реєстру — розбіжність
    у кілька днів усередині року лишається як є.
    """
    if not REGISTER.exists():
        rep.warnings.append("немає build/data/register.json — правок не внесено")
        return {}
    reg = json.loads(REGISTER.read_text(encoding="utf-8"))
    fixes = reg.get("date_fixes", {})
    changed = 0
    for j in ("incoming", "movement", "writeoffs"):
        for r in D[j]:
            new = fixes.get(_doc_key(r["doc_no"]))
            if new and new != r["date"]:
                rep.date_fixes.append((str(r["doc_no"]), r["date"], new))
                r["date"] = new
                changed += 1
    added = _add_missing_invoices(D, reg, rep)
    if changed or added:
        for j in ("incoming", "movement", "writeoffs"):
            D[j].sort(key=lambda r: r["date"])
    return reg


def _add_missing_invoices(D, reg, rep) -> int:
    """Первинні накладні, номерів яких у журналах 3.0 немає — і чому їх не вносимо.

    Спокуса очевидна: справжні документи з номером, датою, цінами й підписами,
    а в книзі їх немає. Але внесення перевірено, і воно ламає все: контрольна
    сума обліку, підсумок на дату знімка ФЕС і кількість термосів зростають
    рівно на одиниці цих накладних, а в термосах ТВН-12 і ТН-36 з'являються
    мінусові залишки.

    Висновок один: це не пропущені рухи, а ті самі рухи під іншими номерами.
    Служба виписала накладну, потім переоформила її, а в книгу пішов лише один
    з двох номерів. Тому вони лишаються у звіті як перелік паперів, що не мають
    пари в книзі, — це предмет для розбору, а не для автоматичного внесення.
    """
    added = 0
    if not ADD_MISSING_INVOICES:
        for m in reg.get("invoices_missing_from_journals", []):
            rep.skipped_invoices.append((m["number"], m["date"], m.get("receiver"),
                                         len(m.get("lines", []))))
        return 0
    # Куди відпущено: у накладній стоїть номер в/ч, у журналах — назва підрозділу
    # того часу. Обидві ведуть в одне дерево через історію назв. Номери частин —
    # дані частини, тож відповідність лежить у build/data, а не тут.
    receivers = _load_map("invoice_receivers.json")
    for m in reg.get("invoices_missing_from_journals", []):
        who = receivers.get(str(m.get("receiver", "")).strip())
        if not who or not m.get("lines"):
            rep.skipped_invoices.append((m["number"], m["date"], m.get("receiver"),
                                         len(m.get("lines", []))))
            continue
        for line in m["lines"]:
            D["movement"].append({
                "row": 0, "doc_type": "Накладна", "date": m["date"],
                "doc_no": m["number"], "src": "склад", "dst": who,
                "code": int(line["code"]), "qty": line["qty"],
                "note": "первинна накладна, у книзі 3.0 відсутня", "flag": ""})
            added += 1
        rep.added_invoices.append((m["number"], m["date"], who, len(m["lines"])))
    return added


def _instance_keys():
    """Код 3.0 -> як шукати екземпляр: заводський номер або номер шасі.

    У 3.0 кожна кухня мала власний код номенклатури, але без номера. Зв'язку
    «код → номер» виведено з документів у `make_appendix46_data.py`, і саме вона
    дозволяє поставити екземпляр у рядок документа: інакше після згортання
    кодів усі кухні стають однією позицією й розрізнити їх нічим.
    """
    app = _load_map("appendix46.json")
    inst = app.get("instances", {})
    out = {}
    for code, key in app.get("code_serial", {}).items():
        r = inst.get(key, {})
        out[str(code)] = (r.get("serial") or "", r.get("chassis") or "")
    return out


def _bind_instances(con, rep):
    """Проставляє екземпляр у рядках, де відомо, який саме примірник рухався."""
    for line_id, (serial, chassis) in rep.instance_lines:
        if serial:
            row = con.execute("SELECT id FROM instance WHERE serial_no = ?",
                              (serial,)).fetchone()
        else:
            row = con.execute("SELECT id FROM instance WHERE serial_no IS NULL "
                              "AND chassis_no = ?", (chassis,)).fetchone()
        if row:
            con.execute("UPDATE document_line SET instance_id = ? WHERE id = ?",
                        (row[0], line_id))
            rep.instance_bound += 1
    rep.instance_lines.clear()


def _load_map(name):
    p = Path(__file__).parent / "data" / name
    return json.loads(p.read_text(encoding="utf-8")) if p.exists() else {}




def migrate(extract_path, db_path) -> MigrationReport:
    D = json.loads(Path(extract_path).read_text(encoding="utf-8"))
    rep = MigrationReport()
    con = open_db(Path(db_path))
    try:
        if con.execute("SELECT COUNT(*) FROM nomen").fetchone()[0]:
            raise SystemExit(
                f"У базі вже є дані: {db_path}\n"
                "Перенесення виконується один раз на порожню базу — "
                "видаліть файл або вкажіть інший.")
        reg = _apply_register(D, rep)
        DOC_META.update(reg.get("doc_meta", {}))
        _seed_lookups(con)
        subs = _load_subdivisions(con, D, rep)
        nomen = _load_nomen(con, D, rep)
        cps = _load_counterparties(con, D, rep)
        price_of = {it["code"]: int(round(float(it["price"]) * 100))
                    for it in D["items"] if it.get("price")}
        archive, live = _split_by_date(D, rep)
        keys = _instance_keys()
        _load_archive(con, archive, subs, nomen, cps, rep, keys)
        _apply_seed(con, rep)
        _group_by_report_lines(con, rep)
        _bind_instances(con, rep)
        _load_live(con, live, subs, nomen, cps, rep, price_of, keys)
        _apply_seed(con, rep, LATE_SEEDS)
        _apply_rules(con)
        # Звірка з 3.0 бере на облік майно інших служб — позиції й вузли рахуємо після неї.
        rep.nomen = con.execute("SELECT COUNT(*) FROM nomen").fetchone()[0]
        rep.subdivisions = con.execute("SELECT COUNT(*) FROM subdivision").fetchone()[0]
        _link_destroyed_to_writeoffs(con, rep)
        _collect_negatives(con, rep)
        con.commit()
    finally:
        close_db(con)
    return rep


# Виправлення обліку частини з `db/seed/`, за рішеннями власника. Звірка з 3.0 —
# остання: наприкінці вона розставляє інвентарні номери за документами.
CORRECTIONS = [
    "battery_rename.sql",      # перейменування підрозділу, решта виправлень — уже за новою назвою
    "grunhelm_vestar.sql",     # холодильники GRUNHELM і Vestar — у тих ВМТЗ, що й у ФЕС
    "grifon_card.sql",         # морозильна скриня Grifon — одна картка, з номером ФЕС
    "thermos_return.sql",      # термоси, повернені на склад у серпні 2025: 3, а не 4
    "losses_jul_aug_2026.sql", # рапорти про втрату, зареєстровані в липні–серпні 2026 року
    "loss_reports.sql",        # рапорти про знищення до двох списань втрат
    "fama_writeoff.sql",       # фритюрниця у витягу про списання, де книга мала 0
    "journals_3_0.sql",        # дати копій, рядки, яких бракувало, рапорти, майно інших служб
    "report_23503_split.sql",  # рапорт 23503: другий водонагрівач був на складі, не в роті
    "report_22509_1.sql",      # рапорт 22509/1: 4 термоси ТВН-12 у ВМТЗ 2 б ТрО, без списання
    "price_codes.sql",         # інша ціна — інший код: згорнуті коди з різними цінами знову окремі
    "fes_numbers_2026_09_28.sql",  # номери ФЕС позиціям без номера й нові назви місць ФЕС (28.09.2026)
]


def _apply_rules(con):
    """Правила над даними після наповнення: вид обліку за кодом ФЕС і майно
    батальйону за його їдальнею (`db/rules/`), а тоді виправлення обліку частини
    (`CORRECTIONS`)."""
    for path in (RULES_DIR / "asset_class.sql", RULES_DIR / "battalion_hall.sql",
                 *(SEED_DIR / name for name in CORRECTIONS)):
        con.executescript(path.read_text(encoding="utf-8"))


def _seed_lookups(con):
    for i, u in enumerate(M.LIST_UOM, 1):
        con.execute("INSERT INTO uom(id, code, name) VALUES (?,?,?)", (i, u, u))
    for i, (code, name, _) in enumerate(GROUPS, 1):
        con.execute("INSERT INTO nomen_group(id, code, name, sort) VALUES (?,?,?,?)",
                    (i, code, name, i * 10))
    con.execute("INSERT INTO nomen_group(code, name, sort) VALUES (?,?,999)", FALLBACK)
    for i, k in enumerate(M.LIST_SUB_TYPE, 1):
        con.execute("INSERT INTO subdivision_kind(id, code, name) VALUES (?,?,?)", (i, k, k))
    for i, k in enumerate(M.LIST_PLACE_TYPE, 1):
        con.execute("INSERT INTO place_kind(id, code, name) VALUES (?,?,?)", (i, k, k))
    for i, k in enumerate(("військова частина", "постачальник", "фонд", "інше"), 1):
        con.execute("INSERT INTO counterparty_kind(id, code, name) VALUES (?,?,?)", (i, k, k))
    for i, k in enumerate(("підстава", "списання за рапортом"), 1):
        con.execute("INSERT INTO doc_link_kind(id, code, name) VALUES (?,?,?)", (i, k, k))
    for i, (code, name, affects) in enumerate(DOC_KINDS, 1):
        con.execute("INSERT INTO doc_kind(id, code, name, affects_stock) VALUES (?,?,?,?)",
                    (i, code, name, affects))


def _load_subdivisions(con, D, rep):
    """Дерево береться з seed, а не будується з назв у журналах.

    Назви в 3.0 не є ключем: «6Б ВМТЗ» і «2 б ВМТЗ ранее 6» — одна одиниця в
    різні роки. Тому кожна назва з журналів розв'язується через історію назв.
    """
    for st in statements((SEED_DIR / "subdivisions.sql").read_text(encoding="utf-8")):
        con.execute(st)
    ids = {}
    for name in sorted(D["units"]):
        row = con.execute(
            "SELECT s.id FROM subdivision_alias a JOIN subdivision s ON s.id = a.subdivision_id "
            "WHERE a.name = ?", (name,)).fetchone()
        if row is None:
            row = con.execute("SELECT id FROM subdivision WHERE name = ?", (name,)).fetchone()
        if row is None:
            rep.warnings.append(f"назва підрозділу без відповідності: {name}")
            continue
        ids[name] = row[0]
    rep.subdivisions = con.execute("SELECT COUNT(*) FROM subdivision").fetchone()[0]
    return ids


def _load_nomen(con, D, rep):
    merge = _load_map("nomen_merge.json")
    into = {int(dup): int(keep) for keep, dups in merge.items() for dup in dups}
    rep.merged_codes = merge
    uom_id = {r["code"]: r["id"] for r in con.execute("SELECT id, code FROM uom")}
    grp_id = {r["code"]: r["id"] for r in con.execute("SELECT id, code FROM nomen_group")}
    ids = {}
    for it in D["items"]:
        if it["code"] in into:
            continue                     # згорнеться в основну позицію нижче
        if not (it["name"] or "").strip():
            # У 3.0 є зарезервовані рядки без назви й ціни. Позиція без назви
            # нічого не означає ні в описі, ні у звіті.
            rep.warnings.append(f"позиція {it['code']} без назви — не перенесено")
            continue
        gc, _ = group_of(it["name"])
        cur = con.execute(
            "INSERT INTO nomen(code, name, group_id, uom_id, tracking, is_fixed_asset, note) "
            "VALUES (?,?,?,?,?,?,?) RETURNING id",
            (str(it["code"]), it["name"], grp_id[gc], uom_id[it["unit"]],
             "qty", int(it["nonrev"] or 0), it["note"] or None))
        ids[it["code"]] = cur.fetchone()[0]
    for dup, keep in into.items():
        ids[dup] = ids[keep]
        con.execute("UPDATE nomen SET old_code = COALESCE(old_code || ',', '') || ? "
                    "WHERE id = ?", (str(dup), ids[keep]))
    rep.nomen = con.execute("SELECT COUNT(*) FROM nomen").fetchone()[0]
    return ids


def _load_counterparties(con, D, rep):
    names = sorted({r["src"] for r in D["incoming"] if r["src"]})
    canon = _load_map("counterparty_map.json")
    ids = {}
    for n in names:
        display = canon.get(n, n)
        if display not in ids:
            cur = con.execute(
                "INSERT INTO counterparty(name, kind_id) VALUES (?,4) RETURNING id", (display,))
            ids[display] = cur.fetchone()[0]
        ids[n] = ids[display]
        if n not in canon:
            rep.warnings.append(f"контрагент без звірки написання: {n}")
    rep.counterparties = con.execute("SELECT COUNT(*) FROM counterparty").fetchone()[0]
    return ids


def _group(rows_in, rows_mv, rows_wr):
    """Рядки 3.0 дублюють шапку; тут вони збираються назад у документи."""
    groups = defaultdict(list)
    for r in rows_in:
        groups[("in", r["doc_type"], r["doc_no"], r["date"], None, r["dst"])].append(r)
    for r in rows_mv:
        groups[("mv", r["doc_type"], r["doc_no"], r["date"], r["src"], r["dst"])].append(r)
    for r in rows_wr:
        groups[("wr", r["doc_type"], r["doc_no"], r["date"], r["unit"], None)].append(r)
    return groups


def _split_by_date(D, rep):
    """Рядки без кількості до бази не потрапляють.

    У 3.0 такі рядки є: код і дата проставлені, кількість — ні. Витяг їх
    навмисно зберігає з нулем і позначкою, щоб вони не зникли тихо; сюди вони
    пройти не можуть, бо рядок документа без кількості нічого не означає.
    """
    dropped = [r for j in ("incoming", "movement", "writeoffs") for r in D[j]
               if not r["qty"]]
    for r in dropped:
        rep.warnings.append(
            f"{r['date']} №{r['doc_no']}: рядок без кількості, код {r['code']} — пропущено")

    def part(journal, keep_early):
        return [r for r in D[journal]
                if r["qty"] and (r["date"] <= OPENING_DATE) == keep_early]
    archive = _group(part("incoming", True), part("movement", True), part("writeoffs", True))
    live = _group(part("incoming", False), part("movement", False), part("writeoffs", False))
    return archive, live


DOC_META = {}


def _insert_document(con, kind_id, src, no, date, dtype, frm, to, cp):
    meta = DOC_META.get(_doc_key(no))
    note = None
    if meta and meta.get("proof"):
        # Який саме примірник документа є на руках — оригінал, копія чи фото.
        # Це перше, що спитають, коли за документ доведеться відповідати.
        note = f"первинка: {meta['proof']}"
    # Вид самого паперу («Накладна», «Атестат», «Витяг із наказу») — у своїй
    # колонці, як і для внесеного в програмі: застосунок читає його звідти.
    cur = con.execute(
        "INSERT INTO document(kind_id, number, doc_date, counterparty_id, "
        "from_subdivision_id, to_subdivision_id, paper, note) VALUES (?,?,?,?,?,?,?,?) RETURNING id",
        (kind_id, no or "б/н", date, cp, frm, to, dtype or None, note))
    return cur.fetchone()[0]


def _load_archive(con, groups, subs, nomen, cps, rep, keys=None):
    kind_id = {r["code"]: r["id"] for r in con.execute("SELECT id, code FROM doc_kind")}
    arch = {"in": kind_id["arch_in"], "mv": kind_id["arch_move"], "wr": kind_id["arch_off"]}
    # Усередині одного дня прихід іде першим, потім переміщення, потім
    # списання: інакше видача тим самим числом шукає партію, якої ще немає.
    # Це вилізло, щойно реєстр повернув старим документам справжні дати.
    order = {"in": 0, "mv": 1, "wr": 2}
    for (src, dtype, no, date, frm, to), rows in sorted(
            groups.items(),
            key=lambda g: (g[0][3], order[g[0][0]], str(g[0][2]))):
        doc_id = _insert_document(
            con, arch[src], src, no, date, dtype, subs.get(frm), subs.get(to),
            cps.get(rows[0].get("src")) if src == "in" else None)
        rep.documents += 1
        for i, r in enumerate(rows, 1):
            cur = con.execute(
                "INSERT INTO document_line(document_id, line_no, nomen_id, qty_milli, note) "
                "VALUES (?,?,?,?,?) RETURNING id",
                (doc_id, i, nomen[r["code"]], int(round(r["qty"] * 1000)),
                 r.get("note") or r.get("flag") or None))
            line_id = cur.fetchone()[0]
            rep.lines += 1
            # Екземпляри ще не заведено — довідник іде наступним кроком, тому
            # прив'язка відкладається до `_bind_instances`.
            if keys and str(r["code"]) in keys:
                rep.instance_lines.append((line_id, keys[str(r["code"])]))


def _collect_negatives(con, rep):
    """Мінусовий залишок — завжди наслідок відкинутого рядка.

    Якщо надходження не перенеслося (у відправника за опорними даними позиції
    немає), то наступне вибуття з одержувача провалюється в мінус. Такий стан
    не приховується: це саме те, що має розглянути начальник служби.
    """
    rep.negative = [
        (r["code"], r["name"], r["sub"], r["qty"] / 1000)
        for r in con.execute("""
            SELECT n.code, n.name, s.name AS sub, SUM(p.sign * p.qty_milli) AS qty
            FROM posting p
            JOIN nomen n ON n.id = p.nomen_id
            JOIN subdivision s ON s.id = p.subdivision_id
            GROUP BY 1, 2, 3 HAVING SUM(p.sign * p.qty_milli) < 0""")]


def _apply_seed(con, rep, names=None):
    """Сіди виписані літералами й зіставлені заздалегідь.

    Виконуємо після архіву: вони шукають підрозділи й номенклатуру за назвою та
    кодом, тому ті мають уже існувати; і до живих рухів, бо саме вони створюють
    партії, з яких ті рухи списують.
    """
    for name in (names or SEEDS):
        path = SEED_DIR / name
        if not path.exists():
            rep.warnings.append(f"сіду немає: {name}")
            continue
        for st in statements(path.read_text(encoding="utf-8")):
            con.execute(st)
    rep.instances = con.execute("SELECT COUNT(*) FROM instance").fetchone()[0]
    # Сід заводить позиції, яких у службі не було, тому рахуємо ще раз.
    rep.nomen = con.execute("SELECT COUNT(*) FROM nomen").fetchone()[0]


def _link_destroyed_to_writeoffs(con, rep):
    """Зв'язує рапорт про знищення з документом, яким це знищене списали.

    Рапорт сам по собі залишків не рухає: майно числиться, доки не пройде
    списання — актом або наказом. Зв'язку між ними в журналах служби немає —
    списання оформлено окремим папером, — але її однозначно видно з чисел:
    пізніший витяг із наказу списує з того самого підрозділу ті самі одиниці,
    що й рапорт.

    Правило свідомо вузьке: той самий підрозділ, списання пізніше за рапорт,
    підсумок збігається до одиниці й більшість рядків — ті самі позиції. Інакше
    зв'язок не ставиться: краще показати знищене як несписане, ніж приписати
    йому чужий документ.
    """
    def lines(doc_id):
        return {r["nomen_id"]: r["q"] for r in con.execute(
            "SELECT nomen_id, SUM(qty_milli) AS q FROM document_line "
            "WHERE document_id = ? GROUP BY nomen_id", (doc_id,))}

    reports = con.execute("""
        SELECT d.id, d.doc_date, d.from_subdivision_id AS sub,
               (SELECT SUM(qty_milli) FROM document_line l WHERE l.document_id = d.id) AS total
          FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE k.code = 'report_destroyed'
           -- уже пов'язаний рапорт (звірка з 3.0 заводить такі разом зі списанням)
           AND NOT EXISTS (SELECT 1 FROM document_link x WHERE x.from_document_id = d.id)""").fetchall()
    acts = con.execute("""
        SELECT d.id, d.doc_date, d.from_subdivision_id AS sub, d.number,
               (SELECT SUM(qty_milli) FROM document_line l WHERE l.document_id = d.id) AS total
          FROM document d JOIN doc_kind k ON k.id = d.kind_id
         WHERE k.code = 'writeoff'""").fetchall()
    kind = con.execute("SELECT id FROM doc_link_kind WHERE code = 'списання за рапортом'"
                       ).fetchone()
    if not kind:
        return
    for r in reports:
        rl = lines(r["id"])
        for a in acts:
            if a["sub"] != r["sub"] or a["doc_date"] <= r["doc_date"]:
                continue
            al = lines(a["id"])
            same = sum(1 for n, q in rl.items() if al.get(n) == q)
            covered = sum(q for n, q in rl.items() if al.get(n, 0) >= q)
            # Списання має покривати рапорт майже повністю: дев'ять десятих
            # кількості й дві третини позицій.
            if covered * 10 < r["total"] * 9 or same * 3 < len(rl) * 2:
                continue
            con.execute("INSERT INTO document_link(from_document_id, to_document_id, "
                        "kind_id, note) VALUES (?,?,?,?)",
                        (r["id"], a["id"], kind[0],
                         f"списання покриває {covered / 1000:g} із {r['total'] / 1000:g} од "
                         f"рапорту, {same} із {len(rl)} позицій збігається"))
            rep.destroyed_linked.append((r["doc_date"], a["number"], r["total"] / 1000))
            break


def _group_by_report_lines(con, rep):
    """Розділ бланка важить більше за здогад по назві.

    Групи — це розділи форми 21/Прод, і там, де служба сама прив'язала позицію
    до табельного рядка, розділ береться звідти. Пароконвектомат за словником
    схожий на плиту, але в бланку він стоїть серед кухонь переносних — і в звіті
    він саме там, тому й у довіднику має бути там.
    """
    n = con.execute("""
        UPDATE nomen SET group_id = (
          SELECT g.id FROM nomen_report_line m
            JOIN report_line rl ON rl.id = m.report_line_id
            JOIN report_form f ON f.id = rl.form_id AND f.code = '21/Прод'
            JOIN nomen_group g ON g.name = rl.section
           WHERE m.nomen_id = nomen.id AND rl.section IS NOT NULL
           LIMIT 1)
        WHERE EXISTS (
          SELECT 1 FROM nomen_report_line m
            JOIN report_line rl ON rl.id = m.report_line_id
            JOIN report_form f ON f.id = rl.form_id AND f.code = '21/Прод'
            JOIN nomen_group g ON g.name = rl.section
           WHERE m.nomen_id = nomen.id AND rl.section IS NOT NULL)""").rowcount
    rep.grouped_by_form = n


def _known_instance(con, keys, code, rep):
    """Екземпляр, відомий із книг служби за кодом 3.0."""
    if not keys or str(code) not in keys:
        return None
    serial, chassis = keys[str(code)]
    if serial:
        row = con.execute("SELECT id FROM instance WHERE serial_no = ?",
                          (serial,)).fetchone()
    else:
        row = con.execute("SELECT id FROM instance WHERE serial_no IS NULL "
                          "AND chassis_no = ?", (chassis,)).fetchone()
    if row:
        rep.instance_bound += 1
        return row[0]
    return None


def _lots(con, as_of):
    """{(підрозділ, позиція): [(дата, id партії, залишок)]} — від найдавнішої."""
    rows = con.execute("""
        SELECT p.subdivision_id, p.nomen_id, p.batch_line_id,
               SUM(p.sign * p.qty_milli) AS qty, MIN(b.doc_date) AS since
        FROM posting p JOIN batch b ON b.batch_line_id = p.batch_line_id
        WHERE p.doc_date <= ?
        GROUP BY p.subdivision_id, p.nomen_id, p.batch_line_id
        HAVING SUM(p.sign * p.qty_milli) > 0""", (as_of,)).fetchall()
    out = defaultdict(list)
    for r in rows:
        out[(r["subdivision_id"], r["nomen_id"])].append(
            [r["since"], r["batch_line_id"], r["qty"]])
    for v in out.values():
        v.sort(key=lambda x: (x[0], x[1]))
    return out


def _instance_lots(con, subdivision_id, nomen_id, as_of):
    """{екземпляр: партія} — на якій партії стоїть кожен примірник підрозділу.

    Партії однієї позиції рівноцінні лише доти, доки одиниці знеособлені. Щойно
    кухню відомо за заводським номером, її не можна списати з партії сусідньої
    кухні: інакше в описі вилізе мінус на одному примірнику й надлишок на іншому.
    """
    return {r["instance_id"]: r["batch_line_id"] for r in con.execute("""
        SELECT p.instance_id, p.batch_line_id, SUM(p.sign * p.qty_milli) AS qty
        FROM posting p
        WHERE p.doc_date <= ? AND p.subdivision_id = ? AND p.nomen_id = ?
          AND p.instance_id IS NOT NULL
        GROUP BY p.instance_id, p.batch_line_id
        HAVING SUM(p.sign * p.qty_milli) > 0""", (as_of, subdivision_id, nomen_id))}


def _free_instances(con, subdivision_id, nomen_id, as_of):
    """Екземпляри цієї позиції, що на дату числяться в цьому підрозділі."""
    return [r["instance_id"] for r in con.execute("""
        SELECT p.instance_id, SUM(p.sign * p.qty_milli) AS qty
        FROM posting p
        WHERE p.doc_date <= ? AND p.subdivision_id = ? AND p.nomen_id = ?
          AND p.instance_id IS NOT NULL
        GROUP BY p.instance_id HAVING SUM(p.sign * p.qty_milli) > 0
        ORDER BY p.instance_id""", (as_of, subdivision_id, nomen_id))]


def _holder(con, date, subdivision_id, nomen_id, lots):
    """Хто насправді тримає позицію: сам підрозділ або хтось із підлеглих.

    Служба списує з батальйону, а ФЕС числить те саме майно за його ВМТЗ чи
    їдальнею. Це не суперечність — ВМТЗ усередині батальйону, — але провести
    вибуття з порожнього вузла не можна: залишок пішов би в мінус, а в
    підлеглого лишився б назавжди. Тому шукаємо фактичного утримувача.
    """
    if lots.get((subdivision_id, nomen_id)):
        return subdivision_id
    kids = [r[0] for r in con.execute(
        "SELECT descendant_id FROM subdivision_tree WHERE ancestor_id = ? AND depth > 0",
        (subdivision_id,))]
    best, best_qty = None, 0
    for k in kids:
        qty = sum(lot[2] for lot in lots.get((k, nomen_id), []))
        if qty > best_qty:
            best, best_qty = k, qty
    return best


def _load_live(con, groups, subs, nomen, cps, rep, price_of=None, keys=None):
    # Ціна в 3.0 лежить на позиції номенклатури, а не в рядку прибутку — саме
    # там її веде служба. Для надходжень після знімка ФЕС іншого джерела
    # немає, тож партія отримує цю ціну.
    price_of = price_of or {}
    kind_id = {r["code"]: r["id"] for r in con.execute("SELECT id, code FROM doc_kind")}
    live = {"in": kind_id["act_in"], "mv": kind_id["invoice"], "wr": kind_id["writeoff"]}
    tracking = {r["id"]: r["tracking"] for r in con.execute("SELECT id, tracking FROM nomen")}
    name_of = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM nomen")}
    sub_name = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM subdivision")}

    # Усередині одного дня прихід іде першим, потім переміщення, потім
    # списання: інакше видача тим самим числом шукає партію, якої ще немає.
    # Це вилізло, щойно реєстр повернув старим документам справжні дати.
    order = {"in": 0, "mv": 1, "wr": 2}
    for (src, dtype, no, date, frm, to), rows in sorted(
            groups.items(),
            key=lambda g: (g[0][3], order[g[0][0]], str(g[0][2]))):
        frm_id, to_id = subs.get(frm), subs.get(to)
        if frm_id is None:                           # надходження ззовні: нові партії
            doc_id = _insert_document(
                con, live[src], src, no, date, dtype, None, to_id,
                cps.get(rows[0].get("src")) if src == "in" else None)
            rep.documents += 1
            for i, r in enumerate(rows, 1):
                _insert_line(con, doc_id, i, nomen[r["code"]],
                             int(round(r["qty"] * 1000)), None,
                             _known_instance(con, keys, r["code"], rep), r, rep,
                             price_kop=price_of.get(r["code"]))
            continue

        # Рядки одного паперу можуть виявитися в різних підлеглих; тоді папір
        # розкладається на кілька документів — по одному на маршрут, як і
        # вимагає модель «одна накладна — один маршрут».
        lots = _lots(con, date)
        by_holder = defaultdict(list)
        for r in rows:
            nid = nomen[r["code"]]
            holder = _holder(con, date, frm_id, nid, lots)
            if holder is None:
                rep.no_batch.append((date, no, name_of[nid],
                                     int(round(r["qty"] * 1000)), frm))
                continue
            by_holder[holder].append(r)

        for holder, held in sorted(by_holder.items()):
            if holder != frm_id:
                rep.moved_route.append((date, no, frm, sub_name[holder]))
            doc_id = _insert_document(con, live[src], src, no, date, dtype,
                                      holder, to_id, None)
            rep.documents += 1
            line_no = 0
            for r in held:
                nid = nomen[r["code"]]
                qty = int(round(r["qty"] * 1000))
                known = _known_instance(con, keys, r["code"], rep)
                busy = (set(_instance_lots(con, holder, nid, date).values())
                        if known is None else ())
                parts = _allocate(con, date, holder, nid, qty, no, rep, name_of,
                                  sub_name[holder], known, busy)
                for batch_id, take, note in parts:
                    if batch_id is None:
                        continue    # рядок без партії база не прийме; він у звіті
                    line_no += 1
                    # Екземпляр — це рівно одна одиниця. Якщо кількість довелося
                    # розкласти на кілька партій, номер втрачає сенс.
                    inst = known if take == 1000 and len(parts) == 1 else None
                    if inst is None and tracking.get(nid) == "instance":
                        free = _free_instances(con, holder, nid, date)
                        inst = free[0] if free else None
                        if inst is None:
                            rep.warnings.append(
                                f"{date} №{no}: немає вільного екземпляра "
                                f"{name_of[nid][:40]} у {sub_name[holder]}")
                    _insert_line(con, doc_id, line_no, nid, take, batch_id, inst,
                                 r, rep, note)


def _allocate(con, date, subdivision_id, nomen_id, qty, number, rep, name_of,
              sub_name, instance_id=None, busy=()):
    """Ділить кількість між партіями підрозділу, від найдавнішої.

    Коли рядок називає примірник, партія береться та сама, якою він прийшов.
    Коли не називає — партії, зайняті відомими примірниками, лишаються на потім:
    знеособлена одиниця не має права з'їсти партію кухні з номером.
    """
    if instance_id is not None:
        own = _instance_lots(con, subdivision_id, nomen_id, date).get(instance_id)
        if own:
            return [(own, qty, None)]
    lots = _lots(con, date).get((subdivision_id, nomen_id), [])
    if busy:
        lots = sorted(lots, key=lambda x: (x[1] in busy, x[0], x[1]))
    if not lots:
        # Розрізняємо два різні випадки. Якщо позиція в підрозділі зʼявиться
        # пізніше — це суперечність дат між реєстром і журналом: за реєстром
        # майно вже видали, а за журналом воно надійшло лише згодом. Якщо не
        # зʼявиться ніколи — у відправника цього майна взагалі не було.
        later = con.execute(
            "SELECT MIN(d.doc_date) FROM posting p "
            "JOIN document d ON d.id = p.document_id "
            "WHERE p.subdivision_id = ? AND p.nomen_id = ? AND p.sign > 0",
            (subdivision_id, nomen_id)).fetchone()[0]
        rep.no_batch.append((date, number, name_of[nomen_id], qty,
                             f"{sub_name} (прихід {later})" if later else sub_name))
        return [(None, qty, None)]
    if len({lot[1] for lot in lots}) > 1:
        rep.ambiguous_batches.append(
            (date, number, name_of[nomen_id], len(lots),
             sorted({lot[0] for lot in lots})))
    out, left = [], qty
    for since, batch_id, avail in lots:
        if left <= 0:
            break
        take = min(left, avail)
        out.append((batch_id, take, None))
        left -= take
    if left > 0:
        # Решту дописуємо до останньої партії: документ у службі відбувся, і
        # викинути його через розбіжність опорних даних означало б підмінити
        # облік звіркою. Рядок іде у звіт поіменно.
        rep.short.append((date, number, name_of[nomen_id], left, sub_name))
        out[-1] = (out[-1][0], out[-1][1] + left, "понад наявні партії")
    return out


def _insert_line(con, doc_id, line_no, nomen_id, qty, batch_id, instance_id, r, rep,
                 note=None, price_kop=None):
    con.execute(
        "INSERT INTO document_line(document_id, line_no, nomen_id, instance_id, qty_milli, "
        "source_line_id, price_kop, note) VALUES (?,?,?,?,?,?,?,?)",
        (doc_id, line_no, nomen_id, instance_id, qty, batch_id, price_kop,
         note or r.get("note") or r.get("flag") or None))
    rep.lines += 1


def _publish(src: Path) -> Path | None:
    """Кладе зібрану базу туди, звідки її читають звіти й застосунок."""
    try:
        from db.paths import db_path
    except Exception:                                   # noqa: BLE001
        return None
    dst = Path(db_path())
    dst.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("-wal", "-shm"):
        stale = dst.with_name(dst.name + suffix)
        if stale.exists():
            stale.unlink()
    shutil.copy2(src, dst)
    return dst


def main():
    here = Path(__file__).parent
    rep = migrate(here / "data" / "extract.json", ROOT / "oblik.sqlite")
    print(f"номенклатура {rep.nomen} | підрозділи {rep.subdivisions} | "
          f"контрагенти {rep.counterparties} | екземпляри {rep.instances}")
    print(f"документи {rep.documents} | рядки {rep.lines} | "
          f"рядків із екземпляром {rep.instance_bound}")
    print(f"групи за розділами 21/Прод | уточнено за бланком {rep.grouped_by_form}")
    if rep.destroyed_linked:
        print("знищене, списане актом:")
        for date, number, qty in rep.destroyed_linked:
            print(f"   рапорт від {date} → акт №{number} ({qty:g} од)")
    published = _publish(ROOT / "oblik.sqlite")
    if published:
        print(f"робоча база: {published}")
    if rep.ambiguous_batches:
        print(f"\nвибір партії неоднозначний: {len(rep.ambiguous_batches)} рядків")
        for date, no, name, n, since in rep.ambiguous_batches[:20]:
            print(f"  {date} №{str(no)[:14]:14} {name[:40]:40} {n} партій від {since[0]}")
    if rep.date_fixes:
        print(f"\nдати виправлено за реєстром техзасобів: "
              f"{len(rep.date_fixes)} рядків")
        seen = sorted({(a, b, c) for a, b, c in rep.date_fixes})
        for no, was, now in seen[:12]:
            print(f"  №{str(no)[:22]:22} {was} -> {now}")
    if rep.added_invoices:
        n = len(rep.added_invoices)
        print()
        print(f"додано первинних накладних, яких немає в книзі 3.0: {n}")
        for no, date, who, n in sorted(rep.added_invoices, key=lambda x: x[1]):
            print(f"  {date}  №{str(no)[:22]:22} -> {who:10} {n} ряд")
    if rep.skipped_invoices:
        n = len(rep.skipped_invoices)
        print()
        print(f"первинні накладні без пари в книзі 3.0: {n} — не вносяться")
        print("  (перевірено: внесення подвоює одиниці й дає мінусові залишки,")
        print("   тобто це ті самі рухи під іншими номерами)")
        for no, date, who, n in sorted(rep.skipped_invoices, key=lambda x: x[1]):
            print(f"  {date}  №{str(no)[:22]:22} -> {str(who)[:22]:22} {n} ряд")
    if rep.no_batch:
        tot = sum(x[3] for x in rep.no_batch) / 1000
        print(f"\nне перенесено — за опорними даними позиції немає в цьому "
              f"підрозділі: {len(rep.no_batch)} рядків, {tot:g} од")
        for date, no, name, q, sub in rep.no_batch[:25]:
            print(f"  {date} №{str(no)[:13]:13} {str(sub)[:16]:16} {name[:38]:38} "
                  f"{q / 1000:>5g}")
    if rep.moved_route:
        seen = sorted({(a, b) for _, _, a, b in rep.moved_route})
        print(f"\nмаршрут уточнено за фактичним утримувачем: "
              f"{len(rep.moved_route)} документів, {len(seen)} напрямків")
        for a, b in seen:
            n = sum(1 for _, _, x, y in rep.moved_route if (x, y) == (a, b))
            print(f"  {str(a)[:22]:22} -> {b[:28]:28} {n}")
    if rep.short:
        print(f"\nвидано понад наявні партії: {len(rep.short)} рядків")
        for date, no, name, q, sub in rep.short[:15]:
            print(f"  {date} №{str(no)[:13]:13} {str(sub)[:16]:16} {name[:38]:38} "
                  f"{q / 1000:>5g}")
    if rep.negative:
        print(f"\nмінусовий залишок після перенесення: {len(rep.negative)}")
        for code, name, sub, q in rep.negative:
            print(f"  {code} {name[:40]:40} {sub[:24]:24} {q:+g}")
    if rep.warnings:
        print(f"\nувага: {len(rep.warnings)}")
        for w in rep.warnings[:12]:
            print("  ", w)


if __name__ == "__main__":
    main()
