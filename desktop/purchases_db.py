# -*- coding: utf-8 -*-
"""Закупівлі в базі: рядки коштів, справи закупівель і документи до них.

Сторінка тримає три розділи стану: `budget` (рядки коштів із рухом), `purchases`
(закупівлі з грошима, версіями, позиціями й пропозиціями) і `purDocs` (договори, ВН,
рахунки, довіреності, оплати, акти введення з рядками, частками й приходами). Розділи
пов'язані між собою, тож пишуться разом: якщо вікно не надіслало жодного з трьох (вікно
старої версії), записи в базі лишаються як були; інакше база стає такою, як розділи
вікна. Гроші — цілі копійки, кількість — тисячні. Подану версію (є № супроводу) змінити
не можна: її позиції й пропозиції — такі, як їх подали."""
import json

import state_db
from state_db import FES_STATUSES, SaveError

SECTIONS = ("budget", "purchases", "purDocs")
# Порядок видалення: діти раніше батьків (зовнішні ключі без каскаду до рядків коштів).
TABLES = ("pur_doc_receipt", "pur_doc_fund", "pur_doc_line", "pur_doc", "purchase_offer", "purchase_position",
          "purchase_version", "purchase_fund", "purchase", "fund_move", "fund_line")
MOVE_KINDS = ("затверджено", "зміна", "профінансовано", "повернуто")
ANSWERS = ("", "погоджено", "не погоджено")
CLOSED = ("", "завершено", "скасовано")
PRICE_RULES = ("середня", "КП", "вручну")
OFFER_KINDS = ("посилання", "КП")
DOC_KINDS = ("договір", "ВН", "рахунок", "довіреність", "оплата", "акт введення", "інше")
DOC_STATES = ("", "чернетка", "підготовлено", "затверджено")
# Статуси ФЕС документів закупівель — п'ять, які знає таблиця pur_doc: «роздрукувати» належить документам чотирьох книг.
PUR_FES_STATUSES = tuple(s for s in FES_STATUSES if s != "роздрукувати")
# Прихід в обліку — акт приймання (і перенесення залишків): лише на такі документи вказує зв'язок приходу.
ACT_KINDS = ("act_in", "opening")
_IS_ACT = f"k.code IN ({', '.join('?' * len(ACT_KINDS))})"
# Текст відмови вікно вставляє в «Зміни НЕ записано: <текст>. Виправте…», тож він — як у state_db:
# з малої літери й без крапки в кінці.


def _t(v):
    return " ".join(str(v if v is not None else "").split())


def _kop(v, what):
    if v in (None, ""):
        return 0
    if isinstance(v, bool) or not isinstance(v, (int, float)) or int(v) != v:
        raise SaveError(f"{what}: сума має бути цілим числом копійок, а не {v!r}")
    return int(v)


def _not_negative(n, said):
    """Число, яке в базі не буває від'ємним (CHECK >= 0): відмова словами, а не текстом бази."""
    if n < 0:
        raise SaveError(said)
    return n


def _year(v, what):
    """Рік запису: у базі від 1950 до 2100 — ті самі межі, що в дат обліку."""
    low, high = state_db.DATE_YEARS
    if v is None or (isinstance(v, str) and not v.strip()):
        raise SaveError(f"{what}: рік не вказано")
    year = int(v) if isinstance(v, str) and v.strip().isdigit() else v
    if isinstance(year, bool) or not isinstance(year, int) or not low <= year <= high:
        raise SaveError(f"{what}: рік має бути від {low} до {high}, а не {v}")
    return year


def _json(v):
    return json.dumps(v, ensure_ascii=False, sort_keys=True) if v else None


def _unjson(v, empty):
    try:
        return json.loads(v) if v else empty
    except ValueError:
        return empty


def _ids(recs, what, seen=None):
    """Ідентифікатори записів переліку. `seen` — id усієї таблиці, а не одного батька: id — ключ таблиці,
    тож той самий id у двох різних закупівлях, версіях, позиціях чи документах теж повтор."""
    seen = set() if seen is None else seen
    for r in recs:
        rid = _t(r.get("id") if isinstance(r, dict) else "")
        if not rid:
            raise SaveError(f"{what} без ідентифікатора")
        if rid in seen:
            raise SaveError(f"{what}: id {rid} повторюється")
        seen.add(rid)
    return seen


