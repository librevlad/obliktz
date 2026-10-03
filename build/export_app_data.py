# -*- coding: utf-8 -*-
"""Експорт даних обліку у компактний JS-модуль для десктоп-застосунку.

Джерело — база, а не витяг із 3.0. Це важливо: у базі лежить уся історія з
24.02.2022, зведена з журналів служби, первинних накладних, реєстру техзасобів
і власних книг (додатки 13 і 46), а у витягу — лише те, що встигло потрапити в
Excel. Застосунок показує проєкцію бази, тому все, що звірено, видно і в ньому.

Формат payload лишається тим самим, що й був: масиви рядків замість словників,
щоб файл не роздувався. До нього додано те, чого в 3.0 не було зовсім — штат,
реєстр примірників з інвентарними номерами й перелік знищеного майна.
"""
import os
import sys
import json
import re
import datetime
import collections

# Під pytest stdout — не консоль, і перекодовувати там нічого.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8")

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path[:0] = [ROOT, HERE]

from build.version import APP_VERSION, APP_VERSION_DATE   # noqa: E402
from db.connect import current_version, open_db, close_db   # noqa: E402

DB = os.path.join(ROOT, "oblik.sqlite")
APP = os.path.join(ROOT, "app")
# Початок обліку, як OPENING у desktop/state_db.py: раніші документи — архів, а
# норма «від початку обліку» лежить у базі з цією датою.
OPENING = "2022-02-24"

# Вид документа в базі -> журнал застосунку.
def app_id(row, prefix="b"):
    """Ідентифікатор запису для застосунку: свій, якщо запис заведено в програмі,
    інакше номер рядка бази. Він не змінюється між запусками — інакше посилання
    (МВО на людину, підписанти опису) розʼїхалися б після перезбірки."""
    return row["ext_id"] if row["ext_id"] else f"{prefix}{row['id']}"


def items_of(con):
    """Позиції з групою, одиницею, останньою ціною, ознакою необоротності й
    бухгалтерським номером ФЕС (є — вид обліку підтверджено фінансовим органом)."""
    inst = collections.defaultdict(list)
    for r in con.execute("SELECT nomen_id, serial_no, chassis_no, made_year, inv_no "
                         "FROM instance ORDER BY id"):
        inst[r["nomen_id"]].append(r)
    out = []
    for r in con.execute("""
            SELECT n.id, n.code, n.name, g.code AS grp, u.code AS uom,
                   n.is_fixed_asset, n.source, n.fes_code, n.note, n.old_code, n.archived_at,
                   COALESCE(p.price_kop, n.app_price_kop) AS price_kop
              FROM nomen n
              JOIN nomen_group g ON g.id = n.group_id
              JOIN uom u ON u.id = n.uom_id
              LEFT JOIN nomen_last_price p ON p.nomen_id = n.id
             ORDER BY n.code"""):
        one = inst[r["id"]][0] if len(inst[r["id"]]) == 1 else None
        out.append([
            r["code"], r["name"], r["grp"], r["uom"],
            round((r["price_kop"] or 0) / 100, 2),
            0,
            one["serial_no"] if one else "",
            one["chassis_no"] if one else "",
            one["made_year"] if one and one["made_year"] else 0,
            int(r["is_fixed_asset"] or 0),
            r["source"] == "program",
            r["fes_code"] or "",
            # Примітка картки, коди з «Облік ТЗ 3.0», згорнуті в позицію, і дата,
            # з якої позиція в архіві (її не пропонують у нових документах).
            r["note"] or "", r["old_code"] or "", r["archived_at"] or "",
        ])
    return out


