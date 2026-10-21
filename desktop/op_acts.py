# -*- coding: utf-8 -*-
"""Акти списання посуду, серветок і миючих засобів за нормами наказу МОУ №390 (вид акта «op390»).

Ядро акта спільне для книг: дані акта лежать поруч із документом вибуття (`act`, `act_paper`,
`act_signer`, `act_item`), підписанти — знімком, складання й видалення — однією транзакцією.
Вид «op390»: серія ОП — група «Одноразовий посуд», серія МЗ — «Серветки» й «Миючі засоби» в одному акті.
Кількість — завжди за нормою: д/д пункту харчування за період × норма позиції на д/д («дободач»), вниз
до кроку групи, не більше залишку місця пункту на кінець періоду й на дату акта; кількість пулу (рядок
норми наказу 390, op_norms.pool_key) ділиться між кодами за порядком надходження — спершу код із найстаршою партією.
Номер акта — один на рік серед документів вибуття; виправляють лише наявний акт (його документ).
"""
import datetime as dt
import re
from decimal import ROUND_FLOOR, ROUND_HALF_UP, Decimal

import op_norms
import state_db
from state_db import SaveError

KIND = "op390"
PAPER = "Акт списання"
SERIES = {
    "ОП": {"groups": ("ОП.1",), "fmt": "ОП{year}-{n:03d}", "folder": "Посуд"},
    "МЗ": {"groups": ("ОП.2", "ОП.3"), "fmt": "МЗ{year}-{n:02d}", "folder": "Миючі і серветки"},
}
GROUP_NAMES = {"ОП.1": "Одноразовий посуд", "ОП.2": "Серветки", "ОП.3": "Миючі засоби"}
# Як папери пакета називають те, що списується, — за групами рядків акта (акт МЗ буває лише з серветками чи лише з
# миючими): «що» (висновок комісії), «чого» (розрахунок), «для чого використано» (рапорт).
WORDING = {
    ("ОП.1",): ("одноразовий посуд", "одноразового посуду", "роздачі їжі"),
    ("ОП.2",): ("серветки", "серветок", "роздачі їжі"),
    ("ОП.3",): ("миючі засоби", "миючих засобів", "миття посуду"),
    ("ОП.2", "ОП.3"): ("серветки й миючі засоби", "серветок і миючих засобів", "роздачі їжі й миття посуду"),
}
GONE = "Такого акта немає — його могли видалити в іншому вікні. Оновіть сторінку."
CHANGED = "Акт змінили чи видалили в іншому вікні. Оновіть сторінку."
LOCKED_MARK = " — у закритому періоді"            # як у журналі змін сторінки після згоди на закритий період


def _iso(v, what):
    """Дата з запиту — «рррр-мм-дд» за календарем і з роком у межах обліку (state_db.DATE_YEARS), як у кожному іншому
    записі бази. Рік, набраний не повністю («27.07.26» у полі дати дає 0026), — відмова словами: така дата не лягає ні в
    акт, ні в його папери (книга ОП з нею назад не читається), і розрахунок не обходить сотні тисяч днів."""
    try:
        day = dt.date.fromisoformat(str(v or "")[:10])
    except ValueError:
        raise SaveError(f"{what}: потрібна дата.") from None
    if not state_db.DATE_YEARS[0] <= day.year <= state_db.DATE_YEARS[1]:
        raise SaveError(f"{what}: «{_dmy(day.isoformat())}» — не дата або рік з опискою.")
    return day.isoformat()


def wording(groups):
    """(що, чого, для чого) — слова паперів пакета за групами рядків акта; невідомий набір — як у МЗ з обома."""
    key = tuple(sorted(set(groups or ())))
    return WORDING.get(key) or WORDING[("ОП.2", "ОП.3")]


def package_names(number):
    """Імена двох файлів пакета акта: «<номер>.xlsx» і «Звірка <номер>.xlsx» (номер — як ім'я файла)."""
    import excel_export                                          # noqa: PLC0415 — openpyxl лише тоді, коли треба
    return (excel_export.safe_name(number) + ".xlsx", excel_export.safe_name(f"Звірка {number}") + ".xlsx")


def _dmy(iso):
    return f"{iso[8:10]}.{iso[5:7]}.{iso[:4]}" if iso else ""


def _series(series):
    s = str(series or "")
    if s not in SERIES:
        raise SaveError("Серія акта — ОП чи МЗ.")
    return s


