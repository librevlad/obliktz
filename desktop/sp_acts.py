# -*- coding: utf-8 -*-
"""Акти сухпаю (вид акта «sp», серія СП<рік>-NNN) на спільному ядрі актів `op_acts`: акт — за рапортом підрозділу.

Дні рапорту й особи на сухпаї кожного дня — з Добовки (аркуш «Сухпай», `dobovka.report_days`) чи вписані людиною —
лягають в акт знімком (`act_day`); людино-дні — сума осіб за дні. Рядки акта — як у «Чернетці акта СП» служби (iprod
`_build/org/kit/sp_chernetka.py`, книга на формулах — ручний шлях) і як в актах книги «Облік СП»:
- пайки — один чи кілька (різні пайки за одним рапортом): у кожного свої людино-дні, першому — решта людино-днів
  рапорту; пайків = ROUNDUP(людино-дні ÷ дободач); «дободач» позиції книги СП — скільки добових дач дає одиниця (набір
  — 1, раціон на одне приймання їжі — 1/3);
- підігрівачі — по одному на пайок, позначений «з підігрівачем» (позначки не ставили — як в останньому акті з цим
  пайком, а без нього — шведський пайок, як у «Чернетці»);
- вода — особи кожного дня × норма води на його дату (`water_norm`: 3,0 кг на людино-день з 1 червня по 31 серпня, в
  інші дні — 1,5 кг);
- «інше» — позиції книги СП з кількістю, вписаною людиною (готові страви, мюслі…).
Підігрівачі й вода — з кодів тієї самої позиції (перше слово назви й одиниця, як у обраного коду), що лежать у місці,
спершу найстаріший прихід (як пул акта ОП/МЗ). Усе списується з одного місця (утримувач — «<батальйон> · ВМТЗ» чи склад)
на дату акта; залишку бракує — пропозиція каже, чого й де, складання відмовляє. Номер — один на рік серед документів
вибуття. Новий акт — статус ФЕС «роздрукувати» (витяг є) чи «немає витяга»; рапорт і наказ — поля документа
(у книзі «Облік СП» — «рапорт», «наказ»), «1прод» рядків — квартали днів рапорту, підрозділ, як у Добовці, — примітка
рядків документа. Складання, виправлення й видалення — `op_acts.save(…, kind=SP)` і `op_acts.delete`."""
import datetime as dt
import math
import re
from decimal import ROUND_HALF_UP, Decimal
from fractions import Fraction

import op_acts
import state_db
from state_db import SaveError

KIND = "sp"
SERIES = "СП"
FMT = "СП{year}-{n:03d}"
PAPER_ROLES = ("накладна", "роздавальна", "рапорт", "витяг")
COMMON = ("командир", "голова комісії", "член комісії", "начальник служби", "бухгалтер")
# Норма води на людино-день — за порою року, щороку однаково (рішення власника 23.10.2026: 3 кг — лише влітку): 3,0 кг на
# людино-день з 1 червня по 31 серпня, в інші дні — 1,5 кг.
WATER_SUMMER = ((6, 1), (8, 31))                          # перший і останній день літньої норми: (місяць, день)
WATER_SUMMER_KG, WATER_KG = Decimal("3.0"), Decimal("1.5")
# Пайок з підігрівачем, коли акта з цим пайком ще не було, — шведський (як у «Чернетці акта СП»).
HEATER_HINT = re.compile(r"швец|швед", re.I)


def _dmy(iso):
    return f"{iso[8:10]}.{iso[5:7]}.{iso[:4]}" if iso else ""


def _num(q):
    """Кількість словами-цифрами вікна: 18, 1,5, 10 (нулі цілого числа лишаються)."""
    if isinstance(q, Decimal):
        text = f"{q:f}"
        return (text.rstrip("0").rstrip(".") if "." in text else text).replace(".", ",")
    return str(int(q)) if float(q).is_integer() else str(q).replace(".", ",")


def water_norm(day):
    """Норма води, кг на людино-день, на дату `day` (рррр-мм-дд): 3,0 кг з 1 червня по 31 серпня, в інші дні — 1,5 кг."""
    d = dt.date.fromisoformat(str(day)[:10])
    return WATER_SUMMER_KG if WATER_SUMMER[0] <= (d.month, d.day) <= WATER_SUMMER[1] else WATER_KG