def subs_of(con):
    """Дерево підрозділів у порядку обходу, з позначками «є рух» і «діє».

    Закритий підрозділ (скажімо, батальйон після переформування) лишається в
    історії й журналах, але в переліках вибору для нових документів його немає;
    примітка каже, куди поділося майно."""
    rows = con.execute("""
        SELECT s.id, s.ext_id, s.name, p.name AS parent, k.code AS kind, s.sort,
               s.is_active, s.note,
               EXISTS (SELECT 1 FROM posting x WHERE x.subdivision_id = s.id) AS used,
               (SELECT COUNT(*) FROM subdivision_alias a WHERE a.subdivision_id = s.id)
             + (SELECT COUNT(*) FROM person pr WHERE pr.subdivision_id = s.id)
             + (SELECT COUNT(*) FROM place pl WHERE pl.subdivision_id = s.id) AS refs
          FROM subdivision s
          JOIN subdivision_kind k ON k.id = s.kind_id
          LEFT JOIN subdivision p ON p.id = s.parent_id
         ORDER BY s.sort, s.id""").fetchall()
    depth = {}
    for r in rows:
        depth[r["name"]] = 0 if not r["parent"] else depth.get(r["parent"], 0) + 1
    # refs — скільки записів бази, яких застосунок не бачить (інші назви з паперів,
    # люди, місця), тримають підрозділ: такий база не видалить, тож і програма
    # не пропонує.
    return [[r["name"], r["parent"] or "", r["kind"], depth[r["name"]],
             r["sort"], bool(r["used"]), bool(r["is_active"]),
             r["note"] or "", app_id(r), r["refs"]] for r in rows]


def sub_titles_of(con):
    """Як підрозділ названо в паперах: [підрозділ, шапка відомості звірки, місце в описі].

    Це інші назви підрозділу з джерелами «відомість» (родовий відмінок) і «опис»
    («в роті …»). Склад, батальйони й їхні взводи застосунок називає сам, тож
    тут лише ті, кого правилами не назвеш."""
    out = {}
    for r in con.execute("""
            SELECT s.name AS sub, a.name, a.source FROM subdivision_alias a
              JOIN subdivision s ON s.id = a.subdivision_id
             WHERE a.source IN ('відомість', 'опис')
             ORDER BY s.sort, s.id, a.id"""):
        row = out.setdefault(r["sub"], [r["sub"], "", ""])
        row[1 if r["source"] == "відомість" else 2] = r["name"]
    return list(out.values())


def locations_of(con):
    """Дислокація частини — місце складання документів, від дати до наступного запису."""
    if not _has_table(con, "unit_location"):
        return []
    return [[app_id(r), r["valid_from"], r["place"], r["note"] or ""]
            for r in con.execute("SELECT * FROM unit_location ORDER BY valid_from")]




def norms_of(con):
    """Штатна потреба: норма на табельний рядок форми або на код служби, зі
    строком дії. Одна таблиця — і те, що прийшло з розшифровки табеля, і те, що
    задали в програмі; поділу немає."""
    codes = collections.defaultdict(list)
    for r in con.execute("""SELECT m.report_line_id, n.code FROM nomen_report_line m
                              JOIN nomen n ON n.id = m.nomen_id"""):
        codes[r["report_line_id"]].append(r["code"])
    out = []
    for r in con.execute("""
            SELECT n.id, n.ext_id, f.code AS form, rl.name AS line, s.name AS sub,
                   n.qty_milli, n.valid_from, n.valid_to, n.report_line_id,
                   c.code AS code, n.basis, n.note
              FROM norm n
              JOIN subdivision s ON s.id = n.subdivision_id
              LEFT JOIN report_line rl ON rl.id = n.report_line_id
              LEFT JOIN report_form f ON f.id = rl.form_id
              LEFT JOIN nomen c ON c.id = n.nomen_id
             ORDER BY f.code, rl.sort, s.sort, n.valid_from"""):
        # Примітка норми — звідки вона (графа розшифровки табеля): у норм із бази
        # наказу часто немає, і саме примітка каже, на чому норма стоїть.
        # Норма «від початку обліку» лежить у базі з датою відліку — застосунку
        # вона йде без дати, як її й задавали, а не «з 24.02.2022».
        out.append([r["form"] or "", r["line"] or "", r["sub"], r["qty_milli"] / 1000,
                    "" if r["valid_from"] in (None, OPENING) else r["valid_from"], r["valid_to"] or "",
                    sorted(codes.get(r["report_line_id"], [])), r["basis"] or "",
                    r["code"] or "", app_id(r), r["note"] or ""])
    return out


