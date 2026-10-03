# -*- coding: utf-8 -*-
"""Відомість щодо визначення залишкової вартості військового майна — Додаток 1 до Методики
(постанова КМУ від 29.05.1998 № 759) у бланку, яким служба подає її на затвердження.

Сторінка програми передає збережений розрахований документ; цей модуль лише розкладає його на
аркуш А4: дванадцять граф, позиція — блок із трьох рядків (Ке, Кз, Ктс). Первісна вартість,
сукупний коефіцієнт зносу й залишкова вартість стоять формулами бланка, тож Excel показує те
саме, що порахувала програма: первісна округлюється до копійок, далі множення без проміжного
округлення. Сторінки розкладає модуль (Pager): блок позиції не рветься між сторінками,
продовження таблиці починається рядком із номерами граф.

    {"kind": "valuation", "file": "...", "unit": "Військова частина А0000", "no": "04/…/В",
     "date": "2026-10-03", "as_of": "2026-10-01", "approved": "" | "2026-10-05", "basis": "...",
     "note": "...", "copies": "...; ...", "norms": "Методика …, редакція …", "p10": [номери рядків],
     "approver": {"pos", "rank", "name"}, "head": {...}, "members": [...], "agree": {...},
     "lines": [{"name", "uom", "qty", "price", "year", "group": "I"|"II"|"III"|"IV", "ki", "rate",
                "vp", "base", "missing", "ke", "kz", "kts", "k", "rule": "p21"|"p10", "unit",
                "floor": bool, "sum", "note"}],
     "total": "327316.73"}

Числа приходять рядками з крапкою — так, як їх порахувала точна арифметика сторінки.
"""
from openpyxl import Workbook
from openpyxl.styles import Alignment
from openpyxl.utils import get_column_letter

from excel_export import _save_wb, clean_workbook
from inventory_export import (A_C, A_L, A_LT, BOX, FMT_MONEY, F, Pager, Sheet, _paper,
                              blank_date, date_uk, date_words)

# Графи бланка: A — поле зліва, B…O — дванадцять граф форми (5-та й 9-та — по дві колонки),
# P — сума рядка (залишкова вартість одиниці × кількість), з якої складається підсумок.
WIDTHS = [3.33, 6, 38.55, 9.11, 9.44, 12.33, 5.89, 7.66, 13, 11.89, 5.55, 6.89, 14.55, 15, 18.55, 17.55]
B, C, D, E, FF, G, H, I, J, K, L, M, N, O, P = range(2, 17)
HEAD = [
    (B, B, "Порядковий номер"), (C, C, "Найменування, модель, марка, заводський номер"), (D, D, "Одиниця виміру"),
    (E, E, "Кількість"),
    (FF, G, "Ціна придбання (ціна за прейскурантом, ціна за договором, згідно з яким військове майно придбане "
            "на дату взяття на облік), дата взяття на облік"),
    (H, H, "Коефіцієнт індексації"), (I, I, "Первісна вартість (графу 5 х графу 6)"),
    (J, J, "Курс іноземної валюти, в якій визначена ціна імпортованого військового майна згідно з договором "
           "(контрактом), до гривні, встановлений Національним банком"),
    (K, L, "Значення коефіцієнтів, які використо-\nвуються під час визначення сукупного коефіцієнта зносу"),
    (M, M, "Сукупний коефіцієнт зносу"), (N, N, "Залишкова вартість (графу 7 х графу 10)"), (O, O, "Примітка"),
    (P, P, "Сума (графу 11 х графу 4)"),
]
COEF = ["Ке     =", "Кз     =", "Ктс   ="]
ROW_MIN = 11.1                    # рядок блока коефіцієнтів у бланку
HEAD_MIN = 110.0                  # шапка граф: довгі назви у вузьких колонках
TURNED = {B, H}                   # графи, чий заголовок стоїть знизу вгору


def _num(v):
    """«16212.96» → число клітинки; порожнє й нечислове — нічого."""
    try:
        x = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        return None
    return int(x) if x.is_integer() and "." not in str(v) else x