def place(con, name):
    r = con.execute("SELECT id, name FROM subdivision WHERE name = ?", (str(name or "").strip(),)).fetchone()
    if r is None:
        raise SaveError("Оберіть місце, з якого списується сухпай.")
    return {"id": r[0], "name": r[1]}


def _item(con, code, what):
    r = con.execute("""SELECT n.id, n.code, n.name, n.per_ration, u.code AS uom,
                              COALESCE((SELECT price_kop FROM nomen_last_price WHERE nomen_id = n.id), n.app_price_kop, 0) AS kop
                         FROM nomen n JOIN nomen_group g ON g.id = n.group_id JOIN uom u ON u.id = n.uom_id
                        WHERE n.code = ? AND g.book = 'СП'""", (str(code or "").strip(),)).fetchone()
    if r is None:
        raise SaveError(f"{what}: позиції {code} немає в книзі СП.")
    return r


def per_ration(value):
    """«Дободач» як дріб: 1/3 зберігається як 0,333…, а рахувати треба з 1/3 — інакше ROUNDUP дає зайвий комплект. Уписане
    десятковим дробом (0,333 чи 0,33) — найближчий простий дріб k/n (n до 12), якщо до нього менше 0,005; інший — як є."""
    if value in (None, "") or float(value) <= 0:
        return None
    x = float(value)
    near = min((Fraction(round(x * n), n) for n in range(1, 13) if round(x * n) > 0),
               key=lambda f: (abs(f - Fraction(x)), f.denominator), default=None)
    return near if near is not None and abs(near - Fraction(x)) < Fraction(1, 200) else \
        Fraction(x).limit_denominator(1000)


def ration_qty(per, days):
    """Пайків за правилом: ROUNDUP(людино-дні ÷ дободач); `per` — дободач дробом (`per_ration`)."""
    return math.ceil(Fraction(days) / per)


def days_of(raw):
    """Дні рапорту: [[рррр-мм-дд, осіб]] — справжні дати, осіб — ціле більше нуля, день — раз; за датами."""
    if raw in (None, ""):
        return []
    if not isinstance(raw, list):
        raise SaveError("Дні рапорту не впізнано. Оновіть сторінку.")
    out = {}
    for rec in raw:
        if not isinstance(rec, (list, tuple)) or len(rec) < 2:
            raise SaveError("День рапорту не впізнано. Оновіть сторінку.")
        day = op_acts._iso(rec[0], "День рапорту")
        n = state_db._whole_number(rec[1])
        if n is None or n <= 0 or n > state_db.RATIONS_MAX:
            raise SaveError(f"День {_dmy(day)}: осіб — ціле число більше нуля.")
        if day in out:
            raise SaveError(f"День {_dmy(day)} — у рапорті двічі.")
        out[day] = n
    return [[d, out[d]] for d in sorted(out)]


def _sum(q_milli, kop):
    return float((Decimal(q_milli) * Decimal(kop) / 100000).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP))


def _line(it, q_milli, norm, rule, have, role, **more):
    """Рядок пропозиції; рядок пайка ще несе `pdays` (його людино-дні) і `heater` (з підігрівачем)."""
    return {"code": it["code"], "name": it["name"], "uom": it["uom"], "group": "", "norm": norm, "rule": rule, "role": role,
            "price": it["kop"] / 100, "stock": have / 1000, "qty": q_milli / 1000, "qty_milli": q_milli,
            "sum": _sum(q_milli, it["kop"]), **more}


def _rows(raw, what):
    if raw in (None, ""):
        return []
    if not isinstance(raw, list) or not all(isinstance(r, dict) for r in raw):
        raise SaveError(f"{what} не впізнано. Оновіть сторінку.")
    return [r for r in raw if str(r.get("code") or "").strip()]           # порожній рядок вікна — не рядок акта