def inventory_ranges(con):
    """Інвентарні номери пачками: [код, підрозділ, перший, останній].

    Номери в межах позиції йдуть підряд, тож тисячі рядків стискаються до
    небагатьох діапазонів — і файл застосунку лишається легким.
    """
    rows = con.execute("""
        SELECT n.code, s.name AS sub, i.inv_no
          FROM instance i
          JOIN nomen n ON n.id = i.nomen_id
          JOIN instance_assignment a ON a.instance_id = i.id
          JOIN subdivision s ON s.id = a.subdivision_id
         WHERE i.inv_no IS NOT NULL
         ORDER BY n.code, i.inv_no""").fetchall()
    out, cur = [], None
    for r in rows:
        seq = int(r["inv_no"].rsplit("/", 1)[-1])
        if cur and cur[0] == r["code"] and cur[1] == r["sub"] and seq == cur[3] + 1:
            cur[3] = seq
            continue
        cur = [r["code"], r["sub"], seq, seq]
        out.append(cur)
    return out


def instances_of(con):
    """Реєстр примірників: інвентарний номер, заводський, шасі, рік, стан."""
    cat = {}
    for r in con.execute("SELECT instance_id, condition_cat FROM instance_condition "
                         "ORDER BY on_date"):
        cat[r["instance_id"]] = r["condition_cat"]
    out = []
    for r in con.execute("""
            SELECT i.id, n.code, i.inv_no, i.serial_no, i.chassis_no, i.made_year,
                   i.note,
                   (SELECT s.name FROM posting p JOIN subdivision s ON s.id = p.subdivision_id
                     WHERE p.instance_id = i.id
                     GROUP BY p.subdivision_id
                    HAVING SUM(p.sign * p.qty_milli) > 0 LIMIT 1) AS holder
              FROM instance i JOIN nomen n ON n.id = i.nomen_id
             WHERE i.serial_no IS NOT NULL OR i.chassis_no IS NOT NULL
             ORDER BY n.code, i.id"""):
        out.append([r["code"], r["inv_no"] or "", r["serial_no"] or "",
                    r["chassis_no"] or "", r["made_year"] or 0,
                    cat.get(r["id"], 0), r["holder"] or "", r["note"] or "", r["id"]])
    return out


def unit_cats_of(con):
    """Історія категорій стану одиниць: [id одиниці, з дати, категорія]. Накладна
    друкує категорію на свою дату, а не нинішню."""
    return [[r[0], r[1], r[2]] for r in con.execute(
        "SELECT instance_id, on_date, condition_cat FROM instance_condition ORDER BY instance_id, on_date, id")]


def attachments_of(con):
    """Скани первинних документів: до якого документа й де лежить файл. Id
    документа — бо папери з однаковими датою й номером (акт приймання на два
    підрозділи, кілька «б/н» того самого дня) мають кожен свої скани."""
    out = []
    for r in con.execute("""
            SELECT d.id, d.doc_date, d.number, a.file_name, a.rel_path, a.mime, a.size_bytes
              FROM attachment a JOIN document d ON d.id = a.document_id
             ORDER BY d.doc_date, a.id"""):
        out.append([r["doc_date"], r["number"], r["file_name"], r["rel_path"],
                    r["mime"] or "", r["size_bytes"] or 0, r["id"]])
    return out


def nomen_files_of(con):
    """Фото й документи до позицій і окремих одиниць: [код, зав.№ або "", файл,
    шлях, тип, розмір, вид]."""
    return [[r["code"], r["unit_no"] or "", r["file_name"], r["rel_path"], r["mime"] or "",
             r["size_bytes"] or 0, r["kind"]]
            for r in con.execute("""
                SELECT n.code, f.unit_no, f.file_name, f.rel_path, f.mime, f.size_bytes, f.kind
                  FROM nomen_file f JOIN nomen n ON n.id = f.nomen_id
                 ORDER BY n.code, f.unit_no, f.kind, f.file_name""")]


def doc_notes_of(con):
    """Примітки самих документів — [id, примітка]: яка первинка є в службі
    («первинка: Оригінал», «Копія», «Ел. копія»), звідки залишки. Рядкові
    примітки йдуть разом із рядками, а ця — одна на документ."""
    return [[r[0], r[1]] for r in con.execute(
        "SELECT d.id, d.note FROM document d JOIN doc_kind k ON k.id = d.kind_id "
        "WHERE k.affects_stock = 1 AND COALESCE(d.note, '') <> '' ORDER BY d.id")]


