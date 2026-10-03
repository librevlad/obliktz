# -*- coding: utf-8 -*-
"""Внесене в програмі — у базі, а не в окремому файлі.

Застосунок працює зі своєю моделлю (документи, норми, довідники, звірки,
інвентаризації) і віддає її цілком. Тут вона розкладається по таблицях бази й
збирається назад:

  * документи лягають у ті самі `document` / `document_line`, що й база, з
    позначкою `source='program'`. Тому перевірки цілісності, звіти й бланки
    бачать увесь облік, а не половину;
  * решта — у таблицях `app_*` полями, а не текстом.

Кругообіг мусить бути точним: що застосунок надіслав, те він і має отримати.
Поля, яких схема ще не знає, зберігаються в колонці `extra` — і не губляться.
"""
import datetime
import json
import re
import sqlite3

# --------------------------------------------------------------------- службове

OPENING = "2022-02-24"      # початок обліку
JOURNALS = {"incoming": "act_in", "movement": "invoice", "writeoffs": "writeoff"}
# Вид документа бази -> журнал застосунку; перенесення залишків — теж прихід:
# його рядки — партії, з яких потім видають.
KIND_OF = {"act_in": "incoming", "opening": "incoming", "invoice": "movement", "writeoff": "writeoffs"}
JOURNAL_ORDER = {"incoming": 0, "movement": 1, "writeoffs": 2}
MILLI = 1000


def _milli(v):
    return int(round(float(v or 0) * MILLI))


def _money(kop):
    """Ціна з копійок: ціле лишається цілим — застосунок надіслав 0, а не 0.0."""
    v = round((kop or 0) / 100, 2)
    return int(v) if float(v).is_integer() else v


def _qty(milli):
    v = (milli or 0) / MILLI
    return int(v) if float(v).is_integer() else v


def _extra(rec, known):
    """Поля запису, яким у схемі немає колонки."""
    rest = {k: v for k, v in rec.items() if k not in known}
    return json.dumps(rest, ensure_ascii=False) if rest else None


def _with_extra(row, extra):
    if extra:
        row.update(json.loads(extra))
    return row


def _clean(row):
    """Поля, яких у записі не було, не вигадуємо: NULL — це «поля не було»,
    а порожній рядок так і лишається порожнім рядком."""
    return {k: v for k, v in row.items() if v is not None}


# ----------------------------------------------------------------- документи
#
# Усі документи обліку — і перенесені з паперових журналів 3.0, і внесені в
# програмі — застосунок отримує разом зі станом і править однаково. Звідки
# документ прийшов, каже `document.source`; для застосунку це лише походження
# (фільтр «внесені в програмі», нагадування про скани), а не право на правку.
#
# Рядок журналу застосунку, крім полів паперу, несе службовий хвіст:
#     …, ціна, дата партії, id документа в базі, походження (seed | program)[, одиниця]
# Дата партії потрібна звірці (яка саме партія поїхала). Id — виправленню:
# змінений документ оновлюється на місці, а не переписується новим, тому скани,
# зв'язок із рапортом і партії, з яких видавали пізніше, лишаються при ньому.
# Одиниця — id примірника із заводським номером (кухня, цистерна): рядок про неї
# завжди на 1 шт., і за такими рядками видно, де саме ця кухня. Рядки без
# хвоста — щойно внесені у формі або зі старого файла стану.

class SaveError(ValueError):
    """Запис не пройшов з причини, яку треба сказати людині словами."""


def _ref(con, cache, table, name, make):
    """Ідентифікатор запису довідника за назвою; чого немає — заводимо."""
    key = (table, name)
    if key in cache:
        return cache[key]
    row = con.execute(f"SELECT id FROM {table} WHERE name = ?", (name,)).fetchone()
    ident = row[0] if row else make(name)
    cache[key] = ident
    return ident


def _lots(con):
    """Партії, що лежать у підрозділах: {(підрозділ, позиція): [[дата, партія, к-сть,
    ціна в копійках, дата приходу партії, з них за одиницями із номерами]]}.

    Береться один раз на запис — далі партії ведуться в пам'яті. Інакше кожен
    рядок документа перечитував би всі проводки, і збереження обліку за кілька
    років тривало б хвилини."""
    units = {}
    for r in con.execute("""
            SELECT subdivision_id AS sub, batch_line_id AS batch, SUM(sign * qty_milli) AS qty
              FROM posting WHERE instance_id IS NOT NULL
             GROUP BY subdivision_id, batch_line_id, instance_id
            HAVING SUM(sign * qty_milli) > 0"""):
        units[(r["sub"], r["batch"])] = units.get((r["sub"], r["batch"]), 0) + r["qty"]
    out = {}
    for r in con.execute("""
            SELECT p.subdivision_id AS sub, p.nomen_id AS nomen, p.batch_line_id AS batch,
                   SUM(p.sign * p.qty_milli) AS qty, MIN(b.doc_date) AS since, MIN(b.price_kop) AS price
              FROM posting p JOIN batch b ON b.batch_line_id = p.batch_line_id
             GROUP BY p.subdivision_id, p.nomen_id, p.batch_line_id
            HAVING SUM(p.sign * p.qty_milli) > 0"""):
        out.setdefault((r["sub"], r["nomen"]), []).append(
            [r["since"], r["batch"], r["qty"], r["price"], r["since"],
             min(r["qty"], units.get((r["sub"], r["batch"]), 0))])
    for v in out.values():
        v.sort(key=lambda x: (x[0], x[1]))
    return out


def _take(lots, sub, nomen, qty, date, prefer=None):
    """Звідки списується: від найдавнішої партії, що вже лежала на дату
    документа; коли таких не вистачає — від найдавнішої з решти. Партія, яку
    назвали в рядку (дата приходу й ціна, `prefer`), іде першою, за нею — партії
    тієї ж ціни. Кількість, що лежить одиницями із заводськими номерами, береться
    в останню чергу: одиницю видають рядком із її номером.
    Повертає [(партія, к-сть, ціна, дата приходу партії)]."""
    rest = lots.get((sub, nomen)) or []
    order = ([lot for lot in rest if not date or lot[0] <= date]
             + [lot for lot in rest if date and lot[0] > date])
    if prefer:
        lot_date, price = prefer
        exact = [lot for lot in order if lot[4] == lot_date and lot[3] == price]
        same = [lot for lot in order if lot[3] == price and lot not in exact]
        order = exact + same + [lot for lot in order if lot not in exact and lot not in same]
    out, left = [], qty
    for free_only in (True, False):
        for lot in order:
            if left <= 0:
                break
            take = min(left, lot[2] - (lot[5] if free_only else 0))
            if take <= 0:
                continue
            lot[2] -= take
            lot[5] = min(lot[5], lot[2])
            left -= take
            same_batch = next((i for i, x in enumerate(out) if x[0] == lot[1]), None)
            if same_batch is None:
                out.append((lot[1], take, lot[3], lot[4]))
            else:
                x = out[same_batch]
                out[same_batch] = (x[0], x[1] + take, x[2], x[3])
    if left > 0:
        # Партії в підрозділі забракло. У формі таке не проведеш (перевірка
        # залишку не пустить), але дані могли прийти з файла старої версії —
        # рядок не губимо: решта йде на останню відому партію.
        if out:
            out[-1] = (out[-1][0], out[-1][1] + left, out[-1][2], out[-1][3])
        else:
            out.append((None, left, None, None))     # партію підбере той, хто пише
    lots[(sub, nomen)] = [lot for lot in rest if lot[2] > 0]
    return out


def _add_lot(lots, sub, nomen, batch, qty, date, price=None, lot_date=None, units=0):
    lots.setdefault((sub, nomen), []).append([date, batch, qty, price, lot_date or date, units])
    lots[(sub, nomen)].sort(key=lambda x: (x[0], x[1]))


def _unit_line(con, unit, nomen_id, milli):
    """Одиниця із заводським номером у рядку: є в реєстрі, тієї самої позиції, 1 шт."""
    row = con.execute("SELECT i.nomen_id, COALESCE(i.serial_no, i.chassis_no, i.inv_no, '') AS no, n.name "
                      "FROM instance i JOIN nomen n ON n.id = i.nomen_id WHERE i.id = ?", (unit,)).fetchone()
    if row is None:
        raise SaveError(f"одиниці з кодом {unit} немає в реєстрі одиниць; оновіть сторінку (F5)")
    if row["nomen_id"] != nomen_id:
        raise SaveError(f"«{row['name']}», зав. № {row['no']}: одиниця іншої позиції")
    if milli != MILLI:
        raise SaveError(f"«{row['name']}», зав. № {row['no']}: одиниця із заводським номером — одна, "
                        f"а в рядку {_qty(milli)}")


def _take_unit(con, lots, sub, nomen, unit, date):
    """Одиниця із заводським номером іде зі своєї партії — тієї, з якою вона
    лежить у відправника за документами. Немає її там за документами — None."""
    row = con.execute("""
        SELECT p.batch_line_id, b.price_kop, b.doc_date FROM posting p
          JOIN batch b ON b.batch_line_id = p.batch_line_id
         WHERE p.instance_id = ? AND p.subdivision_id = ? AND p.doc_date <= ?
         GROUP BY p.batch_line_id HAVING SUM(p.sign * p.qty_milli) > 0
         ORDER BY MAX(p.doc_date) DESC LIMIT 1""", (unit, sub, date)).fetchone()
    if row is None:
        return None
    rest = lots.get((sub, nomen)) or []
    for lot in rest:
        if lot[1] == row[0] and lot[2] > 0:
            lot[2] -= MILLI
            lot[5] = max(0, min(lot[5] - MILLI, lot[2]))
            break
    lots[(sub, nomen)] = [lot for lot in rest if lot[2] > 0]
    return [(row[0], MILLI, row[1], row[2])]


# Скільки документів з паперових журналів один запис може прибрати: вікно
# видаляє по одному, а «Видалити все внесене в програмі…» їх не чіпає взагалі.
MAX_SEED_DROP = 2


def _any_batch(con, cache, nomen_id):
    """Найраніша партія позиції в базі — коли у відправника своєї не лишилося."""
    if nomen_id not in cache:
        row = con.execute("SELECT batch_line_id FROM batch WHERE nomen_id = ? "
                          "ORDER BY doc_date, batch_line_id LIMIT 1", (nomen_id,)).fetchone()
        cache[nomen_id] = row[0] if row else None
    return cache[nomen_id]


def _kop(price):
    return int(round(float(price or 0) * 100)) or None


def _unit_id(v):
    """Id примірника з рядка застосунку: ціле додатне число або нічого."""
    if isinstance(v, bool):
        return None
    if isinstance(v, str) and v.strip().isdigit():
        v = int(v.strip())
    return v if isinstance(v, int) and v > 0 else None


def _wr_row(r):
    """Рядок вибуття старого вигляду — без одержувача ([дата, папір, номер, від
    кого, код, к-сть, …]) — у вигляді решти журналів: одержувач п'ятим полем.
    Старий впізнається за кількістю шостим полем (у новому там код)."""
    r = list(r or [])
    if len(r) > 5 and isinstance(r[5], (int, float)) and not isinstance(r[5], bool):
        r.insert(4, "")
    return r


def _parse_row(journal, r):
    """Рядок журналу застосунку → поля документа й службовий хвіст. Усі три
    журнали — одного вигляду; у вибутті «кому» — одержувач поза частиною
    (акт приймання-передачі в іншу частину), для списання порожньо."""
    r = _wr_row(r) if journal == "writeoffs" else list(r or [])
    date, paper, no, src, dst, code, qty, note, price, lot, doc_id, origin, unit = (r + [None] * 13)[:13]
    if isinstance(doc_id, bool) or not isinstance(doc_id, int) or doc_id <= 0:
        doc_id = None
    return {"date": date or "", "paper": paper, "no": str(no), "src": src or "", "dst": dst or "",
            "code": str(code), "qty": qty, "note": note, "price": price, "lot": lot or "",
            "unit": _unit_id(unit), "doc_id": doc_id, "row": r}


def _merge_lines(journal, lines, detail=False):
    """Рядки документа з погляду застосунку: одна позиція з однією ціною й
    приміткою — один рядок, хоч би на скільки партій розклала його база. Ціна
    важить для приходу; переміщення й списання несуть ціну своєї партії, і вона,
    як і одиниця із заводським номером, важить лише тоді, коли застосунок їх
    назвав (`detail`). Рядок — (код, к-сть, ціна, примітка[, дата партії, одиниця])."""
    tot = {}
    for code, qty, price, note, *rest in lines:
        keep = journal == "incoming" or detail
        unit = (rest[1] if len(rest) > 1 else None) if detail else None
        key = (str(code), round(float(price or 0), 2) if keep else 0.0, note or "", unit or 0)
        tot[key] = round(tot.get(key, 0.0) + float(qty or 0), 3)
    return sorted([c, q, p, n, u] for (c, p, n, u), q in tot.items())


def _names_detail(journal, parsed):
    """Чи назвав застосунок партії чи одиниці: тоді документ звіряється з базою
    й за ними. Рядки, прочитані з бази, несуть і те, й інше; щойно внесені без
    вибору партії — ні, і їх база розкладає від найдавнішої."""
    return any(p.get("unit") for p in parsed) or (
        journal != "incoming" and any(p.get("lot") for p in parsed))


def _current_docs(con):
    """Документи обліку, що вже лежать у базі: id → журнал, шапка й підпис."""
    rows = {}
    for r in con.execute("""
            SELECT d.id, d.doc_date, d.number, k.code AS kind, COALESCE(d.paper, k.name) AS paper,
                   CASE WHEN d.from_subdivision_id IS NULL THEN COALESCE(c.name, '') ELSE COALESCE(sf.name, '') END AS src, CASE WHEN d.from_subdivision_id IS NOT NULL AND d.to_subdivision_id IS NULL THEN COALESCE(c.name, '') ELSE COALESCE(st.name, '') END AS dst,
                   d.from_subdivision_id AS from_sub, d.to_subdivision_id AS to_sub,
                   n.code AS code, l.qty_milli, COALESCE(l.price_kop, b.price_kop) AS price_kop,
                   COALESCE(l.note, '') AS note, l.instance_id
              FROM document d
              JOIN doc_kind k ON k.id = d.kind_id
              LEFT JOIN document_line l ON l.document_id = d.id
              LEFT JOIN nomen n ON n.id = l.nomen_id
              LEFT JOIN batch b ON b.batch_line_id = COALESCE(l.source_line_id, l.id)
              LEFT JOIN subdivision sf ON sf.id = d.from_subdivision_id
              LEFT JOIN subdivision st ON st.id = d.to_subdivision_id
              LEFT JOIN counterparty c ON c.id = d.counterparty_id
             WHERE k.affects_stock = 1"""):
        journal = KIND_OF.get(r["kind"])
        if not journal:
            continue
        head = rows.setdefault(r["id"], {
            "journal": journal, "date": r["doc_date"], "no": r["number"], "src": r["src"],
            "dst": r["dst"], "paper": r["paper"], "from_sub": r["from_sub"], "to_sub": r["to_sub"],
            "lines": []})
        if r["code"] is not None:
            head["lines"].append((r["code"], (r["qty_milli"] or 0) / MILLI, _money(r["price_kop"]),
                                  r["note"], None, r["instance_id"]))
    return rows


def _head_of(journal, date, number, src, dst, paper):
    """Шапка документа з погляду застосунку: вид, дата, номер, сторони, папір."""
    return (journal, date or "", str(number), src or "", dst or "", paper or "")


def _same_lines(journal, base_lines, parsed):
    """Чи ті самі рядки в документі бази й у застосунку. Позиція, для якої
    застосунок назвав партію чи одиницю, звіряється й за ними: інакше заміна
    партії при тій самій кількості виглядала б незміненим документом. Решта — за
    кількістю, приміткою й ціною приходу: рядки, внесені без вибору партії, база
    розклала від найдавнішої, і переписувати їх на кожному збереженні не треба."""
    app, base = {}, {}
    for p in parsed:
        app.setdefault(str(p["code"]), []).append(p)
    for line in base_lines:
        base.setdefault(str(line[0]), []).append(line)
    if set(app) != set(base):
        return False
    for code, rows in app.items():
        detail = _names_detail(journal, rows)
        mine = [(code, p["qty"], p["price"], p["note"], p["lot"], p["unit"]) for p in rows]
        if _merge_lines(journal, mine, detail) != _merge_lines(journal, base[code], detail):
            return False
    return True