def rations_of(raw):
    """Пайки вікна: [{code, days, heater}] → [{code, days, heater}]. Людино-дні першого не читаються (йому — решта);
    `heater` — True / False чи None (людина не позначала: вирішить `heater_hint`)."""
    out = []
    for i, rec in enumerate(_rows(raw, "Пайки")):
        code = str(rec["code"]).strip()
        days = None
        if out:
            days = state_db._whole_number(rec.get("days"))
            if days is None or days <= 0 or days > state_db.RATIONS_MAX:
                raise SaveError(f"Пайок {code}: людино-дні — ціле число більше нуля.")
        out.append({"code": code, "days": days, "heater": rec.get("heater") if isinstance(rec.get("heater"), bool) else None})
    return out


def others_of(raw):
    """Рядки «інше» вікна: [{code, qty}] → [{code, qty_milli}]; кількість — число більше нуля."""
    out = []
    for rec in _rows(raw, "Інше"):
        code = str(rec["code"]).strip()
        try:
            q = Decimal(str(rec.get("qty")).replace(",", ".").strip())
        except ArithmeticError:
            q = None
        if q is None or not q.is_finite() or q <= 0 or q > state_db.RATIONS_MAX:
            raise SaveError(f"Інше {code}: кількість — число більше нуля.")
        out.append({"code": code, "qty_milli": int((q * 1000).to_integral_value(rounding=ROUND_HALF_UP))})
    return out


def heater_hint(con, code, day):
    """Пайок з підігрівачем, коли людина його не позначала: як в останньому акті сухпаю з цим пайком, а без такого — пайок
    шведський (як у «Чернетці акта СП»)."""
    r = con.execute("""SELECT i.heater FROM act_item i JOIN act a ON a.document_id = i.document_id
                         JOIN document d ON d.id = i.document_id JOIN nomen n ON n.id = i.nomen_id
                        WHERE a.kind = ? AND i.role = 'пайок' AND n.code = ? AND d.doc_date <= ?
                        ORDER BY d.doc_date DESC, a.document_id DESC LIMIT 1""", (KIND, code, day)).fetchone()
    if r is not None:
        return bool(r[0])
    name = con.execute("SELECT name FROM nomen WHERE code = ?", (code,)).fetchone()
    return bool(name and HEATER_HINT.search(name[0]))


def _pool(con, holder, day, exclude, code, milli, what, role, norm, rule):
    """Підігрівачі чи вода: `milli` — з кодів тієї самої позиції, що й обраний (`code`: перше слово назви й одиниця), які
    лежать у місці, спершу найстаріший прихід; чого бракує й там — на рядку обраного коду (нестача — у попередженні)."""
    it = _item(con, code, what)
    word = it["name"].split()[0].casefold()                     # SQLite lower() кирилиці не знає — порівняння тут
    kin = [r[0] for r in con.execute("""SELECT n.code, n.name FROM nomen n JOIN nomen_group g ON g.id = n.group_id
                                         WHERE g.book = 'СП' AND n.uom_id = (SELECT uom_id FROM nomen WHERE id = ?)
                                         ORDER BY n.code""", (it["id"],)) if (r[1].split() or [""])[0].casefold() == word]
    have = {}
    for c in kin:
        k = _item(con, c, what)
        q = op_acts._balance(con, holder["id"], k["id"], day, exclude)
        if q > 0:
            have[c] = (op_acts._first_batch(con, holder["id"], k["id"], day, exclude), k, q)
    take, left = {}, milli
    for c in sorted(have, key=lambda c: (have[c][0], c)):
        if left <= 0:
            break
        take[c] = min(left, have[c][2])
        left -= take[c]
    if left > 0:
        take[it["code"]] = take.get(it["code"], 0) + left
    lines = []
    for n, (c, q) in enumerate(take.items()):
        k = have[c][1] if c in have else it
        lines.append(_line(k, q, norm, rule if not n else "решта — з цього коду, спершу найстаріший прихід",
                           have[c][2] if c in have else 0, role))
    return lines


def _water(days):
    """Вода за днями: (кг у тисячних, норма — одна на всі дні чи None, як пораховано)."""
    parts = {}
    for day, n in days:
        kg = water_norm(day)
        parts[kg] = parts.get(kg, 0) + n
    milli = int(sum(Decimal(n) * kg * 1000 for kg, n in parts.items()))
    rule = " + ".join(f"{n} × {_num(kg)} кг" for kg, n in sorted(parts.items(), key=lambda kv: -kv[0]))
    return milli, (float(next(iter(parts))) if len(parts) == 1 else None), f"людино-дні × норма на дату: {rule}"