def receipt_keys(con):
    """Ключ документа сторінки («in|дата|номер|від кого|кому») → id акта приймання в базі."""
    out = {}
    for r in con.execute(f"""SELECT d.id, d.doc_date, d.number, COALESCE(c.name, '') AS party,
                                    COALESCE(s.name, '') AS sub
                               FROM document d JOIN doc_kind k ON k.id = d.kind_id
                               LEFT JOIN counterparty c ON c.id = d.counterparty_id
                               LEFT JOIN subdivision s ON s.id = d.to_subdivision_id
                              WHERE {_IS_ACT}""", ACT_KINDS):
        key = "|".join(["in", r["doc_date"], _t(r["number"]), _t(r["party"]), _t(r["sub"])])
        out[key] = r["id"]
    return out


def _act_ids(con):
    """Id усіх актів приймання. Ключ показує на одного з «близнюків» (актів з тією самою шапкою), id — на кожного."""
    return {r[0] for r in con.execute(f"SELECT d.id FROM document d JOIN doc_kind k ON k.id = d.kind_id WHERE {_IS_ACT}",
                                      ACT_KINDS)}


def _sent_versions(con):
    """Подані версії в базі: id → відбиток позицій і пропозицій."""
    out = {}
    for (vid,) in con.execute("SELECT id FROM purchase_version WHERE COALESCE(sent_no, '') <> ''"):
        out[vid] = _version_print(_load_positions(con, vid))
    return out


def _version_print(positions):
    return json.dumps(positions, ensure_ascii=False, sort_keys=True)


def _party(con, cache, name):
    def make(n):
        kind = con.execute("SELECT id FROM counterparty_kind WHERE code = 'постачальник'").fetchone()
        if kind is None:
            kind = (con.execute("INSERT INTO counterparty_kind(code, name) VALUES('постачальник', 'постачальник')")
                    .lastrowid,)
        return con.execute("INSERT INTO counterparty(name, kind_id) VALUES(?, ?)", (n, kind[0])).lastrowid
    return state_db._ref(con, cache, "counterparty", name, make) if name else None


