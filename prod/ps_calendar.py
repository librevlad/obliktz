# -*- coding: utf-8 -*-
"""Календар програми ПС_2024: тижні Пн–Нд від тижня, у якому 1 січня, періоди по 4 тижні, квартал —
13 тижнів (53-й тиждень, «14.1», — у IV кварталі). ISO-тиждень не годиться: ПС рахує інакше.
Перенесено з iprod (`report_engine.year_start/period_dates/date_to_period/quarter_dates`,
`kvartal.quarter_of`, `suhpay_days.period_of`)."""
import datetime

ROMAN = ("I", "II", "III", "IV")


def year_start(year):
    """Понеділок тижня 1.1 року ПС — тижня, у якому 1 січня."""
    d = datetime.date(year, 1, 1)
    return d - datetime.timedelta(days=d.weekday())


def period_dates(year, period, week):
    """Період P і тиждень W року ПС -> (понеділок, неділя). (2026, 5, 4) -> (11.05.2026, 17.05.2026)."""
    start = year_start(year) + datetime.timedelta(days=((period - 1) * 4 + week - 1) * 7)
    return start, start + datetime.timedelta(days=6)


def date_to_period(d):
    """Дата -> (рік, період, тиждень) ПС. Тиждень належить року своєї неділі: тиждень на межі років —
    1.1 нового року, 53-й тиждень — (рік, 14, 1)."""
    monday = d - datetime.timedelta(days=d.weekday())
    year = (monday + datetime.timedelta(days=6)).year
    idx = (monday - year_start(year)).days // 7
    return year, idx // 4 + 1, idx % 4 + 1


def quarter_dates(year, quarter):
    """Квартал Q (1..4) року ПС -> (понеділок, неділя): 1.1–4.1, 4.2–7.2, 7.3–10.3, 10.4–13.4 (+14.1)."""
    idx = 13 * (quarter - 1)
    start = period_dates(year, idx // 4 + 1, idx % 4 + 1)[0]
    if quarter == 4:
        end = year_start(year + 1) - datetime.timedelta(days=1)
    else:
        end = start + datetime.timedelta(days=13 * 7 - 1)
    return start, end


def quarter_of(d):
    """Дата -> (рік ПС, квартал 1..4)."""
    year = date_to_period(d)[0]
    q = 1
    while q < 4 and d > quarter_dates(year, q)[1]:
        q += 1
    return year, q


def report_quarter(d):
    """Квартал звіту 1/прод: як у ПС, але I квартал починається з 01.01, а IV триває до 31.12 — кінець
    грудня в тижні 1.1 наступного року ще IV квартал свого року (у Розрахунку 1прод — графа «1.1а»)."""
    y, q = quarter_of(d)
    if q == 1 and d.year < y:
        return d.year, 4
    return y, q


def quarter_label(yq):
    """(2026, 3) -> «III кв 2026» — так квартал пише графа «1прод» книги СП."""
    return "%s кв %d" % (ROMAN[yq[1] - 1], yq[0])