def by_rules(rations, days):
    """Кількості акта сухпаю за правилами — ті самі для складання акта (`compute`) і для звірки акта книги «Облік СП» з
    правилами (`sp_book_acts.off_rules`). `rations` — [(дободач дробом, людино-дні, з підігрівачем)], `days` — [[дата,
    осіб]] → (пайків кожного — ROUNDUP(людино-дні ÷ дободач); підігрівачів — по одному на пайок з підігрівачем; води, кг
    у тисячних, — осіб дня × норма на його дату)."""
    each = [ration_qty(per, n) for per, n, _ in rations]
    return each, sum(q for q, (_, _, heated) in zip(each, rations) if heated), _water(days)[0]


def _report_used(con, report, exclude):
    if not report:
        return None
    r = con.execute("""SELECT d.number FROM act_paper p JOIN act a ON a.document_id = p.document_id
                         JOIN document d ON d.id = p.document_id
                        WHERE a.kind = ? AND p.role = 'рапорт' AND TRIM(p.number) = ? AND p.document_id <> ?
                        ORDER BY d.doc_date LIMIT 1""", (KIND, report, exclude)).fetchone()
    return " ".join(str(r[0]).split()) if r else None


def compute(con, spec, strict=False):
    """Пропозиція акта: людино-дні днів рапорту, рядки за правилами, залишок місця на дату акта, попередження.
    `strict` — для складання: без днів, без рядків чи з нестачею — відмова словами, а не попередження."""
    holder = place(con, spec.get("holder"))
    day = op_acts._iso(spec.get("date"), "Дата акта")
    days = days_of(spec.get("days"))
    ld = sum(n for _, n in days)
    exclude = op_acts._doc_id(spec.get("docId"))
    lines, warnings, bad = [], [], []
    if not days:
        warnings.append("Немає днів рапорту: знайдіть рапорт у Добовці чи впишіть дні")
    rations = rations_of(spec.get("rations"))
    if rations:
        rations[0]["days"] = ld - sum(r["days"] for r in rations[1:])
        if ld and rations[0]["days"] <= 0:
            bad.append(f"Людино-дні інших пайків ({ld - rations[0]['days']}) — не менше, ніж у рапорті ({ld})")
    counted = []                                   # пайки, що рахуються: (позиція, дободач, людино-дні, з підігрівачем)
    for r in rations:
        it = _item(con, r["code"], "Пайок")
        per = per_ration(it["per_ration"])
        if per is None:
            bad.append(f"У пайка {it['code']} немає дободача: «Сухпай» → «Позиції»")
        elif r["days"] > 0:
            counted.append((it, per, r["days"],
                            r["heater"] if r["heater"] is not None else heater_hint(con, it["code"], day)))
    each, heated, _ = by_rules([(per, n, heater) for _, per, n, heater in counted], days)
    for (it, per, n, heater), q in zip(counted, each):
        have = op_acts._balance(con, holder["id"], it["id"], day, exclude)
        lines.append(_line(it, q * 1000, float(it["per_ration"]),
                           f"{n} людино-дн. ÷ дободач {per.numerator if per.denominator == 1 else per}", have,
                           "пайок", pdays=n, heater=heater))
    if spec.get("heater") and heated:
        lines += _pool(con, holder, day, exclude, spec["heater"], heated * 1000, "Підігрівач", "підігрівач", 1.0,
                       "по одному на пайок з підігрівачем")
    if spec.get("water") and ld:
        milli, norm, rule = _water(days)
        lines += _pool(con, holder, day, exclude, spec["water"], milli, "Вода", "вода", norm, rule)
    for o in others_of(spec.get("other")):
        it = _item(con, o["code"], "Інше")
        lines.append(_line(it, o["qty_milli"], None, "вручну", op_acts._balance(con, holder["id"], it["id"], day, exclude),
                           "інше"))
    seen = set()
    for l in lines:
        if l["code"] in seen:
            bad.append(f"Позиція {l['code']} — в акті двічі")
        seen.add(l["code"])
    if days and not lines:
        warnings.append("Оберіть пайок чи воду")
    short = [f"Бракує в «{holder['name']}»: {l['code']} {l['name']} — є {_num(l['stock'])} {l['uom']}, "
             f"треба {_num(l['qty'])}" for l in lines if l["qty_milli"] > l["stock"] * 1000 + 1e-6]
    warnings += bad + short
    short = bad + short
    number = " ".join(str(spec.get("number") or "").split())
    if number and op_acts._number_taken(con, number, day, exclude):
        warnings.append(f"Номер {number} уже є в {day[:4]} році")
    report = " ".join(str(((spec.get("papers") or {}).get("рапорт") or {}).get("no") or spec.get("report") or "").split())
    used = _report_used(con, report, exclude)
    if used:
        warnings.append(f"Рапорт №{report} уже є в акті №{used}")
    if strict and (not days or not lines or short):
        raise SaveError(("; ".join(short) or ("Немає днів рапорту: знайдіть рапорт у Добовці чи впишіть дні" if not days
                                              else "Немає чого списувати: оберіть пайок чи воду")) + ".")
    label = " ".join(str(spec.get("label") or "").split())
    return {"kind": KIND, "series": SERIES, "point": None, "sub": holder["name"], "holder": holder["name"],
            "from": days[0][0] if days else day, "to": days[-1][0] if days else day, "date": day, "rations": ld,
            "days": days, "lines": lines, "warnings": warnings, "label": label,
            "party": " ".join(str(spec.get("party") or "").split()) or label}