def _has_table(con, name) -> bool:
    return con.execute("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
                       (name,)).fetchone() is not None


def reconciliations_of(con):
    """Підписані узагальнюючі відомості: шапка й рядки-партії.

    Кількості лишаються порожніми там, де їх у відомості не було: «за
    фінансовим обліком» порожнє — це не нуль, а «не звірено з ФЕС».
    """
    if not _has_table(con, "reconciliation"):
        return []
    q = lambda v: None if v is None else v / 1000            # noqa: E731
    lines = collections.defaultdict(list)
    for r in con.execute("""
            SELECT l.reconciliation_id AS rid, n.code, l.name, l.uom, l.price_kop,
                   l.fin_qty_milli, l.acc_qty_milli, l.fact_qty_milli, l.note
              FROM reconciliation_line l
              LEFT JOIN nomen n ON n.id = l.nomen_id
             ORDER BY l.reconciliation_id, l.line_no"""):
        lines[r["rid"]].append([r["code"] or "", r["name"], r["uom"] or "",
                                round((r["price_kop"] or 0) / 100, 2),
                                q(r["fin_qty_milli"]), q(r["acc_qty_milli"]),
                                q(r["fact_qty_milli"]), r["note"] or ""])
    out = []
    for r in con.execute("""
            SELECT c.*, s.name AS sub FROM reconciliation c
              JOIN subdivision s ON s.id = c.subdivision_id
             ORDER BY c.period_to, c.id"""):
        out.append([r["id"], r["sub"], r["number"] or "", r["doc_date"],
                    r["period_from"] or "", r["period_to"], r["unit_title"] or "",
                    r["signer_position"] or "", r["signer_name"] or "",
                    r["chief_position"] or "", r["chief_name"] or "",
                    r["result"] or "", r["decision"] or "", r["note"] or "",
                    r["status"], r["source"] or "", lines.get(r["id"], [])])
    return out


def report_lines_of(con):
    """Табельні позиції форм 21/Прод і 3/Прод із кодами служби, що до них належать.

    Потрібні не лише позиції зі штатом: заміною можуть іти й ті, під які штату
    немає зовсім (польові печі за переносні кухні), а їхню наявність програма
    рахує саме за цим переліком кодів. І ті, що кодів ще не мають: штат на них
    вписують, а коди прив'язують у програмі («Вагове обладнання» й терези).
    """
    codes = collections.defaultdict(list)
    for r in con.execute("""
            SELECT m.report_line_id AS lid, n.code FROM nomen_report_line m
              JOIN nomen n ON n.id = m.nomen_id ORDER BY n.code"""):
        codes[r["lid"]].append(r["code"])
    return [[r["form"], r["name"], r["section"] or "", codes[r["id"]]]
            for r in con.execute("""
                SELECT rl.id, rl.name, rl.section, f.code AS form FROM report_line rl
                  JOIN report_form f ON f.id = rl.form_id
                 ORDER BY f.code, rl.sort""")]


def responsible_of(con):
    """Матеріально відповідальні, чинні сьогодні: з ким звіряти за замовчуванням."""
    today = datetime.date.today().isoformat()
    return [[r["sub"], r["full_name"], r["position"] or ""] for r in con.execute("""
        SELECT s.name AS sub, p.full_name, p.position FROM responsible r
          JOIN person p ON p.id = r.person_id
          JOIN subdivision s ON s.id = r.subdivision_id
         WHERE r.valid_from <= ? AND (r.valid_to IS NULL OR r.valid_to > ?)""",
        (today, today))]