def _held_batch(con, sub, nomen_id, exclude, price):
    """Партія позиції, яку підрозділ справді тримає (залишок > 0), крім
    `exclude`: тієї ж ціни, коли є, інакше найдавніша. None — не тримає жодної."""
    row = con.execute("""
        SELECT p.batch_line_id, SUM(p.sign * p.qty_milli) AS q, MIN(b.price_kop) AS price, MIN(b.doc_date) AS since
          FROM posting p JOIN batch b ON b.batch_line_id = p.batch_line_id
         WHERE p.subdivision_id = ? AND p.nomen_id = ? AND p.batch_line_id <> ?
         GROUP BY p.batch_line_id HAVING q > 0
         ORDER BY (price = ?) DESC, since, p.batch_line_id LIMIT 1""", (sub, nomen_id, exclude, price)).fetchone()
    return row[0] if row else None


def _drop_line(con, line_id, nomen_id, prefer=None):
    """Прибрати рядок документа. Якщо з цієї партії вже видавали, ті рядки
    переходять на іншу партію позиції — база вимагає назвати партію, а рядок
    обліку викинути не можна. Партія береться з тих, що тримає сам
    підрозділ-відправник: раніше бралася перша-ліпша партія позиції в усій
    базі, і видача роти отримувала ціну партії складу."""
    deps = con.execute("""SELECT l.id, d.from_subdivision_id AS sub FROM document_line l
                          JOIN document d ON d.id = l.document_id WHERE l.source_line_id = ?""",
                       (line_id,)).fetchall()
    if deps:
        price = con.execute("SELECT price_kop FROM document_line WHERE id = ?", (line_id,)).fetchone()
        price = price[0] if price else None
        anywhere = con.execute("SELECT batch_line_id FROM batch WHERE nomen_id = ? AND batch_line_id <> ? "
                               "ORDER BY doc_date, batch_line_id LIMIT 1", (nomen_id, line_id)).fetchone()
        for dep in deps:
            repl = prefer
            if repl is None and dep["sub"] is not None:
                repl = _held_batch(con, dep["sub"], nomen_id, line_id, price)
            if repl is None:
                repl = anywhere[0] if anywhere else None
            if repl is None:
                name = con.execute("SELECT name FROM nomen WHERE id = ?", (nomen_id,)).fetchone()[0]
                raise SaveError(f"«{name}»: з цього приходу вже видавали, а іншого приходу цієї позиції "
                                "немає. Спершу виправте або видаліть пізніші документи")
            con.execute("UPDATE document_line SET source_line_id = ? WHERE id = ?", (repl, dep["id"]))
    con.execute("DELETE FROM document_line WHERE id = ?", (line_id,))


def _drop_doc(con, doc_id):
    for r in con.execute("SELECT id, nomen_id FROM document_line WHERE document_id = ? "
                         "ORDER BY line_no", (doc_id,)).fetchall():
        _drop_line(con, r["id"], r["nomen_id"])
    con.execute("DELETE FROM document WHERE id = ?", (doc_id,))