def _role(con, doc, role):
    """Код рядка акта з роллю `role` («пайок», «підігрівач», «вода») чи «»."""
    r = con.execute("""SELECT n.code FROM act_item i JOIN nomen n ON n.id = i.nomen_id
                        WHERE i.document_id = ? AND i.role = ?""", (doc, role)).fetchone() if doc else None
    return r[0] if r else ""


def _last(con, day, where="", args=()):
    """Найпізніший акт сухпаю на дату `day` (з умовою `where` над рядками документа й даними акта): id документа."""
    r = con.execute(f"""SELECT a.document_id FROM act a JOIN document d ON d.id = a.document_id
                         WHERE a.kind = ? AND d.doc_date <= ? {where}
                         ORDER BY d.doc_date DESC, a.document_id DESC LIMIT 1""", (KIND, day, *args)).fetchone()
    return r[0] if r else None


def _by_label(con, label, day):
    return _last(con, day, "AND EXISTS (SELECT 1 FROM document_line l WHERE l.document_id = a.document_id AND l.note = ?)",
                 (label,)) if label else None


def _signers_of(con, doc, roles=None):
    out = []
    for r in con.execute("SELECT * FROM act_signer WHERE document_id = ? ORDER BY role, sort", (doc,)):
        if roles is None or r["role"] in roles:
            out.append({"role": r["role"], "sort": r["sort"], "pos": r["position"] or "", "rank": r["rank"] or "",
                        "name": r["name"] or ""})
    return out


def default_signers(con, holder, label, day):
    """Комісія й посадовці — з останнього акта сухпаю (а без нього — посадовці програми на дату), МВО — з останнього акта
    того самого місця (а без нього — МВО місця на дату), одержувач — з останнього акта того самого підрозділу."""
    out = []
    last = _last(con, day, "AND EXISTS (SELECT 1 FROM act_signer s WHERE s.document_id = a.document_id)")
    if last:
        out += _signers_of(con, last, COMMON)
    else:
        # Посадовці — як у першого акта ОП/МЗ (op_acts._OFFICIALS): «бухгалтер» акта — «Начфін» (друкується в акті й у
        # блоці ФЕС накладної), тобто посадовець «начальник ФЕС», а не бухгалтер ФЕС.
        for role, official in op_acts._OFFICIALS:
            r = op_acts._official_on(con, official, day) if role in COMMON else None
            if r:
                out.append(op_acts._signer(role, r))
    sub = con.execute("SELECT id FROM subdivision WHERE name = ?", (holder or "",)).fetchone()
    same = _last(con, day, "AND d.from_subdivision_id = ?", (sub[0],)) if sub else None
    mvo = _signers_of(con, same, ("МВО",)) if same else []
    if not mvo and sub:
        r = op_acts._mvo_on(con, sub[0], day)
        if r:
            mvo = [op_acts._signer("МВО", r)]
    prev = _by_label(con, label, day)
    return out + mvo + (_signers_of(con, prev, ("одержувач",)) if prev else [])