def people_of(con):
    """Довідник «Військовослужбовці»: ім'я частинами й історія звань і посад.

    Історія — список [дата, звання, посада, підстава]: документ на дату бере
    останній запис, не пізніший за неї. Хто заведений без історії (так було до
    схеми 15), отримує один запис із поточних звання й посади без дати."""
    hist = collections.defaultdict(list)
    for r in con.execute("SELECT person_id, on_date, rank, position, basis FROM person_history "
                         "ORDER BY person_id, on_date"):
        hist[r["person_id"]].append([r["on_date"], r["rank"] or "", r["position"] or "",
                                     r["basis"] or ""])
    out = []
    for r in con.execute("SELECT * FROM person ORDER BY id"):
        surname, given = r["surname"], r["given_name"]
        if not surname:
            # «Тарас ПЕТРЕНКО» або «ПЕТРЕНКО Т. Г.»: прізвище — слово великими.
            words = (r["full_name"] or "").replace(".", " ").split()
            caps = [w for w in words if w.isupper() and len(w) > 1]
            surname = caps[0] if caps else (r["full_name"] or "")
            given = " ".join(w for w in words if w != surname)
        out.append([app_id(r), surname, given or "", r["patronymic"] or "",
                    r["app_note"] or ("" if r["is_active"] else "не служить"),
                    hist.get(r["id"]) or [["", r["rank"] or "", r["position"] or "", ""]]])
    return out


def mvo_of(con):
    """Відповідальні особи: хто за який підрозділ відповідав і з якого по яке число."""
    return [[r["sub"], r["person"], r["valid_from"], r["valid_to"] or "", r["note"] or "",
             app_id(r)]
            for r in con.execute("""
                SELECT r.id, r.ext_id, s.name AS sub, r.valid_from, r.valid_to, r.note,
                       COALESCE(p.ext_id, 'b' || p.id) AS person
                  FROM responsible r JOIN subdivision s ON s.id = r.subdivision_id
                  JOIN person p ON p.id = r.person_id
                 ORDER BY s.id, r.valid_from""")]


def commanders_of(con):
    """Командири (начальники) підрозділів: хто яким підрозділом командував і з якого по яке число."""
    return [[r["sub"], r["person"], r["valid_from"], r["valid_to"] or "", r["note"] or "",
             app_id(r)]
            for r in con.execute("""
                SELECT r.id, r.ext_id, s.name AS sub, r.valid_from, r.valid_to, r.note,
                       COALESCE(p.ext_id, 'b' || p.id) AS person
                  FROM commander r JOIN subdivision s ON s.id = r.subdivision_id
                  JOIN person p ON p.id = r.person_id
                 ORDER BY s.id, r.valid_from""")]


def officials_of(con):
    """Посадовці частини, що підписують документи служби, зі строком дії."""
    return [[r["role"], r["person"], r["valid_from"], r["valid_to"] or "", r["note"] or "",
             app_id(r)]
            for r in con.execute("""
                SELECT o.id, o.ext_id, o.role, o.valid_from, o.valid_to, o.note,
                       COALESCE(p.ext_id, 'b' || p.id) AS person
                  FROM official o JOIN person p ON p.id = o.person_id
                 ORDER BY o.role, o.valid_from""")]