def _text(cell, value):
    """Назва чи примітка — текст, навіть коли починається з «=»."""
    cell.value = value
    if isinstance(value, str) and value.startswith("="):
        cell.data_type = "s"
    return cell


def _numbers_row(s, r):
    """Рядок із номерами граф: під шапкою і на початку кожної наступної сторінки."""
    for n, (c1, c2, _) in enumerate(HEAD[:-1], 1):
        s.put(r, c1, c2, n, F(8, True), A_C, border=BOX, fit=False)
    s.put(r, P, P, "", F(8, True), A_C, border=BOX, fit=False)
    s.ws.row_dimensions[r].height = 12


def _line_note(ln):
    marks = []
    if ln.get("rule") == "p10":
        marks.append("Кскз = 1: абзац третій пункту 10 Методики")
    if ln.get("group") == "IV":
        marks.append("первісна вартість — за звітом про оцінку")
    if str(ln.get("missing") or "").strip():
        marks.append("без відсутніх комплектувальних (пункт 9)")
    if ln.get("floor"):
        marks.append("не нижче вартості брухту (пункт 11)")
    return "; ".join(x for x in [str(ln.get("note") or "").strip()] + marks if x)


def _block(s, r, n, ln):
    """Позиція — три рядки: реквізити злито по вертикалі, коефіцієнти — по рядку."""
    ws = s.ws
    center = Alignment(horizontal="center", vertical="center", wrap_text=True)

    def tall(c, value, font=None, fmt=None, text=False):
        cell = ws.cell(row=r, column=c)
        if text:
            _text(cell, value)
        else:
            cell.value = value
        cell.font, cell.alignment = font or F(10), center
        if fmt:
            cell.number_format = fmt
        ws.merge_cells(start_row=r, start_column=c, end_row=r + 2, end_column=c)
        for k in range(r, r + 3):
            ws.cell(row=k, column=c).border = BOX

    p10, iv = ln.get("rule") == "p10", ln.get("group") == "IV"
    price, ki, rate, missing = _num(ln.get("price")), _num(ln.get("ki")), _num(ln.get("rate")), _num(ln.get("missing"))
    tall(B, n)
    tall(C, str(ln.get("name") or ""), text=True)
    tall(D, str(ln.get("uom") or ""), text=True)
    tall(E, _num(ln.get("qty")))
    tall(FF, None if iv else price, fmt=FMT_MONEY)
    tall(G, f"{ln['year']} р." if str(ln.get("year") or "").strip() else "", F(8))
    tall(H, None if iv else ki)
    if iv or price is None or ki is None:
        first = _num(ln.get("vp"))                       # за звітом про оцінку — число, не формула
    elif ln.get("group") == "III" and rate is not None:
        first = f"=ROUND(F{r}*J{r}*H{r},2)"
    else:
        first = f"=ROUND(F{r}*H{r},2)"
    if missing is not None and isinstance(first, str):
        first += f"-{round(missing, 2)}"
    elif missing is not None:
        first = _num(ln.get("base"))
    tall(I, first, F(10, True), FMT_MONEY)
    tall(J, rate if ln.get("group") == "III" else None)
    for k, (label, key) in enumerate(zip(COEF, ("ke", "kz", "kts"))):
        a = ws.cell(row=r + k, column=K, value=label)
        a.font, a.alignment, a.border = F(8), Alignment(vertical="center", wrap_text=True), BOX
        b = ws.cell(row=r + k, column=L, value="—" if p10 else _num(ln.get(key)))
        b.font, b.alignment, b.border = F(8), center, BOX
    tall(M, _num(ln.get("k")) if p10 else f"=L{r}*L{r + 1}*L{r + 2}", F(10, True))
    # Залишкова вартість, піднята до вартості брухту, — уже не добуток: стоїть числом.
    tall(N, _num(ln.get("unit")) if ln.get("floor") else f"=I{r}*M{r}", F(10, True), FMT_MONEY)
    tall(O, _line_note(ln), F(9), text=True)
    tall(P, f"=N{r}*E{r}", F(10), FMT_MONEY)