def _stocked(con, holder, day, codes):
    """Коди з `codes`, що лежать у місці на дату, — спершу код із найстаршою партією."""
    sub = con.execute("SELECT id FROM subdivision WHERE name = ?", (holder or "",)).fetchone()
    if not sub:
        return []
    got = []
    for nid, code in codes:
        if op_acts._balance(con, sub[0], nid, day, 0) > 0:
            got.append((op_acts._first_batch(con, sub[0], nid, day, 0), code))
    return [c for _, c in sorted(got)]


def defaults(con, spec, today):
    """Типове нового акта: номер, дата, місце, одержувач, перший пайок, підігрівач, вода, підписанти й папери.
    `spec` — що відомо (підрозділ і група з Добовки, рапорт, місце)."""
    day = op_acts._iso(spec.get("date") or today, "Дата акта")
    number = op_acts.next_number(con, SERIES, day[:4], fmt=FMT)
    label = " ".join(str(spec.get("label") or "").split())
    prev = _by_label(con, label, day)
    holder = str(spec.get("holder") or "").strip()
    if not holder and prev:
        holder = con.execute("SELECT s.name FROM document d JOIN subdivision s ON s.id = d.from_subdivision_id "
                             "WHERE d.id = ?", (prev,)).fetchone()[0]
    party = (con.execute("SELECT party FROM act WHERE document_id = ?", (prev,)).fetchone()[0] if prev else "") or label
    sp = con.execute("""SELECT n.id, n.code, n.name, n.per_ration FROM nomen n JOIN nomen_group g ON g.id = n.group_id
                         WHERE g.book = 'СП' AND n.archived_at IS NULL ORDER BY n.code""").fetchall()
    rations = [(r["id"], r["code"]) for r in sp if per_ration(r["per_ration"])]
    sub = con.execute("SELECT id FROM subdivision WHERE name = ?", (holder,)).fetchone()
    # Пайок — як в останньому акті з цього місця, а без такого — з тих, що лежать у місці (найстарша партія першою);
    # підігрівач і вода — як в останньому акті сухпаю, а без нього — позиції книги «Підігрівач…» і «Вода…».
    same = _last(con, day, "AND d.from_subdivision_id = ?", (sub[0],)) if sub else None
    ration = _role(con, same, "пайок") or next(iter(_stocked(con, holder, day, rations)), "")
    last = _last(con, day)
    named = lambda word: [(r["id"], r["code"]) for r in sp if r["name"].lower().startswith(word)]   # noqa: E731
    heater = _role(con, last, "підігрівач") or next(iter(_stocked(con, holder, day, named("підігрівач"))
                                                          or [c for _, c in named("підігрівач")]), "")
    water = _role(con, last, "вода") or next(iter(_stocked(con, holder, day, named("вода"))
                                                   or [c for _, c in named("вода")]), "")
    report = " ".join(str(spec.get("report") or "").split())
    return {"date": day, "number": number, "holder": holder, "party": party, "label": label, "ration": ration,
            "heater": heater, "water": water,
            "signers": default_signers(con, holder, label, day),
            "papers": {"накладна": {"no": number, "date": day}, "роздавальна": {"no": number, "date": day},
                       "рапорт": {"no": report, "date": str(spec.get("reportDate") or "")},
                       "витяг": {"no": "", "date": ""}}}