def _doc_id(v):
    """Id документа акта з запиту: ціле число або 0 (новий акт)."""
    try:
        return int(v or 0)
    except (TypeError, ValueError, OverflowError):          # OverflowError: «Infinity» з JSON
        raise SaveError("Акт не впізнано. Оновіть сторінку.") from None


def _sum(q_milli, kop):
    """Сума рядка в гривнях: кількість (тисячні) × ціна (копійки), до копійки — половина вгору, як у паперах і в Excel."""
    return float((Decimal(q_milli) * Decimal(kop) / 100000).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _key(day, number, holder):
    """Ключ документа акта — той самий, що на сторінці: вид, дата, номер, звідки, кому."""
    return f"wr|{day}|{number}|{holder}|"


def _act_exists(con, doc_id):
    return con.execute("SELECT 1 FROM act WHERE document_id = ?", (doc_id,)).fetchone() is not None


def sig_of(con, doc_id):
    """Відбиток акта таким, яким він зараз у базі (state_db._act_sig): відповідь, що називає щойно записаний акт, несе його —
    вікно, що стало цим актом, тримає відбиток у `was.sig`, як вікно акта, відкритого з реєстру (_same_act порівняє його).
    Акта немає — порожній рядок."""
    act = state_db._load_acts(con).get(str(doc_id))
    return act["sig"] if act else ""


def _same_act(con, doc_id, was):
    """Вікно акта знає, яким акт був, коли його відкрило (`was`: number, date, from, to, sig — що є). Інше під тим самим
    id — уже інший акт (SQLite віддає новому документу id видаленого) чи акт, виправлений в іншому вікні (`sig` —
    відбиток підписантів, паперів, примітки, пункту й серії: state_db._act_sig, у кожного акта стану — `sig`).
    Без `was` — не перевіряється; `was` не словником — не той акт (зламане вікно не вимикає перевірки)."""
    if was is None:
        return True
    if not isinstance(was, dict):
        return False
    cur = con.execute("""SELECT d.number, d.doc_date, a.period_from, a.period_to FROM document d
                           LEFT JOIN act a ON a.document_id = d.id WHERE d.id = ?""", (doc_id,)).fetchone()
    if cur is None:
        return False
    have = {"number": " ".join(str(cur[0] or "").split()), "date": cur[1] or "", "from": cur[2] or "", "to": cur[3] or ""}
    if not all(" ".join(str(was[k]).split()) == have[k] for k in have if was.get(k)):
        return False
    if was.get("sig"):
        act = state_db._load_acts(con).get(str(doc_id))
        return act is not None and str(was["sig"]) == act["sig"]
    return True


def _number_taken(con, number, day, exclude):
    """Номер уже має інший документ вибуття того самого року."""
    return con.execute("""SELECT 1 FROM document d JOIN doc_kind k ON k.id = d.kind_id
                           WHERE k.code = 'writeoff' AND TRIM(d.number, ' ' || char(9, 10, 13, 160)) = ?
                             AND d.doc_date LIKE ? AND d.id <> ?""",
                       (number, f"{day[:4]}-%", exclude)).fetchone() is not None


def point(con, ext):
    r = con.execute("""SELECT p.id, p.ext_id, p.name, p.subdivision_id, s.name AS sub, k.code AS kind,
                              p.hall, p.title, p.closed_at
                         FROM food_point p JOIN subdivision s ON s.id = p.subdivision_id
                         LEFT JOIN subdivision_kind k ON k.id = s.kind_id
                        WHERE p.ext_id = ? OR p.name = ?""", (str(ext or ""), str(ext or ""))).fetchone()
    if r is None:
        raise SaveError("Немає такого пункту харчування — заведіть його на вкладці «Пункти харчування».")
    return {"id": r["id"], "ext": r["ext_id"], "name": r["name"], "sub_id": r["subdivision_id"], "sub": r["sub"],
            "sub_kind": r["kind"] or "", "hall": r["hall"] or "", "title": r["title"] or "", "closed": r["closed_at"] or ""}


def rations(con, point_id, d1, d2):
    """Д/д пункту за дні періоду: сума, дні з номером витягу, дні без даних. Дні рахуються в межах років обліку: акт,
    що ліг у базу з роком-опискою ще до перевірки дат, не обходить сотні тисяч днів."""
    got = {r[0]: (r[1], r[2] or "") for r in con.execute(
        """SELECT d.on_date, d.rations, x.order_no FROM ration_day d LEFT JOIN ration_date x ON x.on_date = d.on_date
            WHERE d.point_id = ? AND d.on_date BETWEEN ? AND ? ORDER BY d.on_date""", (point_id, d1, d2))}
    days, missing = [], []
    day = max(dt.date.fromisoformat(d1), dt.date(state_db.DATE_YEARS[0], 1, 1))
    end = min(dt.date.fromisoformat(d2), dt.date(state_db.DATE_YEARS[1], 12, 31))
    while day <= end:
        iso = day.isoformat()
        if iso in got:
            days.append([iso, got[iso][0], got[iso][1]])
        else:
            missing.append(iso)
        day += dt.timedelta(days=1)
    return {"total": sum(n for _, n, _ in days), "days": days, "missing": missing}


def _balance(con, sub_id, nomen_id, day, exclude):
    return con.execute("""SELECT COALESCE(SUM(sign * qty_milli), 0) FROM posting
                           WHERE subdivision_id = ? AND nomen_id = ? AND doc_date <= ? AND document_id <> ?""",
                       (sub_id, nomen_id, day, exclude)).fetchone()[0]


def _first_batch(con, sub_id, nomen_id, day, exclude):
    """Дата найстаршої партії коду, що ще лежить у місці на день `day`."""
    row = con.execute("""SELECT MIN(b.doc_date) FROM (
                            SELECT batch_line_id, SUM(sign * qty_milli) AS q FROM posting
                             WHERE subdivision_id = ? AND nomen_id = ? AND doc_date <= ? AND document_id <> ?
                             GROUP BY batch_line_id HAVING q > 0) s
                          JOIN batch b ON b.batch_line_id = s.batch_line_id""",
                      (sub_id, nomen_id, day, exclude)).fetchone()
    return row[0] or "9999-12-31"


def next_number(con, series, year, exclude=0):
    """Наступний вільний номер серії за рік: найбільший номер документа вибуття цього року + 1
    (документ `exclude` не рахується)."""
    series = _series(series)
    pat = re.compile(rf"^{re.escape(series)}{int(year)}-(\d+)$")
    top = 0
    for (no,) in con.execute("""SELECT d.number FROM document d JOIN doc_kind k ON k.id = d.kind_id
                                 WHERE k.code = 'writeoff' AND d.doc_date LIKE ? AND d.id <> ?""",
                             (f"{int(year)}-%", int(exclude or 0))):
        m = pat.match(str(no).strip())
        if m:
            top = max(top, int(m.group(1)))
    return SERIES[series]["fmt"].format(year=int(year), n=top + 1)


def defaults(con, series, point_ext, today):
    """Період — з дня після попереднього акта серії й пункту (чи з 1-го минулого місяця) до кінця минулого місяця.
    Минулий місяць уже списано — до вчора; списано й учора — один день, з якого акт іще можна скласти."""
    series = _series(series)
    p = point(con, point_ext)
    day = dt.date.fromisoformat(_iso(today, "Дата"))
    end = day.replace(day=1) - dt.timedelta(days=1)
    last = con.execute("SELECT MAX(period_to) FROM act WHERE series = ? AND point_id = ?", (series, p["id"])).fetchone()[0]
    start = dt.date.fromisoformat(last) + dt.timedelta(days=1) if last else end.replace(day=1)
    if start > end:
        end = max(start, day - dt.timedelta(days=1))
    return {"from": start.isoformat(), "to": end.isoformat(), "date": day.isoformat(),
            "number": next_number(con, series, day.year)}


def _overlaps(con, series, point_id, d1, d2, exclude):
    """Акти тієї ж серії й пункту, чий період перетинає [d1, d2] (крім документа `exclude`): [(номер, з, по)]."""
    return [(" ".join(str(r[0] or "").split()), r[1], r[2]) for r in con.execute(
        """SELECT d.number, a.period_from, a.period_to FROM act a JOIN document d ON d.id = a.document_id
            WHERE a.series = ? AND a.point_id = ? AND a.period_from <= ? AND a.period_to >= ?
              AND a.document_id <> ? ORDER BY a.period_from, d.number""", (series, point_id, d2, d1, exclude))]


def _norms_words(n):
    return "дві норми — спишуться обидві" if n == 2 else f"норм: {n} — спишеться кожна"


def compute(con, spec):
    """Пропозиція акта: д/д періоду, рядки за нормою, попередження. Пул — рядок норми наказу 390 (op_norms.pool_key): коди
    одного рядка ділять одну межу, різні рядки з однаковим числом (тарілка мілка й виделка) — кожен свою. Позиція без
    вибраного рядка, чиє число є в кількох рядках наказу, в акт не йде — попередження просить обрати рядок у картці (R60:
    ні межі за назвою, ні спільної за числом)."""
    series = _series(spec.get("series"))
    p = point(con, spec.get("point"))
    d1, d2, day = _iso(spec.get("from"), "Початок періоду"), _iso(spec.get("to"), "Кінець періоду"), _iso(spec.get("date"), "Дата акта")
    if d1 > d2:
        raise SaveError("Початок періоду пізніше за кінець.")
    if d2 > day:
        raise SaveError("Дата акта раніша за кінець періоду.")
    exclude = _doc_id(spec.get("docId"))
    r = rations(con, p["id"], d1, d2)
    groups = SERIES[series]["groups"]
    rows = con.execute(f"""SELECT n.id, n.code, n.name, n.per_ration, n.norm_line, g.code AS grp, u.code AS uom,
                                  COALESCE((SELECT price_kop FROM nomen_last_price WHERE nomen_id = n.id), n.app_price_kop, 0) AS price_kop
                             FROM nomen n JOIN nomen_group g ON g.id = n.group_id JOIN uom u ON u.id = n.uom_id
                            WHERE g.book = 'ОП' AND g.code IN ({",".join("?" * len(groups))})
                            ORDER BY n.code""", groups).fetchall()
    pools, no_norm, held = {}, [], []
    for it in rows:
        have = min(_balance(con, p["sub_id"], it["id"], d2, exclude), _balance(con, p["sub_id"], it["id"], day, exclude))
        per = op_norms.per_milli(it["per_ration"])
        if have <= 0:
            continue
        if per is None:
            no_norm.append(it["code"])
            continue
        held.append({"it": it, "have": have, "per": per})
    keys = op_norms.pool_keys([{"group": h["it"]["grp"], "uom": h["it"]["uom"], "per": h["per"],
                                "line": h["it"]["norm_line"], "name": h["it"]["name"]} for h in held])
    unclear = []                                             # R60: рядка не вибрано, а число є в кількох рядках наказу
    for h, key in zip(held, keys):
        if key is None:
            unclear.append(h)
            continue
        pools.setdefault(key, []).append(
            {"it": h["it"], "have": h["have"], "first": _first_batch(con, p["sub_id"], h["it"]["id"], d2, exclude)})
    lines, warnings, seen = [], [], {}
    for n_pool, (key, codes) in enumerate(sorted(pools.items(), key=lambda kv: op_norms.pool_order(kv[0]))):
        grp, _, per = key
        seen[grp] = seen.get(grp, 0) + 1
        step = op_norms.STEP_MILLI[grp]
        limit = int((Decimal(r["total"]) * per).to_integral_value(rounding=ROUND_FLOOR)) // step * step
        left = min(limit, sum(c["have"] for c in codes))
        for c in sorted(codes, key=lambda c: (c["first"], c["it"]["code"])):
            q = min(left, c["have"])
            left -= q
            it = c["it"]
            lines.append({"code": it["code"], "name": it["name"], "uom": it["uom"], "group": grp, "pool": n_pool,
                          "norm": float(per / 1000), "price": it["price_kop"] / 100, "limit": limit / 1000,
                          "stock": c["have"] / 1000, "qty": q / 1000, "qty_milli": q, "sum": _sum(q, it["price_kop"])})
    if r["missing"]:
        warnings.append(f"Немає дободач за {len(r['missing'])} дн. періоду")
    if not r["total"]:
        warnings.append("За період немає дободач")
    if no_norm:
        warnings.append(f"У {len(no_norm)} позицій немає норми")
    warnings += [f"У групі «{GROUP_NAMES[g]}» {_norms_words(n)}" for g, n in seen.items() if n > 1]
    warnings += [f"Позиція {h['it']['code']} {h['it']['name']}: норма {op_norms.per_text(h['per'])} є в кількох рядках "
                 "наказу 390 — оберіть рядок норми в картці позиції." for h in unclear]
    number = " ".join(str(spec.get("number") or "").split())
    if number and _number_taken(con, number, day, exclude):
        warnings.append(f"Номер {number} уже є в серії {series} {day[:4]} року")
    overlap = _overlaps(con, series, p["id"], d1, d2, exclude)
    if overlap:
        warnings.append("Період перетинається з " + ", ".join(f"актом №{no} ({_dmy(a)} — {_dmy(b)})" for no, a, b in overlap))
    return {"series": series, "point": p["ext"], "pointName": p["name"], "sub": p["sub"], "from": d1, "to": d2,
            "date": day, "rations": r["total"], "days": r["days"], "missing": r["missing"],
            "lines": [l for l in lines if l["qty_milli"] > 0], "noNorm": no_norm, "warnings": warnings,
            "overlap": [no for no, _, _ in overlap]}


PAPER_ROLES = ("накладна", "рапорт", "звірка", "розрахунок")
# Роль акта → посадовець «Люди й МВО», яким її заповнити для першого акта пункту. «Бухгалтер» акта — це «Начфін»
# (начальник фінансово-економічної служби: друкується в акті й у блоці ФЕС накладної), тобто посадовець «начальник ФЕС»,
# а не «бухгалтер» (бухгалтер ФЕС лише вносить облікові дані).
_OFFICIALS = (("командир", "командир"), ("начальник служби", "начальник служби"), ("бухгалтер", "начальник ФЕС"),
              ("начальник логістики", "начальник логістики"))


def _name(r):
    """«Ім'я ПРІЗВИЩЕ», як у підписах бланків; без частин імені — як записано."""
    if r["given_name"] and r["surname"]:
        return f"{r['given_name']} {r['surname'].upper()}"
    return r["full_name"] or ""


def default_signers(con, point_ext, day):
    """З попереднього акта пункту, де підписантів записано; якщо такого немає — посадовці програми й МВО місця на дату."""
    p = point(con, point_ext)
    prev = con.execute("""SELECT a.document_id FROM act a JOIN document d ON d.id = a.document_id
                           WHERE a.point_id = ? AND d.doc_date <= ?
                             AND EXISTS (SELECT 1 FROM act_signer s WHERE s.document_id = a.document_id)
                           ORDER BY d.doc_date DESC, a.document_id DESC LIMIT 1""",
                       (p["id"], day)).fetchone()
    if prev:
        return [{"role": r["role"], "sort": r["sort"], "pos": r["position"] or "", "rank": r["rank"] or "",
                 "name": r["name"] or ""}
                for r in con.execute("SELECT * FROM act_signer WHERE document_id = ? ORDER BY role, sort", (prev[0],))]
    out = []
    for role, official in _OFFICIALS:
        r = con.execute("""SELECT p.* FROM official o JOIN person p ON p.id = o.person_id
                            WHERE o.role = ? AND o.valid_from <= ? AND (o.valid_to IS NULL OR o.valid_to > ?)
                            ORDER BY o.valid_from DESC LIMIT 1""", (official, day, day)).fetchone()
        if r:
            out.append({"role": role, "sort": 0, "pos": r["position"] or "", "rank": r["rank"] or "", "name": _name(r)})
    r = con.execute("""SELECT p.* FROM responsible x JOIN person p ON p.id = x.person_id
                        WHERE x.subdivision_id = ? AND x.valid_from <= ? AND (x.valid_to IS NULL OR x.valid_to > ?)
                        ORDER BY x.valid_from DESC LIMIT 1""", (p["sub_id"], day, day)).fetchone()
    if r:
        out.append({"role": "МВО", "sort": 0, "pos": r["position"] or "", "rank": r["rank"] or "", "name": _name(r)})
    return out


def default_papers(number, d1, d2, day, with_issue=True):
    """Типові номери й дати паперів пакета: накладна — початок періоду, рапорт — кінець, звірка й розрахунок — дата акта."""
    out = {"рапорт": {"no": "", "date": d2}, "звірка": {"no": number, "date": day}, "розрахунок": {"no": "", "date": day}}
    if with_issue:
        out["накладна"] = {"no": number, "date": d1}
    return out


def _clean_signers(recs):
    if recs is not None and not isinstance(recs, list):
        raise SaveError("Підписантів акта не впізнано. Оновіть сторінку.")
    out, seen = [], set()
    for r in recs or []:
        if r is not None and not isinstance(r, dict):
            raise SaveError("Підписанта не впізнано. Оновіть сторінку.")
        role = " ".join(str((r or {}).get("role") or "").split())
        try:
            sort = int((r or {}).get("sort") or 0)
        except (TypeError, ValueError):
            raise SaveError(f"Підписант «{role}»: порядок — ціле число.") from None
        vals = tuple(" ".join(str((r or {}).get(k) or "").split()) for k in ("pos", "rank", "name"))
        if role and any(vals) and (role, sort) not in seen:
            seen.add((role, sort))
            out.append((role, sort, *vals))
    return out


def _check_papers(papers):
    """Папери пакета ({роль: {no, date}}) — до запису: дата кожного — справжня."""
    if papers is None:
        return
    if not isinstance(papers, dict):
        raise SaveError("Папери акта не впізнано. Оновіть сторінку.")
    for role, rec in papers.items():
        if role in PAPER_ROLES and rec is not None and not isinstance(rec, dict):
            raise SaveError(f"Папір «{role}» не впізнано. Оновіть сторінку.")
        if role in PAPER_ROLES and isinstance(rec, dict) and rec.get("date"):
            _iso(rec["date"], f"Дата паперу «{role}»")


def _write_act(con, doc, prop, spec, off_norm=False):
    con.execute("""INSERT INTO act(document_id, kind, series, point_id, period_from, period_to, rations, off_norm, note)
                   VALUES(?, ?, ?, (SELECT id FROM food_point WHERE ext_id = ?), ?, ?, ?, ?, ?)
                   ON CONFLICT(document_id) DO UPDATE SET kind = excluded.kind, series = excluded.series,
                     point_id = excluded.point_id, period_from = excluded.period_from, period_to = excluded.period_to,
                     rations = excluded.rations, off_norm = excluded.off_norm, note = excluded.note""",
                (doc, KIND, prop["series"], prop["point"], prop["from"], prop["to"], prop["rations"], int(off_norm),
                 " ".join(str(spec.get("note") or "").split()) or None))
    for t in ("act_paper", "act_signer", "act_item"):
        con.execute(f"DELETE FROM {t} WHERE document_id = ?", (doc,))
    for role, rec in (spec.get("papers") or {}).items():
        if role in PAPER_ROLES and isinstance(rec, dict) and (rec.get("no") or rec.get("date")):
            on = _iso(rec["date"], f"Дата паперу «{role}»") if rec.get("date") else None
            con.execute("INSERT INTO act_paper(document_id, role, number, doc_date) VALUES(?, ?, ?, ?)",
                        (doc, role, " ".join(str(rec.get("no") or "").split()) or None, on))
    for row in _clean_signers(spec.get("signers")):
        con.execute("INSERT INTO act_signer(document_id, role, sort, position, rank, name) VALUES(?, ?, ?, ?, ?, ?)",
                    (doc, *row))
    for l in prop["lines"]:
        con.execute("""INSERT OR REPLACE INTO act_item(document_id, nomen_id, norm)
                       VALUES(?, (SELECT id FROM nomen WHERE code = ?), ?)""", (doc, l["code"], l["norm"]))


def _log(con, what, key, text, who):
    con.execute("INSERT INTO app_log(at, what, key, text, who) VALUES(?, ?, ?, ?, ?)",
                (dt.datetime.now().strftime("%Y-%m-%d %H:%M"), what, key, text, who or None))


def _overlap_ok(spec):
    """Номери актів, з якими людина бачила перетин періоду в пропозиції (`overlapOk` — перелік) і зберігає все одно."""
    got = spec.get("overlapOk")
    return {" ".join(str(x).split()) for x in got if isinstance(x, (str, int))} if isinstance(got, list) else set()


def save(con, spec, who=None):
    """Складає новий акт чи виправляє наявний (`docId`): документ вибуття, дані акта, статус ФЕС — разом.
    `docId` — лише документ наявного акта: акт, видалений в іншому вікні, не складається наново;
    `was` ({number, date, from, to, sig}) — яким акт був у вікні: інший чи виправлений деінде акт не переписується;
    `overlapOk` — номери актів, перетин із якими вікно показало: перетин з іншим (акт склали, поки вікно було
    відкрите) — відмова, перевіряється в транзакції; `locked: true` — людина погодилась на закритий період
    (позначка в журналі змін, як для решти документів)."""
    number = " ".join(str(spec.get("number") or "").split())
    if not number or "|" in number:
        raise SaveError("Вкажіть номер акта.")
    _clean_signers(spec.get("signers"))                      # підписанти й папери — до запису, не після документа
    _check_papers(spec.get("papers"))
    doc_id = _doc_id(spec.get("docId"))
    if doc_id and not _act_exists(con, doc_id):
        raise SaveError(GONE)
    if doc_id and not _same_act(con, doc_id, spec.get("was")):
        raise SaveError(CHANGED)
    prop = compute(con, spec)
    if not prop["lines"]:
        raise SaveError("Немає чого списувати: " + ("; ".join(w.rstrip(".") for w in prop["warnings"])
                                                     or "немає залишку позицій із нормою") + ".")
    day, holder = prop["date"], prop["sub"]
    con.execute("BEGIN IMMEDIATE")
    try:
        if doc_id and not _act_exists(con, doc_id):          # між перевіркою й записом акт могли видалити
            raise SaveError(GONE)
        if doc_id and not _same_act(con, doc_id, spec.get("was")):
            raise SaveError(CHANGED)
        if _number_taken(con, number, day, doc_id):
            raise SaveError(f"Документ №{number} уже є в {day[:4]} році.")
        seen = _overlap_ok(spec)                             # перетин, якого пропозиція у вікні не показала, — відмова
        fresh = [o for o in _overlaps(con, prop["series"], point(con, prop["point"])["id"], prop["from"], prop["to"], doc_id)
                 if o[0] not in seen]
        if fresh:
            raise SaveError("Період перетинається з " + ", ".join(f"актом №{no} ({_dmy(a)} — {_dmy(b)})" for no, a, b in fresh)
                            + ". Перевірте період і збережіть ще раз.")
        before = state_db.negative_days(con)
        head = con.execute("""SELECT d.doc_date, d.number, s.name FROM document d
                                LEFT JOIN subdivision s ON s.id = d.from_subdivision_id WHERE d.id = ?""",
                           (doc_id,)).fetchone() if doc_id else None
        docs = state_db._load_docs(con)
        rows = [r for r in docs.get("writeoffs", [])
                if not (doc_id and len(r) > 10 and state_db._doc_key(r[10]) == doc_id)]
        rows += [[day, PAPER, number, holder, "", l["code"], l["qty_milli"] / 1000, "", 0, "",
                  doc_id or None, "program"] for l in prop["lines"]]
        docs["writeoffs"] = rows
        state_db._save_docs(con, docs)
        if doc_id:                                           # виправлення — той самий документ
            doc = doc_id
        else:
            # Новий — документ саме з шапкою акта; номер — як записано (такого ж номера року, хоч із пробілами,
            # уже немає — _number_taken). Не «новий id»: документ без рядків _save_docs щоразу записує наново,
            # і його id міг дістатися акту.
            fresh = [r[-1] for r in state_db.doc_ids(con) if r[0] == "writeoffs" and r[1] == day and r[2] == number
                     and r[3] == holder and not (r[4] or "")]
            if len(fresh) != 1:
                raise SaveError("Документ акта не записано. Оновіть сторінку й спробуйте ще раз.")
            doc = fresh[0]
        _write_act(con, doc, prop, spec)
        if not doc_id:
            con.execute("""INSERT INTO document_fes(document_id, status, changed_on) VALUES(?, 'на підписі', ?)
                           ON CONFLICT(document_id) DO NOTHING""", (doc, day))
        new = {k: v for k, v in state_db.negative_days(con).items() if k not in before}
        if new:
            raise SaveError(state_db._negative_words(con, new))
        if head:                                             # файли документа (пакет, скани) — за документом
            was_no = " ".join(str(head[1] or "").split())
            old = _key(head[0], was_no, head[2] or "")
            names = package_names(was_no)
            # Пакет старого номера лишається в теці, але не в файлах акта; номер з тим самим іменем файла («/» → «-», інший
            # регістр) — той самий пакет: його записи переходять до нового ключа разом з усім.
            if [n.casefold() for n in names] != [n.casefold() for n in package_names(number)]:
                con.execute("DELETE FROM app_file WHERE target = ? AND folder = 'opActs' AND file_name IN (?, ?)",
                            (old, *names))
            if old != _key(day, number, holder):
                con.execute("UPDATE app_file SET target = ?, doc_date = ?, doc_no = ? WHERE target = ?",
                            (_key(day, number, holder), day, number, old))
        _log(con, "акт виправлено" if doc_id else "акт складено", _key(day, number, holder),
             f"Акт №{number}: {prop['pointName']}, {_dmy(prop['from'])} — {_dmy(prop['to'])}, {prop['rations']} д/д, "
             f"{len(prop['lines'])} поз." + (LOCKED_MARK if spec.get("locked") is True else ""), who)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return doc


def delete(con, doc_id, who=None, was=None, locked=False):
    """Видаляє документ акта (дані акта йдуть разом); файли пакета в теці лишаються, а записи про файли акта (пакет,
    скани) — ні: новий акт з тим самим ключем їх не успадковує.
    `was` — яким акт був у вікні (як у save): інший чи виправлений деінде акт не видаляється; `locked` — людина
    погодилась на закритий період (позначка в журналі змін)."""
    doc_id = _doc_id(doc_id)
    con.execute("BEGIN IMMEDIATE")
    try:
        row = con.execute("""SELECT d.number, d.doc_date, s.name AS sub FROM document d
                               LEFT JOIN subdivision s ON s.id = d.from_subdivision_id WHERE d.id = ?""",
                          (doc_id,)).fetchone()
        if row is None or not _act_exists(con, doc_id):
            raise SaveError("Такого акта немає.")
        if not _same_act(con, doc_id, was):
            raise SaveError(CHANGED)
        docs = state_db._load_docs(con)
        docs["writeoffs"] = [r for r in docs.get("writeoffs", [])
                             if not (len(r) > 10 and state_db._doc_key(r[10]) == doc_id)]
        state_db._save_docs(con, docs)
        key = _key(row["doc_date"], " ".join(str(row["number"] or "").split()), row["sub"] or "")
        con.execute("DELETE FROM app_file WHERE target IN (?, ?)", (key, _key(row["doc_date"], row["number"], row["sub"] or "")))
        _log(con, "акт видалено", key, f"Акт №{row['number']} від {_dmy(row['doc_date'])}"
             + (LOCKED_MARK if locked is True else ""), who)
        con.execute("COMMIT")
    except Exception:
        con.execute("ROLLBACK")
        raise
    return row["number"]


def act_of(con, doc_id):
    """Один акт для пакета паперів: дані акта, документ, місце й рядки з цінами, нормами й номерами ФЕС."""
    doc_id = _doc_id(doc_id)
    act = state_db._load_acts(con).get(str(doc_id))
    if act is None:
        raise SaveError("Такого акта немає.")
    d = con.execute("""SELECT d.number, d.doc_date, s.name AS sub, k.code AS kind FROM document d
                         JOIN subdivision s ON s.id = d.from_subdivision_id
                         LEFT JOIN subdivision_kind k ON k.id = s.kind_id WHERE d.id = ?""", (doc_id,)).fetchone()
    lines = []
    for r in con.execute("""SELECT n.code, n.name, n.norm_line, u.code AS uom, g.code AS grp, SUM(l.qty_milli) AS q,
                                   COALESCE((SELECT price_kop FROM nomen_last_price WHERE nomen_id = n.id), n.app_price_kop, 0) AS kop,
                                   (SELECT m.fes_code FROM fes_item_map m WHERE m.nomen_id = n.id ORDER BY m.fes_code LIMIT 1) AS fes
                              FROM document_line l JOIN nomen n ON n.id = l.nomen_id JOIN uom u ON u.id = n.uom_id
                              JOIN nomen_group g ON g.id = n.group_id
                             WHERE l.document_id = ? GROUP BY n.id ORDER BY MIN(l.line_no)""", (doc_id,)):
        lines.append({"code": r["code"], "name": r["name"], "uom": r["uom"], "group": r["grp"],
                      "norm": act["norms"].get(r["code"]), "price": r["kop"] / 100, "qty": r["q"] / 1000,
                      "qty_milli": r["q"], "sum": _sum(r["q"], r["kop"]), "fes": r["fes"] or "", "line": r["norm_line"]})
    keys = op_norms.pool_keys([{"group": l["group"], "uom": l["uom"], "per": op_norms.per_milli(l["norm"]),
                                "line": l.pop("line"), "name": l["name"]} for l in lines])
    for l, key in zip(lines, keys):                      # пул — як у розрахунку акта: «належить» Розрахунку ділиться так само
        l["pool"] = key
    p = con.execute("SELECT p.*, s.name AS sub FROM food_point p JOIN subdivision s ON s.id = p.subdivision_id "
                    "WHERE p.ext_id = ?", (act["point"],)).fetchone()
    return {**act, "docId": doc_id, "number": d["number"], "date": d["doc_date"], "sub": d["sub"], "sub_kind": d["kind"] or "",
            "pointName": p["name"] if p else "", "hall": (p["hall"] or "") if p else "", "title": (p["title"] or "") if p else "",
            "days": rations(con, p["id"], act["from"], act["to"])["days"] if p else [], "lines": lines}