def inventories_of(con):
    """Проведені інвентаризації з бази: шапка, комісія (голова першим), хто
    затвердив і підписав, МВО описів, охоплення й папери.

    Підписанти й МВО — лише ті, що записані в паперах цієї інвентаризації;
    де їх немає, програма підставить посадовців і МВО з довідника на дату."""
    members = collections.defaultdict(list)
    for r in con.execute("SELECT inventory_id, role, person_id FROM inventory_member "
                         "ORDER BY inventory_id, line_no"):
        members[r["inventory_id"]].append([r["role"], r["person_id"]])
    mvo = collections.defaultdict(dict)
    if _has_table(con, "inventory_mvo"):
        for r in con.execute("""SELECT m.inventory_id, s.name, m.person_id FROM inventory_mvo m
                                  JOIN subdivision s ON s.id = m.subdivision_id"""):
            mvo[r["inventory_id"]][r["name"]] = r["person_id"]
    files = collections.defaultdict(list)
    if _has_table(con, "inventory_file"):
        for r in con.execute("""SELECT inventory_id, file_name, rel_path, mime, size_bytes, kind, note
                                  FROM inventory_file ORDER BY inventory_id, kind, file_name"""):
            files[r["inventory_id"]].append([r["file_name"], r["rel_path"], r["mime"] or "",
                                             r["size_bytes"] or 0, r["kind"], r["note"] or ""])
    sign_cols = {"cmd": "commander_id", "nachlog": "logistics_id", "chief": "chief_id",
                 "buh": "accountant_id"}
    # Охоплення записане назвами. Після виправлення назви підрозділу на місці
    # там лишається стара — за іншими назвами вона веде до поточної, інакше
    # перейменований підрозділ випадав би з інвентаризації та її закритого періоду.
    current = {r[0] for r in con.execute("SELECT name FROM subdivision")}
    aliases = {}
    if _has_table(con, "subdivision_alias"):
        aliases = {r["name"]: r["sub"] for r in con.execute(
            "SELECT a.name, s.name AS sub FROM subdivision_alias a JOIN subdivision s ON s.id = a.subdivision_id")}
    canon = lambda x: x if x in current else aliases.get(x, x)          # noqa: E731
    out = []
    for r in con.execute("SELECT * FROM inventory ORDER BY as_of"):
        keys = r.keys()
        out.append({
            "id": f"base-{r['id']}", "kind": r["kind"], "date": r["as_of"],
            "start": r["started"] or "", "end": r["finished"] or "",
            "orderNo": r["order_no"] or "", "orderDate": r["order_date"] or "",
            "prevDate": r["prev_date"] or "", "result": r["result"] or "",
            "source": r["source"] or "",
            "note": (r["note"] if "note" in keys else None) or "",
            "scope": [canon(x) for x in ((r["scope"] if "scope" in keys else None) or "").split("|") if x],
            "sign": {k: r[c] for k, c in sign_cols.items() if c in keys and r[c] is not None},
            "mvo": mvo.get(r["id"], {}),
            "files": files.get(r["id"], []),
            "head": next((m[1] for m in members[r["id"]] if m[0] == "голова"), None),
            "members": [m[1] for m in members[r["id"]] if m[0] == "член"]})
    return out


def payload(con) -> dict:
    """Проєкція бази для застосунку.

    Одне джерело: програма бере довідники, документи й журнали звідси, і сюди ж
    вони повертаються. Тому витяг мусить читатися з живої бази, а не лише з
    файла, зібраного під час випуску.
    """
    items = items_of(con)
    subs = subs_of(con)
    sub_titles = sub_titles_of(con)
    norms = norms_of(con)
    instances = instances_of(con)
    ranges = inventory_ranges(con)
    scans = attachments_of(con)
    nomen_files = nomen_files_of(con)
    recon = reconciliations_of(con)
    responsible = responsible_of(con)
    people = people_of(con)
    mvo = mvo_of(con)
    officials = officials_of(con)
    locations = locations_of(con)
    inventories = inventories_of(con)
    report_lines = report_lines_of(con)
    chief = con.execute(
        "SELECT value FROM settings WHERE key = 'service_chief'").fetchone()
    # Реквізити частини для бланків: назва юридичної особи, ЄДРПОУ, повна
    # назва служби й строк дії накладної. Раніше вони жили в самому бланку.
    conf = dict(con.execute("SELECT key, value FROM settings"))
    groups = [[r["code"], r["name"]] for r in con.execute(
        "SELECT code, name FROM nomen_group ORDER BY sort, code")]
    period = con.execute(
        "SELECT MIN(doc_date), MAX(doc_date) FROM document").fetchone()

    legal = conf.get("unit_legal_name", "") or ""
    unit_code = (re.search(r"частина\s+(\S+)", legal, re.I) or [None, ""])[1] if legal else ""
    payload = {
    "meta": {
        "unit": unit_code,
        "service": "продовольча служба",
        # Версія програми й схема бази — для рядка внизу панелі ⚙.
        "version": APP_VERSION,
        "versionDate": APP_VERSION_DATE,
        "schema": current_version(con),
        "built": datetime.date.today().isoformat(),
        "period": [period[0], period[1]],
        # Перший документ бази буває пізнішим за початок обліку, і старий папір
        # між ними вноситься в режимі історії.
        "opening": OPENING,
        "source": "база обліку ТЗ (oblik.sqlite)",
        "chief": chief[0] if chief else "",
        "legalName": conf.get("unit_legal_name", ""),
        "edrpou": conf.get("unit_edrpou", ""),
        "serviceFull": conf.get("service_full", ""),
        "validDays": int(conf.get("invoice_valid_days") or 1),
    },
    "groups": groups,
    "itemCols": ["code", "name", "group", "unit", "price", "cat",
                 "serial", "chassis", "year", "nonrev", "own", "fes", "note", "old", "archived"],
    "items": items,
    "subCols": ["name", "parent", "kind", "depth", "sort", "used", "active", "note", "id", "refs"],
    "subs": subs,
    "subTitleCols": ["sub", "title", "where"],
    "subTitles": sub_titles,
    "normCols": ["form", "line", "sub", "qty", "from", "to", "codes", "basis",
                 "code", "id", "note"],
    "norms": norms,
    "instCols": ["code", "inv", "serial", "chassis", "year", "cat",
                 "holder", "note"],
    "instances": instances,
    "unitCats": unit_cats_of(con),
    "invCols": ["code", "sub", "from", "to"],
    "inventory": ranges,
    "docNotes": doc_notes_of(con),
    "scanCols": ["date", "number", "file", "path", "mime", "size", "docId"],
    "scans": scans,
    "nomenFileCols": ["code", "unit", "file", "path", "mime", "size", "kind"],
    "nomenFiles": nomen_files,
    "reconCols": ["id", "sub", "no", "date", "from", "to", "title", "signerPos",
                  "signerName", "chiefPos", "chiefName", "result", "decision",
                  "note", "status", "source", "lines"],
    "reconLineCols": ["code", "name", "uom", "price", "fin", "acc", "fact", "note"],
    "recon": recon,
    "lineCols": ["form", "line", "section", "codes"],
    "lines": report_lines,
    "respCols": ["sub", "name", "position"],
    "responsible": responsible,
    "personCols": ["id", "surname", "name", "patr", "note", "hist"],
    "personHistCols": ["date", "rank", "position", "basis"],
    "people": people,
    "mvoCols": ["sub", "person", "from", "to", "note", "id"],
    "mvo": mvo,
    "cmdrs": commanders_of(con),
    "officialCols": ["role", "person", "from", "to", "note", "id"],
    "officials": officials,
    "locationCols": ["id", "from", "place", "note"],
    "locations": locations,
    "inventoryFileCols": ["file", "path", "mime", "size", "kind", "note"],
    "inventories": inventories,
    }
    return payload