def _insert_lines(con, doc_id, from_sub, to_sub, date, lines, lots, batches, orphan, journal):
    """Рядки в документ, що вже має шапку. Видача бере партії від найдавнішої,
    одиниця із заводським номером — свою партію."""
    line_no = con.execute("SELECT COALESCE(MAX(line_no), 0) FROM document_line WHERE document_id = ?",
                          (doc_id,)).fetchone()[0]
    for nid, milli, price_kop, note, p in lines:
        unit = p.get("unit")
        if unit is not None:
            _unit_line(con, unit, nid, milli)
        # Застосунок назвав партію (дата приходу й ціна) — беремо її, решту від найдавнішої.
        prefer = (p["lot"], _kop(p["price"])) if from_sub is not None and p.get("lot") else None
        parts = [(None, milli, price_kop, date)] if from_sub is None else None
        if parts is None and unit is not None:
            parts = _take_unit(con, lots, from_sub, nid, unit, date)
            if parts is None:
                # За документами цієї одиниці у відправника немає (форма такого не
                # пропускає): рядок іде кількістю, а не вигаданим рухом одиниці.
                unit = None
        if parts is None:
            parts = _take(lots, from_sub, nid, milli, date, prefer)
        if from_sub is not None and parts and parts[0][0] is None:
            # Жодної партії цієї позиції у відправника не знайшлося: чіпляємо до
            # найранішої партії позиції взагалі.
            # Перевірка залишків наприкінці запису скаже, чи є з чого видавати.
            # Немає жодного приходу позиції в обліку — видавати нема чого: відмова
            # словами, а не рядок без проводки, який вікно бачило б, а база — ні.
            parts = [(_any_batch(con, batches, nid), parts[0][1], None, None)]
            if parts[0][0] is None:
                name = con.execute("SELECT code || ' ' || name FROM nomen WHERE id = ?", (nid,)).fetchone()[0]
                where = con.execute("SELECT name FROM subdivision WHERE id = ?", (from_sub,)).fetchone()
                raise SaveError(f"«{name}» у «{where[0] if where else from_sub}» на {_date_words(date)}: "
                                "нема чого видавати, приходу цієї позиції в обліку немає")
        for batch, part, lot_price, lot_date in parts:
            line_no += 1
            cur = con.execute(
                "INSERT INTO document_line(document_id, line_no, nomen_id, instance_id, qty_milli, "
                "source_line_id, price_kop, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                (doc_id, line_no, nid, unit, part, batch, price_kop, note))
            if to_sub is not None:
                _add_lot(lots, to_sub, nid, batch or cur.lastrowid, part, date,
                         lot_price if batch else price_kop, lot_date if batch else date,
                         part if unit is not None else 0)


def _line_key(journal, price, unit, detail):
    """Чим рядок відрізняється від сусідніх тієї ж позиції: ціною (приходу — завжди,
    партії — коли її назвали) й одиницею із заводським номером."""
    keep = journal == "incoming" or detail
    return (round(float(price or 0), 2) if keep else 0.0, (unit or 0) if detail else 0)


def _notes_by_line(journal, o, n, detail):
    """Нові примітки рядків бази, коли змінилися лише примітки: [(id рядка, примітка)].

    Рядки бази й застосунку зіставляються за ціною (партії — якщо її назвали) й
    одиницею, далі по черзі за кількістю: база могла розкласти рядок застосунку на
    кілька партій, і кожна частина отримує його примітку. Раніше всім рядкам
    позиції ставилась примітка першого, і примітка другої партії губилася. Не
    зіставляється (кількості чи ціни інші) — None: рядки перепишуться."""
    lot_price = detail and journal != "incoming"
    olds, news = {}, {}
    for r in o:
        key = _line_key(journal, _money(r["lot_price"] if lot_price else r["price_kop"]), r["instance_id"], detail)
        olds.setdefault(key, []).append((r["qty_milli"], r["id"], r["note"] or None))
    for _, q, pk, note, p in n:
        key = _line_key(journal, p["price"] if lot_price else _money(pk), p["unit"], detail)
        news.setdefault(key, []).append([q, note or None])
    if set(olds) != set(news):
        return None
    out = []
    for key, lines in olds.items():
        rows = news[key]
        if sum(q for q, _, _ in lines) != sum(q for q, _ in rows):
            return None
        i, left = 0, rows[0][0]
        for milli, line_id, was in lines:
            if milli > left:
                return None
            if rows[i][1] != was:
                out.append((line_id, rows[i][1]))
            left -= milli
            if left == 0 and i + 1 < len(rows):
                i += 1
                left = rows[i][0]
    return out


def _update_receipt_lines(con, nid, o, n, detail):
    """Прихід: його рядки — партії, з яких видавали далі, тому вони правляться на
    місці й лишаються тими самими партіями. Рядок одиниці із заводським номером
    правиться у своєму рядку бази, решта — по черзі. Повертає рядки, яким рядка
    бази не знайшлося (їх треба вставити)."""
    by_unit = {r["instance_id"]: r for r in o if r["instance_id"]} if detail else {}
    pairs, spare_n, taken = [], [], set()
    for row in n:
        r = by_unit.get(row[4]["unit"]) if detail and row[4]["unit"] else None
        if r is not None and r["id"] not in taken:
            pairs.append((r, row))
            taken.add(r["id"])
        else:
            spare_n.append(row)
    spare_o = [r for r in o if r["id"] not in taken and not (detail and r["instance_id"])]
    gone = [r for r in o if r["id"] not in taken and detail and r["instance_id"]]
    pairs += list(zip(spare_o, spare_n))
    kept = None
    for r, (_, milli, price_kop, note, p) in pairs:
        if detail:
            unit = p["unit"]
            if unit is not None:
                _unit_line(con, unit, nid, milli)
        else:
            unit = r["instance_id"] if milli == MILLI else None
        if (r["qty_milli"], r["price_kop"], r["note"] or None, r["instance_id"]) != (milli, price_kop, note, unit):
            con.execute("UPDATE document_line SET qty_milli = ?, price_kop = ?, note = ?, instance_id = ? "
                        "WHERE id = ?", (milli, price_kop, note, unit, r["id"]))
        kept = kept or r["id"]
    for r in spare_o[len(spare_n):] + gone:
        _drop_line(con, r["id"], nid, prefer=kept)
    return spare_n[len(spare_o):]


def _update_doc(con, doc_id, key, g, cur, nomens, sides, orphan):
    """Виправлення документа на місці: шапка — коли змінилася, рядки — лише ті
    позиції, що справді змінилися. Повертає рядки, які треба перевзяти з партій."""
    journal, date, no, src, dst = key
    party, from_sub, to_sub = sides(journal, src, dst)
    if (str(no), date, g["paper"] or "", src or "", dst or "") != (
            str(cur["no"]), cur["date"], cur["paper"] or "", cur["src"] or "", cur["dst"] or ""):
        # Одержувач акта передачі в іншу частину — поле «кому» у вибутті; у
        # переміщенні контрагента форма не має, і правка дати його не стирає.
        con.execute("UPDATE document SET number = ?, doc_date = ?, paper = ?, "
                    "counterparty_id = CASE WHEN ? THEN counterparty_id ELSE ? END, "
                    "from_subdivision_id = ?, to_subdivision_id = ? WHERE id = ?",
                    (no, date, g["paper"], journal == "movement", party, from_sub, to_sub, doc_id))
    old = {}
    for r in con.execute("SELECT l.id, l.nomen_id, l.qty_milli, l.price_kop, COALESCE(l.note, '') AS note, "
                         "l.instance_id, COALESCE(l.price_kop, b.price_kop) AS lot_price FROM document_line l "
                         "LEFT JOIN batch b ON b.batch_line_id = COALESCE(l.source_line_id, l.id) "
                         "WHERE l.document_id = ? ORDER BY l.line_no", (doc_id,)):
        old.setdefault(r["nomen_id"], []).append(dict(r))
    new = {}
    for p in g["parsed"]:
        nid = nomens.get(p["code"])
        if nid is None:
            orphan(journal, p)
            continue
        new.setdefault(nid, []).append((nid, _milli(p["qty"]), _kop(p["price"]) if journal == "incoming"
                                        else None, p["note"] or None, p))
    # Інший відправник — партії всіх рядків беруться заново, уже в нього.
    moved = from_sub is not None and from_sub != cur["from_sub"]
    left = []
    for nid in sorted(set(old) | set(new)):
        o, n = old.get(nid, []), new.get(nid, [])
        # Назвали партію чи одиницю — важать і вони: інша партія тієї ж кількості теж правка.
        detail = _names_detail(journal, [p for *_, p in n])
        lot_price = detail and journal != "incoming"
        was = _merge_lines(journal, [(nid, r["qty_milli"] / MILLI,
                                      _money(r["lot_price"] if lot_price else r["price_kop"]), r["note"],
                                      None, r["instance_id"]) for r in o], detail)
        now = _merge_lines(journal, [(nid, q / MILLI, p["price"] if lot_price else _money(pk), note or "",
                                      None, p["unit"]) for _, q, pk, note, p in n], detail)
        if was == now and not moved:
            continue
        if from_sub is None:
            left.extend(_update_receipt_lines(con, nid, o, n, detail))
            continue
        notes = None if moved or not o else _notes_by_line(journal, o, n, detail)
        if notes is not None:
            # Ті самі кількості з тих самих партій — змінилися лише примітки: партій не чіпаємо.
            for line_id, note in notes:
                con.execute("UPDATE document_line SET note = ? WHERE id = ?", (note or None, line_id))
            continue
        for r in o:
            _drop_line(con, r["id"], nid)
        left.extend(n)
    return left


_ISO_DATE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


def _check_row(journal, p, subs):
    """Рядок, який форма не пропустила б, база не приймає мовчки: без номера,
    з «|» у номері (за ним застосунок знаходить документ), з датою не за
    календарем, з кількістю не більшою за нуль чи зі стороною, якої немає в
    довіднику, — відмова словами. Інакше рядок губився б без сліду або лягав
    би документом «нікуди»."""
    where = f"{JOURNAL_NAMES.get(journal, journal)} {('№' + p['no']) if p['no'].strip() else 'без номера'} від {p['date'] or '—'}"
    if not p["no"].strip():
        raise SaveError(f"{where}: не вказано номер документа")
    if "|" in p["no"]:
        raise SaveError(f"{where}: у номері документа не можна вживати «|»")
    try:
        ok = bool(_ISO_DATE.match(p["date"] or "")) and datetime.date.fromisoformat(p["date"]) is not None
    except ValueError:
        ok = False
    if not ok:
        raise SaveError(f"{where}: дата документа не за календарем")
    try:
        milli = _milli(p["qty"])
    except (TypeError, ValueError):
        milli = 0
    if milli <= 0:
        raise SaveError(f"{where}, «{p['code']}»: кількість має бути більшою за нуль (вказано {p['qty']!r})")
    if journal == "incoming":
        if p["dst"] and p["dst"] not in subs:
            raise SaveError(f"{where}: одержувача «{p['dst']}» немає в довіднику підрозділів")
    else:
        if p["src"] not in subs:
            raise SaveError(f"{where}: відправника «{p['src']}» немає в довіднику підрозділів")
        if journal == "movement":
            if not p["dst"]:
                raise SaveError(f"{where}: не вказано одержувача")
            if p["dst"] not in subs:
                raise SaveError(f"{where}: одержувача «{p['dst']}» немає в довіднику підрозділів")
            if p["dst"] == p["src"]:
                raise SaveError(f"{where}: відправник і одержувач збігаються")


JOURNAL_NAMES = {"incoming": "прихід", "movement": "накладна", "writeoffs": "вибуття"}


def _save_docs(con, docs):
    """Документи застосунку → база. Перелік повний: чого в ньому немає, того
    немає й в обліку. Незмінені не чіпаються, змінені оновлюються на місці,
    нові додаються, зайві видаляються з передачею партій далі."""
    if docs is None:
        return
    cache, batches = {}, {}

    def counterparty(name):
        kind = con.execute("SELECT id FROM counterparty_kind ORDER BY id LIMIT 1").fetchone()
        if kind is None:                     # база без довідника видів контрагентів
            kind = (con.execute("INSERT INTO counterparty_kind(code, name) "
                                "VALUES('інше', 'інше')").lastrowid,)
        cur = con.execute("INSERT INTO counterparty(name, kind_id) VALUES(?, ?)", (name, kind[0]))
        return cur.lastrowid

    nomens = dict(con.execute("SELECT code, id FROM nomen"))
    subs = dict(con.execute("SELECT name, id FROM subdivision"))
    kinds = dict(con.execute("SELECT code, id FROM doc_kind"))
    for code, name in (("act_in", "Акт приймання"), ("invoice", "Накладна"),
                       ("writeoff", "Акт списання")):
        if code not in kinds:                # чиста база без довідника видів
            cur = con.execute("INSERT INTO doc_kind(code, name, affects_stock) VALUES(?, ?, 1)",
                              (code, name))
            kinds[code] = cur.lastrowid

    def orphan(journal, p):
        """Позиції немає в довіднику бази — рядок лишається в налаштуваннях,
        поки вона не з'явиться."""
        con.execute("INSERT INTO app_setting(key, value) VALUES(?, ?) "
                    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                    (f"orphan_line:{journal}:{p['date']}:{p['no']}:{p['code']}",
                     json.dumps(p["row"], ensure_ascii=False)))

    def sides(journal, src, dst):
        """Сторони документа: постачальник і одержувач для приходу, відправник
        і одержувач для решти."""
        if journal == "incoming":
            party = _ref(con, cache, "counterparty", src.strip(), counterparty) if src.strip() else None
            return party, None, subs.get(dst or "склад")
        if journal == "writeoffs":
            # Акт приймання-передачі в іншу частину: з балансу майно йде так само,
            # як за актом списання, а одержувач — контрагент документа.
            party = _ref(con, cache, "counterparty", dst.strip(), counterparty) if (dst or "").strip() else None
            return party, subs.get(src), None
        return None, subs.get(src), (subs.get(dst) if dst else None)

    # 1. Рядки застосунку — у документи, за датами; у межах дня прихід перед
    #    видачею, інакше видача тим самим числом шукає партію, якої ще немає.
    rows = []
    for journal, arr in docs.items():
        if journal not in JOURNALS:
            continue
        for n, r in enumerate(arr or []):
            p = _parse_row(journal, r)
            _check_row(journal, p, subs)
            rows.append((p["date"], JOURNAL_ORDER[journal], n, journal, p))
    rows.sort(key=lambda x: (x[0], x[1], x[2]))
    grouped, order = {}, []
    for _, _, _, journal, p in rows:
        key = (journal, p["date"], p["no"], p["src"], p["dst"])
        # Рядки одного запису бази — один документ, навіть коли в базі є його
        # «близнюк» із тією самою шапкою: за шапкою вони злились би в один, і
        # другий документ зник би разом зі сканами. Без id — групуємо за шапкою.
        gid = (journal, "#", p["doc_id"]) if p["doc_id"] is not None else key
        g = grouped.get(gid)
        if g is None:
            g = grouped[gid] = {"journal": journal, "paper": p["paper"], "id": p["doc_id"],
                                "key": key, "parsed": []}
            order.append(gid)
        g["parsed"].append(p)

    # 2. Що з цього вже лежить у базі: незмінене, виправлене, нове.
    have = _current_docs(con)
    by_head = {}
    for doc_id, h in have.items():
        by_head.setdefault(_head_of(h["journal"], h["date"], h["no"], h["src"], h["dst"], h["paper"]),
                           []).append(doc_id)
    claimed, changed, fresh = set(), [], []
    for gid in order:
        g = grouped[gid]
        key = g["key"]
        # Свій запис — першим: однакових за шапкою документів у базі буває кілька.
        cands = sorted((i for i in by_head.get(_head_of(g["journal"], *key[1:], g["paper"]), ())
                        if i not in claimed), key=lambda i: i != g["id"])
        same = next((i for i in cands if _same_lines(g["journal"], have[i]["lines"], g["parsed"])), None)
        if same is not None:
            claimed.add(same)                                # не змінився — не чіпаємо
        elif g["id"] in have and g["id"] not in claimed:
            claimed.add(g["id"])
            changed.append((key, g))                         # свій запис, але з правками
        else:
            fresh.append((key, g))

    # 3. Зайве — геть: спершу видачі й списання, потім приходи — так партія
    #    приходу, що зникає разом зі своїми видачами, нікому не передається;
    #    решту видач переводимо на інші приходи позиції.
    stale = [i for i in have if i not in claimed]
    # Документи з паперових журналів вікно видаляє по одному (з підтвердженням);
    # десятки за раз зникають лише при відновленні з чужої чи неповної копії —
    # такий запис не проходить, облік лишається.
    seed_gone = [i for i in stale if con.execute("SELECT source FROM document WHERE id = ?", (i,)).fetchone()[0] == "seed"]
    if len(seed_gone) > MAX_SEED_DROP:
        raise SaveError(f"запис вилучає {len(seed_gone)} документів з паперових журналів разом — так буває лише "
                        "при відновленні з чужої чи неповної копії; облік не змінено. Потрібну копію "
                        "відновлюйте через ⚙ → «Автоматичні копії…»")
    for doc_id in sorted(stale, key=lambda i: (have[i]["from_sub"] is None, have[i]["date"])):
        _drop_doc(con, doc_id)

    # 4. Виправлення — на місці.
    pending = []
    for key, g in changed:
        left = _update_doc(con, g["id"], key, g, have[g["id"]], nomens, sides, orphan)
        if left:
            pending.append((key, g, g["id"], left))

    # 5. Нове й перевзяте — за датами; партії читаються один раз, уже без зайвого.
    if not fresh and not pending:
        _sync_unit_places(con)
        return
    lots = _lots(con)
    pos = {id(grouped[gid]): i for i, gid in enumerate(order)}
    work = [(key, g, None, None) for key, g in fresh] + pending
    work.sort(key=lambda w: (w[0][1], JOURNAL_ORDER[w[0][0]], pos[id(w[1])]))
    for key, g, doc_id, lines in work:
        journal, date, no, src, dst = key
        party, from_sub, to_sub = sides(journal, src, dst)
        if doc_id is None:
            cur = con.execute(
                "INSERT INTO document(kind_id, number, doc_date, counterparty_id, "
                "from_subdivision_id, to_subdivision_id, source, paper) "
                "VALUES(?, ?, ?, ?, ?, ?, 'program', ?)",
                (kinds[JOURNALS[journal]], no, date, party, from_sub, to_sub, g["paper"]))
            doc_id = cur.lastrowid
            lines = []
            for p in g["parsed"]:
                nid = nomens.get(p["code"])
                if nid is None:
                    orphan(journal, p)
                    continue
                lines.append((nid, _milli(p["qty"]), _kop(p["price"]) if journal == "incoming" else None,
                              p["note"] or None, p))
        _insert_lines(con, doc_id, from_sub, to_sub, date, lines, lots, batches, orphan, journal)
    _sync_unit_places(con)


def _sync_unit_places(con):
    """Місце одиниці із заводським номером визначають документи: коли накладна
    називає номер, за нею переїжджає й інвентарний номер. Інакше реєстр номерів
    показував би кухню там, де її вже немає, а перевірка бази — суперечність."""
    holder = ("SELECT p.subdivision_id FROM posting p WHERE p.instance_id = instance_assignment.instance_id "
              "GROUP BY p.subdivision_id HAVING SUM(p.sign * p.qty_milli) > 0")
    con.execute(
        f"UPDATE instance_assignment SET subdivision_id = ({holder}), "
        "on_date = COALESCE((SELECT MAX(p.doc_date) FROM posting p "
        "                     WHERE p.instance_id = instance_assignment.instance_id AND p.sign = 1), on_date) "
        f"WHERE subdivision_id <> ({holder})")


def _load_docs(con):
    """Три журнали застосунку з усіх документів обліку — з бази й внесених тут.

    Один рядок документа міг лягти в базу кількома — по партіях, з яких пішло
    майно; для застосунку це рядок на партію: звірка знає, яка саме поїхала.
    Хвіст рядка — дата партії, id документа й походження (див. вище)."""
    out = {"incoming": [], "movement": [], "writeoffs": []}
    seen = {}
    for r in con.execute("""
            SELECT d.id AS doc_id, d.source, d.doc_date, COALESCE(d.paper, k.name) AS paper,
                   d.number, k.code AS kind,
                   CASE WHEN d.from_subdivision_id IS NULL THEN COALESCE(c.name, '') ELSE COALESCE(sf.name, '') END AS src, CASE WHEN d.from_subdivision_id IS NOT NULL AND d.to_subdivision_id IS NULL THEN COALESCE(c.name, '') ELSE COALESCE(st.name, '') END AS dst,
                   n.code AS code, l.qty_milli, COALESCE(l.note, '') AS note, l.instance_id,
                   COALESCE(l.price_kop, b.price_kop) AS price_kop, COALESCE(b.doc_date, '') AS lot
              FROM document_line l
              JOIN document d ON d.id = l.document_id
              JOIN doc_kind k ON k.id = d.kind_id
              JOIN nomen n ON n.id = l.nomen_id
              LEFT JOIN batch b ON b.batch_line_id = COALESCE(l.source_line_id, l.id)
              LEFT JOIN subdivision sf ON sf.id = d.from_subdivision_id
              LEFT JOIN subdivision st ON st.id = d.to_subdivision_id
              LEFT JOIN counterparty c ON c.id = d.counterparty_id
             WHERE k.affects_stock = 1
             ORDER BY d.doc_date, d.id, l.line_no"""):
        journal = KIND_OF.get(r["kind"])
        if not journal:
            continue
        price = _money(r["price_kop"])
        qi = 6
        key = (journal, r["doc_id"], r["code"], r["note"], price, r["lot"], r["instance_id"])
        if key in seen:
            row = seen[key]
            row[qi] = _qty(_milli(row[qi]) + r["qty_milli"])
            continue
        # Одиниця із заводським номером — останнім полем, лише коли вона є.
        tail = [r["lot"], r["doc_id"], r["source"] or "seed"] + ([r["instance_id"]] if r["instance_id"] else [])
        row = [r["doc_date"], r["paper"], r["number"], r["src"], r["dst"],
               r["code"], _qty(r["qty_milli"]), r["note"], price] + tail
        seen[key] = row
        out[journal].append(row)
    for key, value in con.execute("SELECT key, value FROM app_setting WHERE key LIKE 'orphan_line:%'"):
        row = json.loads(value)
        parts = key.split(":")
        journal = parts[1] if len(parts) > 1 and parts[1] in out else (
            "movement" if len(row) == 9 else "writeoffs")
        out[journal].append(_wr_row(row) if journal == "writeoffs" else row)
    return out


def doc_ids(con):
    """Документи, внесені в програмі, з їхніми id у базі: [журнал, дата, номер,
    від кого, кому, id]. Вікно програми після запису вписує id у свої рядки, тож
    виправлення щойно проведеного документа оновлює його запис, а не видаляє й
    вставляє документ наново (з партіями, з яких уже видали)."""
    out = []
    for r in con.execute("""
            SELECT d.id, k.code AS kind, d.doc_date, d.number,
                   CASE WHEN d.from_subdivision_id IS NULL THEN COALESCE(c.name, '') ELSE COALESCE(sf.name, '') END AS src, CASE WHEN d.from_subdivision_id IS NOT NULL AND d.to_subdivision_id IS NULL THEN COALESCE(c.name, '') ELSE COALESCE(st.name, '') END AS dst
              FROM document d
              JOIN doc_kind k ON k.id = d.kind_id
              LEFT JOIN subdivision sf ON sf.id = d.from_subdivision_id
              LEFT JOIN subdivision st ON st.id = d.to_subdivision_id
              LEFT JOIN counterparty c ON c.id = d.counterparty_id
             WHERE k.affects_stock = 1 AND d.source = 'program'
             ORDER BY d.id"""):
        journal = KIND_OF.get(r["kind"])
        if journal:
            out.append([journal, r["doc_date"], r["number"], r["src"], r["dst"], r["id"]])
    return out


# ------------------------------------------------------- прості переліки

# collection -> (таблиця, [(поле застосунку, колонка)])
SIMPLE = {
    "destroyed": ("app_destroyed", [("id", "id"), ("date", "event_date"), ("sub", "subdivision"),
                                    ("code", "code"), ("qty", "qty_milli!"), ("report", "report_no"),
                                    ("reportDate", "report_date"), ("act", "act_no"),
                                    ("status", "status"), ("note", "note")]),
    "scans": ("app_file", [("id", "id"), ("key", "target"), ("date", "doc_date"), ("no", "doc_no"),
                           ("file", "file_name"), ("path", "rel_path"), ("mime", "mime"),
                           ("size", "size_bytes")]),
}


def _columns(spec):
    """Колонка й вид перетворення: `!` — кількість у тисячних, `?` — прапорець."""
    for field, col in spec:
        kind = col[-1] if col[-1] in "!?" else ""
        yield field, col.rstrip("!?"), kind


def _save_simple(con, name, rows):
    table, spec = SIMPLE[name]
    known = {f for f, _, _ in _columns(spec)}
    cols = [c for _, c, _ in _columns(spec)]
    con.execute(f"DELETE FROM {table}")
    for pos, rec in enumerate(rows or []):
        values = []
        for field, _, kind in _columns(spec):
            v = rec.get(field)
            if v is None and field not in rec:
                values.append(None)                   # поля не було — так і запишемо
                continue
            if kind == "!":
                v = _milli(v)
            elif kind == "?":
                v = 1 if v else 0
            values.append(v)
        con.execute(
            f"INSERT INTO {table}({', '.join(cols)}, pos, extra) "
            f"VALUES({', '.join('?' * len(cols))}, ?, ?)",
            (*values, pos, _extra(rec, known)))


def _load_simple(con, name):
    table, spec = SIMPLE[name]
    order = "pos" if name != "items" else "pos"
    out = []
    for row in con.execute(f"SELECT * FROM {table} ORDER BY {order}"):
        rec = {}
        for field, col, kind in _columns(spec):
            v = row[col]
            if v is None:
                continue
            rec[field] = _qty(v) if kind == "!" else (bool(v) if kind == "?" else v)
        out.append(_with_extra(rec, row["extra"]))
    return out


# ------------------------------------------------------------------- люди
# Довідники живуть у своїх таблицях бази — тих самих, які наповнює збірка з
# паперів. Програма їх і читає, і пише: поділу «база / моє» немає.
#
# `ext_id` — під яким ідентифікатором запис знає програма. Базовий рядок
# застосунок бачить як «b12» (номер рядка), свій — під власним; і те, й те
# лишається незмінним між запусками, інакше посилання (МВО на людину,
# підписанти опису) розʼїхалися б після першого ж перезапуску.

def _row_id(app_id):
    """Номер рядка бази за ідентифікатором застосунку («b12» → 12).

    Стан попередніх версій позначав записи довідників за видом: «bm5» — МВО,
    «bo3» — посадовець, «bl1» — дислокація. Це теж номери рядків тієї ж бази,
    тож перенесення має їх упізнати, інакше воно заводило б дублікати."""
    text = str(app_id or "")
    for prefix in ("bm", "bo", "bl", "b"):
        if text.startswith(prefix) and text[len(prefix):].isdigit():
            return int(text[len(prefix):])
    return None


def _keep(con, table, rows, write, extra_where="", match=None):
    """Записати перелік у таблицю: що є — оновити, чого немає — завести, зайве
    прибрати. Порядок рядків застосунку зберігається в тому ж порядку id.

    `match` шукає рядок за природним ключем (назвою підрозділу, кодом позиції) —
    коли запис прийшов без ідентифікатора бази."""
    plan = []
    for pos, rec in enumerate(rows or []):
        app_id = rec.get("id")
        row_id = _row_id(app_id)
        if row_id is not None:
            exists = con.execute(f"SELECT 1 FROM {table} WHERE id = ?", (row_id,)).fetchone()
        else:
            got = con.execute(f"SELECT id FROM {table} WHERE ext_id = ?", (str(app_id),)).fetchone()
            if not got and match:
                got = match(rec)
            row_id, exists = (got[0], True) if got else (None, False)
        plan.append((pos, rec, row_id, bool(exists)))

    def drop(ids):
        """Прибрати рядки; той, на який щось посилається (документ, опис,
        призначення), база видалити не дасть — його повертаємо."""
        left = []
        for row_id in ids:
            con.execute("SAVEPOINT drop_row")
            try:
                con.execute(f"DELETE FROM {table} WHERE id = ?", (row_id,))
                con.execute("RELEASE drop_row")
            except sqlite3.IntegrityError:
                con.execute("ROLLBACK TO drop_row")
                con.execute("RELEASE drop_row")
                left.append(row_id)
        return left

    held = []
    if rows is not None:
        # Зайве — геть ДО запису: новий запис на місці прибраного (та сама дата,
        # той самий строк норми) інакше впирався б у старий, і база відхиляла б
        # усе збереження. Що не вдалося прибрати зараз (на нього ще посилаються
        # рядки, які цей самий запис переведе), пробуємо ще раз наприкінці.
        keep = [row_id for *_, row_id, exists in plan if exists and row_id is not None]
        marks = ",".join("?" * len(keep))
        held = drop([r[0] for r in con.execute(
            f"SELECT id FROM {table} WHERE id NOT IN ({marks}) {extra_where}", keep)])
    seen = []
    for pos, rec, row_id, exists in plan:
        row_id = write(rec, row_id, exists, pos)
        if row_id is not None:
            seen.append(row_id)
    drop([row_id for row_id in held if row_id not in seen])
    return seen


def _full_name(rec):
    given = (rec.get("name") or "").strip()
    surname = (rec.get("surname") or "").strip()
    return (f"{given} {surname}".strip() or surname or given or "—")


def _save_people(con, people):
    if people is None:
        return
    ids = []

    def write(rec, row_id, exists, pos):
        hist = rec.get("hist") or []
        last = hist[-1] if hist else {}
        note = (rec.get("note") or "").strip()
        cols = dict(rank=last.get("rank") or None, full_name=_full_name(rec),
                    position=last.get("pos") or None, surname=(rec.get("surname") or "").strip(),
                    given_name=(rec.get("name") or "").strip() or None,
                    patronymic=(rec.get("patr") or "").strip() or None,
                    is_active=0 if note == "не служить" else 1,
                    app_note=None if note in ("", "не служить") else note)
        if exists:
            if not _same_row(con, "person", row_id, cols):
                con.execute(f"UPDATE person SET {', '.join(k + ' = ?' for k in cols)} WHERE id = ?",
                            (*cols.values(), row_id))
        else:
            keys = list(cols) + (["id"] if row_id is not None else []) + ["ext_id"]
            vals = list(cols.values()) + ([row_id] if row_id is not None else []) \
                + [None if _row_id(rec.get("id")) is not None else str(rec.get("id"))]
            cur = con.execute(f"INSERT INTO person({', '.join(keys)}) "
                              f"VALUES({', '.join('?' * len(keys))})", vals)
            row_id = row_id or cur.lastrowid
        # Запис історії без дати (людина, заведена до історії звань) у базу не
        # лягає: дата там обов'язкова, а звання й посада лишаються в самій картці.
        want = [(h.get("date"), h.get("rank") or None, h.get("pos") or None,
                 h.get("basis") or None) for h in hist if h.get("date")]
        have = [tuple(r) for r in con.execute(
            "SELECT on_date, rank, position, basis FROM person_history "
            "WHERE person_id = ? ORDER BY id", (row_id,))]
        if want != have:
            con.execute("DELETE FROM person_history WHERE person_id = ?", (row_id,))
            for h in want:
                con.execute("INSERT INTO person_history(person_id, on_date, rank, position, basis) "
                            "VALUES(?, ?, ?, ?, ?)", (row_id, *h))
        return row_id

    ids = _keep(con, "person", people, write)
    return ids


def _save_responsible(con, mvo, officials, cmdrs=None):
    subs = dict(con.execute("SELECT name, id FROM subdivision"))
    people = _person_ids(con)

    def held(table):
        """МВО й командир підрозділу — той самий запис у своїй таблиці."""
        def write(rec, row_id, exists, pos):
            sub = subs.get(rec.get("sub"))
            person = people.get(str(rec.get("person")))
            if sub is None or person is None:
                return None
            cols = dict(subdivision_id=sub, person_id=person, valid_from=rec.get("from") or None,
                        valid_to=rec.get("to") or None, note=rec.get("note") or None)
            return _write_row(con, table, rec, row_id, exists, cols)
        return write

    mvo_write = held("responsible")

    def off_write(rec, row_id, exists, pos):
        person = people.get(str(rec.get("person")))
        if person is None:
            return None
        cols = dict(role=rec.get("role") or "", person_id=person,
                    valid_from=rec.get("from") or None, valid_to=rec.get("to") or None,
                    note=rec.get("note") or None)
        return _write_row(con, "official", rec, row_id, exists, cols)

    if mvo is not None:
        _keep(con, "responsible", mvo, mvo_write)
    if cmdrs is not None:
        _keep(con, "commander", cmdrs, held("commander"))
    if officials is not None:
        _keep(con, "official", officials, off_write)


def _same_row(con, table, row_id, cols):
    """Чи такий рядок уже лежить у базі — до поля."""
    got = con.execute(f"SELECT {', '.join(cols)} FROM {table} WHERE id = ?", (row_id,)).fetchone()
    if got is None:
        return False
    return all(got[k] == v for k, v in cols.items())


def _write_row(con, table, rec, row_id, exists, cols):
    if exists:
        # Зайвий UPDATE — це рядок у журналі аудиту й сторінка у файлі. Коли
        # застосунок надсилає модель цілком, таких «оновлень нічим» більшість.
        if not _same_row(con, table, row_id, cols):
            con.execute(f"UPDATE {table} SET {', '.join(k + ' = ?' for k in cols)} WHERE id = ?",
                        (*cols.values(), row_id))
        return row_id
    keys = list(cols) + (["id"] if row_id is not None else []) + ["ext_id"]
    vals = list(cols.values()) + ([row_id] if row_id is not None else []) \
        + [None if _row_id(rec.get("id")) is not None else str(rec.get("id"))]
    cur = con.execute(f"INSERT INTO {table}({', '.join(keys)}) "
                      f"VALUES({', '.join('?' * len(keys))})", vals)
    return row_id or cur.lastrowid


def _person_ids(con):
    """Ідентифікатор застосунку → номер рядка людини."""
    out = {}
    for r in con.execute("SELECT id, ext_id FROM person"):
        out["b" + str(r["id"])] = r["id"]
        if r["ext_id"]:
            out[r["ext_id"]] = r["id"]
    return out


def _save_locations(con, rows):
    if rows is None:
        return

    def write(rec, row_id, exists, pos):
        cols = dict(valid_from=rec.get("from") or None, place=rec.get("place") or "",
                    note=rec.get("note") or None)
        return _write_row(con, "unit_location", rec, row_id, exists, cols)

    # Рядок без місця («+ Нове місце» натиснули й пішли з вкладки) — не дислокація.
    _keep(con, "unit_location", [r for r in rows if str(r.get("place") or "").strip()], write)


def _save_subdivisions(con, rows):
    if rows is None:
        return
    kinds = dict(con.execute("SELECT code, id FROM subdivision_kind"))

    def kind_id(name):
        if name not in kinds:
            cur = con.execute("INSERT INTO subdivision_kind(code, name) VALUES(?, ?)", (name, name))
            kinds[name] = cur.lastrowid
        return kinds[name]

    # Спершу самі вузли, потім підпорядкування: батько може стояти в переліку
    # нижче за дитину.
    def write(rec, row_id, exists, pos):
        cols = dict(name=rec.get("name") or "", kind_id=kind_id(rec.get("type") or "підрозділ"),
                    sort=pos + 1, is_active=0 if rec.get("active") is False else 1,
                    note=rec.get("note") or None)
        was = con.execute("SELECT name FROM subdivision WHERE id = ?", (row_id,)).fetchone() if exists else None
        row_id = _write_row(con, "subdivision", rec, row_id, exists, cols)
        # Назву виправили на місці — стара лишається іншою назвою того самого
        # підрозділу: за нею його впізнають у старих паперах і журналах 3.0.
        if was and was[0] and was[0] != cols["name"]:
            con.execute("INSERT OR IGNORE INTO subdivision_alias(subdivision_id, name, source) "
                        "VALUES(?, ?, 'стара назва')", (row_id, was[0]))
        return row_id

    _keep(con, "subdivision", rows, write,
          match=lambda rec: con.execute("SELECT id FROM subdivision WHERE name = ?",
                                        (rec.get("name") or "",)).fetchone())
    by_name = dict(con.execute("SELECT name, id FROM subdivision"))
    now = dict(con.execute("SELECT id, parent_id FROM subdivision"))
    # Підпорядкування по колу («А → Б → А») дерево підрозділів не витримує:
    # рекурсивний запит subdivision_tree не закінчується. Такий запис — відмова.
    want = dict(now)
    for rec in rows:
        mine = by_name.get(rec.get("name"))
        if mine is not None:
            want[mine] = by_name.get(rec.get("parent"))
    names = {v: k for k, v in by_name.items()}
    for start in want:
        seen, cur = [], start
        while cur is not None and cur not in seen:
            seen.append(cur)
            cur = want.get(cur)
        if cur is not None:
            loop = seen[seen.index(cur):] + [cur]
            raise SaveError("підрозділи підпорядковані по колу: "
                            + " → ".join(f"«{names.get(i, i)}»" for i in loop))
    for rec in rows:
        parent = by_name.get(rec.get("parent"))
        mine = by_name.get(rec.get("name"))
        # Підпорядкування ставимо другим заходом (батько міг стояти нижче в
        # переліку), але чіпаємо лише те, що справді змінилося.
        if mine is not None and now.get(mine) != parent:
            con.execute("UPDATE subdivision SET parent_id = ? WHERE id = ?", (parent, mine))


def _save_norms(con, rows):
    """Норми — і табельні, і на код служби — в одній таблиці зі строками дії."""
    if rows is None:
        return
    subs = dict(con.execute("SELECT name, id FROM subdivision"))
    nomens = dict(con.execute("SELECT code, id FROM nomen"))
    lines = {}
    for r in con.execute("""SELECT rl.id, f.code AS form, rl.name FROM report_line rl
                              JOIN report_form f ON f.id = rl.form_id"""):
        lines[(r["form"], r["name"])] = r["id"]

    def write(rec, row_id, exists, pos):
        sub = subs.get(rec.get("sub"))
        if sub is None:
            return None
        nomen = nomens.get(str(rec.get("code"))) if rec.get("code") else None
        line = lines.get((rec.get("form"), rec.get("line"))) if rec.get("line") else None
        if nomen is None and line is None:
            return None
        cols = dict(subdivision_id=sub, nomen_id=nomen, report_line_id=line,
                    qty_milli=_milli(rec.get("qty")),
                    # «Без дати» означає «від початку обліку» — база тримає це
                    # датою відліку, інакше норму не було б із чим порівняти.
                    valid_from=rec.get("from") or OPENING,
                    valid_to=rec.get("to") or None, basis=rec.get("basis") or None)
        return _write_row(con, "norm", rec, row_id, exists, cols)

    _keep(con, "norm", rows, write)


def _save_items(con, rows):
    """Позиції, заведені в програмі, — у довіднику номенклатури."""
    if rows is None:
        return
    groups = dict(con.execute("SELECT code, id FROM nomen_group"))
    uoms = dict(con.execute("SELECT code, id FROM uom"))

    def uom_id(code):
        code = (code or "шт").strip() or "шт"
        if code not in uoms:
            cur = con.execute("INSERT INTO uom(code, name) VALUES(?, ?)", (code, code))
            uoms[code] = cur.lastrowid
        return uoms[code]

    for rec in rows:
        code = str(rec.get("code") or "").strip()
        if not code:
            continue
        grp = groups.get(rec.get("group")) or next(iter(groups.values()))
        cols = dict(name=rec.get("name") or code, group_id=grp, uom_id=uom_id(rec.get("unit")),
                    is_fixed_asset=1 if rec.get("nonrev") else 0,
                    app_price_kop=int(round(float(rec.get("price") or 0) * 100)) or None,
                    source="program")
        # Номер ФЕС, примітка, старі коди й архів — лише коли картка їх несе:
        # запис, збережений попередньою версією, їх не мав, і стирати їх не можна.
        for field, col in (("fes", "fes_code"), ("note", "note"), ("old", "old_code"), ("archived", "archived_at")):
            if field in rec:
                cols[col] = str(rec.get(field) or "").strip() or None
        got = con.execute("SELECT id FROM nomen WHERE code = ?", (code,)).fetchone()
        if got:
            # Правка позиції з паперів служби (вид обліку, назва, одиниця) не
            # робить її «заведеною в програмі»: походження лишається, а з ним
            # і номер ФЕС, і захист від видалення разом із внесеними.
            upd = {k: v for k, v in cols.items() if k != "source"}
            if not _same_row(con, "nomen", got[0], upd):
                con.execute(f"UPDATE nomen SET {', '.join(k + ' = ?' for k in upd)} WHERE id = ?",
                            (*upd.values(), got[0]))
        else:
            keys = list(cols) + ["code"]
            con.execute(f"INSERT INTO nomen({', '.join(keys)}) "
                        f"VALUES({', '.join('?' * len(keys))})", (*cols.values(), code))
    # Позиція, яку прибрали в програмі, зникає — але лише якщо на неї нічого не
    # посилається; інакше база сама не дасть (є рядки документів), і тоді вона
    # лишається, а не зупиняє все збереження.
    keep = [str(r.get("code")) for r in rows if r.get("code")]
    marks = ",".join("?" * len(keep))
    for (nid,) in con.execute(f"SELECT id FROM nomen WHERE source = 'program' AND code NOT IN ({marks})",
                              keep).fetchall():
        con.execute("SAVEPOINT drop_item")
        try:
            con.execute("DELETE FROM nomen WHERE id = ?", (nid,))
            con.execute("RELEASE drop_item")
        except sqlite3.IntegrityError:
            con.execute("ROLLBACK TO drop_item")
            con.execute("RELEASE drop_item")


# ----------------------------------------------------------------- звірки

RECON_COLS = [("id", "id"), ("sub", "subdivision"), ("no", "number"), ("date", "doc_date"),
              ("from", "period_from"), ("to", "period_to"), ("title", "unit_title"),
              ("signerPos", "signer_pos"), ("signerName", "signer_name"),
              ("chiefPos", "chief_pos"), ("chiefName", "chief_name"), ("result", "result"),
              ("decision", "decision"), ("note", "note"), ("status", "status"),
              ("created", "created")]
# Одиниця виміру рядка відомості в застосунку — `uom`; раніше тут стояло «unit», і
# вона лягала в extra, а колонка uom лишалася порожньою.
LINE_COLS = [("code", "code"), ("name", "name"), ("uom", "uom"), ("price", "price"),
             ("fin", "fin_milli!"), ("acc", "acc_milli!"), ("fact", "fact_milli!"), ("note", "note")]


def _save_recon(con, recs):
    con.execute("DELETE FROM app_recon_line")
    con.execute("DELETE FROM app_recon")
    known = {f for f, _ in RECON_COLS} | {"lines"}
    for pos, r in enumerate(recs or []):
        cols = [c for _, c in RECON_COLS]
        con.execute(f"INSERT INTO app_recon({', '.join(cols)}, pos, extra) "
                    f"VALUES({', '.join('?' * len(cols))}, ?, ?)",
                    (*[r.get(f) for f, _ in RECON_COLS], pos, _extra(r, known)))
        for n, ln in enumerate(r.get("lines") or []):
            if "unit" in ln and ln["unit"] is None:      # порожній слід старої назви поля
                ln = {k: v for k, v in ln.items() if k != "unit"}
            values = []
            for field, col in LINE_COLS:
                v = ln.get(field)
                values.append(None if v is None else (_milli(v) if col.endswith("!") else v))
            cols = [c.rstrip("!") for _, c in LINE_COLS]
            con.execute(f"INSERT INTO app_recon_line(recon_id, pos, {', '.join(cols)}, extra) "
                        f"VALUES(?, ?, {', '.join('?' * len(cols))}, ?)",
                        (r.get("id"), n, *values, _extra(ln, {f for f, _ in LINE_COLS})))


# ------------------------------------------------ рапорти про знищення
# Рапорт про знищення — документ бази (вид report_destroyed, залишків не
# рухає), як і рапорти з паперових журналів: і внесені в програмі, і прийшлі з
# паперів лежать однаково й правляться однаково. Застосунок тримає рапорт
# записами по рядку: дата події, підрозділ, позиція, кількість, номер і дата
# рапорту, обставини (спільні для рапорту), примітка рядка й номер акта
# списання. Номер акта — на рядку (report_line_act): до акта включають і тоді,
# коли його ще не проведено; проведений акт — ще й зв'язок документів.

REPORT_KIND = ("report_destroyed", "Рапорт про знищення")
REPORT_LINK = "списання за рапортом"
# Так сіди паперових журналів позначали кожен рядок рапорту: рядок — знищення,
# а не списання. Власної примітки рядка ця позначка не несе.
REPORT_LINE_MARK = "знищено, не списано"
# Дата рапорту стоїть у примітці документа («рапорт №123 від 2026-01-05»): дата
# документа — це дата події, а рапорт пишуть пізніше, часто на тижні.
_REPORT_DATE = re.compile(r"рапорт\b[^.;]*?\bвід (\d{4}-\d{2}-\d{2})", re.IGNORECASE)
_REPORT_HEAD = re.compile(r"^рапорт №\S+ від \d{4}-\d{2}-\d{2}[.,]?\s*", re.IGNORECASE)
# Ціна рядка рапорту (інше майно, ціна за документом) — у гривнях × 10000: у
# справах ЄАС ціна одиниці буває з чотирма знаками, і сума має зійтися до копійки.
PRICE_SCALE = 10000


def _text(v):
    return str(v if v is not None else "").strip()


def _price4(v):
    """Ціна з рядка застосунку → грн × 10000; порожня — None; хибна — ValueError."""
    if isinstance(v, bool):
        raise ValueError("ціна")
    if v is None or (isinstance(v, str) and not v.strip()):
        return None
    x = float(v)
    if x < 0 or x != x:
        raise ValueError("ціна")
    return int(round(x * PRICE_SCALE))


def _price_out(x):
    """Ціна з бази: ціле лишається цілим, решта — з чотирма знаками."""
    v = round(x / PRICE_SCALE, 4)
    return int(v) if float(v).is_integer() else v


def _norm_no(x):
    """Номер документа для порівняння — як у застосунку: без пробілів з країв і
    без різниці великих і малих літер."""
    return str(x if x is not None else "").strip().lower()


def _report_note(note, doc_date):
    """Примітка рапорту в базі → (дата рапорту, обставини)."""
    note = note or ""
    m = _REPORT_DATE.search(note)
    return (m.group(1) if m else doc_date), _REPORT_HEAD.sub("", note).strip()


def _report_kinds(con):
    """Вид документа «рапорт про знищення» і вид зв'язку «списання за
    рапортом»: у чистій базі їх може ще не бути."""
    row = con.execute("SELECT id FROM doc_kind WHERE code = ?", (REPORT_KIND[0],)).fetchone()
    kind = row[0] if row else con.execute(
        "INSERT INTO doc_kind(code, name, affects_stock) VALUES(?, ?, 0)", REPORT_KIND).lastrowid
    row = con.execute("SELECT id FROM doc_link_kind WHERE code = ?", (REPORT_LINK,)).fetchone()
    link = row[0] if row else con.execute(
        "INSERT INTO doc_link_kind(code, name) VALUES(?, ?)", (REPORT_LINK, REPORT_LINK)).lastrowid
    return kind, link


def _load_reports(con):
    """Рапорти про знищення записами по рядку: рядки техзасобів — за рядком
    документа, інше майно (продукти, запаси, майно інших служб) — за своїм
    рядком при рапорті, після рядків техзасобів. Номер акта — з рядка рапорту,
    а в рапорту, зв'язаного з актом цілком (так зв'язано рапорти з паперів), —
    з самого акта."""
    kind = con.execute("SELECT id FROM doc_kind WHERE code = ?", (REPORT_KIND[0],)).fetchone()
    if kind is None:
        return []
    whole = {}
    for r in con.execute("""
            SELECT dl.from_document_id AS doc, a.id, a.number FROM document_link dl
              JOIN doc_link_kind lk ON lk.id = dl.kind_id AND lk.code = ?
              JOIN document a ON a.id = dl.to_document_id
              JOIN doc_kind ak ON ak.id = a.kind_id AND ak.affects_stock = 1
             ORDER BY a.doc_date, a.id""", (REPORT_LINK,)):
        whole.setdefault(r["doc"], []).append((r["id"], r["number"]))
    codes = {}

    def codes_of(act_id):
        if act_id not in codes:
            codes[act_id] = {x[0] for x in con.execute(
                "SELECT n.code FROM document_line l JOIN nomen n ON n.id = l.nomen_id "
                "WHERE l.document_id = ?", (act_id,))}
        return codes[act_id]
    rows = con.execute("""
            SELECT d.id AS doc_id, d.number, d.doc_date, d.source, COALESCE(d.note, '') AS note,
                   COALESCE(s.name, '') AS sub, l.id AS line_id, n.code, l.qty_milli, l.instance_id,
                   COALESCE(l.note, '') AS lnote, ra.line_id AS own, ra.act_no, ra.act_id,
                   rp.price_x10000 AS price
              FROM document d
              JOIN document_line l ON l.document_id = d.id
              JOIN nomen n ON n.id = l.nomen_id
              LEFT JOIN subdivision s ON s.id = d.from_subdivision_id
              LEFT JOIN report_line_act ra ON ra.line_id = l.id
              LEFT JOIN report_line_price rp ON rp.line_id = l.id
             WHERE d.kind_id = ?
             ORDER BY d.doc_date, d.id, l.line_no""", (kind[0],)).fetchall()
    by_line = {r["doc_id"] for r in rows if r["own"] is not None}
    by_doc = {}
    for r in rows:
        rd, circ = _report_note(r["note"], r["doc_date"])
        lnote = "" if r["lnote"] == REPORT_LINE_MARK else r["lnote"]
        if r["doc_id"] in by_line:
            act_id, act = r["act_id"] or 0, r["act_no"] or ""
        else:
            # Рапорт, зв'язаний цілком із кількома актами, — рядок до того акта,
            # де є його позиція.
            acts = whole.get(r["doc_id"]) or [(0, "")]
            act_id, act = next((a for a in acts if len(acts) > 1 and r["code"] in codes_of(a[0])), acts[0])
        rec = {"id": f"l{r['line_id']}", "docId": r["doc_id"], "lineId": r["line_id"],
               "origin": r["source"] or "seed", "date": r["doc_date"], "sub": r["sub"],
               "code": r["code"], "qty": _qty(r["qty_milli"]), "report": r["number"] or "",
               "reportDate": rd, "circ": circ, "lnote": lnote,
               "note": "; ".join(x for x in (circ, lnote) if x), "act": act}
        if act_id:
            rec["actId"] = act_id
        if r["instance_id"]:
            rec["unit"] = str(r["instance_id"])
        if r["price"] is not None:
            rec["price"] = _price_out(r["price"])
        by_doc.setdefault(r["doc_id"], []).append(rec)
    # Інше майно: без позиції довідника й без акта програми — списане тим
    # документом, що названий на рядку.
    for r in con.execute("""
            SELECT d.id AS doc_id, d.number, d.doc_date, d.source, COALESCE(d.note, '') AS note,
                   COALESCE(s.name, '') AS sub, o.id AS other_id, o.name, o.qty_milli,
                   COALESCE(o.uom, '') AS uom, o.price_x10000 AS price, COALESCE(o.off_no, '') AS off_no,
                   COALESCE(o.off_date, '') AS off_date, COALESCE(o.note, '') AS lnote
              FROM document d
              JOIN report_other o ON o.document_id = d.id
              LEFT JOIN subdivision s ON s.id = d.from_subdivision_id
             WHERE d.kind_id = ?
             ORDER BY d.doc_date, d.id, o.line_no""", (kind[0],)):
        rd, circ = _report_note(r["note"], r["doc_date"])
        rec = {"id": f"o{r['other_id']}", "docId": r["doc_id"], "otherId": r["other_id"],
               "origin": r["source"] or "seed", "date": r["doc_date"], "sub": r["sub"], "code": "",
               "other": True, "name": r["name"], "qty": _qty(r["qty_milli"]), "uom": r["uom"],
               "offNo": r["off_no"], "offDate": r["off_date"], "report": r["number"] or "",
               "reportDate": rd, "circ": circ, "lnote": r["lnote"],
               "note": "; ".join(x for x in (circ, r["lnote"]) if x), "act": ""}
        if r["price"] is not None:
            rec["price"] = _price_out(r["price"])
        by_doc.setdefault(r["doc_id"], []).append(rec)
    order = [r[0] for r in con.execute("SELECT id FROM document WHERE kind_id = ? ORDER BY doc_date, id", (kind[0],))]
    return [rec for doc_id in order for rec in by_doc.get(doc_id, [])]


def _legacy_reports(state):
    """Записи про знищення старих версій: внесене в програмі лежало окремо
    (app_destroyed), а номери актів до рапортів із бази — мапою «дата|підрозділ|
    код|рапорт → акт» (dzActs). Перші стають записами без документа (запис
    перетворить їх на документи), другі — номером акта на своєму рядку."""
    if "dzActs" not in state:
        return state
    state = dict(state)
    acts = state.pop("dzActs")
    if isinstance(acts, dict) and acts and isinstance(state.get("destroyed"), list):
        out = []
        for rec in state["destroyed"]:
            key = "|".join(str(rec.get(k) or "") for k in ("date", "sub", "code", "report")) \
                if isinstance(rec, dict) else None
            if key and rec.get("docId") and not rec.get("act") and acts.get(key):
                rec = dict(rec, act=str(acts[key]))
            out.append(rec)
        state["destroyed"] = out
    return state


def _report_circ(recs):
    """Обставини рапорту: спільні для всіх його записів. Запис старої версії
    несе лише примітку — тоді обставини те, що в усіх записів однакове."""
    for rec in recs:
        if rec.get("circ") is not None:
            return str(rec.get("circ") or "").strip()
    notes = {str(rec.get("note") or "").strip() for rec in recs}
    return notes.pop() if len(notes) == 1 else ""


def _line_note(rec, circ):
    """Власна примітка рядка рапорту."""
    if rec.get("lnote") is not None:
        return str(rec.get("lnote") or "").strip()
    note = str(rec.get("note") or "").strip()
    return "" if note == circ else note


def _find_act(con, act_no, from_sub, since):
    """Проведений акт із цим номером: той самий підрозділ, не раніший за подію,
    найраніший із таких — так само, як його шукає застосунок."""
    want = _norm_no(act_no)
    if not want or from_sub is None:
        return None
    for r in con.execute("""
            SELECT d.id, d.number FROM document d JOIN doc_kind k ON k.id = d.kind_id
             WHERE k.affects_stock = 1 AND d.from_subdivision_id = ? AND d.to_subdivision_id IS NULL
               AND d.doc_date >= ?
             ORDER BY d.doc_date, d.id""", (from_sub, since or "")):
        if _norm_no(r["number"]) == want:
            return r["id"]
    return None


def _save_reports(con, records):
    """Рапорти застосунку → документи бази. Перелік повний: рапорту, якого в
    ньому немає, немає й у базі. Незмінене не чіпається; виправлене лишається тим
    самим документом із тими самими рядками — до них прив'язані скани й номери
    актів. Рядок техзасобів — рядок документа (з ціною за документом, коли її
    вказано), інше майно — свій рядок при рапорті. Новий запис, який не можна
    покласти в документ без втрат (позиції чи підрозділу немає в довіднику,
    кількість не додатна, одиниця не тієї позиції, інше майно без назви, ціна не
    число), лишається в app_destroyed як був — до виправлення; такий самий запис
    рапорту, що вже є документом, запис не приймає — словами, що не так.
    Повертає {id запису програми: [id документа, id рядка(, "other")]} для нових
    записів."""
    if records is None:
        return {}
    kind, link = _report_kinds(con)
    nomens = dict(con.execute("SELECT code, id FROM nomen"))
    subs = dict(con.execute("SELECT name, id FROM subdivision"))
    unit_nomen = dict(con.execute("SELECT id, nomen_id FROM instance"))
    have = {r["id"]: r for r in con.execute(
        "SELECT id, number, doc_date, from_subdivision_id, COALESCE(note, '') AS note "
        "FROM document WHERE kind_id = ?", (kind,))}

    def as_id(v):
        return v if isinstance(v, int) and not isinstance(v, bool) and v > 0 else None

    parked, groups, order, price_of = [], {}, [], {}
    for rec in records or []:
        if not isinstance(rec, dict):
            continue
        other = bool(rec.get("other"))
        nid = None if other else nomens.get(str(rec.get("code") or ""))
        milli = _milli(rec.get("qty")) if str(rec.get("qty") or "").strip() else 0
        unit = None if other else _unit_id(rec.get("unit"))
        try:
            price = _price4(rec.get("price"))
        except (TypeError, ValueError):
            price = "bad"
        doc_id = as_id(rec.get("docId"))
        bad = ("не вказано найменування іншого майна" if other and not _text(rec.get("name"))
               else "позиції «{}» немає в довіднику".format(rec.get("code")) if not other and nid is None
               else "кількість має бути більшою за нуль" if milli <= 0
               else "не вказано дату події" if not rec.get("date")
               else "ціна має бути невід'ємним числом" if price == "bad"
               else "одиниця із заводським номером — одна, і саме цієї позиції"
               if unit is not None and (unit_nomen.get(unit) != nid or milli != MILLI) else None)
        if bad and doc_id in have:
            # Рапорт уже документ: відкласти його рядок означало б прибрати рядок із рапорту.
            raise SaveError(f"рапорт №{str(rec.get('report') or '').strip() or '—'}: {bad}")
        if bad or (doc_id not in have and rec.get("sub") not in subs):
            # Колонки, без яких рядок у таблицю не ляже, — порожніми, а не NULL.
            parked.append(dict({"id": f"p{len(parked)}", "date": "", "sub": "", "code": ""},
                               **{k: v for k, v in rec.items() if v is not None}))
            continue
        gid = ("#", doc_id) if doc_id in have else (
            "new", subs.get(rec.get("sub")), str(rec.get("date")), str(rec.get("report") or "").strip())
        if gid not in groups:
            groups[gid] = {"tz": [], "other": []}
            order.append(gid)
        price_of[id(rec)] = price
        if other:
            groups[gid]["other"].append((rec, milli, price))
        else:
            groups[gid]["tz"].append((rec, nid, milli, unit))

    # Нові рапорти, що вже лежать у базі (вікно ще не отримало їхніх id): той
    # самий підрозділ, дата й номер — той самий документ.
    claimed = {g[1] for g in order if g[0] == "#"}
    target = {}
    for gid in order:
        if gid[0] == "#":
            target[gid] = gid[1]
            continue
        _, sub, date, no = gid
        same = next((i for i, h in sorted(have.items()) if i not in claimed and h["from_subdivision_id"] == sub
                     and h["doc_date"] == date and (h["number"] or "").strip() == no), None)
        if same is not None:
            claimed.add(same)
        target[gid] = same

    # Рапорти, яких у переліку немає, — геть (з рядками, номерами актів і зв'язками).
    for doc_id in sorted(set(have) - claimed):
        con.execute("DELETE FROM document WHERE id = ?", (doc_id,))

    out = {}
    for gid in order:
        recs, others = groups[gid]["tz"], groups[gid]["other"]
        every = [r for r, *_ in recs] + [r for r, *_ in others]
        first = every[0]
        no = str(first.get("report") or "").strip()
        date = str(first.get("date"))
        doc_id = target[gid]
        cur = have.get(doc_id)
        # Підрозділу запису немає в довіднику — рапорт лишається там, де був.
        sub = subs.get(first.get("sub"), cur["from_subdivision_id"] if cur else None)
        rd = str(first.get("reportDate") or "").strip() or date
        circ = _report_circ(every)
        if doc_id is None:
            note = f"рапорт №{no} від {rd}" + (f". {circ}" if circ else "")
            doc_id = con.execute(
                "INSERT INTO document(kind_id, number, doc_date, from_subdivision_id, note, source) "
                "VALUES(?, ?, ?, ?, ?, 'program')", (kind, no, date, sub, note)).lastrowid
        else:
            was_rd, was_circ = _report_note(cur["note"], cur["doc_date"])
            # Примітка документа з паперу буває іншого вигляду, ніж «рапорт №… від
            # …»: не змінилися номер, дата рапорту й обставини — лишається слово в
            # слово; номер — теж, з пробілами, як у папері.
            same = (no, rd, circ) == ((cur["number"] or "").strip(), was_rd, was_circ.strip())
            note = cur["note"] if same else f"рапорт №{no} від {rd}" + (f". {circ}" if circ else "")
            if no == (cur["number"] or "").strip():
                no = cur["number"] or ""
            if ((cur["number"] or ""), cur["doc_date"], cur["from_subdivision_id"], cur["note"]) != (no, date, sub, note):
                con.execute("UPDATE document SET number = ?, doc_date = ?, from_subdivision_id = ?, note = ? "
                            "WHERE id = ?", (no, date, sub, note, doc_id))
        lines = _save_report_lines(con, doc_id, recs, circ)
        _save_report_acts(con, doc_id, link, sub, date, lines)
        _save_report_prices(con, [(line_id, price_of.get(id(rec))) for rec, line_id in lines])
        for rec, line_id in lines:
            if as_id(rec.get("lineId")) != line_id or as_id(rec.get("docId")) != doc_id:
                out[str(rec.get("id"))] = [doc_id, line_id]
        for rec, other_id in _save_report_other(con, doc_id, others, circ):
            if as_id(rec.get("otherId")) != other_id or as_id(rec.get("docId")) != doc_id:
                out[str(rec.get("id"))] = [doc_id, other_id, "other"]

    # Що не лягло в документ — лишається як було, до виправлення.
    _save_simple(con, "destroyed", parked)
    return out


def _save_report_lines(con, doc_id, recs, circ):
    """Рядки рапорту на місці: свій рядок — за id, решта — за позицією, одиницею й
    кількістю; нове — у кінець. Повертає [(запис, id рядка)]."""
    old = {r["id"]: r for r in con.execute(
        "SELECT id, line_no, nomen_id, qty_milli, instance_id, COALESCE(note, '') AS note "
        "FROM document_line WHERE document_id = ? ORDER BY line_no", (doc_id,))}
    pairs, free = {}, dict(old)
    for n, (rec, nid, milli, unit) in enumerate(recs):
        lid = rec.get("lineId")
        if isinstance(lid, int) and lid in free:
            pairs[n] = free.pop(lid)
    for exact in (True, False):
        for n, (rec, nid, milli, unit) in enumerate(recs):
            if n in pairs:
                continue
            hit = next((r for r in free.values() if r["nomen_id"] == nid and r["instance_id"] == unit
                        and (not exact or r["qty_milli"] == milli)), None)
            if hit is not None:
                pairs[n] = free.pop(hit["id"])
    # Зайве — геть до вставки: номер рядка звільняється для нового.
    for line_id in free:
        con.execute("DELETE FROM document_line WHERE id = ?", (line_id,))
    line_no = max([r["line_no"] for r in old.values() if r["id"] not in free] or [0])
    out = []
    for n, (rec, nid, milli, unit) in enumerate(recs):
        note = _line_note(rec, circ)
        r = pairs.get(n)
        if r is None:
            line_no += 1
            line_id = con.execute(
                "INSERT INTO document_line(document_id, line_no, nomen_id, instance_id, qty_milli, note) "
                "VALUES(?, ?, ?, ?, ?, ?)", (doc_id, line_no, nid, unit, milli, note or None)).lastrowid
        else:
            line_id = r["id"]
            # Позначка сідів «знищено, не списано» — те саме, що порожня примітка.
            was = "" if r["note"] == REPORT_LINE_MARK else r["note"]
            if (r["nomen_id"], r["qty_milli"], r["instance_id"], was) != (nid, milli, unit, note):
                keep = (r["note"] or None) if note == was else (note or None)
                con.execute("UPDATE document_line SET nomen_id = ?, qty_milli = ?, instance_id = ?, note = ? "
                            "WHERE id = ?", (nid, milli, unit, keep, line_id))
        out.append((rec, line_id))
    return out


def _save_report_acts(con, doc_id, link, sub, date, lines):
    """Номери актів на рядках рапорту й зв'язки з проведеними актами. Рапорт, що
    весь пішов до одного проведеного акта, тримається самим зв'язком — так, як
    рапорти з паперів; інакше номер стоїть на кожному рядку, що до акта включений."""
    acts = {}
    for rec, line_id in lines:
        no = str(rec.get("act") or "").strip()
        act_id = rec.get("actId")
        # Акт, з яким рапорт уже зв'язано, — за записом: номер акта могли виправити.
        row = con.execute("SELECT d.number FROM document d JOIN doc_kind k ON k.id = d.kind_id "
                          "WHERE d.id = ? AND k.affects_stock = 1", (act_id,)).fetchone()             if isinstance(act_id, int) and not isinstance(act_id, bool) else None
        if row is not None:
            no = row[0] or no
        else:
            # Акт складено від іншого підрозділу, ніж у записі (майно вже передали,
            # коли дійшло до списання): застосунок каже, від якого саме (actSub).
            at = sub
            hint = rec.get("actSub")
            if isinstance(hint, str) and hint.strip():
                other = con.execute("SELECT id FROM subdivision WHERE name = ?", (hint.strip(),)).fetchone()
                if other is not None:
                    at = other[0]
            act_id = _find_act(con, no, at, date)
        acts[line_id] = (no, act_id) if (no or act_id) else None
    linked = {x[1] for x in acts.values() if x and x[1]}
    whole = len(linked) == 1 and all(x and x[1] for x in acts.values())
    rows = {} if whole else {line_id: x for line_id, x in acts.items() if x}
    for line_id, want in [(line_id, rows.get(line_id)) for line_id in acts]:
        cur = con.execute("SELECT act_no, act_id FROM report_line_act WHERE line_id = ?", (line_id,)).fetchone()
        if want is None:
            if cur is not None:
                con.execute("DELETE FROM report_line_act WHERE line_id = ?", (line_id,))
        elif cur is None:
            con.execute("INSERT INTO report_line_act(line_id, act_no, act_id) VALUES(?, ?, ?)",
                        (line_id, want[0], want[1]))
        elif (cur["act_no"], cur["act_id"]) != want:
            con.execute("UPDATE report_line_act SET act_no = ?, act_id = ? WHERE line_id = ?",
                        (want[0], want[1], line_id))
    have = {r[0] for r in con.execute(
        "SELECT dl.to_document_id FROM document_link dl JOIN document a ON a.id = dl.to_document_id "
        "JOIN doc_kind k ON k.id = a.kind_id WHERE dl.from_document_id = ? AND dl.kind_id = ? "
        "AND k.affects_stock = 1", (doc_id, link))}
    for act_id in have - linked:
        con.execute("DELETE FROM document_link WHERE from_document_id = ? AND to_document_id = ? AND kind_id = ?",
                    (doc_id, act_id, link))
    for act_id in linked - have:
        con.execute("INSERT INTO document_link(from_document_id, to_document_id, kind_id) VALUES(?, ?, ?)",
                    (doc_id, act_id, link))


def _save_report_prices(con, pairs):
    """Ціна за документом на рядках техзасобів: є — стоїть, немає — рядок
    оцінюється партією."""
    for line_id, price in pairs:
        cur = con.execute("SELECT price_x10000 FROM report_line_price WHERE line_id = ?", (line_id,)).fetchone()
        if price is None:
            if cur is not None:
                con.execute("DELETE FROM report_line_price WHERE line_id = ?", (line_id,))
        elif cur is None:
            con.execute("INSERT INTO report_line_price(line_id, price_x10000) VALUES(?, ?)", (line_id, price))
        elif cur[0] != price:
            con.execute("UPDATE report_line_price SET price_x10000 = ? WHERE line_id = ?", (price, line_id))


def _save_report_other(con, doc_id, recs, circ):
    """Рядки іншого майна рапорту на місці: свій рядок — за id, решта — за
    назвою (спершу з тією самою кількістю й ціною); нове — у кінець, зайве —
    геть. Повертає [(запис, id рядка)]."""
    old = {r["id"]: r for r in con.execute(
        "SELECT id, line_no, name, qty_milli, COALESCE(uom, '') AS uom, price_x10000, "
        "COALESCE(off_no, '') AS off_no, COALESCE(off_date, '') AS off_date, COALESCE(note, '') AS note "
        "FROM report_other WHERE document_id = ? ORDER BY line_no", (doc_id,))}
    pairs, free = {}, dict(old)
    for n, (rec, milli, price) in enumerate(recs):
        oid = rec.get("otherId")
        if isinstance(oid, int) and not isinstance(oid, bool) and oid in free:
            pairs[n] = free.pop(oid)
    for exact in (True, False):
        for n, (rec, milli, price) in enumerate(recs):
            if n in pairs:
                continue
            name = _text(rec.get("name"))
            hit = next((r for r in free.values() if r["name"] == name
                        and (not exact or (r["qty_milli"] == milli and r["price_x10000"] == price))), None)
            if hit is not None:
                pairs[n] = free.pop(hit["id"])
    for oid in free:
        con.execute("DELETE FROM report_other WHERE id = ?", (oid,))
    line_no = max([r["line_no"] for r in old.values() if r["id"] not in free] or [0])
    out = []
    for n, (rec, milli, price) in enumerate(recs):
        vals = (_text(rec.get("name")), milli, _text(rec.get("uom")) or None, price,
                _text(rec.get("offNo")) or None, _text(rec.get("offDate")) or None, _line_note(rec, circ) or None)
        r = pairs.get(n)
        if r is None:
            line_no += 1
            oid = con.execute(
                "INSERT INTO report_other(document_id, line_no, name, qty_milli, uom, price_x10000, off_no, off_date, note) "
                "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)", (doc_id, line_no) + vals).lastrowid
        else:
            oid = r["id"]
            was = (r["name"], r["qty_milli"], r["uom"] or None, r["price_x10000"], r["off_no"] or None,
                   r["off_date"] or None, r["note"] or None)
            if was != vals:
                con.execute("UPDATE report_other SET name = ?, qty_milli = ?, uom = ?, price_x10000 = ?, "
                            "off_no = ?, off_date = ?, note = ? WHERE id = ?", vals + (oid,))
        out.append((rec, oid))
    return out


def _save_inv_moves(con, moves):
    """Перенесення інвентарних номерів із програми: номери «код/NNN» з/по — до
    іншого підрозділу. Накладна кількістю номерів не називає, тож за майном їх
    переносять руками. Повторний запис того самого переліку нічого не змінює."""
    subs = dict(con.execute("SELECT name, id FROM subdivision"))
    for m in moves or []:
        sub = subs.get(m.get("sub"))
        code = str(m.get("code") or "")
        try:
            lo, hi = int(m.get("from")), int(m.get("to"))
        except (TypeError, ValueError):
            continue
        if sub is None or not code or lo > hi:
            continue
        ids = [r[0] for r in con.execute("""
            SELECT i.id FROM instance i JOIN nomen n ON n.id = i.nomen_id
             WHERE n.code = ? AND i.inv_no LIKE ? || '/%'
               AND CAST(substr(i.inv_no, length(?) + 2) AS INTEGER) BETWEEN ? AND ?""",
                                          (code, code, code, lo, hi))]
        for iid in ids:
            con.execute("UPDATE instance_assignment SET subdivision_id = ?, on_date = COALESCE(?, on_date), note = ? "
                        "WHERE instance_id = ? AND subdivision_id <> ?",
                        (sub, m.get("date") or None, m.get("note") or "перенесено в програмі", iid, sub))


def _save_inv_issue(con, issues):
    """Видача власних інвентарних номерів із програми: номери «код/NNN» з/по — одиницям позиції
    в підрозділі, які номера ще не мають. Номер лягає на одиницю із заводським номером, що
    числиться в цьому підрозділі без інвентарного, а коли таких немає — на нову одиницю реєстру.
    Повторний запис того самого переліку нічого не змінює. Номерів позиції не стає більше, ніж
    її одиниць на обліку: інакше номер пішов би на майно, якого немає."""
    subs = dict(con.execute("SELECT name, id FROM subdivision"))
    touched = {}
    for m in issues or []:
        code = str(m.get("code") or "")
        sub = subs.get(m.get("sub"))
        row = con.execute("SELECT id FROM nomen WHERE code = ?", (code,)).fetchone()
        try:
            lo, hi = int(m.get("from")), int(m.get("to"))
        except (TypeError, ValueError):
            lo, hi = 0, -1
        date = str(m.get("date") or "")
        if row is None or sub is None or lo < 1 or lo > hi or not _ISO_DATE.match(date):
            raise SaveError(f"видача інвентарних номерів «{code}» для «{m.get('sub')}»: "
                            f"немає такої позиції чи підрозділу або номери вказано не числами")
        nomen = row[0]
        for k in range(lo, hi + 1):
            inv = f"{code}/{k:03d}"
            if con.execute("SELECT 1 FROM instance WHERE inv_no = ?", (inv,)).fetchone():
                continue
            named = con.execute("""
                SELECT i.id FROM instance i
                 WHERE i.nomen_id = ? AND i.inv_no IS NULL
                   AND (SELECT p.subdivision_id FROM posting p
                         WHERE p.instance_id = i.id AND p.doc_date <= ?
                         GROUP BY p.subdivision_id HAVING SUM(p.sign * p.qty_milli) > 0 LIMIT 1) = ?
                 ORDER BY i.id LIMIT 1""", (nomen, date, sub)).fetchone()
            if named:
                iid = named[0]
                con.execute("UPDATE instance SET inv_no = ? WHERE id = ?", (inv, iid))
            else:
                iid = con.execute("INSERT INTO instance(nomen_id, inv_no, note) VALUES(?, ?, ?)",
                                  (nomen, inv, f"номер видано {date}, {m.get('sub')}")).lastrowid
            con.execute("INSERT INTO instance_assignment(instance_id, subdivision_id, on_date, note) "
                        "VALUES(?, ?, ?, 'видано в програмі')", (iid, sub, date))
            touched[nomen] = (code, date)
    for nomen, (code, date) in touched.items():
        numbers = con.execute("SELECT COUNT(*) FROM instance WHERE nomen_id = ? AND inv_no IS NOT NULL",
                              (nomen,)).fetchone()[0]
        units = con.execute("SELECT COALESCE(SUM(sign * qty_milli), 0) FROM posting "
                            "WHERE nomen_id = ? AND doc_date <= ?", (nomen, date)).fetchone()[0] // 1000
        if numbers > units:
            raise SaveError(f"видача інвентарних номерів «{code}»: номерів стало б {numbers}, а одиниць на обліку "
                            f"{units} — оновіть сторінку й видайте номери ще раз")


def _save_line_codes(con, edits):
    """Коди служби рядків табеля ({"форма|рядок": [коди]}): з них складається
    наявність під штат рядка. Рядок, якого немає в переліку, не чіпається."""
    nomens = dict(con.execute("SELECT code, id FROM nomen"))
    for key, codes in (edits or {}).items():
        form, _, line = str(key).partition("|")
        row = con.execute("SELECT rl.id FROM report_line rl JOIN report_form f ON f.id = rl.form_id "
                          "WHERE f.code = ? AND rl.name = ?", (form, line)).fetchone()
        if row is None or not isinstance(codes, list):
            continue
        want = {nomens[str(c)] for c in codes if str(c) in nomens}
        have = {r[0] for r in con.execute("SELECT nomen_id FROM nomen_report_line WHERE report_line_id = ?",
                                          (row[0],))}
        for nid in have - want:
            con.execute("DELETE FROM nomen_report_line WHERE report_line_id = ? AND nomen_id = ?", (row[0], nid))
        for nid in want - have:
            con.execute("INSERT INTO nomen_report_line(nomen_id, report_line_id) VALUES(?, ?)", (nid, row[0]))


def _save_recon_base(con, edits):
    """Графи 6 і 7 підписаних відомостей із бази (рішення начальника, примітки):
    їх дописують уже за підписаною, решта відомості лишається як у папері."""
    for rid, rec in (edits or {}).items():
        if not str(rid).isdigit() or not isinstance(rec, dict):
            continue
        row = con.execute("SELECT decision, note FROM reconciliation WHERE id = ?", (int(rid),)).fetchone()
        if row is None:
            continue
        new = (str(rec.get("decision") or "").strip() or None, str(rec.get("note") or "").strip() or None)
        if (row["decision"], row["note"]) != new:
            con.execute("UPDATE reconciliation SET decision = ?, note = ? WHERE id = ?", (*new, int(rid)))


def _load_recon(con):
    lines = {}
    for row in con.execute("SELECT * FROM app_recon_line ORDER BY recon_id, pos"):
        ln = {}
        for field, col in LINE_COLS:
            v = row[col.rstrip("!")]
            ln[field] = None if v is None else (_qty(v) if col.endswith("!") else v)
        lines.setdefault(row["recon_id"], []).append(_with_extra(ln, row["extra"]))
    out = []
    for row in con.execute("SELECT * FROM app_recon ORDER BY pos"):
        rec = _clean({f: row[c] for f, c in RECON_COLS})
        rec["lines"] = lines.get(row["id"], [])
        out.append(_with_extra(rec, row["extra"]))
    return out


# --------------------------------------------------------- інвентаризації

INV_COLS = [("id", "id"), ("kind", "kind"), ("date", "inv_date"), ("start", "start_date"),
            ("end", "end_date"), ("orderNo", "order_no"), ("orderDate", "order_date"),
            ("prevDate", "prev_date"), ("head", "head_id"), ("status", "status"),
            ("created", "created")]
INV_PARTS = ["sign", "mvo", "where", "fact", "note", "accFixed", "accStock", "findings", "scope"]


def _save_inventories(con, invs):
    con.execute("DELETE FROM app_inventory_cell")
    con.execute("DELETE FROM app_inventory")
    for pos, inv in enumerate(invs or []):
        # По клітинках розкладаються лише словники; переліки (що охоплює
        # інвентаризація) і скалярна частина (текст субрахунків, висновки
        # комісії) лежать в extra як є. Перелік у клітинках повертався словником
        # {"0": …, "1": …}, і після перезапуску картка інвентаризації не відкривалась.
        known = ({f for f, _ in INV_COLS} | {"members"}
                 | {p for p in INV_PARTS if isinstance(inv.get(p), dict)})
        cols = [c for _, c in INV_COLS]
        con.execute(f"INSERT INTO app_inventory({', '.join(cols)}, members, pos, extra) "
                    f"VALUES({', '.join('?' * len(cols))}, ?, ?, ?)",
                    (*[inv.get(f) for f, _ in INV_COLS],
                     json.dumps(inv.get("members") or [], ensure_ascii=False), pos,
                     _extra(inv, known)))
        for part in INV_PARTS:
            v = inv.get(part)
            if not isinstance(v, dict):
                continue
            items = list(v.items())
            if not items:
                # Порожній розділ опису — теж запис: людина його відкривала.
                con.execute("INSERT INTO app_inventory_cell(inventory_id, part, key, value) "
                            "VALUES(?, ?, '', NULL)", (inv.get("id"), part))
            for key, value in items:
                con.execute("INSERT INTO app_inventory_cell(inventory_id, part, key, value) "
                            "VALUES(?, ?, ?, ?)",
                            (inv.get("id"), part, str(key), json.dumps(value, ensure_ascii=False)))


def _load_inventories(con):
    cells = {}
    for row in con.execute("SELECT * FROM app_inventory_cell"):
        part = cells.setdefault(row["inventory_id"], {}).setdefault(row["part"], {})
        if row["key"] == "" and row["value"] is None:
            continue                                  # позначка порожнього розділу
        part[row["key"]] = json.loads(row["value"]) if row["value"] is not None else None
    out = []
    for row in con.execute("SELECT * FROM app_inventory ORDER BY pos"):
        rec = _clean({f: row[c] for f, c in INV_COLS})
        rec["members"] = json.loads(row["members"] or "[]")
        extra = json.loads(row["extra"]) if row["extra"] else {}
        for part, data in (cells.get(row["id"]) or {}).items():
            if part in extra and isinstance(extra[part], list):
                continue
            # Записане попередніми версіями: перелік лежав у клітинках з ключами
            # «0», «1», … — повертаємо його переліком.
            if part == "scope" and set(data) == {str(n) for n in range(len(data))}:
                data = [data[str(n)] for n in range(len(data))]
            rec[part] = data
        out.append(_with_extra(rec, row["extra"]))
    return out


# ------------------------------------------------------------ заміни, журнал

def _save_subst(con, rows):
    con.execute("DELETE FROM app_subst")
    for pos, r in enumerate(rows or []):
        con.execute("INSERT INTO app_subst(id, pos, form, src, targets, extra) "
                    "VALUES(?, ?, ?, ?, ?, ?)",
                    (r.get("id"), pos, r.get("form"), r.get("from"),
                     json.dumps(r.get("to") or [], ensure_ascii=False),
                     _extra(r, {"id", "form", "from", "to"})))


def _load_subst(con):
    out = []
    for row in con.execute("SELECT * FROM app_subst ORDER BY pos"):
        rec = {"id": row["id"], "form": row["form"], "from": row["src"],
               "to": json.loads(row["targets"] or "[]")}
        out.append(_with_extra(rec, row["extra"]))
    return out


def _save_log(con, rows):
    con.execute("DELETE FROM app_log")
    for r in rows or []:
        con.execute("INSERT INTO app_log(at, what, key, text) VALUES(?, ?, ?, ?)",
                    (r.get("t"), r.get("what"), r.get("key"), r.get("text")))


def _load_log(con):
    return [_clean({"t": r["at"], "what": r["what"], "key": r["key"], "text": r["text"]})
            for r in con.execute("SELECT * FROM app_log ORDER BY id")]


# ----------------------------------------------- документи служби (папери)
#
# Відомість залишкової вартості й акт якісного (технічного) стану. Документ —
# рядок `app_paper`: шапка колонками, решта (реквізити, рядки, параметри й
# результат розрахунку, історія) — JSON у `body`. Затверджені версії — знімки в
# `app_paper_version`; їх додають і ніколи не переписують.

PAPER_COLS = [("id", "id"), ("kind", "kind"), ("no", "number"), ("date", "doc_date"), ("state", "state"),
              ("ver", "version"), ("created", "created"), ("changed", "changed")]
PAPER_KINDS = ("valuation", "tech_act")
PAPER_STATES = ("чернетка", "підготовлено", "затверджено", "скасовано")


def _paper_name(rec):
    return f"№{rec.get('no') or 'б/н'} від {_date_words(rec.get('date') or '')}".strip()


def _save_papers(con, papers, replace=False):
    """Папери — як їх віддало вікно. Розділу в стані немає (стара копія, вікно
    попередньої версії) — документи в базі лишаються як були. Затверджена версія
    пишеться раз: інший зміст під тим самим номером версії — відмова, а не тиха
    заміна. replace — відновлення з файла копії: документи лягають такими, якими
    були в копії, разом із їхніми версіями (перед цим сервер знімає копію бази)."""
    if papers is None:
        return
    if not isinstance(papers, list):
        raise SaveError("документи служби мають бути переліком")
    if replace:
        con.execute("DELETE FROM app_paper")
    seen = set()
    for pos, rec in enumerate(papers):
        if not isinstance(rec, dict) or not str(rec.get("id") or "").strip():
            raise SaveError("документ служби без ідентифікатора")
        pid = str(rec["id"])
        if pid in seen:
            raise SaveError(f"документ служби {_paper_name(rec)} записано двічі")
        seen.add(pid)
        if rec.get("kind") not in PAPER_KINDS:
            raise SaveError(f"невідомий вид документа служби: {rec.get('kind')!r}")
        if rec.get("state") not in PAPER_STATES:
            raise SaveError(f"документ {_paper_name(rec)}: невідомий стан {rec.get('state')!r}")
        try:
            ver = int(rec.get("ver") or 1)
        except (TypeError, ValueError):
            raise SaveError(f"документ {_paper_name(rec)}: номер версії має бути числом") from None
        known = {f for f, _ in PAPER_COLS} | {"versions"}
        body = json.dumps({k: v for k, v in rec.items() if k not in known}, ensure_ascii=False, sort_keys=True)
        row = (rec["kind"], pos, rec.get("no") or "", rec.get("date") or "", rec["state"], ver,
               rec.get("created") or "", rec.get("changed") or "", body)
        have = con.execute("SELECT kind, pos, number, doc_date, state, version, created, changed, body "
                           "FROM app_paper WHERE id = ?", (pid,)).fetchone()
        if have is None:
            con.execute("INSERT INTO app_paper(kind, pos, number, doc_date, state, version, created, changed, body, id) "
                        "VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)", (*row, pid))
        elif tuple(have) != row:
            con.execute("UPDATE app_paper SET kind = ?, pos = ?, number = ?, doc_date = ?, state = ?, version = ?, "
                        "created = ?, changed = ?, body = ? WHERE id = ?", (*row, pid))
        frozen = {r[0]: r[1] for r in con.execute(
            "SELECT version, body FROM app_paper_version WHERE paper_id = ?", (pid,))}
        sent = set()
        for v in rec.get("versions") or []:
            try:
                n = int(v.get("ver"))
            except (AttributeError, TypeError, ValueError):
                raise SaveError(f"документ {_paper_name(rec)}: затверджена версія без номера") from None
            snap = json.dumps(v.get("body") or {}, ensure_ascii=False, sort_keys=True)
            sent.add(n)
            if n not in frozen:
                con.execute("INSERT INTO app_paper_version(paper_id, version, saved_at, reason, body) VALUES(?, ?, ?, ?, ?)",
                            (pid, n, v.get("at") or "", v.get("reason") or "", snap))
            elif frozen[n] != snap:
                raise SaveError(f"документ {_paper_name(rec)}: затверджену версію {n} змінено — "
                                "затверджені версії не правляться, виправлення йде новою версією")
        gone = sorted(set(frozen) - sent)
        if gone:
            raise SaveError(f"документ {_paper_name(rec)}: зникла затверджена версія {gone[0]} — "
                            "оновіть вікно програми (F5)")
    for (pid,) in con.execute("SELECT id FROM app_paper").fetchall():
        if pid not in seen:
            con.execute("DELETE FROM app_paper WHERE id = ?", (pid,))


def _load_papers(con):
    versions = {}
    for r in con.execute("SELECT paper_id, version, saved_at, reason, body FROM app_paper_version ORDER BY paper_id, version"):
        versions.setdefault(r["paper_id"], []).append(
            {"ver": r["version"], "at": r["saved_at"], "reason": r["reason"] or "", "body": json.loads(r["body"])})
    out = []
    for row in con.execute("SELECT * FROM app_paper ORDER BY pos, id"):
        rec = json.loads(row["body"])
        rec.update({f: row[c] for f, c in PAPER_COLS})
        rec["versions"] = versions.get(row["id"], [])
        out.append(rec)
    return out


# ------------------------------------------------------------- налаштування

# «mtz» — відомість МТЗ: джерело, КПКВ і КЕКВ надходжень, відмітки про подання.
SETTINGS = ["ui", "unit", "baseSeen", "baseSig", "mtz"]
# Розділи старих версій, які запис приймає й відкидає: номери актів до рапортів
# і виправлення рапортів із бази тепер лежать у самих документах.
RETIRED = {"dzActs", "reportFix"}


def _save_settings(con, state):
    con.execute("DELETE FROM app_setting WHERE key NOT LIKE 'orphan_line:%'")
    for key in SETTINGS:
        if key in state:
            con.execute("INSERT INTO app_setting(key, value) VALUES(?, ?)",
                        (key, json.dumps(state[key], ensure_ascii=False)))
    rest = {k: v for k, v in state.items() if k not in KNOWN and k not in ONE_TIME}
    if rest:
        con.execute("INSERT INTO app_setting(key, value) VALUES('_решта', ?)",
                    (json.dumps(rest, ensure_ascii=False),))


def _load_settings(con):
    out = {}
    for key, value in con.execute("SELECT key, value FROM app_setting"):
        if key.startswith("orphan_line:"):
            continue
        if key == "_решта":
            out.update(json.loads(value))
        else:
            out[key] = json.loads(value)
    return out


# Разова дія вікна: виконується під час запису й у стані не лишається — повторений
# з кожним наступним записом перелік видачі номерів ожив би після відновлення з копії.
ONE_TIME = {"invIssue"}

# Довідники більше не частина стану: вони лежать у своїх таблицях, і застосунок
# бачить їх у витягу з бази. Тут вони лише приймаються на запис.
DIRECTORIES = {"people", "mvo", "cmdrs", "officials", "locations", "subs", "norms", "items"}
KNOWN = set(SIMPLE) | set(SETTINGS) | DIRECTORIES | RETIRED | {"docs", "recon", "inventories",
                                                               "subst", "log", "papers"}


# ------------------------------------------------------------------ публічне

def _legacy(state):
    """Стан попередніх версій: норми там були мапою «підрозділ|код → кількість»,
    без строку дії. Переносимо їх у записи, чинні від початку обліку, — так само,
    як це робить сам застосунок."""
    norms = state.get("norms")
    if isinstance(norms, dict):
        out = []
        for n, (key, qty) in enumerate(norms.items()):
            sub, _, code = str(key).partition("|")
            if sub and code and qty:
                out.append({"id": f"legacy{n}", "sub": sub, "code": code, "qty": qty,
                            "from": "", "to": "", "basis": ""})
        state = dict(state, norms=out)
    for name in SIMPLE:
        v = state.get(name)
        if v is not None and not isinstance(v, list):
            state = dict(state)
            state.pop(name)
    docs = state.get("docs")
    if isinstance(docs, dict) and isinstance(docs.get("writeoffs"), list):
        state = dict(state, docs=dict(docs, writeoffs=[_wr_row(r) for r in docs["writeoffs"]]))
    return state


_REFUSALS = [
    # (що в повідомленні бази, що сказати людині)
    ("person_history.person_id, person_history.on_date",
     "у людини дві зміни звання чи посади на ту саму дату — виправте дату однієї з них"),
    ("unit_location.valid_from", "два місця дислокації з тією самою датою — виправте дату одного з них"),
    ("valid_to > valid_from", "строк «по» не пізніший за «з» — виправте дати запису"),
    ("NOT NULL constraint failed: person_history.on_date", "у зміні звання чи посади не вказано дату"),
    ("NOT NULL constraint failed: unit_location.valid_from", "у місці дислокації не вказано дату"),
    ("NOT NULL constraint failed: responsible.valid_from", "у призначенні МВО не вказано дату"),
    ("NOT NULL constraint failed: commander.valid_from", "у призначенні командира підрозділу не вказано дату"),
    ("NOT NULL constraint failed: official.valid_from", "у призначенні посадовця не вказано дату"),
    ("instance.nomen_id, instance.serial_no", "у цієї позиції вже є одиниця з таким заводським номером"),
    ("FOREIGN KEY constraint failed", "запис потрібен іншим записам обліку (документам, описам, призначенням), "
                                      "тож прибрати його не можна"),
]


def save_units(con, rows):
    """Реєстр одиниць із заводськими номерами: виправлення (номер, шасі, рік,
    примітка, категорія стану на дату) і нові одиниці, заведені в програмі.
    Нова одиниця впізнається за позицією й заводським номером (або шасі) —
    повторний запис того самого переліку її не дублює. Повертає {id програми:
    id бази} для нових."""
    out = {}
    if not rows:
        return out
    nomens = dict(con.execute("SELECT code, id FROM nomen"))
    for rec in rows:
        nid = nomens.get(str(rec.get("code") or ""))
        serial = str(rec.get("serial") or "").strip() or None
        chassis = str(rec.get("chassis") or "").strip() or None
        if nid is None:
            continue
        # Одиниця з бази приходить зі своїм id (числом), нова — з id програми («u…»).
        known = str(rec.get("id") or "").isdigit()
        row_id = int(rec["id"]) if known else None
        cur = con.execute("SELECT * FROM instance WHERE id = ?", (row_id,)).fetchone() if row_id else None
        if cur is None and (serial or chassis):
            cur = con.execute("SELECT * FROM instance WHERE nomen_id = ? AND "
                              + ("serial_no = ?" if serial else "chassis_no = ?"),
                              (nid, serial or chassis)).fetchone()
        if rec.get("deleted"):
            # Прибрати можна лише одиницю, якої не торкався жоден документ.
            if cur is not None and not con.execute("SELECT 1 FROM document_line WHERE instance_id = ? LIMIT 1",
                                                   (cur["id"],)).fetchone():
                con.execute("DELETE FROM instance_condition WHERE instance_id = ?", (cur["id"],))
                con.execute("DELETE FROM instance_assignment WHERE instance_id = ?", (cur["id"],))
                con.execute("DELETE FROM instance WHERE id = ?", (cur["id"],))
            continue
        year = int(rec["year"]) if str(rec.get("year") or "").strip().isdigit() else None
        cols = dict(serial_no=serial, chassis_no=chassis, made_year=year,
                    note=str(rec.get("note") or "").strip() or None)
        if cur is None:
            if not (serial or chassis):
                continue                      # без номера одиницю не впізнати
            new_id = con.execute("INSERT INTO instance(nomen_id, serial_no, chassis_no, made_year, note) "
                                 "VALUES(?, ?, ?, ?, ?)", (nid, *cols.values())).lastrowid
        else:
            new_id = cur["id"]
            if any(cur[k] != v for k, v in cols.items()):
                con.execute("UPDATE instance SET serial_no = ?, chassis_no = ?, made_year = ?, note = ? "
                            "WHERE id = ?", (*cols.values(), new_id))
                # Фото й паспорт одиниці прив'язані до її номера — ідуть за виправленим.
                was = cur["serial_no"] or cur["chassis_no"]
                now = serial or chassis
                if was and now and was != now:
                    con.execute("UPDATE nomen_file SET unit_no = ? WHERE nomen_id = ? AND unit_no = ?",
                                (now, nid, was))
        if not known:
            out[str(rec.get("id"))] = new_id
        cat, on = rec.get("cat"), str(rec.get("catDate") or "").strip()
        if cat and on and str(cat).isdigit() and 1 <= int(cat) <= 5:
            have = con.execute("SELECT id, condition_cat FROM instance_condition WHERE instance_id = ? "
                               "AND on_date = ?", (new_id, on)).fetchone()
            if have is None:
                con.execute("INSERT INTO instance_condition(instance_id, on_date, condition_cat, note) "
                            "VALUES(?, ?, ?, 'з програми')", (new_id, on, int(cat)))
            elif have["condition_cat"] != int(cat):
                con.execute("UPDATE instance_condition SET condition_cat = ? WHERE id = ?", (int(cat), have["id"]))
    return out


def _refusal(e):
    """Відмова бази — словами: людина має знати, що саме виправити."""
    text = str(e)
    for needle, said in _REFUSALS:
        if needle in text:
            return said
    return text


# Що останній запис дав новим записам про знищення: {id програми: [id документа,
# id рядка]}. Вікно вписує їх у свої записи — так само, як id документів.
LAST_SAVE = {"reports": {}}


def save_state(con, state, replace_papers=False):
    """Записати модель застосунку в базу. Все або нічого. Відмова бази (строки,
    що перекриваються, дві записи на ту саму дату) приходить як SaveError зі
    словами — інакше вікно бачило лише «програма не відповідає».
    Повертає {id програми: id бази} одиниць, щойно заведених у реєстрі; id
    нових записів про знищення — у LAST_SAVE["reports"]."""
    LAST_SAVE["reports"] = {}
    state = _legacy_reports(_legacy(state))
    try:
        return _save_state(con, state, replace_papers)
    except sqlite3.IntegrityError as e:
        raise SaveError(_refusal(e)) from e


# Де в рядку журналу застосунку id одиниці із заводським номером.
UNIT_AT = {"incoming": 12, "movement": 12, "writeoffs": 12}


def _remap_units(docs, ids):
    """Рядок, що назвав щойно заведену одиницю її id програми, отримує id бази."""
    for journal, at in UNIT_AT.items():
        for r in (docs or {}).get(journal) or []:
            if len(r) > at and str(r[at]) in ids:
                r[at] = ids[str(r[at])]


# Залишок позиції в підрозділі на кінець дня — сума проводок до цього дня
# включно. Саме так рахує вікно (stockAt), тож порядок документів одного дня
# ролі не грає: видача й прихід одного дня — не мінус.
NEGATIVE_SQL = """
WITH day AS (
  SELECT nomen_id, subdivision_id, doc_date, SUM(sign * qty_milli) AS d
    FROM posting GROUP BY nomen_id, subdivision_id, doc_date),
run AS (
  SELECT nomen_id, subdivision_id, doc_date,
         SUM(d) OVER (PARTITION BY nomen_id, subdivision_id ORDER BY doc_date
                      ROWS UNBOUNDED PRECEDING) AS bal
    FROM day)
SELECT nomen_id, subdivision_id, doc_date, bal FROM run WHERE bal < 0"""


def _date_words(date):
    return f"{date[8:10]}.{date[5:7]}.{date[:4]}" if date and len(str(date)) == 10 else str(date)


def negative_days(con):
    """Дні, на кінець яких залишок позиції в підрозділі від'ємний:
    {(nomen_id, subdivision_id, doc_date): залишок у тисячних}."""
    return {(r[0], r[1], r[2]): r[3] for r in con.execute(NEGATIVE_SQL)}


def _negative_words(con, new):
    """Відмова словами: що, де й на яку дату йде в мінус (до трьох випадків)."""
    parts = []
    for (nomen_id, sub_id, date), bal in sorted(new.items(), key=lambda kv: (kv[0][2], kv[0][0]))[:3]:
        n = con.execute("SELECT code, name FROM nomen WHERE id = ?", (nomen_id,)).fetchone()
        sd = con.execute("SELECT name FROM subdivision WHERE id = ?", (sub_id,)).fetchone()
        what = f"{n[0]} {n[1]}" if n else f"позиція {nomen_id}"
        where = sd[0] if sd else f"підрозділ {sub_id}"
        parts.append(f"«{what}» у «{where}» на {_date_words(date)}: {bal / 1000:+g}")
    more = f" і ще {len(new) - 3}" if len(new) > 3 else ""
    return ("залишок стає від'ємним: " + "; ".join(parts) + more
            + ". Перевірте дати й кількості документів")


# Інша ціна — інший код: позиція несе одну ціну, а майно за іншою ціною — інша
# позиція зі своїм кодом (так веде облік книга служби). Ціни, з якими позиція вже
# лежить у базі, лишаються: відмова лише на запис, що додає позиції ще одну ціну.
def code_prices(con):
    """Ціни, за якими позиції оприбутковано: {id позиції: {ціна в копійках}}."""
    out = {}
    for nomen_id, kop in con.execute("SELECT DISTINCT nomen_id, price_kop FROM batch "
                                     "WHERE price_kop IS NOT NULL"):
        out.setdefault(nomen_id, set()).add(kop)
    return out


def _money_words(kop):
    """Ціна так, як її пишуть у папері: 21 789,60."""
    return f"{kop / 100:,.2f}".replace(",", " ").replace(".", ",")


def _price_words(con, added, before):
    """Відмова словами: яка позиція отримує ще одну ціну (до трьох випадків)."""
    parts = []
    for nomen_id in sorted(added)[:3]:
        n = con.execute("SELECT code, name FROM nomen WHERE id = ?", (nomen_id,)).fetchone()
        what = f"{n[0]} «{n[1]}»" if n else f"позицію {nomen_id}"
        was = sorted(before.get(nomen_id) or ())
        new = ", ".join(_money_words(k) for k in sorted(added[nomen_id]))
        if was:
            parts.append(f"{what} оприбутковано за {', '.join(_money_words(k) for k in was)} грн, "
                         f"а запис додає ціну {new} грн")
        else:
            parts.append(f"{what} запис оприбутковує за різними цінами: {new} грн")
    more = f" і ще {len(added) - 3}" if len(added) > 3 else ""
    return "; ".join(parts) + more + ". Для іншої ціни заведіть новий код"


_DATE_LIKE = re.compile(r"^[+-]?(\d{4,6})-(\d{2})-(\d{2})$")
_DATE_IN_TEXT = re.compile(r"(?<![\d-])(\d{4,6})-(\d{2})-(\d{2})(?![\d-])")
DATE_YEARS = (1950, 2100)
# Назви розділів стану для повідомлення про дату; решта називається своїм ключем.
SECTION_WORDS = {"docs": "документи", "people": "люди", "mvo": "МВО", "officials": "посадовці",
                 "cmdrs": "командири", "locations": "дислокація", "norms": "штат", "items": "номенклатура",
                 "units": "одиниці", "subs": "підрозділи", "destroyed": "знищене майно", "recon": "звірки",
                 "reconBase": "звірки", "inventories": "інвентаризації", "papers": "документи служби",
                 "subst": "заміни", "scans": "файли", "mtz": "відомість МТЗ"}
# Поля, де рядок «рррр-мм-дд» може бути номером чи назвою з паперу, а не датою.
NOT_A_DATE = {"no", "offNo", "report", "act", "name", "tname", "note", "pnote", "text", "basis", "title",
              "file", "path", "id", "key"}


def _record_words(rec):
    """Як назвати запис у повідомленні: людина, документ, підрозділ, позиція."""
    for keys in (("surname", "name"), ("no",), ("title",), ("sub",), ("name",), ("code",)):
        got = " ".join(str(rec.get(k) or "").strip() for k in keys).strip()
        if got:
            return got
    return ""


def _odd_dates_in_base(con):
    """Дати з роком поза межами, які вже лежать у базі (унесені до цієї перевірки): вони запису не
    спиняють — про них каже «Перевірити базу…». Шукаємо в усіх текстових графах, і в записах,
    що зберігаються цілими (інвентаризації, звірки, налаштування)."""
    out = set()
    tables = [r[0] for r in con.execute("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")]
    for t in tables:
        if t in ("audit_log", "app_log"):
            continue
        for col in con.execute(f'PRAGMA table_info("{t}")').fetchall():
            if "TEXT" not in str(col[2]).upper():
                continue
            name = '"' + col[1] + '"'
            for (value,) in con.execute(f'SELECT DISTINCT {name} FROM "{t}" WHERE {name} LIKE ?', ("%-__-__%",)):
                for m in _DATE_IN_TEXT.finditer(str(value)):
                    if not DATE_YEARS[0] <= int(m.group(1)) <= DATE_YEARS[1]:
                        out.add(m.group(0))
    return out


def _check_dates(con, state):
    """Рік, набраний у полі дати не повністю («30.09.26» дає 0026 рік), — описка: поле дати у
    вікні приймає будь-який рік, і така дата мовчки лягала в базу (звання від 30.09.0002).
    Відмова словами — із записом, де вона стоїть. Дата, що вже лежить у базі, запису не спиняє:
    інакше через одну давню описку не записувалося б нічого."""
    odd = []

    def walk(v, section, words, key=None):
        if isinstance(v, dict):
            mine = _record_words(v) or words
            for k, x in v.items():
                walk(x, section, mine, k)
        elif isinstance(v, list):
            for x in v:
                walk(x, section, words, key)
        elif isinstance(v, str) and key not in NOT_A_DATE:
            m = _DATE_LIKE.match(v)
            if m and not DATE_YEARS[0] <= int(m.group(1)) <= DATE_YEARS[1]:
                odd.append((v.lstrip("+-"), m, section, words))
    for section, v in state.items():
        if section not in ("log", "ui"):                  # журнал змін і вигляд екрана дат обліку не несуть
            walk(v, section, "")
    if not odd:
        return
    known = _odd_dates_in_base(con)
    for value, m, section, words in odd:
        if value not in known:
            where = ", ".join(x for x in (SECTION_WORDS.get(section, section), words) if x)
            raise SaveError(f"дата {m.group(3)}.{m.group(2)}.{m.group(1)} ({where}): рік уведено не повністю "
                            f"або з опискою — виправте дату")


def _save_state(con, state, replace_papers=False):
    _check_dates(con, state)
    con.execute("BEGIN IMMEDIATE")
    try:
        # Мінус, що вже є в базі (з паперових журналів), не заважає записувати
        # інше: відмова лише на новий мінус, якого до цього запису не було.
        before = negative_days(con) if state.get("docs") is not None else None
        prices = code_prices(con) if state.get("docs") is not None else None
        con.execute("DELETE FROM app_setting WHERE key LIKE 'orphan_line:%'")
        # Підрозділи й позиції — ДО документів: накладна на щойно заведений
        # підрозділ чи з новою позицією інакше лягала без одержувача чи без рядка.
        _save_subdivisions(con, state.get("subs"))
        _save_items(con, state.get("items"))
        # Одиниці реєстру — теж до документів: прихід може назвати щойно заведену.
        units = save_units(con, state.get("units"))
        _remap_units(state.get("docs"), units)
        for rec in state.get("destroyed") or []:
            if isinstance(rec, dict) and str(rec.get("unit") or "") in units:
                rec["unit"] = str(units[str(rec["unit"])])
        # Документи переписуються не всі підряд, а лише ті, що змінилися: інакше
        # кожне збереження тягло б за собою весь облік — і в журнал аудиту, і в
        # розмір файла.
        _save_docs(con, state.get("docs"))
        _save_simple(con, "scans", state.get("scans"))
        # Порядок важить: підрозділи потрібні МВО й нормам, люди — призначенням,
        # номенклатура — нормам на код. Другий захід по підрозділах прибирає ті,
        # на які посилалися документи, щойно видалені цим самим записом.
        _save_subdivisions(con, state.get("subs"))
        _save_people(con, state.get("people"))
        _save_responsible(con, state.get("mvo"), state.get("officials"), state.get("cmdrs"))
        _save_locations(con, state.get("locations"))
        _save_items(con, state.get("items"))
        _save_line_codes(con, state.get("lineCodes"))
        _save_inv_issue(con, state.get("invIssue"))
        _save_inv_moves(con, state.get("invMoves"))
        # Рапорти — після документів: номер акта знаходить уже проведений акт.
        reports = _save_reports(con, state.get("destroyed"))
        _save_norms(con, state.get("norms"))
        _save_recon(con, state.get("recon"))
        _save_recon_base(con, state.get("reconBase"))
        _save_inventories(con, state.get("inventories"))
        _save_subst(con, state.get("subst"))
        _save_papers(con, state.get("papers"), replace_papers)
        _save_log(con, state.get("log"))
        _save_settings(con, state)
        if prices is not None:
            added = {k: v - prices.get(k, set()) for k, v in code_prices(con).items()
                     if len(v) > 1 and v - prices.get(k, set())}
            if added:
                raise SaveError(_price_words(con, added, prices))
        if before is not None:
            # Вікно блокує видачу понад залишок і видалення приходу, з якого
            # видали; сервер раніше довіряв йому, і через API чи з іншого вікна
            # залишок міг піти в мінус. Тепер відмова словами й нічого не записано.
            new = {k: v for k, v in negative_days(con).items() if k not in before}
            if new:
                raise SaveError(_negative_words(con, new))
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    LAST_SAVE["reports"] = reports
    return units


def load_state(con):
    """Зібрати модель застосунку з бази — у тому вигляді, в якому він її віддав.

    Порожні розділи не вигадуємо: чиста база має віддати порожній стан, а не
    перелік порожніх переліків — застосунок відрізняє «ще нічого не вносили»
    від «внесене видалили»."""
    state = {"docs": _load_docs(con)}
    state["scans"] = _load_simple(con, "scans")
    # Рапорти — документи бази; записи, що ще не лягли в документ (старі версії
    # чи ті, що чекають виправлення), — за ними.
    state["destroyed"] = _load_reports(con) + [dict(r, origin="program") for r in _load_simple(con, "destroyed")]
    state["recon"] = _load_recon(con)
    state["inventories"] = _load_inventories(con)
    state["subst"] = _load_subst(con)
    state["papers"] = _load_papers(con)
    state["log"] = _load_log(con)
    state.update(_load_settings(con))
    state = _legacy_reports(state)
    if not any(state["docs"].values()):
        del state["docs"]
    return {k: v for k, v in state.items() if v or isinstance(v, (int, float, str))}


def is_empty(con):
    """Чи є в базі хоч що-небудь, внесене в програмі."""
    n = con.execute("SELECT COUNT(*) FROM document WHERE source = 'program'").fetchone()[0]
    if n:
        return False
    for table in ("app_destroyed", "app_subst", "app_recon", "app_inventory",
                  "app_file", "app_log", "app_setting", "app_paper"):
        if con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]:
            return False
    return True