def save(con, state):
    """Розділи закупівель із вікна — у базу (у транзакції `_save_state`)."""
    if all(state.get(k) is None for k in SECTIONS):
        return
    budget = state.get("budget") or []
    purchases = state.get("purchases") or []
    docs = state.get("purDocs") or []
    for name, recs in (("рядки коштів", budget), ("закупівлі", purchases), ("документи закупівель", docs)):
        if not isinstance(recs, list):
            raise SaveError(f"{name} мають бути переліком")
    lines = _ids(budget, "рядок коштів")
    names = {_t(ln["id"]): _t(ln.get("label")) for ln in budget}      # назви рядків — для слів у відмовах
    purs = _ids(purchases, "закупівля")
    doc_ids = _ids(docs, "документ закупівлі")
    sent = _sent_versions(con)
    people = state_db._person_ids(con)
    keys = receipt_keys(con)
    acts = _act_ids(con)
    # id у цих таблицях не повторюється й між різними батьками (рухи двох рядків, позиції двох версій…).
    used = {t: set() for t in ("fund_move", "purchase_version", "purchase_position", "purchase_offer", "pur_doc_line")}
    cache = {}
    for t in TABLES:
        con.execute(f"DELETE FROM {t}")
    seen_label = set()
    for pos, ln in enumerate(budget):
        label = _t(ln.get("label"))
        if not label or not _t(ln.get("fund")):
            raise SaveError(f"рядок коштів {label or ln['id']}: потрібні назва й фонд")
        year = _year(ln.get("year"), f"рядок коштів «{label}»")
        if (year, label) in seen_label:
            raise SaveError(f"рядок коштів «{label}» за {year} рік записано двічі")
        seen_label.add((year, label))
        con.execute("""INSERT INTO fund_line(id, pos, year, label, fund, kpkv, kekv, exp_code, community, purpose,
                       agree_no, agree_date, decision_no, decision_date, return_by, report_by, missing, note)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (ln["id"], pos, year, label, _t(ln.get("fund")), _t(ln.get("kpkv")) or None,
                     _t(ln.get("kekv")) or None, _t(ln.get("exp")) or None, _t(ln.get("community")) or None,
                     _t(ln.get("purpose")) or None, _t(ln.get("agreeNo")) or None, ln.get("agreeDate") or None,
                     _t(ln.get("decisionNo")) or None, ln.get("decisionDate") or None, ln.get("returnBy") or None,
                     ln.get("reportBy") or None, _json(ln.get("missing")), _t(ln.get("note")) or None))
        _ids(ln.get("moves") or [], f"рух рядка «{label}»", used["fund_move"])
        for mpos, mv in enumerate(ln.get("moves") or []):
            if mv.get("kind") not in MOVE_KINDS:
                raise SaveError(f"рядок коштів «{label}»: невідомий вид руху {mv.get('kind')!r}")
            con.execute("INSERT INTO fund_move(id, line_id, pos, kind, move_date, amount_kop, basis, note) "
                        "VALUES(?, ?, ?, ?, ?, ?, ?, ?)",
                        (mv["id"], ln["id"], mpos, mv["kind"], mv.get("date") or None,
                         _kop(mv.get("kop"), f"рядок коштів «{label}»"), _t(mv.get("basis")) or None,
                         _t(mv.get("note")) or None))

    def line_ref(v, where, required=False):
        v = _t(v)
        if required and not v:
            raise SaveError(f"{where}: не вибрано рядок коштів")
        if v and v not in lines:
            raise SaveError(f"{where}: немає такого рядка коштів ({v})")
        return v or None

    seen_title = set()
    for pos, pu in enumerate(purchases):
        title = _t(pu.get("title"))
        if not title:
            raise SaveError("закупівля без теми")
        year = _year(pu.get("year"), f"закупівля «{title}»")
        if (year, title) in seen_title:
            raise SaveError(f"закупівля «{title}» за {year} рік уже є")
        seen_title.add((year, title))
        if pu.get("closed", "") not in CLOSED:
            raise SaveError(f"закупівля «{title}»: невідома позначка {pu.get('closed')!r}")
        con.execute("""INSERT INTO purchase(id, pos, year, title, what, person_id, parent_id, source_id, closed, folder,
                       missing, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (pu["id"], pos, year, title, _t(pu.get("what")) or None,
                     people.get(str(pu.get("person") or "")), None, None, pu.get("closed") or "",
                     _t(pu.get("folder")) or None, _json(pu.get("missing")), _t(pu.get("note")) or None))
        funded = set()
        for f in pu.get("funds") or []:
            line = line_ref(f.get("line"), f"закупівля «{title}»", required=True)
            if line in funded:
                raise SaveError(f"закупівля «{title}»: рядок коштів «{names[line]}» двічі")
            funded.add(line)
            kop = _not_negative(_kop(f.get("kop"), f"закупівля «{title}»"),
                                f"закупівля «{title}»: сума з рядка коштів «{names[line]}» не може бути від'ємною")
            con.execute("INSERT INTO purchase_fund(purchase_id, line_id, amount_kop) VALUES(?, ?, ?)",
                        (pu["id"], line, kop))
        _ids(pu.get("versions") or [], f"версія закупівлі «{title}»", used["purchase_version"])
        labels = set()
        for vpos, ver in enumerate(pu.get("versions") or []):
            label = _t(ver.get("label")) or "1.0"
            if label in labels:
                raise SaveError(f"закупівля «{title}»: версія {label} двічі")
            labels.add(label)
            _save_version(con, pu, title, ver, label, vpos, sent, line_ref, used)
    for pu in purchases:                         # посилання між закупівлями — коли всі вже є
        parent = _t(pu.get("parent"))
        source = _t(pu.get("source"))
        con.execute("UPDATE purchase SET parent_id = ?, source_id = ? WHERE id = ?",
                    (parent if parent in purs else None, source if source in purs else None, pu["id"]))
    for pos, d in enumerate(docs):
        _save_doc(con, d, pos, purs, people, keys, acts, cache, line_ref, names, used)
    for d in docs:
        parent = _t(d.get("parent"))
        con.execute("UPDATE pur_doc SET parent_id = ? WHERE id = ?",
                    (parent if parent in doc_ids and parent != d["id"] else None, d["id"]))


def _save_version(con, pu, title, ver, label, vpos, sent, line_ref, used):
    if ver.get("answer", "") not in ANSWERS:
        raise SaveError(f"закупівля «{title}», версія {label}: невідома відповідь {ver.get('answer')!r}")
    positions = []
    _ids(ver.get("positions") or [], f"позиція версії {label} закупівлі «{title}»", used["purchase_position"])
    for p in ver.get("positions") or []:
        if p.get("rule") not in PRICE_RULES:
            raise SaveError(f"закупівля «{title}», позиція «{_t(p.get('name'))}»: невідоме правило ціни {p.get('rule')!r}")
        _ids(p.get("offers") or [], f"пропозиція позиції «{_t(p.get('name'))}»", used["purchase_offer"])
        for o in p.get("offers") or []:
            if o.get("kind") not in OFFER_KINDS:
                raise SaveError(f"позиція «{_t(p.get('name'))}»: невідомий вид пропозиції {o.get('kind')!r}")
        positions.append(p)
    con.execute("""INSERT INTO purchase_version(id, purchase_id, pos, label, reason, signed_on, sent_no, sent_on, answer,
                   answer_no, answer_on, answer_note, handed_on, signers, missing)
                   VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (ver["id"], pu["id"], vpos, label, _t(ver.get("reason")) or None, ver.get("signedOn") or None,
                 _t(ver.get("sentNo")) or None, ver.get("sentOn") or None, ver.get("answer") or "",
                 _t(ver.get("answerNo")) or None, ver.get("answerOn") or None, _t(ver.get("answerNote")) or None,
                 ver.get("handedOn") or None, _json(ver.get("signers")), _json(ver.get("missing"))))
    for ppos, p in enumerate(positions):
        where = f"закупівля «{title}», позиція «{_t(p.get('name'))}»"
        qty = _not_negative(state_db._milli(p.get("qty") or 0), f"{where}: кількість не може бути від'ємною")
        price = _not_negative(_kop(p.get("priceKop"), f"позиція «{_t(p.get('name'))}»"),
                              f"{where}: ціна не може бути від'ємною")
        con.execute("""INSERT INTO purchase_position(id, version_id, pos, name, specs, uom, qty_milli, price_rule,
                       price_kop, kekv, exp_code, dk_code, line_id, nomen_code, note)
                       VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (p["id"], ver["id"], ppos, _t(p.get("name")) or "—", p.get("specs") or None,
                     _t(p.get("uom")) or None, qty, p["rule"], price, _t(p.get("kekv")) or None,
                     _t(p.get("exp")) or None, _t(p.get("dk")) or None,
                     line_ref(p.get("line"), f"позиція «{_t(p.get('name'))}»"), _t(p.get("code")) or None,
                     _t(p.get("note")) or None))
        for opos, o in enumerate(p.get("offers") or []):
            offer = None if o.get("priceKop") in (None, "") else _not_negative(
                _kop(o.get("priceKop"), "пропозиція"), f"{where}: ціна пропозиції не може бути від'ємною")
            con.execute("""INSERT INTO purchase_offer(id, position_id, pos, kind, seller, url, price_kop, checked_on,
                           offer_no, offer_date, note) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                        (o["id"], p["id"], opos, o["kind"], _t(o.get("seller")) or None, _t(o.get("url")) or None,
                         offer, o.get("checked") or None, _t(o.get("no")) or None, o.get("date") or None,
                         _t(o.get("note")) or None))
    if ver["id"] in sent and _version_print(_load_positions(con, ver["id"])) != sent[ver["id"]]:
        raise SaveError(f"подану версію {label} закупівлі «{title}» не правлять — відкрийте нову версію")


def _save_doc(con, d, pos, purs, people, keys, acts, cache, line_ref, names, used):
    kind = d.get("kind")
    if kind not in DOC_KINDS:
        raise SaveError(f"невідомий вид документа закупівлі {kind!r}")
    what = f"{kind} №{_t(d.get('no')) or 'б/н'}"
    if d.get("state", "") not in DOC_STATES:
        raise SaveError(f"{what}: невідомий стан {d.get('state')!r}")
    fes = d.get("fes") or {}
    if fes.get("status", "") not in ("",) + PUR_FES_STATUSES:
        raise SaveError(f"{what}: невідомий статус ФЕС {fes.get('status')!r}")
    purchase = _t(d.get("purchase"))
    kop = _kop(d.get("kop"), what)
    parts = d.get("parts") or []
    shared = set()
    for p in parts:
        line = line_ref(p.get("line"), what, required=True)
        if line in shared:
            raise SaveError(f"{what}: рядок коштів «{names[line]}» двічі в частках")
        shared.add(line)
    if parts and sum(_kop(p.get("kop"), what) for p in parts) != kop:
        raise SaveError(f"{what}: частки між рядками коштів не дають суми документа")
    con.execute("""INSERT INTO pur_doc(id, pos, kind, number, doc_date, purchase_id, parent_id, counterparty_id, person_id,
                   amount_kop, vat_kop, deliver_by, valid_to, used_on, returned_on, pay_on, procedure_no, state,
                   fes_status, fes_on, fes_register, fes_ref, extra, missing, note)
                   VALUES(?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                (d["id"], pos, kind, _t(d.get("no")) or None, d.get("date") or None,
                 purchase if purchase in purs else None, _party(con, cache, _t(d.get("party"))),
                 people.get(str(d.get("person") or "")), kop, _kop(d.get("vatKop"), what),
                 d.get("deliverBy") or None, d.get("validTo") or None, d.get("usedOn") or None,
                 d.get("returnedOn") or None, d.get("payOn") or None, _t(d.get("procedure")) or None,
                 d.get("state") or "", fes.get("status") or "", fes.get("date") or None,
                 _t(fes.get("register")) or None, _t(fes.get("ref")) or None, _json(d.get("extra")),
                 _t(d.get("missing")) or None, _t(d.get("note")) or None))
    _ids(d.get("lines") or [], f"рядок документа {what}", used["pur_doc_line"])
    for lpos, ln in enumerate(d.get("lines") or []):
        con.execute("""INSERT INTO pur_doc_line(id, doc_id, pos, name, nomen_code, uom, qty_milli, price_kop, fes_no,
                       made_year, passport, life) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                    (ln["id"], d["id"], lpos, _t(ln.get("name")) or "—", _t(ln.get("code")) or None,
                     _t(ln.get("uom")) or None, state_db._milli(ln.get("qty") or 0),
                     _kop(ln.get("priceKop"), what), _t(ln.get("fesNo")) or None, _t(ln.get("year")) or None,
                     _t(ln.get("passport")) or None, _t(ln.get("life")) or None))
    for p in parts:
        con.execute("INSERT INTO pur_doc_fund(doc_id, line_id, amount_kop) VALUES(?, ?, ?)",
                    (d["id"], line_ref(p.get("line"), what), _kop(p.get("kop"), what)))
    linked = set()
    for r in d.get("receipts") or []:
        doc = r.get("doc") if isinstance(r, dict) else None
        if not (type(doc) is int and doc in acts):     # id, що не веде до акта приймання (чужий документ), — не прихід
            doc = keys.get(_t((r or {}).get("key")))
        if doc and doc not in linked:
            linked.add(doc)
            con.execute("INSERT INTO pur_doc_receipt(doc_id, document_id) VALUES(?, ?)", (d["id"], doc))


def _load_positions(con, vid):
    out = []
    for p in con.execute("SELECT * FROM purchase_position WHERE version_id = ? ORDER BY pos", (vid,)):
        offers = [{"id": o["id"], "kind": o["kind"], "seller": o["seller"] or "", "url": o["url"] or "",
                   "priceKop": o["price_kop"] if o["price_kop"] is not None else 0, "checked": o["checked_on"] or "",
                   "no": o["offer_no"] or "", "date": o["offer_date"] or "", "note": o["note"] or ""}
                  for o in con.execute("SELECT * FROM purchase_offer WHERE position_id = ? ORDER BY pos", (p["id"],))]
        out.append({"id": p["id"], "name": p["name"], "specs": p["specs"] or "", "uom": p["uom"] or "",
                    "qty": state_db._qty(p["qty_milli"]), "rule": p["price_rule"], "priceKop": p["price_kop"],
                    "kekv": p["kekv"] or "", "exp": p["exp_code"] or "", "dk": p["dk_code"] or "",
                    "line": p["line_id"] or "", "code": p["nomen_code"] or "", "note": p["note"] or "",
                    "offers": offers})
    return out


def load(con):
    app_person = {r["id"]: (r["ext_id"] or f"b{r['id']}") for r in con.execute("SELECT id, ext_id FROM person")}
    budget = []
    for ln in con.execute("SELECT * FROM fund_line ORDER BY pos"):
        moves = [{"id": m["id"], "kind": m["kind"], "date": m["move_date"] or "", "kop": m["amount_kop"],
                  "basis": m["basis"] or "", "note": m["note"] or ""}
                 for m in con.execute("SELECT * FROM fund_move WHERE line_id = ? ORDER BY pos", (ln["id"],))]
        budget.append({"id": ln["id"], "year": ln["year"], "label": ln["label"], "fund": ln["fund"],
                       "kpkv": ln["kpkv"] or "", "kekv": ln["kekv"] or "", "exp": ln["exp_code"] or "",
                       "community": ln["community"] or "", "purpose": ln["purpose"] or "",
                       "agreeNo": ln["agree_no"] or "", "agreeDate": ln["agree_date"] or "",
                       "decisionNo": ln["decision_no"] or "", "decisionDate": ln["decision_date"] or "",
                       "returnBy": ln["return_by"] or "", "reportBy": ln["report_by"] or "",
                       "missing": _unjson(ln["missing"], {}), "note": ln["note"] or "", "moves": moves})
    purchases = []
    for pu in con.execute("SELECT * FROM purchase ORDER BY pos"):
        funds = [{"line": f["line_id"], "kop": f["amount_kop"]}
                 for f in con.execute("SELECT * FROM purchase_fund WHERE purchase_id = ? ORDER BY rowid", (pu["id"],))]
        versions = []
        for v in con.execute("SELECT * FROM purchase_version WHERE purchase_id = ? ORDER BY pos", (pu["id"],)):
            versions.append({"id": v["id"], "label": v["label"], "reason": v["reason"] or "",
                             "signedOn": v["signed_on"] or "", "sentNo": v["sent_no"] or "",
                             "sentOn": v["sent_on"] or "", "answer": v["answer"], "answerNo": v["answer_no"] or "",
                             "answerOn": v["answer_on"] or "", "answerNote": v["answer_note"] or "",
                             "handedOn": v["handed_on"] or "", "signers": _unjson(v["signers"], {}),
                             "missing": _unjson(v["missing"], {}), "positions": _load_positions(con, v["id"])})
        purchases.append({"id": pu["id"], "year": pu["year"], "title": pu["title"], "what": pu["what"] or "",
                          "person": app_person.get(pu["person_id"], ""), "parent": pu["parent_id"] or "",
                          "source": pu["source_id"] or "", "closed": pu["closed"], "folder": pu["folder"] or "",
                          "missing": _unjson(pu["missing"], {}), "note": pu["note"] or "", "funds": funds,
                          "versions": versions})
    docs = []
    party = {r["id"]: r["name"] for r in con.execute("SELECT id, name FROM counterparty")}
    for d in con.execute("SELECT * FROM pur_doc ORDER BY pos"):
        lines = [{"id": ln["id"], "name": ln["name"], "code": ln["nomen_code"] or "", "uom": ln["uom"] or "",
                  "qty": state_db._qty(ln["qty_milli"]), "priceKop": ln["price_kop"], "fesNo": ln["fes_no"] or "",
                  "year": ln["made_year"] or "", "passport": ln["passport"] or "", "life": ln["life"] or ""}
                 for ln in con.execute("SELECT * FROM pur_doc_line WHERE doc_id = ? ORDER BY pos", (d["id"],))]
        parts = [{"line": p["line_id"], "kop": p["amount_kop"]}
                 for p in con.execute("SELECT * FROM pur_doc_fund WHERE doc_id = ? ORDER BY rowid", (d["id"],))]
        receipts = [{"doc": r["document_id"], "key": ""}
                    for r in con.execute("SELECT document_id FROM pur_doc_receipt WHERE doc_id = ? ORDER BY document_id",
                                         (d["id"],))]
        docs.append({"id": d["id"], "kind": d["kind"], "no": d["number"] or "", "date": d["doc_date"] or "",
                     "purchase": d["purchase_id"] or "", "parent": d["parent_id"] or "",
                     "party": party.get(d["counterparty_id"], ""), "person": app_person.get(d["person_id"], ""),
                     "kop": d["amount_kop"] or 0, "vatKop": d["vat_kop"] or 0, "deliverBy": d["deliver_by"] or "",
                     "validTo": d["valid_to"] or "", "usedOn": d["used_on"] or "", "returnedOn": d["returned_on"] or "",
                     "payOn": d["pay_on"] or "", "procedure": d["procedure_no"] or "", "state": d["state"],
                     "fes": {"status": d["fes_status"], "date": d["fes_on"] or "", "register": d["fes_register"] or "",
                             "ref": d["fes_ref"] or ""},
                     "extra": _unjson(d["extra"], {}), "missing": d["missing"] or "", "note": d["note"] or "",
                     "lines": lines, "parts": parts, "receipts": receipts})
    return {"budget": budget, "purchases": purchases, "purDocs": docs}