def as_js(data: dict) -> str:
    return ("window.OBLIK_DATA = "
            + json.dumps(data, ensure_ascii=False, separators=(",", ":")) + ";\n")


def main():
    if not os.path.exists(DB):
        raise SystemExit(f"немає бази: {DB}")
    con = open_db(DB, migrate=False)
    try:
        payload = globals()["payload"](con)
    finally:
        close_db(con)
    items, subs, norms = payload["items"], payload["subs"], payload["norms"]
    instances, ranges = payload["instances"], payload["inventory"]
    scans, recon = payload["scans"], payload["recon"]
    responsible, people = payload["responsible"], payload["people"]
    mvo, officials = payload["mvo"], payload["officials"]
    nomen_files, inventories = payload["nomenFiles"], payload["inventories"]
    period = payload["meta"]["period"]

    os.makedirs(APP, exist_ok=True)
    js = as_js(payload)
    path = os.path.join(APP, "data.js")
    with open(path, "w", encoding="utf-8") as f:
        f.write(js)

    print(f"{path}  ({len(js) / 1024:.0f} КБ)")
    print(f"позицій {len(items)} | підрозділів {len(subs)} "
          f"(з рухом {sum(1 for s in subs if s[5])})")
    print(f"період {period[0]}—{period[1]} (документи й рапорти йдуть зі станом, не з витягом)")
    print(f"норм {len(norms)} | примірників з номером або паспортом {len(instances)} "
          f"| діапазонів інвентарних номерів {len(ranges)} "
          f"({sum(r[3] - r[2] + 1 for r in ranges)} одиниць) "
          f"| сканів {len(scans)} | звірок {len(recon)} | відповідальних {len(responsible)}")
    print(f"людей {len(people)} | МВО {len(mvo)} | посадовців {len(officials)} "
          f"| інвентаризацій {len(inventories)} (паперів {sum(len(i['files']) for i in inventories)}) "
          f"| файлів до майна {len(nomen_files)}")


if __name__ == "__main__":
    main()
