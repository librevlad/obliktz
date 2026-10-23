# -*- coding: utf-8 -*-
"""Сервер «Звіти › Описи 572» (`/api/opysy/…`): чернетки інвентаризаційних описів запасів з книг обліку — сухі пайки,
тара, посуд, миючі засоби, серветки — за типовою формою наказу Мінфіну № 572 рушієм iprod `tools/inv/opysy_knyhy.py`
(коміт 4e143c6, `prod.opysy_knyhy`). Значення частини — конфіг JSON поряд з описами (наказ, комісія, місця, МВО,
«станом на»): вписаний людиною на основному ПК й запам'ятований абсолютним шляхом (`app_setting` «opysyConfig»); з інших
ПК — лише запам'ятований. Книги конфігу «Облік СП» / «Облік ОП» / «Облік РП» — книги програми: перед складанням їх
вивантажено (кожну раз) в тій самій будові в тимчасову теку, і рушій читає вивантаження так само, як iprod читав книги;
програма цих вивантажень своїми книгами не запам'ятовує (`own=False`: відбитки книг у теці книг не витісняються); інша
книга конфігу — файлом. Рушію йдуть ще імена книг для «Довідки» (`_knyhy_names`) і стани документів, яких ФЕС ще не провів
(`_pending` = `op_fes.PENDING`). Вигляд значень конфігу перевіряє `check` при читанні: конфіг не того вигляду не
запам'ятовується, а книги не вивантажуються. «Перевірити» — хід без запису, «Скласти описи» — xlsx у теку конфігу (лише
ім'я з `out` конфігу; з іншого ПК файл віддає сервер завантаженням); рушій працює секунди, тож відповідь приходить одразу з
ходом, а збій конфігу чи Добовки — словами (`explain`). «Відкрити теку» — лише на основному ПК. Описи продуктів і води з
бази ПС — випуск 2.0.0."""
import os
import re
import shutil
import tempfile
import traceback

import book_xlsx as B
import op_book
import op_fes
from prod import opysy_knyhy as OK

OUT = "Описи запасів з книг.xlsx"
SETTING = "opysyConfig"
PROGRAM_BOOKS = (("Облік СП", "СП"), ("Облік ОП", "ОП"), ("Облік РП", "РП"))   # книга конфігу -> книга програми
NO_CONFIG = "Вкажіть конфіг описів; формат описано в довіднику адміністратора, розділ «Описи 572»"
HOST_ONLY = "Конфіг описів вписують і теку відкривають на основному ПК."


def config_path(con, req):
    """Конфіг: вписаний людиною або запам'ятований."""
    given = str(req.get("config") or "").strip().strip('"')
    if given:
        return given
    row = con.execute("SELECT value FROM app_setting WHERE key = ?", (SETTING,)).fetchone()
    return row[0] if row else ""