def _under_table(spec):
    """Текст під таблицею: за чим рахували, примітка служби й підстава відомості."""
    lines = spec.get("lines") or []
    p10 = [n for n in (spec.get("p10") or []) if isinstance(n, int)]
    parts = []
    norms = (spec.get("norms") or "Методики визначення залишкової вартості майна Збройних Сил України та інших "
             "військових формувань").strip().rstrip(".")
    if len(p10) < len(lines):
        parts.append(f"Залишкову вартість визначено згідно з: {norms} — додаток 3, пункт 21 «Технічні засоби та майно "
                     "продовольчої служби», Кскз = Ке х Кз х Ктс.")
    if p10:
        which = "усіх рядків" if len(p10) == len(lines) else "рядків " + ", ".join(str(n) for n in p10)
        head = "" if parts else f"Залишкову вартість визначено згідно з: {norms}. "
        parts.append(f"{head}Для {which} сукупний коефіцієнт зносу становить 1 — абзац третій пункту 10 Методики.")
    if str(spec.get("note") or "").strip():
        parts.append(str(spec["note"]).strip())
    if str(spec.get("basis") or "").strip():
        parts.append(f"Підстава видачі відомості: {str(spec['basis']).strip().rstrip('.')}.")
    return " ".join(parts)


def build_valuation(spec: dict):
    lines = spec.get("lines") or []
    if not lines:
        raise ValueError("у відомості немає жодного рядка")
    wb = clean_workbook(Workbook())
    ws = wb.active
    ws.title = "Відомість"
    s = Sheet(ws, WIDTHS)
    _paper(ws, True, left=0.79, right=0.39, top=0.39, bottom=0.39)
    approver, head, agree = (spec.get(k) or {} for k in ("approver", "head", "agree"))

    # Шапка бланка.
    s.put(2, B, C, "ЗАТВЕРДЖУЮ", F(11), A_C, fit=False)
    s.put(2, N, O, "Додаток 1", F(10), A_C, fit=False)
    s.put(3, B, FF, approver.get("pos") or "", F(10), A_L)
    s.put(3, N, O, "до Методики", F(10), A_C, fit=False)
    s.put(4, B, FF, f"{approver.get('rank') or ''} ________________ {approver.get('name') or ''}".strip(), F(10), A_L, fit=False)
    ws.cell(row=5, column=FF, value=f"ВІДОМІСТЬ   №   {spec.get('no') or '________'}").font = F(12, True)
    ws.cell(row=5, column=FF).alignment = A_C
    ws.merge_cells(start_row=5, start_column=FF, end_row=6, end_column=K)
    ws.row_dimensions[5].height, ws.row_dimensions[6].height = 5.25, 13.5
    s.put(6, C, D, date_uk(spec.get("approved"), " року") if spec.get("approved") else blank_date(spec, "року"), F(12), A_L, fit=False)
    s.put(7, B, O, "щодо визначення залишкової вартості військового майна", F(10, True), A_C, fit=False)
    s.put(8, B, O, f"станом на {date_words(spec.get('as_of'))}", F(10, True), A_C, fit=False)
    ws.row_dimensions[9].height = 6
    # Шапка граф: вузькі графи (номер, коефіцієнт індексації) — текстом знизу вгору, решта —
    # із переносами; висота — під найдовший заголовок, щоб жоден не обрізався.
    upright = Alignment(horizontal="center", vertical="center", wrap_text=True, textRotation=90)
    need = HEAD_MIN
    for c1, c2, text in HEAD:
        turned = c1 in TURNED
        s.put(10, c1, c2, text, F(9, True), upright if turned else A_C, border=BOX, fit=False)
        need = max(need, len(text) * 5.4 + 8 if turned else Sheet.need(text, sum(WIDTHS[c1 - 1:c2]), 9))
    ws.row_dimensions[10].height = round(need, 1)
    _numbers_row(s, 11)

    pager = Pager(ws, WIDTHS[1:])
    pager.flow(11)
    r, first, total_h = 12, 12, 15.0
    for n, ln in enumerate(lines, 1):
        # Висота блока — під назву й примітку: злита клітинка сама не розтягується.
        need = max(3 * ROW_MIN, Sheet.need(str(ln.get("name") or ""), WIDTHS[C - 1], 10),
                   Sheet.need(_line_note(ln), WIDTHS[O - 1], 9) if _line_note(ln) else 0)
        each = round(need / 3 + 0.049, 1)
        pager.flow(r - 1)
        # Останній блок лишається на одній сторінці з підсумком.
        if not pager.fits(3 * each + (total_h if n == len(lines) else 0)):
            pager.page(r)
            _numbers_row(s, r)
            pager.y += pager.height(r)
            r += 1
        for k in range(3):
            ws.row_dimensions[r + k].height = each
        _block(s, r, n, ln)
        pager.y += 3 * each
        pager.done = r + 2
        r += 3
    last = r - 1

    # Підсумок і текст під таблицею.
    ws.row_dimensions[r].height = 5
    r += 1
    under = _under_table(spec)
    if under:
        s.put(r, B, O, under, F(8), A_LT)
        r += 1
    s.put(r, K, M, "на загальну суму :", F(11, True), Alignment(horizontal="right", vertical="center"), fit=False)
    cell = ws.cell(row=r, column=N, value=f"=SUM(P{first}:P{last})")
    cell.font, cell.number_format, cell.alignment = F(12, True), FMT_MONEY, Alignment(horizontal="right", vertical="center")
    s.put(r, O, O, "грн.", F(11, True), A_L, fit=False)
    ws.row_dimensions[r].height = total_h
    pager.keep(last + 1, r)
    r += 1
    ws.row_dimensions[r].height = 5
    r += 1

    # Підписи: ліворуч комісія, праворуч — погодження й примірники.
    left = [("Голова комісії – " + (head.get("pos") or "").strip(), None, True), (head.get("rank") or "", head.get("name") or "", False)]
    members = [m for m in (spec.get("members") or []) if (m.get("name") or "").strip()]
    if members:
        left.append(("Члени комісії:", None, True))
    for m in members:
        left.append((m.get("pos") or "", None, False))
        left.append((m.get("rank") or "", m.get("name") or "", False))
    right = []
    if (agree.get("name") or "").strip():
        right += [("ПОГОДЖЕНО:", None, True), (agree.get("pos") or "", None, False), (agree.get("rank") or "", agree.get("name") or "", False),
                  ("", None, False)]
    right += [(x.strip(), None, False) for x in str(spec.get("copies") or "").replace("\n", ";").split(";") if x.strip()]
    start, shift = r, 2 if len(left) > 2 else 0          # погодження — на рівні «Члени комісії:»
    for k, (a, b, bold) in enumerate(left):
        if b is None:
            s.put(start + k, B, I, a, F(10, bold), A_L)
        else:
            s.put(start + k, B, C, a, F(10), A_L, fit=False)
            s.put(start + k, FF, H, b, F(10), A_L, fit=False)
            ws.row_dimensions[start + k].height = 19
    for k, (a, b, bold) in enumerate(right):
        rr = start + shift + k
        if b is None:
            s.put(rr, J, O, a, F(11 if bold else 10, bold), A_L)
        else:
            s.put(rr, J, K, a, F(10), A_L, fit=False)
            s.put(rr, N, O, b, F(10), A_L, fit=False)
            ws.row_dimensions[rr].height = max(ws.row_dimensions[rr].height or 0, 19)
    end = start + max(len(left), shift + len(right)) - 1
    # Підпис лишається зі своєю посадою: рядки йдуть парами.
    k = start
    while k <= end:
        pair = min(end, k + 1)
        pager.keep(k, pair)
        k = pair + 1
    ws.print_area = f"B1:{get_column_letter(P)}{end}"
    return wb


def save_valuation(spec: dict, folder: str) -> str:
    return _save_wb(build_valuation(spec), folder, spec.get("file") or "Відомість залишкової вартості")
