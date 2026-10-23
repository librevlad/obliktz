# -*- coding: utf-8 -*-
"""Забезпеченість сухпаєм: залишок у добових дачах (кількість × «дободач») по місцях на дату проти
потреби «днів × осіб на харчуванні». Залишок — після всіх актів на дату: знищене, списане актом, у
залишку не лежить. Осіб на харчуванні дає Добовка; без них — лише добо-дачі. «У т.ч. ДПНП» — вітчизняні
сухі пайки (ДПНП, ДПНП-Р, ПНСП, ПНСП-Р), у комплектах."""
DAYS = 3
NATIONAL = ("ДПНП", "ПНСП")


def national(item):
    """Вітчизняний сухий пайок — за видом позиції; позиція без виду — за назвою: у книгах служби вид вписано не всім
    позиціям («Добовий польовий набір продуктів (ДПНП)» без виду)."""
    kind = (item["type"] or "").upper()
    return kind.startswith(NATIONAL) if kind else any(k in (item["name"] or "").upper() for k in NATIONAL)


def compute(con, day, people=None, days=DAYS):
    """{day, days, people, places: [{name, dd}], total, dpnp, need, pct, pctDpnp} на кінець дня `day`.
    `dpnp` — вітчизняні пайки у комплектах (ДПНП, ДПНП-Р, ПНСП, ПНСП-Р, а не лише ДПНП), `pctDpnp` — їхня частка від потреби;
    назви ключів лишаються: їх читає сторінка."""
    import book_xlsx as B                                        # noqa: PLC0415
    m = B.model_from_db(con, B.SP)
    bal = B._balances(m, day)
    per = {i["code"]: float(i["per_ration"] or 0) for i in m["items"] if not i["archived"]}
    nat = {i["code"]: national(i) for i in m["items"]}
    places, dpnp = {}, 0.0
    for (code, place), q in bal.items():
        f = per.get(code, 0.0)
        if f <= 0 or abs(q) < 1e-9:
            continue
        places[place] = places.get(place, 0.0) + q * f
        if nat.get(code):
            dpnp += q
    total = sum(places.values())
    people = int(people) if people else None
    need = days * people if people else None
    return {"day": day, "days": days, "people": people,
            "places": [{"name": k, "dd": round(v, 3)} for k, v in sorted(places.items(), key=lambda kv: (-kv[1], kv[0]))],
            "total": round(total, 3), "dpnp": round(dpnp, 3), "need": need,
            "pct": round(total * 100 / need, 1) if need else None,
            "pctDpnp": round(dpnp * 100 / need, 1) if need else None}