def preview(con, req, today):
    """Пропозиція для вікна акта: свіжа (`fresh` — нове вікно чи щойно знайдений рапорт) — ще й типові значення
    (`defaults`), і розрахунок іде вже з ними (пайків ще немає — перший пайок типовий); далі — розрахунок за полями вікна.
    Місця ще не обрано — без рядків."""
    spec = dict(req)
    out = {}
    if spec.get("fresh"):
        d = defaults(con, spec, today)
        out["defaults"] = d
        for k in ("date", "number", "holder", "party", "heater", "water", "signers", "papers"):
            if not spec.get(k):
                spec[k] = d[k]
        if not rations_of(spec.get("rations")) and d["ration"]:
            spec["rations"] = [{"code": d["ration"]}]
    if not str(spec.get("holder") or "").strip():
        days = days_of(spec.get("days"))
        out.update(lines=[], warnings=["Оберіть місце, з якого списується сухпай"], rations=sum(n for _, n in days),
                   days=days)
        return out
    out.update(compute(con, spec))
    return out


def paper_text(rec):
    """Номер і дата паперу так, як їх пише книга «Облік СП» (рапорт, наказ): «№301 п.18 від 26.09.2026»."""
    rec = rec or {}
    no = " ".join(str(rec.get("no") or "").split()).lstrip("№").strip()
    if not no:
        return None
    return f"№{no} від {_dmy(rec['date'])}" if rec.get("date") else f"№{no}"


def shares_of(number, days, waters=()):
    """Частки днів одного акта сухпаю програми для «1прод» — за його днями рапорту [[дата, осіб]]: {номер: {дата:
    частка}} за особами (пайки, підігрівачі, інше) і {(номер, код води): {дата: частка}} за кілограмами — осіб дня ×
    норма води на дату (`water_norm`). Номер — без пробілів (`suhpay_days.act_key`)."""
    import suhpay_days                                           # noqa: PLC0415
    key = suhpay_days.act_key(number)
    out = {}
    for k, weight in [(key, lambda d, n: n)] + [((key, c), lambda d, n: n * float(water_norm(d))) for c in waters]:
        by = {}
        for d, n in days:
            day = dt.date.fromisoformat(d)
            by[day] = by.get(day, 0) + weight(d, n)
        total = sum(by.values())
        if total:
            out[k] = {day: v / total for day, v in sorted(by.items())}
    return out


def q1_label(number, day, days, qty, code="", water=False):
    """«1прод» рядка акта сухпаю: `qty` одиниць рядка `code` акта №`number` від `day` за днями рапорту `days`
    ([[дата, осіб]]) — частками осіб днів, а рядок води (`water`) — частками кілограмів днів (`shares_of`). Ним пише
    «1прод» складання акта (`SpKind.extra`), і ним же прийом книги СП впізнає програмне «1прод» рядка акта."""
    import suhpay_days                                           # noqa: PLC0415
    return suhpay_days.row_label({"loss": False, "num": number, "base": suhpay_days.act_base(number), "code": code,
                                  "date": dt.date.fromisoformat(day), "qty": qty},
                                 shares_of(number, days, [code] if water else ()))


def day_shares(con, days_from=None):
    """Частки днів актів сухпаю програми для «1прод» (`shares_of` кожного акта): кожен акт — за своїми днями рапорту, і
    продовження акта («СП2026-103/1» до «СП2026-103») теж за своїми, а не за днями іншого акта того самого номера.
    Акт, датований раніше за `days_from` (квартал уже подано за датою акта), — без часток."""
    acts = {doc: no for doc, no, day in con.execute(
        """SELECT a.document_id, d.number, d.doc_date FROM act a JOIN document d ON d.id = a.document_id
            WHERE a.kind = ?""", (KIND,)) if not (days_from and dt.date.fromisoformat(day) < days_from)}
    days, waters = {}, {}
    for doc, on, n in con.execute("SELECT document_id, on_date, persons FROM act_day ORDER BY document_id, on_date"):
        if doc in acts:
            days.setdefault(doc, []).append([on, n])
    for doc, code in con.execute("""SELECT i.document_id, n.code FROM act_item i JOIN nomen n ON n.id = i.nomen_id
                                     WHERE i.role = 'вода' ORDER BY i.rowid"""):
        if doc in acts:
            waters.setdefault(doc, []).append(code)
    out = {}
    for doc, no in acts.items():
        out.update(shares_of(no, days.get(doc, []), waters.get(doc, ())))
    return out