def remember(con, path):
    con.execute("INSERT INTO app_setting(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                (SETTING, path))


def load(path):
    """Конфіг рушія з `_path`, як його готував `main` iprod; нема файла чи ключа — ValueError словами."""
    if not os.path.isfile(path):
        raise ValueError("Нема конфігу описів: %s" % path)
    try:
        cfg = OK.load_config(path)
    except SystemExit as e:
        raise ValueError(str(e.code)) from None
    except ValueError as e:
        raise ValueError("Конфіг описів не читається: %s" % e) from None
    except (AttributeError, TypeError):                       # у файлі не об'єкт JSON, а список чи рядок
        raise ValueError("Конфіг описів не читається: у файлі має бути об'єкт JSON {…}") from None
    cfg["_path"] = os.path.abspath(path)
    check(cfg)
    return cfg


def check(cfg):
    """Вигляд значень конфігу, поки його не запам'ятовано й не вивантажено книги: що не те — ValueError словами з назвою ключа
    (бракує ключа, не той вигляд, дата не ДД.ММ.РРРР). Перевіряються ключі, які рушій читає й називає довідник адміністратора."""
    def texts(v, size=None):
        return isinstance(v, (list, tuple)) and all(isinstance(x, str) for x in v) and (size is None or len(v) == size)

    def pair(v):                                             # [звання, ПІБ]; зайве рушій не читає
        return texts(v) and len(v) >= 2

    def objects(key, value, need):                           # список об'єктів із потрібними ключами
        if not isinstance(value, list) or not all(isinstance(x, dict) for x in value):
            raise ValueError("У конфігу «%s» має бути список об'єктів {%s}" % (key, ", ".join(need)))
        for item in value:
            for k in need:
                if k not in item:
                    raise ValueError("У конфігу в «%s» бракує ключа «%s»" % (key, k))

    def person(where, spec):                                 # {posada, pib} чи {dobovka: [підрозділ, роль]}
        if spec and not (isinstance(spec, dict) and (not spec.get("dobovka") or texts(spec["dobovka"], 2))):
            raise ValueError("У конфігу %s має бути {posada, pib} чи {dobovka: [підрозділ, роль]}" % where)

    for key in ("stan_na", "pochatok", "kinets", "data_skladannia", "data_pidpysu"):
        value = cfg.get(key)
        if key != "stan_na" and (not value or isinstance(value, str) and not value.strip()):
            continue                                         # порожня дата (як і з самих пробілів) — рядок «___» під руку
        try:
            OK.parse_date(value)
        except (AttributeError, ValueError):
            raise ValueError("У конфігу «%s» має бути дата ДД.ММ.РРРР, а там «%s»" % (key, value)) from None
    if not (isinstance(cfg["edrpou"], str) or texts(cfg["edrpou"])):
        raise ValueError("У конфігу «edrpou» має бути рядок цифр")
    kom = cfg["komisia"]
    if not (isinstance(kom, dict) and pair(kom.get("holova")) and isinstance(kom.get("chleny", []), list)
            and all(texts(x, 2) for x in kom.get("chleny", []))):
        raise ValueError("У конфігу «komisia» має бути {holova: [звання, ПІБ], chleny: [[звання, ПІБ], …]}")
    if cfg.get("buhgalter") and not pair(cfg["buhgalter"]):
        raise ValueError("У конфігу «buhgalter» має бути [посада, ПІБ]")
    person("«pereviryv»", cfg.get("pereviryv"))
    if not (texts(cfg["knyhy"]) and all(cfg["knyhy"])):
        raise ValueError("У конфігу «knyhy» має бути список шляхів до книг")
    objects("kategorii", cfg["kategorii"], ("kod", "subrahunok"))
    if not all(isinstance(k["subrahunok"], str) and k["subrahunok"].split() for k in cfg["kategorii"]):
        raise ValueError("У конфігу в «kategorii» «subrahunok» має бути рядком: рахунок і назва")
    objects("mista", cfg["mista"], ("knyha", "nazva", "de"))
    for place in cfg["mista"]:
        if not (texts(place["knyha"]) and isinstance(place["nazva"], str)):
            raise ValueError("У конфігу в «mista» «knyha» — список назв місць книги, «nazva» — рядок")
        if place.get("prymitky") and not isinstance(place["prymitky"], dict):
            raise ValueError("У конфігу в «mista» «prymitky» — {місце книги: примітка}")
        person("«mvo» в «mista»", place.get("mvo"))
    zn = cfg.get("znyshcheno")
    if zn:
        if not (isinstance(zn, dict) and all(isinstance(zn.get(k, ""), str) for k in ("nomer", "prymitka"))):
            raise ValueError("У конфігу «znyshcheno» має бути {nomer, prymitka}")
        try:
            zn.get("prymitka", "").format(data="01.01.2026")
        except (KeyError, IndexError, ValueError, AttributeError):          # «{x}», «{0}», «{» і «{data.x}»
            raise ValueError("У конфігу в «znyshcheno» у «prymitka» дозволено лише {data}") from None
    if cfg.get("poza_opysom"):
        objects("poza_opysom", cfg["poza_opysom"], ("kod",))
    if cfg.get("fes_kody") and not isinstance(cfg["fes_kody"], dict):
        raise ValueError("У конфігу «fes_kody» має бути {код позиції: номенклатурний номер}")


def program_book(path):
    """Книга програми, яку називає шлях конфігу: «Облік СП 6.xlsx» -> «СП»; інша книга — None."""
    name = os.path.basename(str(path))
    return next((book for word, book in PROGRAM_BOOKS if word in name), None)


def target(cfg):
    """Файл описів: лише ім'я з `out` конфігу — «../x.xlsx» чи абсолютний шлях не виводять його з теки конфігу."""
    return os.path.join(cfg["_dir"], os.path.basename(str(cfg.get("out") or "")) or OUT)


def explain(e):
    """Збій конфігу чи Добовки під час складання — словами: текст винятку («KeyError: 'nazva'», «time data …») на екран не йде."""
    if isinstance(e, KeyError):
        key = str(e.args[0]) if e.args else ""
        if "Підписанти" in key:                                        # openpyxl: «Worksheet Підписанти does not exist.»
            return "у Добовці нема аркуша «Підписанти»"
        return "у конфігу бракує ключа «%s»" % key
    if isinstance(e, ValueError) and str(e).startswith(("time data", "unconverted data remains")):
        got = re.match(r"time data '(.*?)' does not match", str(e))
        return "дата %sу конфігу — ДД.ММ.РРРР" % ("«%s» " % got.group(1) if got else "")
    return ("у конфігу чи книгах значення не того вигляду: перевірте «komisia», «buhgalter», «znyshcheno», «mista», "
            "«kategorii», дати й числа")


def state(con, req):
    """Конфіг і що в ньому — «станом на», місця, файл описів (чи вже є), книги (з програми чи файлом)."""
    path = config_path(con, req)
    out = {"config": path}
    if not path:
        out["why"] = NO_CONFIG
        return out
    try:
        cfg = load(path)
    except ValueError as e:
        out["why"] = str(e)
        return out
    try:
        dst = target(cfg)
        shown = dict(stan_na=cfg["stan_na"], mista=[m.get("nazva", "") for m in cfg["mista"]], out=os.path.basename(dst),
                     exists=os.path.exists(dst),
                     books=[{"file": os.path.basename(p), "program": program_book(p)} for p in cfg["knyhy"]])
    except (LookupError, TypeError, ValueError, AttributeError) as e:         # не той вигляд — словами, а не «AttributeError»
        out["why"] = explain(e)
        return out
    out.update(shown)
    return out


def run(db, lock, req, dobovka_file):
    """«Перевірити» (`dry`) чи «Скласти описи»: книги програми — вивантаженням у тимчасову теку, рушій — одразу.
    `db()` — з'єднання бази, `lock` — замок стану (вивантаження й запам'ятований конфіг — під ним).
    -> {summary, log, out?}; «стоп» рушія — {stop, log}."""
    with lock:
        path = config_path(db(), req)
    if not path:
        raise ValueError(NO_CONFIG)
    cfg = load(path)
    dry = bool(req.get("dry"))
    tmp = tempfile.mkdtemp(prefix="описи 572 ")
    log = []
    try:
        with lock:
            remember(db(), cfg["_path"])
            books, names, once = [], [], {}
            for i, src in enumerate(cfg["knyhy"]):
                file, book = os.path.basename(src), program_book(src)
                if book is None:
                    books.append(src)
                    names.append("%s (файлом)" % file)
                    log.append("книга «%s» — файлом" % file)
                    continue
                if book in once:                       # одна книга програми — одне вивантаження й одне читання, не подвійні залишки
                    log.append("книга «%s» — та сама книга %s, що й «%s»: вдруге не читається" % (file, book, once[book]))
                    continue
                once[book] = file
                dst = os.path.join(tmp, "%d %s" % (i, file))
                if book == "ОП":
                    op_book.export_book(db(), dst, own=False)
                else:
                    B.export_book(db(), dst, B.LAYOUTS[book], own=False)
                books.append(dst)
                names.append("%s (з програми)" % file)
                log.append("книга «%s» — з програми (книга %s)" % (file, book))
        cfg.update(knyhy=books, _knyhy_names=names, _pending=list(op_fes.PENDING))
        dst = target(cfg)
        try:
            ops, _info = OK.build(cfg, dst, dry=dry, log=log.append, dobovka=dobovka_file)
        except SystemExit as e:                                  # «стоп» рушія — словами, з ходом
            return {"stop": str(e.code), "log": log}
        except (LookupError, TypeError, ValueError, AttributeError) as e:   # не той вигляд — словами; подробиці — в консоль
            traceback.print_exc()
            return {"stop": explain(e), "log": log}
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
    lines = sum(len(op["lines"]) for op in ops)
    if dry:
        return {"summary": "Перевірено без запису: описів %d, рядків %d" % (len(ops), lines), "log": log}
    return {"summary": "Описи складено: %s — описів %d, рядків %d" % (os.path.basename(dst), len(ops), lines),
            "log": log, "out": dst}


def folder(con, req):
    """Тека конфігу описів — її відкриває «Відкрити теку»."""
    path = config_path(con, req)
    where = os.path.dirname(os.path.abspath(path)) if path else ""
    if not where or not os.path.isdir(where):
        raise ValueError("Нема теки описів")
    return where