class SpKind(op_acts.Kind):
    """Акт сухпаю поверх спільного складання: рядки — за рапортом, примітка рядків — підрозділ, як у Добовці; поруч —
    дні рапорту, рапорт і наказ документа, «1прод» рядків; статус нового акта — «роздрукувати» чи «немає витяга»."""
    code = KIND
    paper_roles = PAPER_ROLES
    folder = "spActs"                          # тека й файли пакета: за ними ядро чистить пакет старого номера

    def package(self, number):
        import excel_export                                      # noqa: PLC0415
        return (excel_export.safe_name(number) + ".xlsx",)

    def compute(self, con, spec):
        return compute(con, spec, strict=True)

    def note(self, prop, line):
        return prop["label"]

    def status(self, spec, prop):
        return "роздрукувати" if paper_text((spec.get("papers") or {}).get("витяг")) else "немає витяга"

    def restatus(self, con, doc, spec, prop):
        """Виправлення дописало витяг: «немає витяга» стає «роздрукувати»; статусу, який поставила людина, не чіпаємо."""
        if self.status(spec, prop) == "роздрукувати":
            con.execute("""UPDATE document_fes SET status = 'роздрукувати', changed_on = ?
                            WHERE document_id = ? AND status = 'немає витяга'""", (dt.date.today().isoformat(), doc))

    def extra(self, con, doc, prop, spec, number):
        con.execute("DELETE FROM act_day WHERE document_id = ?", (doc,))
        con.executemany("INSERT INTO act_day(document_id, on_date, persons) VALUES(?, ?, ?)",
                        [(doc, d, n) for d, n in prop["days"]])
        papers = spec.get("papers") or {}
        con.execute("""INSERT INTO document_extra(document_id, report, order_ref) VALUES(?, ?, ?)
                       ON CONFLICT(document_id) DO UPDATE SET report = excluded.report, order_ref = excluded.order_ref""",
                    (doc, paper_text(papers.get("рапорт")), paper_text(papers.get("витяг"))))
        # «1прод» — тими самими частками, що й перерахунок (day_shares): дні акта, вода — за кілограмами днів.
        keep = set()
        for l in prop["lines"]:
            label = q1_label(number, prop["date"], prop["days"], l["qty"], l["code"], l["role"] == "вода")
            keep.add((l["code"], prop["label"]))
            con.execute("""INSERT INTO doc_line_extra(document_id, code, note, q1prod, q1prod_fixed) VALUES(?, ?, ?, ?, 0)
                           ON CONFLICT(document_id, code, note) DO UPDATE SET q1prod = excluded.q1prod
                           WHERE doc_line_extra.q1prod_fixed = 0""", (doc, l["code"], prop["label"], label))
        for code, note in con.execute("SELECT code, note FROM doc_line_extra WHERE document_id = ?", (doc,)).fetchall():
            if (code, note) not in keep:
                con.execute("DELETE FROM doc_line_extra WHERE document_id = ? AND code = ? AND note = ?", (doc, code, note))

    def words(self, number, prop):
        return (f"Акт №{number}: {prop['label'] or prop['sub']}, {_dmy(prop['from'])} — {_dmy(prop['to'])}, "
                f"{prop['rations']} людино-дн., {len(prop['lines'])} поз.")


SP = SpKind()


def save(con, spec, who=None):
    """Складає новий акт сухпаю чи виправляє наявний (`docId`, `was`) — `op_acts.save` з видом «sp»."""
    return op_acts.save(con, spec, who, kind=SP)


def act_of(con, doc_id):
    """Акт сухпаю для пакета паперів: дані акта (`op_acts.act_of`), підрозділ (примітка рядків), рапорт і наказ документа."""
    a = op_acts.act_of(con, doc_id)
    note = con.execute("SELECT note FROM document_line WHERE document_id = ? AND note IS NOT NULL LIMIT 1",
                       (a["docId"],)).fetchone()
    extra = con.execute("SELECT report, order_ref FROM document_extra WHERE document_id = ?", (a["docId"],)).fetchone()
    return {**a, "label": (note[0] if note else "") or "", "report": (extra[0] if extra else "") or "",
            "order": (extra[1] if extra else "") or ""}
