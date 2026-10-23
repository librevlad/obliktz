# -*- coding: utf-8 -*-
"""Облік ТЗ ПС — запуск як програма Windows.

Піднімає локальний сервер на вільному порту (тільки 127.0.0.1, назовні нічого
не слухає) і відкриває вікно WebView2 без адресного рядка й вкладок. Коли на
основному ПК увімкнено роботу в мережі («Налаштування» → «Робота в мережі»), сервер слухає й
мережу на сталому порту, а інші ПК відкривають програму в браузері — з кодом доступу
(див. network.py). Стан
користувача — норми, проведені документи, записи знищення — лягає в ту саму
базу `Дані обліку/oblik.sqlite`, що й облік із паперів: один файл, який видно,
можна покласти в резервну копію або перенести на інший комп'ютер.

Коли вікно закривають, сервер зупиняється разом із програмою.
"""
import sys, os, re, io, json, socket, sqlite3, threading, subprocess, tempfile, shutil, time
import contextlib
import datetime
import gc
import ntpath
import traceback
from collections import OrderedDict
from urllib.parse import quote, unquote, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "Облік ТЗ ПС"
# Сторінка: index.html, стилі й модулі app/js, які підключає index.html (порядок — його).
ASSETS = ("index.html", "style.css")
MIME = {".html": "text/html; charset=utf-8", ".css": "text/css; charset=utf-8",
        ".js": "text/javascript; charset=utf-8", ".json": "application/json; charset=utf-8",
        ".pdf": "application/pdf", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
        ".png": "image/png", ".tif": "image/tiff", ".tiff": "image/tiff",
        ".webp": "image/webp", ".heic": "image/heic", ".doc": "application/msword",
        ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        ".gif": "image/gif", ".bmp": "image/bmp",
        ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        ".zip": "application/zip"}
# Що можна підшити: скани й фото, PDF, документи Office, текст, архіви й
# підписані файли з електронного документообігу (.p7s, .asice).
SCAN_EXT = {".pdf", ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".tif", ".tiff", ".webp", ".heic",
            ".doc", ".docx", ".xls", ".xlsx", ".odt", ".ods", ".rtf", ".txt", ".csv",
            ".zip", ".rar", ".7z", ".p7s", ".asice", ".asics", ".sig"}
# Відмова на тип, якого не підшивають: той самий текст для завантаження й прив'язки; відкриття — свій.
BAD_TYPE = "тип файла не підходить. Потрібні PDF, фото, документи Office, текст, архів або підписаний файл"
BAD_OPEN = "з програми відкриваються лише PDF, фото, документи Office, текст, архіви й підписані файли"
OFFICE_OWNER = "~$"                     # «~$Рапорт.docx»: Word і Excel кладуть його поруч із відкритим документом — не документ
# Лише ці типи сторінка показує сама. Решту сервер віддає як «завантажити»,
# а відкриває їх Windows відповідною програмою: файл, що прийшов звідкись,
# не має виконуватися всередині програми обліку.
INLINE_EXT = {".pdf", ".jpg", ".jpeg", ".png", ".gif", ".bmp", ".webp"}
# Мініатюри фото: десятки знімків акта по кілька мегабайт у сітці файлів
# вантажились би цілими. Зменшена копія робиться на льоту й тримається в пам'яті.
THUMB_EXT = {".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif"}
THUMB_MIN_BYTES = 200_000
_THUMBS: "OrderedDict[tuple, bytes]" = OrderedDict()
_THUMBS_MAX = 400
_THUMBS_LOCK = threading.Lock()


def thumbnail(full: str, width: int) -> bytes | None:
    """JPEG не ширший і не вищий за `width`, з урахуванням повороту з EXIF.
    None — якщо зменшити не вдалося: тоді віддається сам файл."""
    key = (full, os.path.getmtime(full), width)
    with _THUMBS_LOCK:
        hit = _THUMBS.get(key)
        if hit is not None:
            _THUMBS.move_to_end(key)
            return hit
    try:
        from PIL import Image, ImageOps
        with Image.open(full) as im:
            im.draft("RGB", (width, width))
            im = ImageOps.exif_transpose(im)
            im.thumbnail((width, width))
            if im.mode not in ("RGB", "L"):
                im = im.convert("RGB")
            buf = io.BytesIO()
            im.save(buf, "JPEG", quality=80)
            data = buf.getvalue()
    except Exception:                                   # noqa: BLE001
        return None
    with _THUMBS_LOCK:
        _THUMBS[key] = data
        while len(_THUMBS) > _THUMBS_MAX:
            _THUMBS.popitem(last=False)
    return data
MAX_SCAN = 40 * 1024 * 1024
MAX_JSON = 1024 * 1024                  # запит сторінки (JSON) не більший за мегабайт: файлів у ньому нема
MAX_CHECK = 8 * 1024 * 1024             # перевірка зниклих файлів: тисячі шляхів при запуску, але не потоп
RENAME_TRIES, RENAME_PAUSE = 10, 0.05   # скільки разів і через скільки секунд повторювати перейменування, яке не дається
BAD_FILE_CHARS = re.compile(r'[\\/:*?"<>|\x00-\x1f]+')
SCANS = "скани/"

EDGE_CANDIDATES = [
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files (x86)\Google\Chrome\Application\chrome.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
]


def base_dir():
    """Каталог із файлами застосунку: у зібраному .exe це розпакований тимчасовий."""
    if getattr(sys, "frozen", False):
        return sys._MEIPASS
    return os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "app"))


DATA_NEAR = None                      # тека даних поруч із програмою, якщо є


def data_dir(probe=False):
    """Каталог даних — поруч із .exe, а в разі відсутності прав — у профілі.

    Без probe нічого не створюється й не пишеться: імпорт лаунчера (перевірки,
    QA-сервери над копією) не має лишати по собі порожню теку «Дані обліку»."""
    global DATA_NEAR
    if getattr(sys, "frozen", False):
        near_exe = os.path.join(os.path.dirname(sys.executable), "Дані обліку")
    else:
        near_exe = os.path.join(os.path.dirname(os.path.abspath(__file__)), "Дані обліку")
    DATA_NEAR = near_exe
    if not probe:
        return near_exe
    try:
        os.makedirs(near_exe, exist_ok=True)
        probe = os.path.join(near_exe, ".write-test")
        with open(probe, "w") as f:
            f.write("ok")
        os.remove(probe)
        return near_exe
    except OSError:
        fallback = os.path.join(os.environ.get("APPDATA", tempfile.gettempdir()), "OblikTZPS")
        os.makedirs(fallback, exist_ok=True)
        return fallback


sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
import state_db                                       # noqa: E402
import network                                        # noqa: E402
import stable_hash                                    # noqa: E402
from db.connect import (apply_migrations, checked_version, current_version,   # noqa: E402
                        APP_SCHEMA_VERSION, SchemaTooNewError, SchemaTooOldError)
from build import export_app_data                     # noqa: E402
from build import verify_db                           # noqa: E402
from reports import form2, form11, form21, journals   # noqa: E402

ROOT = base_dir()
DATA = data_dir()
STATE = os.path.join(DATA, "стан обліку.json")
STATE_LOCK = threading.Lock()
# Робота в мережі: налаштування з теки даних, підбір коду, хто записав останнім.
_NET = {"cfg": None, "data": None}
GATE = network.Gate()
LAST_WRITE = {"who": "", "at": ""}
# Що можна зробити лише на самому основному ПК: відновити базу з копії чи файла, зберегти
# копію діалогом Windows, відкрити файл чи теку програмою цього ПК (і теку акта), змінити
# налаштування мережі, шукати файли в теках служби за вмістом.
HOST_ONLY = {"/api/restore", "/api/restore-file", "/api/copy", "/api/reveal", "/api/open", "/api/network",
             "/api/folders", "/api/files-find", "/api/op-act/reveal", "/api/sp-act/reveal"}


def net_cfg() -> dict:
    """Налаштування мережі для теки даних, з якою працює програма."""
    if _NET["cfg"] is None or _NET["data"] != DATA:
        _NET.update(cfg=network.load(DATA), data=DATA)
    return _NET["cfg"]


def host_name() -> str:
    """Ім'я людини на основному ПК для журналу змін; не задано — порожнє."""
    return network.clean_name(net_cfg().get("host_name"))
ASSET_CACHE = {}
for name in ASSETS:
    with open(os.path.join(ROOT, name), "rb") as f:
        ASSET_CACHE[name] = f.read()
PAGE_MODULES = tuple(re.findall(r'<script src="(js/[\w.-]+\.js)"></script>',
                                ASSET_CACHE["index.html"].decode("utf-8")))
for name in PAGE_MODULES:
    with open(os.path.join(ROOT, *name.split("/")), "rb") as f:
        ASSET_CACHE[name] = f.read()


class StateBroken(Exception):
    """База є, але прочитати з неї внесене не вдалося."""


_DB_CON = {"path": None, "con": None}


def db_path() -> str:
    return os.path.join(DATA, "oblik.sqlite")


def db():
    """Одне з'єднання з базою на весь час роботи вікна.

    Внесене в програмі живе в тій самій базі, що й облік із паперів: окремого
    файла стану більше немає. Тому й копія — це копія бази.
    """
    path = db_path()
    if _DB_CON["con"] is not None and _DB_CON["path"] == path:
        return _DB_CON["con"]
    if _DB_CON["con"] is not None:
        _DB_CON["con"].close()
        _DB_CON["con"] = None
    if not os.path.exists(path):
        # Тека поруч із програмою — лише для читання (диск із правами, флешка
        # без запису). Працювати з бази, у яку не можна писати, не вийде, тож
        # вона переїжджає в профіль користувача цілком, разом з обліком.
        near = os.path.join(DATA_NEAR or "", "oblik.sqlite")
        if DATA_NEAR and os.path.exists(near) and os.path.realpath(near) != os.path.realpath(path):
            try:
                shutil.copy2(near, path)
            except OSError as e:
                raise StateBroken(f"тека даних лише для читання, а скопіювати базу "
                                  f"в {os.path.dirname(path)} не вдалося: {e}") from e
        else:
            raise StateBroken(f"немає бази обліку: {path}")
    con = sqlite3.connect(path, isolation_level=None, check_same_thread=False)
    con.row_factory = sqlite3.Row
    # Те саме, що в db.connect.open_db: перевірки бази (/api/verify) шукають
    # по назвах через lower_uk, бо вбудований lower() кирилицю не згортає.
    con.create_function("lower_uk", 1, lambda s: s.lower() if s else s, deterministic=True)
    # Тека даних могла приїхати зі старішого релізу: схему доганяємо тут, інакше
    # програма не знайшла б таблиць, у які пише. Оновлення схеми буває й
    # оновленням даних, тому перед ним — копія бази поруч з автоматичними.
    # Усе — під одним try: на пошкодженому файлі падає вже PRAGMA, і з'єднання,
    # що лишилось відкритим, не дало б відкласти файл і відновити базу з копії.
    try:
        con.execute("PRAGMA foreign_keys = ON")
        con.execute("PRAGMA journal_mode = WAL")
        con.execute("PRAGMA synchronous = FULL")
        con.execute("PRAGMA busy_timeout = 5000")
        if checked_version(con) < APP_SCHEMA_VERSION:
            backup_before_upgrade(con)
        apply_migrations(con)
    except StateBroken:
        con.close()
        raise
    except (SchemaTooNewError, SchemaTooOldError) as e:
        con.close()
        raise StateBroken(str(e)) from e
    except sqlite3.Error as e:
        con.close()
        # SQLITE_CORRUPT і SQLITE_NOTADB — це саме DatabaseError, без підкласу.
        what = "файл бази пошкоджено" if type(e) is sqlite3.DatabaseError else "схема бази не оновилася"
        raise StateBroken(f"{what}: {e}") from e
    _DB_CON.update(path=path, con=con)
    return con


def load_state(ui_key="ui"):
    """Внесене в програмі — з бази. Не читається база — не мовчимо: інакше
    перше ж збереження лягло б поверх даних, яких ми не побачили. `ui_key` — чиї
    налаштування вікна віддати: основного ПК («ui») чи людини з іншого ПК («ui@ім'я»)."""
    try:
        con = db()
        if state_db.is_empty(con):
            import_old_state(con)
        return state_db.load_state(con, ui_key)
    except StateBroken:
        raise
    except (sqlite3.Error, ValueError) as e:
        raise StateBroken(str(e)) from e


def import_old_state(con):
    """Разове перенесення: у попередніх версіях внесене лежало у «стан обліку.json».

    Файл не видаляємо — перейменовуємо: якщо перенесення виявиться неповним,
    у людини лишається чим повернутися."""
    if not os.path.exists(STATE):
        return
    try:
        with open(STATE, encoding="utf-8") as f:
            data = json.load(f)
        if not isinstance(data, dict):
            raise ValueError("у файлі не об'єкт даних")
    except (OSError, ValueError) as e:
        # Файл є, але прочитати не вдалося. Мовчки почати з порожньої бази
        # означало б показати людині програму без її документів — і дати
        # записати поверх.
        raise StateBroken(f"старий файл стану не читається: {e}") from e
    if not data:
        return
    # У старому файлі — лише внесене в програмі; документи й рапорти з паперових
    # журналів уже лежать у базі. Запис приймає повний перелік, тож свої додаємо
    # до них (номери актів до рапортів із бази старий файл тримав мапою dzActs —
    # запис покладе їх на рядки рапортів).
    base = state_db.load_state(con)
    have = base.get("docs") or {}
    docs = data.get("docs") or {}
    data["docs"] = {j: list(have.get(j) or []) + list(docs.get(j) or [])
                    for j in ("incoming", "movement", "writeoffs")}
    old_reports = [r for r in data.get("destroyed") or [] if isinstance(r, dict)]
    data["destroyed"] = list(base.get("destroyed") or []) + old_reports
    state_db.save_state(con, data)
    data["destroyed"] = old_reports
    # Перейменовуємо файл лише тоді, коли з бази читається те саме, що в ньому
    # було: втрата хоч одного заповненого поля (так зникали тексти
    # інвентаризації) — це не перенесення, а підміна.
    lost = lost_after_import(data, state_db.load_state(con))
    if lost:
        raise StateBroken("старий файл стану перенесено неповно, файл лишено як є: "
                          + "; ".join(lost[:5]))
    os.replace(STATE, STATE + ".перенесено")


# Розділи, що переносяться як є (документи й норми міняють форму — їх звіряє
# state_db своїми перевірками; записи про знищення стають документами — їх
# звіряє _lost_reports за змістом).
IMPORT_CHECKED = ("inventories", "recon", "subst", "scans")
REPORT_FIELDS = ("date", "sub", "code", "report", "act", "note", "unit", "name", "uom", "price", "offNo", "offDate")


def _lost_reports(old, new):
    """Записи про знищення старого стану, яких після перенесення немає: запис
    стає рядком рапорту-документа з іншим id, тож шукаємо його за змістом —
    датою, підрозділом, позицією, кількістю, рапортом, актом, приміткою."""
    def key(r):
        return tuple(str(r.get(k) or "").strip().lower() if k == "act" else str(r.get(k) or "").strip()
                     for k in REPORT_FIELDS) + (round(float(r.get("qty") or 0), 3),)
    left = {}
    for r in new.get("destroyed") or []:
        if isinstance(r, dict):
            left[key(r)] = left.get(key(r), 0) + 1
    out = []
    for n, r in enumerate(old.get("destroyed") or []):
        if not isinstance(r, dict):
            continue
        k = key(r)
        if left.get(k):
            left[k] -= 1
        else:
            out.append(f"destroyed: запис {r.get('id', n)} зник")
    return out


def lost_after_import(old, new):
    """Заповнені поля старого стану, яких після перенесення в базу немає або
    які змінилися — за розділами, що мають повернутися такими самими."""
    out = _lost_reports(old, new)
    for section in IMPORT_CHECKED:
        before = old.get(section) or []
        after = new.get(section) or []
        if not isinstance(before, list):
            continue
        by_id = {r.get("id"): r for r in after if isinstance(r, dict)}
        for n, rec in enumerate(before):
            if not isinstance(rec, dict):
                continue
            got = by_id.get(rec.get("id")) if rec.get("id") is not None else (after[n] if n < len(after) else None)
            if not isinstance(got, dict):
                out.append(f"{section}: запис {rec.get('id', n)} зник")
                continue
            for key, value in rec.items():
                if value in (None, "", [], {}):
                    continue
                if json.dumps(got.get(key), sort_keys=True, ensure_ascii=False) != json.dumps(value, sort_keys=True, ensure_ascii=False):
                    out.append(f"{section}: {rec.get('id', n)}.{key}")
    return out


KEEP_BACKUPS = 60
KEEP_DAYS = 30                  # і остання копія кожного з тридцяти останніх днів із копіями
BACKUP_EVERY = 10 * 60          # не частіше, ніж раз на 10 хвилин
# Копії поруч із даними не рятують, якщо втрачено всю теку (видалили, забрали
# флешку, зламався диск). Тому остання копія дублюється ще й у профіль
# користувача — окремо від робочої теки.
KEEP_AWAY = 10


def away_dir():
    base = os.environ.get("LOCALAPPDATA") or os.environ.get("APPDATA") or tempfile.gettempdir()
    return os.path.join(base, "OblikTZPS", "копії")


def copy_away(src: str) -> None:
    """Дублює копію бази поза робочою текою; збій тут нічого не спиняє."""
    try:
        if os.path.realpath(os.path.dirname(src)).startswith(os.path.realpath(away_dir())):
            return
        d = away_dir()
        os.makedirs(d, exist_ok=True)
        shutil.copy2(src, os.path.join(d, os.path.basename(src)))
        names = sorted((f for f in os.listdir(d) if AUTO_BACKUP.match(f)),
                       key=lambda f: os.path.getmtime(os.path.join(d, f)))
        for f in names[:-KEEP_AWAY]:
            os.remove(os.path.join(d, f))
    except OSError:
        pass


BACKUP_EXT = ".sqlite"
BACKUP_NAME = "облік "
# Автоматична копія — «облік 2026-09-18 101500.sqlite» (і «-2», якщо дві в ту саму
# секунду). Копії з назвою («… перед виправленням …») робить людина чи
# розробник свідомо: ротація їх не чіпає.
AUTO_BACKUP = re.compile(r"^облік \d{4}-\d{2}-\d{2} \d{6}(-\d+)?\.sqlite$")


# Остання копія цього сеансу і ревізія стану, з якої її знято.
_COPIED = {"path": None, "rev": None}


def _changed_after(path: str) -> bool:
    """Чи змінювалась база після того, як зроблено копію `path`.

    Для копії цього сеансу відповідає лічильник ревізій — він росте з кожним
    записом. Часу файла тут мало: запис іде одразу за копією, і на Windows він
    часто потрапляє в той самий такт годинника (~16 мс), тож файл бази виглядав
    не новішим за копію — і копія перед незворотною дією пропускалася, хоча
    останньої правки не було в жодній. Час файла бази й журналу WAL лишається
    для старших копій і для запису ззовні."""
    if _COPIED["path"] == path and _COPIED["rev"] != current_rev():
        return True
    stamp = os.path.getmtime(path)
    for f in (db_path(), db_path() + "-wal"):
        try:
            if os.path.getmtime(f) > stamp:
                return True
        except OSError:
            pass
    return False


def backup_state(force=False):
    """Копія бази перед записом — не частіше, ніж раз на 10 хвилин.

    «Видалити все внесене в програмі…» і випадкове видалення документа незворотні в самій
    програмі, тому незворотними вони не мають бути на диску: шістдесят
    останніх копій лежать у «Дані обліку/копії» з датою й часом в імені.
    """
    if not os.path.exists(db_path()):
        return
    backups = os.path.join(DATA, "копії")
    os.makedirs(backups, exist_ok=True)
    # Збереження йде на кожну правку; копія на кожне означала б, що тридцять
    # копій — це останні хвилини набору, а не вчорашній день.
    def listing():
        # Порядок — за часом запису, не за іменем: дві копії в одну секунду
        # мають суфікс «-2», і за абеткою він стояв би раніше за старшу.
        names = [f for f in os.listdir(backups)
                 if f.startswith(BACKUP_NAME) and f.endswith(BACKUP_EXT)]
        return sorted(names, key=lambda f: os.path.getmtime(os.path.join(backups, f)))

    existing = listing()
    if existing and not force:
        last = os.path.getmtime(os.path.join(backups, existing[-1]))
        if time.time() - last < BACKUP_EVERY:
            return
    # Примусова копія (перед незворотною дією) не дублюється, якщо база відтоді не
    # змінилась: запис, що раз по раз не проходить, інакше плодив би однакові копії.
    if existing and force and not _changed_after(os.path.join(backups, existing[-1])):
        return
    stamp = time.strftime("%Y-%m-%d %H%M%S")
    rev = current_rev()
    target = os.path.join(backups, f"{BACKUP_NAME}{stamp}{BACKUP_EXT}")
    n = 2
    while os.path.exists(target):            # копія в ту саму секунду не затирає попередню
        target = os.path.join(backups, f"{BACKUP_NAME}{stamp}-{n}{BACKUP_EXT}")
        n += 1
    # VACUUM INTO робить цілісну копію бази під час роботи — на відміну від
    # копіювання файла, яке може застати незаписаний журнал.
    try:
        db().execute("VACUUM INTO ?", (target,))
    except sqlite3.Error:
        # Недописаний файл із пошкодженої бази серед копій виглядав би копією.
        if os.path.exists(target):
            os.remove(target)
        raise
    os.utime(target)
    _COPIED.update(path=target, rev=rev)
    copy_away(target)
    old = [f for f in listing() if AUTO_BACKUP.match(f)]
    # Остання копія кожного з останніх днів лишається понад ліміт: день, коли вносять довідники,
    # дає десятки примусових копій, і без цього шістдесят останніх — це лише остання година.
    last_of_day = {}
    for f in old:
        day = time.strftime("%Y-%m-%d", time.localtime(os.path.getmtime(os.path.join(backups, f))))
        last_of_day[day] = f
    keep = set(old[-KEEP_BACKUPS:]) | set(list(last_of_day.values())[-KEEP_DAYS:])
    for f in old:
        if f in keep:
            continue
        try:
            os.remove(os.path.join(backups, f))
        except OSError:
            pass


def named_backup(con, label) -> str:
    """Іменована копія бази в «Дані обліку/копії» («облік … перед прийомом книги ОП»): такі
    програма не прибирає, і з них відновлюються через «Автоматичні копії…»."""
    backups = os.path.join(DATA, "копії")
    stamp = time.strftime("%Y-%m-%d %H%M%S")
    target = os.path.join(backups, f"{BACKUP_NAME}{stamp} {label}{BACKUP_EXT}")
    n = 2
    while os.path.exists(target):
        target = os.path.join(backups, f"{BACKUP_NAME}{stamp} {label}-{n}{BACKUP_EXT}")
        n += 1
    os.makedirs(backups, exist_ok=True)
    con.execute("VACUUM INTO ?", (target,))
    copy_away(target)
    return target


def backup_before_upgrade(con) -> str:
    """Копія бази перед оновленням схеми — у «Дані обліку/копії», з позначкою
    в імені. Без копії оновлення не йде: міграція може змінювати дані."""
    try:
        return named_backup(con, "перед оновленням")
    except (OSError, sqlite3.Error) as e:
        raise StateBroken(f"перед оновленням бази не вдалося зберегти її копію: {e}") from e


# Книга обліку за адресою маршруту (/api/book/<op|sp|rp>/…) і тека книг СП і РП у FOLDERS.
BOOK_URL = {"op": "ОП", "sp": "СП", "rp": "РП"}
BOOK_FOLDER = {"СП": "spBook", "РП": "rpBook"}

# Теки, куди програма кладе файли ручного шляху: (ключ, підпис у «Налаштуваннях», типова тека
# відносно «Дані обліку»). Перелік спільний: інші розділи (закупівлі) дописують сюди свої теки.
FOLDERS = [
    ("opBook", "Книга «Облік ОП»", "вивантаження"),
    ("reports", "Звіти", os.path.join("вивантаження", "Звіти")),
    ("requests", "Заявки", "вивантаження"),
    ("fes", "Звірки з ФЕС", "вивантаження"),
    ("purchases", "Закупівлі", "Закупівлі"),
    ("receipts", "Прибутково-видаткові документи", "Прибутково-видаткові документи"),
    ("fesRegisters", "Реєстри на ФЕС", "Реєстри на ФЕС"),
    ("spActs", "Акти сухпаю", os.path.join("вивантаження", "Акти сухпаю")),
    ("opActs", "Акти списання ОП", os.path.join("вивантаження", "Акти списання")),
    ("dobovka", "Добовка", None),            # лише читання; типового значення немає — «Налаштування» → «Теки»
    ("spBook", "Книга «Облік СП»", "вивантаження"),
    ("rpBook", "Книга «Облік РП»", "вивантаження"),
]
# Теки, у які програма лише дивиться: Добовку читають інші програми служби за сталим шляхом, тож ні файла (/api/scan), ні
# каталогу («Показати в теці» з `make`) там не створюється. Значення — відповідь на спробу.
READ_ONLY_FOLDERS = {"dobovka": "Теку Добовки програма лише читає"}


def _default_folder(default):
    """Типова тека ключа: у «Дані обліку»; `None` — типового значення немає (порожній шлях, не «Дані обліку»)."""
    return os.path.join(DATA, default) if default is not None else ""


def _folders_set():
    try:
        row = db().execute("SELECT value FROM app_setting WHERE key = 'folders'").fetchone()
        mine = json.loads(row[0]) if row else {}
    except (sqlite3.Error, ValueError, StateBroken):
        mine = {}
    return mine if isinstance(mine, dict) else {}


def folders() -> dict:
    """{ключ: тека}: задана в «Налаштуваннях» або типова в «Дані обліку»."""
    mine = _folders_set()
    out = {}
    for key, _label, default in FOLDERS:
        v = mine.get(key)
        out[key] = v.strip() if isinstance(v, str) and v.strip() else _default_folder(default)
    return out


def folders_listing() -> list:
    mine, have = _folders_set(), folders()
    return [{"key": key, "label": label, "path": have[key], "default": _default_folder(default),
             "set": bool(isinstance(mine.get(key), str) and mine[key].strip())}
            for key, label, default in FOLDERS]


def _window_title() -> str:
    m = re.search(rb"<title>(.*?)</title>", ASSET_CACHE.get("index.html", b""))
    return m.group(1).decode("utf-8", "ignore") if m else APP_NAME


def ask_save_path(suggested: str, initial_dir: str = ""):
    """Системне вікно «Зберегти як» для копії бази; None — людина передумала.

    Сторінка шляхів на диску не бачить, тому вікно показує сама програма — з
    вікном обліку як власником, щоб не ховалося позаду. OBLIK_COPY_TO=<шлях>
    замінює вікно в перевірках без екрана."""
    forced = os.environ.get("OBLIK_COPY_TO")
    if forced:
        return forced
    if os.name != "nt":
        return None
    import ctypes                                              # noqa: PLC0415
    from ctypes import wintypes                                # noqa: PLC0415

    class OPENFILENAMEW(ctypes.Structure):
        _fields_ = [("lStructSize", wintypes.DWORD), ("hwndOwner", wintypes.HWND),
                    ("hInstance", wintypes.HINSTANCE), ("lpstrFilter", wintypes.LPCWSTR),
                    ("lpstrCustomFilter", wintypes.LPWSTR), ("nMaxCustFilter", wintypes.DWORD),
                    ("nFilterIndex", wintypes.DWORD), ("lpstrFile", wintypes.LPWSTR),
                    ("nMaxFile", wintypes.DWORD), ("lpstrFileTitle", wintypes.LPWSTR),
                    ("nMaxFileTitle", wintypes.DWORD), ("lpstrInitialDir", wintypes.LPCWSTR),
                    ("lpstrTitle", wintypes.LPCWSTR), ("Flags", wintypes.DWORD),
                    ("nFileOffset", wintypes.WORD), ("nFileExtension", wintypes.WORD),
                    ("lpstrDefExt", wintypes.LPCWSTR), ("lCustData", wintypes.LPARAM),
                    ("lpfnHook", ctypes.c_void_p), ("lpTemplateName", wintypes.LPCWSTR),
                    ("pvReserved", ctypes.c_void_p), ("dwReserved", wintypes.DWORD),
                    ("FlagsEx", wintypes.DWORD)]

    user32 = ctypes.windll.user32
    user32.FindWindowW.argtypes = [wintypes.LPCWSTR, wintypes.LPCWSTR]
    user32.FindWindowW.restype = wintypes.HWND
    buf = ctypes.create_unicode_buffer(suggested, 32768)
    ofn = OPENFILENAMEW()
    ofn.lStructSize = ctypes.sizeof(OPENFILENAMEW)
    ofn.hwndOwner = user32.FindWindowW(None, _window_title()) or None
    ofn.lpstrFilter = "База обліку (*.sqlite)\0*.sqlite\0Усі файли\0*.*\0\0"
    ofn.nFilterIndex = 1
    ofn.lpstrFile = ctypes.cast(buf, wintypes.LPWSTR)
    ofn.nMaxFile = 32768
    ofn.lpstrInitialDir = initial_dir or None
    ofn.lpstrTitle = "Зберегти копію бази обліку"
    # OFN_EXPLORER | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR | OFN_HIDEREADONLY | OFN_OVERWRITEPROMPT
    ofn.Flags = 0x00080000 | 0x00000800 | 0x00000008 | 0x00000004 | 0x00000002
    ofn.lpstrDefExt = "sqlite"
    if not ctypes.windll.comdlg32.GetSaveFileNameW(ctypes.byref(ofn)):
        return None
    return buf.value or None


def copy_database_to(path: str) -> str:
    """Цілісна копія бази туди, куди показала людина — VACUUM INTO, як і
    автоматичні копії. Наявний файл замінюється: вікно вже перепитало."""
    path = os.path.abspath(path)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with STATE_LOCK:
        if os.path.exists(path):
            os.remove(path)
        db().execute("VACUUM INTO ?", (path,))
    return path


MAX_RESTORE = 512 * 1024 * 1024


def _backup_summary(data) -> dict:
    """Що лежить у копії: скільки документних рядків, записів знищення, звірок."""
    docs = data.get("docs") or {}
    return {"docs": sum(len(docs.get(k) or []) for k in ("incoming", "movement", "writeoffs")),
            "destroyed": len(data.get("destroyed") or []),
            "recon": len(data.get("recon") or []),
            "inventories": len(data.get("inventories") or []),
            "people": len(data.get("people") or [])}


def is_accounting(con) -> bool:
    """Чи є у файлі облік. Файл SQLite без таблиць обліку (чужа база, порожній
    файл) копією не є: міграції створили б у нього порожню схему, і відновлення
    з такого «файла» затерло б облік порожньою базою."""
    return current_version(con) > 0


NOT_A_COPY = "це не копія бази обліку: у файлі немає обліку"


def _backup_uri(path: str) -> str:
    """Адреса копії бази для SQLite: лише читання, файл незмінний (immutable).

    Незмінний файл SQLite читає без блокувань і без журналу, тож поруч із
    копією в режимі WAL не з'являються «….sqlite-shm» і «….sqlite-wal» — читання
    їх після себе не прибирало, і в теці копій після кожного запуску лежало
    сміття. «%», «?» і «#» в адресі службові: назва копії з «#» обривалася на
    ньому (і поруч з'являвся порожній файл), а «%41» читалося як «A»."""
    path = path.replace("%", "%25").replace("?", "%3f").replace("#", "%23")
    return f"file:{path}?mode=ro&immutable=1"


# Журнали, які SQLite тримає поруч із базою: попереднього запису й відкату.
BACKUP_JOURNALS = ("-wal", "-journal")


@contextlib.contextmanager
def _backup_open(path):
    """Копія бази, відкрита для читання: (з'єднання, схема копії на диску).

    Сама копія не змінюється, і поруч із нею нічого не з'являється: це файл, з
    якого, можливо, доведеться відновлюватися. Усе, що потребує запису, іде на
    тимчасову копію.

    Копія зі старішою схемою (знята до оновлення програми) — тимчасову доводять
    міграції: інакше після кожного оновлення всі попередні копії виглядали в
    діалозі «пошкодженими» й без кнопки «Відновити» — саме тоді, коли вони
    найпотрібніші. Журнал поруч із копією (відкладена пошкоджена база, копія
    файлами під час роботи, обірваний запис) — незмінний файл читається без
    нього, а частина внесеного може лежати лише там: журнал дочитує SQLite, на
    тимчасовій копії."""
    journals = [s for s in BACKUP_JOURNALS
                if os.path.isfile(path + s) and os.path.getsize(path + s)]
    if not journals:
        con = sqlite3.connect(_backup_uri(path), uri=True)
        con.row_factory = sqlite3.Row
        try:
            if not is_accounting(con):
                raise ValueError(NOT_A_COPY)
            have = current_version(con)
            if have >= APP_SCHEMA_VERSION:
                yield con, have
                return
        finally:
            con.close()
    tmp = os.path.join(tempfile.gettempdir(), f"oblik-copy-{os.getpid()}-{os.urandom(3).hex()}.sqlite")
    try:
        for s in ("", *journals):
            shutil.copy2(path + s, tmp + s)
        con = sqlite3.connect(tmp, isolation_level=None)
        con.row_factory = sqlite3.Row
        try:
            if not is_accounting(con):
                raise ValueError(NOT_A_COPY)
            have = current_version(con)
            if have < APP_SCHEMA_VERSION:
                apply_migrations(con)
            yield con, have
        finally:
            con.close()
    finally:
        for s in ("", "-shm", *BACKUP_JOURNALS):
            if os.path.exists(tmp + s):
                os.remove(tmp + s)


def _backup_read(path):
    """Внесене з копії бази — без того, щоб її відкривати як робочу (див.
    _backup_open). Повертає (стан, схема)."""
    with _backup_open(path) as (con, have):
        return state_db.load_state(con), have


def _backup_state(path):
    """Стан із копії бази (див. _backup_read)."""
    return _backup_read(path)[0]


# Підсумки копій за (ім'я, час, розмір): діалог відкривають часто, а копій
# буває десятки — старіші читаються через міграцію тимчасової копії.
_BACKUP_SUMMARIES = {}


def list_backups():
    """Копії від найновішої: ім'я, час, розмір і короткий вміст — щоб людина
    вибрала потрібну, не відкриваючи файли."""
    backups = os.path.join(DATA, "копії")
    if not os.path.isdir(backups):
        return []
    out = []
    for f in os.listdir(backups):
        if not (f.startswith(BACKUP_NAME) and f.endswith(BACKUP_EXT)):
            continue
        full = os.path.join(backups, f)
        st = os.stat(full)
        item = {"name": f, "mtime": st.st_mtime, "size": st.st_size,
                "time": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))}
        key = (full, st.st_mtime_ns, st.st_size)      # повний шлях: однойменні копії різних тек
        if key not in _BACKUP_SUMMARIES:
            try:
                data, schema = _backup_read(full)
                _BACKUP_SUMMARIES[key] = dict(_backup_summary(data), ok=True, schema=schema,
                                              old_schema=schema < APP_SCHEMA_VERSION)
            except (ValueError, SchemaTooNewError, SchemaTooOldError) as e:
                # Файл цілий, але не годиться — і людині кажуть чому.
                _BACKUP_SUMMARIES[key] = {"ok": False, "why": str(e)}
            except (OSError, sqlite3.Error):
                _BACKUP_SUMMARIES[key] = {"ok": False}
        item.update(_BACKUP_SUMMARIES[key])
        out.append(item)
    out.sort(key=lambda x: x["mtime"], reverse=True)
    return out


def restore_backup(name: str) -> dict:
    """Повернути облік із копії — усю базу: документи й знищене, а також
    довідники, людей і призначення, норми, підрозділи й позиції. Раніше
    поверталося лише внесене, а довідники й норми лишалися поточними — тож
    «відновити з файла» при передачі обліку давало суміш двох баз.
    Поточний стан перед цим сам іде в копії — відновлення теж можна відкотити."""
    backups = os.path.realpath(os.path.join(DATA, "копії"))
    full = os.path.realpath(os.path.join(backups, os.path.basename(name or "")))
    if not full.startswith(backups + os.sep) or not os.path.isfile(full):
        raise ValueError("такої копії немає")
    # Копія лише читається: її схему доганяли міграціями просто в ній, і файл у
    # «копіях» після відновлення був уже не тим, що зняли (а обрив посеред
    # міграції лишав би копію половинчастою).
    with _backup_open(full) as (src, _):
        # Копія зі старішої версії програми вже доведена міграціями, з новішої —
        # не відновлюється (SchemaTooNewError іде нагору з поясненням).
        checked_version(src)
        data = state_db.load_state(src)
        with STATE_LOCK:
            broken = False
            try:
                backup_state(force=True)
                dst = db()
            except (StateBroken, sqlite3.DatabaseError) as e:
                if not _unreadable(e):
                    raise
                broken = True
            if broken:
                # Робоча база пошкоджена: SQLite не зніме з неї копію й не
                # відкриє. Файл відкладається в «копії» як є — і на його місце
                # лягає обрана копія. Саме для цього копії й робляться.
                # Поза except: виняток тримає кадри з відкритим з'єднанням, а
                # відкритий файл у Windows не переїде.
                set_aside_broken_db()
                dst = sqlite3.connect(db_path(), isolation_level=None)
            try:
                src.backup(dst)
            finally:
                if dst is not _DB_CON["con"]:
                    dst.close()
            bump_state_version()
            _DATA_JS.update(version=None, body=None)
    return _backup_summary(data)


def _unreadable(e) -> bool:
    """Чи збій — пошкоджений файл бази (SQLITE_CORRUPT, SQLITE_NOTADB), а не
    зайнятий файл чи повний диск: ті дають OperationalError, і базу тоді не
    підмінюють."""
    cause = e.__cause__ if isinstance(e, StateBroken) else e
    return type(cause) is sqlite3.DatabaseError


def set_aside_broken_db() -> str:
    """Пошкоджену робочу базу — у «копії» як є, з журналом -wal і -shm, якщо вони
    є: на її місце ляже копія, а спроба врятувати з неї дані лишиться можливою.
    Журнал переїжджає разом із нею — залишений поруч із новою базою, він
    зіпсував би і її."""
    con = _DB_CON["con"]
    if con is not None:
        try:
            con.close()
        except sqlite3.Error:
            pass
        _DB_CON.update(path=None, con=None)
    gc.collect()                 # з'єднання, що лишилось у кадрах винятку, закривається тут
    path = db_path()
    backups = os.path.join(DATA, "копії")
    os.makedirs(backups, exist_ok=True)
    stamp = time.strftime("%Y-%m-%d %H%M%S")
    target = os.path.join(backups, f"{BACKUP_NAME}{stamp} пошкоджено{BACKUP_EXT}")
    n = 2
    while os.path.exists(target):
        target = os.path.join(backups, f"{BACKUP_NAME}{stamp} пошкоджено-{n}{BACKUP_EXT}")
        n += 1
    for suffix in ("", "-wal", "-shm"):
        if os.path.exists(path + suffix):
            shutil.move(path + suffix, target + suffix)
    return target


# Номер ревізії стану. Часу зміни файла для цього мало: після швидкої
# атомарної заміни він іноді повторюється, і застаріле вікно виглядає свіжим —
# у перевірці зі ста пар записів двічі проходив запис, який мав бути відхилений.
# Тому версія — власний лічильник із випадковим хвостом; час файла лишається
# в ній другою половиною, щоб підміна файла ззовні теж змінювала версію.
_REV = {"value": None}


def _rev_path() -> str:
    return os.path.join(DATA, ".ревізія стану")


def _load_rev() -> str:
    try:
        with open(_rev_path(), encoding="utf-8") as f:
            v = f.read().strip()
        if v:
            return v
    except OSError:
        pass
    return "0-" + os.urandom(4).hex()


def current_rev() -> str:
    """Ревізія стану без часу файла: змінюється лише записом програми."""
    if _REV["value"] is None:
        _REV["value"] = _load_rev()
    return _REV["value"]


def bump_state_version() -> str:
    """Наступна ревізія — після кожного запису стану."""
    cur = _REV["value"] or _load_rev()
    try:
        n = int(cur.split("-", 1)[0]) + 1
    except ValueError:
        n = 1
    _REV["value"] = f"{n}-{os.urandom(4).hex()}"
    _STAMP.update(real=None, shown=None)
    try:
        with open(_rev_path(), "w", encoding="utf-8") as f:
            f.write(_REV["value"])
    except OSError:
        pass                                 # немає прав на запис — ревізія житиме в пам'яті
    return _REV["value"]


# Час файла, який дав запис самих налаштувань вікна, і час, який версія показує замість
# нього: такий запис версії стану не міняє.
_STAMP = {"real": None, "shown": None}


def _file_stamp() -> str:
    try:
        return str(os.stat(db_path()).st_mtime_ns)
    except OSError:
        return "0"


def state_version() -> str:
    """Версія стану: ревізія програми плюс час файла. Вікно, що відкрилося
    раніше за чужий запис, не має права записати свій, застарілий стан."""
    if _REV["value"] is None:
        _REV["value"] = _load_rev()
    stamp = _file_stamp()
    if stamp == _STAMP["real"]:
        stamp = _STAMP["shown"]
    return f"{_REV['value']}.{stamp}"


def save_ui(ui, ui_key="ui"):
    """Лише налаштування вікна (оформлення, чернетки). Версія стану лишається тією ж:
    інші вікна не оновлюються через чужу чернетку, а чужий запис не робить це вікно
    «застарілим». Зміну файла кимось іншим версія, як і раніше, бачить."""
    shown = state_version().rsplit(".", 1)[1]
    state_db.save_ui(db(), ui, ui_key)
    _STAMP.update(real=_file_stamp(), shown=shown)


class BackupError(OSError):
    """Копію бази перед незворотним записом зробити не вдалося — такий запис не йде."""


def save_state(obj, force_backup=False, replace_papers=False, ui_key="ui"):
    """Запис іде однією транзакцією: обрив не лишає половини документа.
    Перед незворотними діями (скидання, відновлення з копії, видалення) копія
    робиться завжди, а не раз на 10 хвилин, — і без неї такий запис не йде:
    вікно повторює спробу, поки копія не ляже, а видалене доти лишається.
    replace_papers — відновлення з файла: документи служби лягають як у копії,
    разом із затвердженими версіями (і лише з копією бази перед цим)."""
    try:
        backup_state(force=force_backup)
    except (OSError, sqlite3.Error) as e:
        if force_backup:
            raise BackupError(f"копію бази перед записом не вдалося зробити: {e}") from e
        # Звичайний запис копія не спиняє: за десять хвилин буде нова спроба.
    units = state_db.save_state(db(), obj, replace_papers=replace_papers and force_backup, ui_key=ui_key)
    bump_state_version()
    return units or {}


_DATA_JS = {"version": None, "body": None}


def app_data() -> bytes:
    """Дані для застосунку — з бази, у якій він і працює.

    Раніше це був файл, зібраний під час випуску: довідники в ньому застигали, і
    все, що людина правила, жило окремо «поверх бази». Тепер джерело одне, тож і
    витяг будується з живої бази — а перебудовується лише після запису.
    """
    version = state_version()
    if _DATA_JS["version"] == version and _DATA_JS["body"] is not None:
        return _DATA_JS["body"]
    try:
        body = export_app_data.as_js(export_app_data.payload(db())).encode("utf-8")
    except sqlite3.Error as e:
        raise StateBroken(f"не вдалося прочитати базу: {e}") from e
    _DATA_JS.update(version=version, body=body)
    return body


ACT_WITHOUT_WAS = "У запиті немає даних акта з вікна. Оновіть сторінку."


def _names_act(req):
    """Запит називає наявний акт: `docId` не нуль і не порожнє. Те, що не число, — теж (op_acts відмовить словами)."""
    try:
        return bool(int(req.get("docId") or 0))
    except (TypeError, ValueError, OverflowError):
        return True


def _sukhpai_refusal(file, problems):
    """Слова читача аркуша «Сухпай» (dobovka) одним реченням разом із тим, звідки аркуш: «Файл «…» не є книгою Excel
    (.xlsx).», «Файл «…»: немає аркуша «Сухпай».», «Файл «…», аркуш «Сухпай» впізнано, але …», «Вставлений аркуш «Сухпай»
    впізнано, але …». Слово, з якого починаються і «де», і слова читача, не повторюється; далі — з малої літери."""
    text = " ".join(p if p.endswith(".") else p + "." for p in problems)
    low = text[:1].lower() + text[1:]
    if file:
        head = f"Файл «{file}»"
        if text.startswith("Файл "):
            return f"{head} {text[len('Файл '):]}"
        return f"{head}, {low}" if text.startswith("Аркуш ") else f"{head}: {low}"
    if text.startswith("Аркуш «Сухпай» "):
        return f"Вставлений аркуш «Сухпай» {text[len('Аркуш «Сухпай» '):]}"
    return f"Вставлений аркуш: {low}"


def dobovka_people(day):
    """Особи на харчуванні з Добовки на день `day`: «разом» пунктів харчування того дня чи найближчого
    раніше заповненого (аркуш «Пункти харчування», найновіша «Добовка*.xlsx» теки «Добовка»).
    -> (осіб або None, джерело). Джерело: None — Добовки немає (теку не задано чи в ній немає файла);
    {"file", "day"} — файл прочитано (day None — до цього дня в ньому нічого не внесено);
    {"file", "error"} — файл не прочитано, error — причина словами для людини (подробиці — у консоль)."""
    import dobovka                                           # noqa: PLC0415
    path = dobovka.newest(folders().get("dobovka", ""))
    if not path:
        return None, None
    name = os.path.basename(path)
    try:
        with open(path, "rb") as f:
            got = dobovka.read_file(f.read())
    except OSError as e:                                     # тримає інша програма, немає доступу: слова — людині, причина — у консоль
        print(f"Добовка: {path} не прочитано — {e}")
        return None, {"file": name, "error": f"файл «{name}» тримає інша програма чи немає доступу"}
    except Exception:                                        # noqa: BLE001 — зіпсований файл: слова — людині, подробиці — у консоль
        traceback.print_exc()
        return None, {"file": name, "error": f"файл «{name}» не вдалося прочитати"}
    points = got["points"]
    if not points and got["kind"] != "book" and got["problems"]:
        print(f"Добовка: {path} не прочитано — {got['problems'][0]}")
        why = got["problems"][0].rstrip(". ")
        return None, {"file": name, "error": why[:1].lower() + why[1:]}
    days = sorted({d for per in points.values() for d in per if d <= day})
    if not days:
        return None, {"file": name, "day": None}
    total = sum(per.get(days[-1]) or 0 for per in points.values())
    return (round(total) or None), {"file": name, "day": days[-1]}


def broken_app_data(why: str) -> bytes:
    """data.js, коли база не читається: дані порожньої бази (лише схема) і причина в meta.broken. Модулі
    сторінки вантажаться як завжди, а замість програми — екран з копіями (dataBroken), без помилок у консолі."""
    from db.connect import close_db, open_db                 # noqa: PLC0415
    con = open_db(":memory:")
    try:
        data = export_app_data.payload(con)
    finally:
        close_db(con)
    data.setdefault("meta", {})["broken"] = why
    return export_app_data.as_js(data).encode("utf-8")


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *a):
        pass

    def _send(self, code, body=b"", ctype="text/plain; charset=utf-8", headers=None):
        self.send_response(code)
        for k, v in (headers or {}).items():
            self.send_header(k, v)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if body:
            self.wfile.write(body)

    # ------------------------------------------------------------- хто питає
    remote = False
    who = ""

    def do_GET(self):
        if self._admit("GET"):
            self._get()

    def do_POST(self):
        if self._admit("POST"):
            self._post()

    def do_PUT(self):
        if self._admit("PUT"):
            self._put()

    def _drain(self):
        """Тіло запиту, на який відповідаємо відмовою, теж вичитується: інакше воно
        лишилося б у з'єднанні й зіпсувало наступний запит."""
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            n = 0
        while n > 0:                                  # частинами: завелике тіло не лягає в пам'ять цілим
            block = self.rfile.read(min(n, 1 << 16))
            if not block:
                break
            n -= len(block)

    def _admit(self, method):
        """Хто зробив запит. Вікно на самому основному ПК — без перепустки; з іншого ПК —
        лише з перепусткою, виданою після входу з кодом доступу."""
        route = self.path.split("?", 1)[0]
        ip = self.client_address[0]
        if ip in network.LOCAL:
            self.remote, self.who = False, host_name()
            return True
        self.remote = True
        cfg = net_cfg()
        if not cfg.get("on") or not cfg.get("code"):
            self._drain()
            self._send(403, "Робота в мережі на основному ПК вимкнена.".encode("utf-8"))
            return False
        if method == "POST" and route == "/api/login":
            self._login(cfg, ip)
            return False
        name = network.read(cfg, network.cookie_of(self.headers.get("Cookie")))
        if name:
            self.who = name
            if method == "POST" and route == "/api/logout":
                self._drain()
                self._send(200, b"{}", MIME[".json"], {"Set-Cookie": network.drop_cookie()})
                return False
            return True
        self._drain()
        if method == "GET" and route in ("/", "/index.html"):
            self._send(200, network.LOGIN_PAGE.encode("utf-8"), MIME[".html"])
        else:
            self._send(401, "Потрібно ввійти: відкрийте головну сторінку програми.".encode("utf-8"))
        return False

    def _login(self, cfg, ip):
        """Вхід з іншого ПК: ім'я для журналу змін і код доступу. Після кількох невдалих
        спроб з тієї самої адреси — пауза."""
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except ValueError:
            req = {}
        wait = GATE.wait(ip)
        if wait:
            return self._send(429, f"Забагато невдалих спроб. Спробуйте за {wait} с.".encode("utf-8"))
        name = network.clean_name(req.get("name") if isinstance(req, dict) else "")
        if not name:
            return self._send(400, "Впишіть своє ім'я.".encode("utf-8"))
        if not network.check_code(cfg, req.get("code")):
            GATE.fail(ip)
            return self._send(401, "Код доступу не той.".encode("utf-8"))
        GATE.ok(ip)
        body = json.dumps({"ok": True, "name": name}, ensure_ascii=False).encode("utf-8")
        return self._send(200, body, MIME[".json"], {"Set-Cookie": network.set_cookie(network.issue(cfg, name))})

    def _me(self):
        """Хто працює в цьому вікні; основному ПК — ще й налаштування мережі."""
        out = {"name": self.who, "remote": self.remote}
        if not self.remote:
            cfg = net_cfg()
            port = int(cfg.get("port") or network.DEFAULT_PORT)
            out["net"] = {"on": bool(cfg.get("on")), "port": port, "host_name": cfg.get("host_name") or "",
                          "has_code": bool(cfg.get("code")), "addresses": network.addresses(port),
                          "listening": bool(cfg.get("on") and cfg.get("code")) and NET_LISTENING["on"]}
        return self._send(200, json.dumps(out, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _set_network(self):
        """Налаштування мережі з екрана «Налаштування» основного ПК. Діють після перезапуску програми."""
        n = int(self.headers.get("Content-Length", 0) or 0)
        req = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        cfg = dict(net_cfg())
        try:
            port = int(req.get("port") or cfg.get("port") or network.DEFAULT_PORT)
        except (TypeError, ValueError):
            port = 0
        if not 1024 <= port <= 65535:
            return self._send(400, "Порт — число від 1024 до 65535.".encode("utf-8"))
        cfg["port"] = port
        cfg["on"] = bool(req.get("on"))
        if "host_name" in req:
            cfg["host_name"] = network.clean_name(req.get("host_name"))
        code = str(req.get("code") or "")
        if code:
            if len(code) < 4:
                return self._send(400, "Код доступу — щонайменше 4 знаки.".encode("utf-8"))
            network.set_code(cfg, code)
        if cfg["on"] and not cfg.get("code"):
            return self._send(400, "Задайте код доступу: без нього з іншого ПК програму не відкрити.".encode("utf-8"))
        network.save(DATA, cfg)
        _NET["cfg"] = None
        body = {"ok": True, "addresses": network.addresses(port), "restart": True}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _send_export(self, rel):
        """Вивантаження для браузера іншого ПК: файл із теки «вивантаження» на основному ПК."""
        if _rooted(rel):
            return self._send(404, b"not found")
        base = os.path.realpath(os.path.join(DATA, "вивантаження"))
        full = os.path.realpath(os.path.join(base, rel))
        if not _inside(base, full) or not os.path.isfile(full):
            return self._send(404, b"not found")
        with open(full, "rb") as f:
            body = f.read()
        name = os.path.basename(full)
        ext = os.path.splitext(name)[1].lower()
        return self._send(200, body, MIME.get(ext, "application/octet-stream"),
                          {"Content-Disposition": f"attachment; filename*=UTF-8''{quote(name)}"})

    def _get(self):
        # Шлях приходить закодованим (%D1%81%D0%BA…), бо в іменах сканів кирилиця.
        path = unquote(self.path.split("?", 1)[0].lstrip("/"))
        if path in ("", "index.html"):
            return self._send(200, ASSET_CACHE["index.html"], MIME[".html"])
        if path == "api/ping":
            return self._send(200, APP_NAME.encode("utf-8"))
        if path == "api/me":
            return self._me()
        if path == "api/version":
            # Вікна питають раз на кілька секунд, чи не записав хтось інший: тоді вони
            # підтягують свіжі дані. Хто й коли — для підпису «оновлено».
            with STATE_LOCK:
                body = json.dumps({"version": state_version(), **LAST_WRITE}, ensure_ascii=False).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        if path == "api/file":
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            return self._send_export((query.get("p") or [""])[0])
        if path == "api/sp/supply":
            # Забезпеченість сухпаєм на дату: добо-дачі по місцях проти «днів × осіб» (екран «Забезпеченість»).
            import zabezpechenist                                # noqa: PLC0415
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            day = (query.get("day") or [time.strftime("%Y-%m-%d")])[0][:10]
            try:
                datetime.date.fromisoformat(day)
                people = int((query.get("people") or ["0"])[0] or 0) or None
                days = int((query.get("days") or [str(zabezpechenist.DAYS)])[0] or zabezpechenist.DAYS)
            except ValueError:
                return self._send(400, "дата — РРРР-ММ-ДД, осіб і діб — цілі числа".encode("utf-8"))
            source = None
            if people is None:
                people, source = dobovka_people(day)
            with STATE_LOCK:
                rep_ = zabezpechenist.compute(db(), day, people, days)
            rep_["peopleFrom"] = source
            return self._send(200, json.dumps(rep_, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        if path == "api/form2":
            # Звіт 2/прод за рік — з бази книг ТЗ і ОП (екран «2/Прод»).
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            try:
                year = int((query.get("year") or [""])[0])
            except ValueError:
                return self._send(400, "рік звіту — число".encode("utf-8"))
            with STATE_LOCK:
                rep = form2.collect(db(), year, (query.get("asOf") or [""])[0] or None)
            return self._send(200, json.dumps(rep, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        if path == "api/form11":
            # Звіт 11/прод за квартал — з книги СП (екран «11/прод»).
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            try:
                year, q = int((query.get("year") or [""])[0]), int((query.get("q") or [""])[0])
            except ValueError:
                return self._send(400, "рік і квартал звіту — числа".encode("utf-8"))
            if q not in (1, 2, 3, 4):
                return self._send(400, "квартал — від 1 до 4".encode("utf-8"))
            with STATE_LOCK:
                rep = form11.collect(db(), year, q)
            return self._send(200, json.dumps(rep, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        if path == "api/folders":
            return self._send(200, json.dumps(folders_listing(), ensure_ascii=False).encode("utf-8"), MIME[".json"])
        if path == "api/backups":
            body = json.dumps(list_backups(), ensure_ascii=False).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        if path == "api/verify":
            # Звірка бази за правилами обліку — та сама, що й build/verify_db.py,
            # але для людини без Python: кнопка в «Налаштуваннях».
            try:
                with STATE_LOCK:
                    checks = verify_db.check_all(db())
            except (sqlite3.Error, StateBroken, ValueError, TypeError) as e:
                return self._send(500, str(e).encode("utf-8"))
            body = json.dumps([{"name": c.name, "ok": bool(c.ok), "detail": c.detail or "",
                                "advisory": bool(getattr(c, "advisory", False))}
                               for c in checks], ensure_ascii=False).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        # Читання — під тим самим замком, що й запис: з'єднання з базою одне
        # на всі потоки, і читання посеред запису бачило б його незафіксовані
        # рядки (після відхиленого запису — документ, якого в базі немає).
        if path == "api/state":
            try:
                with STATE_LOCK:
                    body = json.dumps(load_state(self._ui_key()), ensure_ascii=False).encode("utf-8")
                    version = state_version()
            except StateBroken as e:
                return self._send(500, str(e).encode("utf-8"))
            return self._send(200, body, MIME[".json"], {"X-State-Version": version})
        if path == "data.js":
            try:
                with STATE_LOCK:
                    body = app_data()
            except StateBroken as e:
                body = broken_app_data(str(e))     # сторінка покаже «База обліку не читається» з копіями
            return self._send(200, body, MIME[".js"])
        if path in ASSET_CACHE:
            ext = os.path.splitext(path)[1]
            return self._send(200, ASSET_CACHE[path], MIME.get(ext, "application/octet-stream"))
        if path.startswith("теки/"):
            # Файл із теки служби (закупівлі, прибутково-видаткові, реєстри на ФЕС): лише в її межах і лише того типу, що
            # підшивається (SCAN_EXT; папери програми — .xlsx, .xls, .docx — серед них). У теці може лежати що завгодно —
            # програма, покинутий .part: їх сторінка не показує й не віддає.
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            key, _, rel = path[len("теки/"):].partition("/")
            full = folder_path(key, rel)
            if not full:
                return self._send(404, b"not found")
            if os.path.splitext(full)[1].lower() not in SCAN_EXT:
                return self._send(415, BAD_OPEN.encode("utf-8"))
            return self._send_scan(rel, (query.get("w") or [""])[0], full=full)
        if path == "api/folder-list":
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            return self._folder_list((query.get("key") or [""])[0], (query.get("path") or [""])[0])
        if path.startswith(SCANS):
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            return self._send_scan(path[len(SCANS):], (query.get("w") or [""])[0])
        self._send(404, b"not found")

    def _send_scan(self, rel, w="", full=None):
        """Скан первинного документа з теки даних; `w` — мініатюра фото.

        Шлях складається лише з того, що записано в базі, але приходить він від
        сторінки, тому перевіряється ще раз: за межі теки сканів вийти не можна.
        `full` — файл, уже знайдений у теці служби (`folder_path`), тоді `rel` не потрібен.
        """
        full = full or scan_path(rel)
        if not full:
            return self._send(404, b"not found")
        ext = os.path.splitext(full)[1].lower()
        if w and ext in THUMB_EXT and os.path.getsize(full) > THUMB_MIN_BYTES:
            try:
                width = max(64, min(1024, int(w)))
            except ValueError:
                width = 0
            data = thumbnail(full, width) if width else None
            if data:
                return self._send(200, data, MIME[".jpg"], {"X-Content-Type-Options": "nosniff"})
        with open(full, "rb") as f:
            body = f.read()
        if ext in INLINE_EXT:
            return self._send(200, body, MIME[ext], {"X-Content-Type-Options": "nosniff"})
        name = os.path.basename(full)
        self._send(200, body, "application/octet-stream",
                   {"X-Content-Type-Options": "nosniff",
                    "Content-Disposition": "attachment; filename*=UTF-8''" + quote(name)})

    def _folder_list(self, key, rel):
        """Що лежить у підтеці теки з налаштувань: для прив'язки файлів, покладених руками. Файли «~$…», які Word і Excel
        кладуть поруч із відкритим документом (хто його тримає), — не документи: їх у переліку немає."""
        root = folders().get(key)
        if not root:
            return self._send(404, "немає такої теки".encode("utf-8"))
        if _rooted(rel):
            return self._send(404, b"not found")
        base = os.path.realpath(root)
        here = os.path.realpath(os.path.join(base, rel or ""))
        if here != base and not _inside(base, here):
            return self._send(404, b"not found")
        dirs, files = [], []
        if os.path.isdir(here):
            try:
                names = sorted(os.listdir(here), key=str.lower)
            except OSError:
                return self._send(403, "немає доступу до теки".encode("utf-8"))
            for name in names:
                full = os.path.join(here, name)
                if os.path.isdir(full):
                    dirs.append(name)
                elif os.path.splitext(name)[1].lower() in SCAN_EXT and not name.startswith(OFFICE_OWNER):
                    try:
                        st = os.stat(full)
                    except OSError:
                        continue                   # зник, поки йшов перелік: Провідник, синхронізація диска
                    files.append({"name": name, "size": st.st_size,
                                  "mtime": time.strftime("%Y-%m-%d %H:%M", time.localtime(st.st_mtime))})
        body = json.dumps({"ok": True, "dirs": dirs, "files": files}, ensure_ascii=False).encode("utf-8")
        return self._send(200, body, MIME[".json"])

    def _scan_file(self, spec):
        """Файл із теки сканів за шляхом із запиту (`spec` — розібраний об'єкт), — або None, якщо шлях
        виводить за межі теки чи файла немає. З ключем теки служби (`folder`) — файл у ній. Друге
        значення — ключ теки служби (порожній — «Дані обліку/скани»): відмова називає ту теку, де шукали."""
        key = str(spec.get("folder") or "")
        return (folder_path(key, spec.get("path")) if key else scan_path(spec.get("path"))), key

    def _restore_backup(self):
        n = int(self.headers.get("Content-Length", 0))
        spec = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        try:
            summary = restore_backup(spec.get("name", ""))
        except ValueError as e:
            # Немає такої копії — 404; файл є, але обліку в ньому немає — 400.
            return self._send(400 if str(e) == NOT_A_COPY else 404, str(e).encode("utf-8"))
        body = json.dumps({"ok": True, "version": state_version(), **summary},
                          ensure_ascii=False).encode("utf-8")
        self._send(200, body, MIME[".json"])

    def _copy_away(self):
        """Копія бази туди, куди покаже людина (флешка, інший диск). Сторінка
        передає лише теку, з якої відкрити вікно, — шлях обирається у вікні."""
        n = int(self.headers.get("Content-Length", 0))
        spec = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        start = str(spec.get("dir") or "")
        if not os.path.isdir(start):
            start = ""
        suggested = f"{BACKUP_NAME}{time.strftime('%Y-%m-%d %H%M')}{BACKUP_EXT}"
        target = ask_save_path(suggested, start)
        if not target:
            body = json.dumps({"ok": False, "cancelled": True}).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        try:
            path = copy_database_to(target)
        except (OSError, sqlite3.Error, StateBroken) as e:
            body = json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False).encode("utf-8")
            return self._send(500, body, MIME[".json"])
        body = json.dumps({"ok": True, "path": path, "dir": os.path.dirname(path)},
                          ensure_ascii=False).encode("utf-8")
        return self._send(200, body, MIME[".json"])

    def _restore_file(self):
        """Відновлення з копії бази, яку людина принесла файлом (флешка, інший
        комп'ютер). Файл лягає в «копії» як звичайна копія й відновлюється тим
        самим шляхом, що й автоматична: поточний стан перед цим теж іде в копії,
        а копія зі старішої версії програми доганяється міграціями."""
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_RESTORE:
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        body = self.rfile.read(n)
        if body[:16] != b"SQLite format 3\x00":
            return self._send(400, "це не копія бази обліку: не файл SQLite".encode("utf-8"))
        backups = os.path.join(DATA, "копії")
        os.makedirs(backups, exist_ok=True)
        stamp = time.strftime("%Y-%m-%d %H%M%S")
        full = os.path.join(backups, f"{BACKUP_NAME}{stamp} з файла{BACKUP_EXT}")
        k = 2
        while os.path.exists(full):
            full = os.path.join(backups, f"{BACKUP_NAME}{stamp} з файла-{k}{BACKUP_EXT}")
            k += 1
        with open(full, "wb") as f:
            f.write(body)
        try:
            # Принесений файл лежить у «копіях» таким, яким його принесли: схему
            # доганяє відновлення, на тимчасовій копії.
            con = sqlite3.connect(_backup_uri(full), uri=True)
            try:
                if not is_accounting(con):
                    raise ValueError("у файлі немає обліку")
            finally:
                con.close()
            summary = restore_backup(os.path.basename(full))
        except (SchemaTooNewError, SchemaTooOldError) as e:
            os.remove(full)
            return self._send(400, f"{e}".encode("utf-8"))
        except (sqlite3.Error, ValueError, KeyError, TypeError) as e:
            os.remove(full)
            return self._send(400, f"це не копія бази обліку: {e}".encode("utf-8"))
        body = json.dumps({"ok": True, "version": state_version(), **summary},
                          ensure_ascii=False).encode("utf-8")
        return self._send(200, body, MIME[".json"])

    def _read_mtz(self):
        """Відомість МТЗ частини — файл Excel, який людина обрала у вікні: її
        рядки йдуть сторінці, і та звіряє з ними надходження служби. Файл лише
        читається й ніде не зберігається."""
        import mtz_export                                        # noqa: PLC0415
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_RESTORE:
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        got = mtz_export.read_mtz(self.rfile.read(n))
        body = json.dumps({"ok": True, **got}, ensure_ascii=False).encode("utf-8")
        return self._send(200, body, MIME[".json"])

    def _read_history(self):
        """Заповнений шаблон імпорту історії — файл Excel, який людина обрала у вікні:
        рядки його аркушів ідуть сторінці, і та перевіряє їх правилами обліку. Файл лише
        читається; у базу нічого не лягає, доки людина не погодиться внести."""
        import history_import                                    # noqa: PLC0415
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_RESTORE:
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        got = history_import.read_history(self.rfile.read(n))
        body = json.dumps({"ok": True, **got}, ensure_ascii=False).encode("utf-8")
        return self._send(200, body, MIME[".json"])

    def _set_folders(self):
        """Теки з «Налаштувань» ({ключ: повний шлях або ""}): «» — типова тека."""
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except ValueError:
            req = None
        if not isinstance(req, dict):
            return self._send(400, "теки — це перелік «ключ → шлях»".encode("utf-8"))
        known = {k for k, _, _ in FOLDERS}
        clean = {}
        for key, value in req.items():
            if key not in known:
                return self._send(400, f"невідома тека «{key}»".encode("utf-8"))
            value = str(value or "").strip()
            if value and not os.path.isabs(value):
                return self._send(400, f"«{value}» — не повний шлях до теки".encode("utf-8"))
            clean[key] = value
        with STATE_LOCK:
            mine = dict(_folders_set(), **clean)
            db().execute("INSERT INTO app_setting(key, value) VALUES('folders', ?) "
                         "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                         (json.dumps({k: v for k, v in mine.items() if v}, ensure_ascii=False),))
            bump_state_version()
        return self._send(200, json.dumps(folders_listing(), ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _form2_upload(self, submitted):
        """Файл служби для 2/прод: зданий звіт (графи 5–18 по рядках — у базу) або таблиця
        відповідності кодів (лише читається: прийняти її вирішує людина на сторінці)."""
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > MAX_RESTORE:
            self._drain()
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        data = self.rfile.read(n)
        try:
            if not submitted:
                query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
                got = form2.read_map(data, (query.get("date") or [time.strftime("%Y-%m-%d")])[0])
                return self._send(200, json.dumps(got, ensure_ascii=False).encode("utf-8"), MIME[".json"])
            with STATE_LOCK:
                got = form2.read_submitted(db(), data)
                if got["mismatch"]:
                    body = {"error": "назви рядків у файлі не збігаються з бланком", "problems": got["mismatch"][:50]}
                    return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
                rows = form2.store_submitted(db(), got["year"], got["values"])
                bump_state_version()
                LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
        except Exception as e:                                       # noqa: BLE001 — будь-який зіпсований файл
            body = {"error": "файл не прочитано", "problems": [str(e)]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        body = {"ok": True, "year": got["year"], "rows": rows, "unknown": got["unknown"]}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _opysy(self, route):
        """«Звіти › Описи 572» — `/api/opysy/state|run|open` (`opysy_api`): чернетки описів запасів з книг обліку.
        «Стоп» рушія — {ok: false, stop, log}; конфіг чи книга, що не читається, — {ok: false, why}. Шлях до конфігу
        вписують і теку відкривають лише на основному ПК (з іншого — 403): шлях до файлів основного ПК обирає лише його
        вікно; запам'ятований конфіг працює й звідти, а файл описів з іншого ПК віддається завантаженням (`download`)."""
        import dobovka                                           # noqa: PLC0415
        import opysy_api                                         # noqa: PLC0415
        req = self._json_body()
        if req is None:
            return None
        name = route.rsplit("/", 1)[-1]
        if self.remote and (name == "open" or str(req.get("config") or "").strip()):
            return self._send(403, opysy_api.HOST_ONLY.encode("utf-8"))
        try:
            if name == "state":
                with STATE_LOCK:
                    out = opysy_api.state(db(), req)
            elif name == "run":
                out = opysy_api.run(db, STATE_LOCK, req, dobovka.newest(folders().get("dobovka", "")) or None)
                if self.remote and out.get("out"):                   # з іншого ПК файл описів віддається завантаженням
                    try:
                        out["download"] = remote_any(out["out"])["download"]
                    except OSError as e:                             # файл записано, а копії для завантаження не вийшло
                        out["why"] = f"Описи складено, а для завантаження не підготовлено: {e}"
            elif name == "open":
                with STATE_LOCK:
                    where = opysy_api.folder(db(), req)
                out = {"opened": open_file(where), "folder": where}
            else:
                return self._send(404, b"not found")
        except ValueError as e:
            return self._send(400, str(e).encode("utf-8"))
        except Exception as e:                                   # noqa: BLE001 — зіпсований файл книги чи описів
            out = {"why": "%s: %s" % (type(e).__name__, e)}
        out["ok"] = "stop" not in out and "why" not in out or name == "state"
        return self._send(200, json.dumps(out, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _op_fes(self):
        """Звірка книги ОП чи СП (`book`) зі звітом ФЕС «Залишки ТМЦ»: результат — на сторінку й книгою в теку
        звірок."""
        import fes_read                                          # noqa: PLC0415
        import op_fes                                            # noqa: PLC0415
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > MAX_RESTORE:
            self._drain()
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        data = self.rfile.read(n)
        query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
        book = (query.get("book") or ["ОП"])[0]
        if book not in op_fes.FES_BOOKS:
            return self._send(400, "Звірка з ФЕС — для книг ОП і СП".encode("utf-8"))
        try:
            report = fes_read.read_report(data)
        except ValueError as e:
            body = {"error": "звіт ФЕС не прочитано", "problems": [str(e)]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        with STATE_LOCK:
            con = db()
            row = con.execute("SELECT value FROM app_setting WHERE key = 'fesPlaces'").fetchone()
            try:
                places = json.loads(row[0]) if row else {}
            except ValueError:
                places = {}
            got = op_fes.compare(con, report, (query.get("asOf") or [""])[0] or None,
                                 places if isinstance(places, dict) else {}, book)
        got["path"] = op_fes.write_result(got, folders()["fes"])
        got["ok"] = True
        got["places"] = [p["name"] for p in report["places"]]
        if self.remote:
            got.update(remote_any(got["path"]))
        return self._send(200, json.dumps(got, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _op_export(self):
        """Книга «Облік ОП» — у теку з налаштувань. Книгу, яку програма сама записала чи прийняла
        (її відбиток байтів або вмісту запам'ятано: op_book.own_book — вміст пізнає її й після
        «Зберегти» в Excel), перезаписує без звірки, хоч би облік у програмі за цей час змінився.
        Іншу — лише коли в ній немає внесеного руками, чого немає в базі: нових і змінених
        документів, нових позицій, нових актів, нових пунктів харчування, днів, яких у базі немає
        такими (інакше 409: спершу «Прийняти книгу…»). Наявні акти й пункти, змінені в книзі,
        бере «Прийняти книгу…»."""
        import op_book                                           # noqa: PLC0415
        path = os.path.join(folders()["opBook"], "Облік ОП.xlsx")
        with STATE_LOCK:
            con = db()
            if os.path.exists(path):
                try:
                    own, have = op_book.own_book(con, path)      # своя — за байтами, а після Excel — за вмістом
                    extra = []
                    if not own:
                        plan = op_book.diff(con, have)
                        days = plan["rations"]["fromBook"]
                        extra = (plan["docs"]["new"] + plan["docs"]["changed"] + plan["items"]["new"] + plan["acts"]["new"]
                                 + [f"Довідка · пункт харчування «{p}»" for p in plan["points"]["new"]]
                                 + ([f"Дободачі · записів, яких немає в програмі: {days}"] if days else []))
                except op_book.BookError as e:
                    extra = e.problems
                except OSError as e:
                    extra = [f"файл зайнятий: {e}"]
                if extra:
                    body = {"error": "у книзі є внесене руками, чого немає в програмі: спершу «Прийняти книгу…»",
                            "rows": extra[:50]}
                    return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                got = op_book.export_book(con, path)
            except PermissionError:
                body = {"error": "книга «Облік ОП.xlsx» відкрита в Excel: закрийте її й вивантажте знову"}
                return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
            con.execute("INSERT INTO app_setting(key, value) VALUES('op_book_export', ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                        (json.dumps(time.strftime("%Y-%m-%d")),))
            bump_state_version()
        got["ok"] = True
        if self.remote:
            got.update(remote_any(path))
        return self._send(200, json.dumps(got, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _op_upload_dir(self):
        d = os.path.join(DATA, "вивантаження", ".прийом книги ОП")
        os.makedirs(d, exist_ok=True)
        return d

    def _op_preview(self):
        """Перегляд змін книги проти бази; файл лежить до «Прийняти» під своїм sha, а поруч (<sha>.json) — відмінності,
        які людина побачила: «Прийняти» звіряє з ними те, що прийом зробив би тепер (`_op_apply`). Sha — від вмісту
        файла й показаних відмінностей разом, як у книги закупівель. Для старої книги спляча позиція іншої книги (архівна,
        без рядків) віддає код позиції старої книги (`claim_dormant`), і кожна така — перший рядок звіту."""
        import hashlib                                           # noqa: PLC0415
        import op_book                                           # noqa: PLC0415
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > MAX_RESTORE:
            self._drain()
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        data = self.rfile.read(n)
        legacy = "legacy=1" in self.path
        try:
            model = op_book.read_book(data, legacy=legacy)
            with STATE_LOCK:
                con = db()
                if legacy:                                   # спляча позиція іншої книги віддає код позиції старої книги
                    model = op_book.claim_dormant(con, model)
                plan = op_book.diff(con, model)              # код позиції іншої книги — відмова, як і в читанні
        except op_book.BookError as e:
            body = {"error": "книга не приймається", "problems": e.problems[:200]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        seen = _plan_text(plan)
        sha = hashlib.sha256(data + b"\0" + seen.encode("utf-8")).hexdigest()
        folder = self._op_upload_dir()
        for name, content in ((sha + ".json", seen.encode("utf-8")), (sha + ".xlsx", data)):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(content)
        body = {"ok": True, "sha": sha, "diff": plan, "places": op_book.legacy_places(model) if legacy else [],
                "report": model.get("report", [])}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _op_apply(self):
        """Прийняти книгу: копія бази «перед прийомом книги ОП» (чи «перед перенесенням…»), тоді
        книга ОП у базі стає такою, як у файлі. Усе або нічого.

        Книга лягає на базу, якою та стала після перегляду: інше вікно могло за цей час змінити облік
        ОП, і прийом мовчки переписав би його. Тож під тим самим замком, що й прийом, відмінності
        рахуються знову: не ті, що людина бачила (<sha>.json), — 409 з новими відмінностями, і нічого
        не змінено (ні копії, ні прийому); файли застарілого перегляду прибираються. Прийнята книга
        далі — своя (op_book.remember_sha): вивантаження перезапише її без звірки."""
        import op_book                                           # noqa: PLC0415
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except ValueError:
            req = {}
        sha = re.sub(r"[^0-9a-f]", "", str(req.get("sha") or ""))
        folder = self._op_upload_dir()
        path, seen_path = os.path.join(folder, sha + ".xlsx"), os.path.join(folder, sha + ".json")
        seen = None
        if sha and os.path.exists(path):
            try:
                with open(seen_path, encoding="utf-8") as f:
                    seen = _plan_text(json.loads(f.read()))
            except (OSError, ValueError):            # немає того, що бачили при перегляді, — звіряти нема з чим
                seen = None
        if seen is None:
            return self._send(400, "оберіть книгу ще раз: перегляд застарів".encode("utf-8"))
        with open(path, "rb") as f:
            data = f.read()
        legacy = bool(req.get("legacy"))
        stale = None
        try:
            model = op_book.read_book(data, legacy=legacy)
            with STATE_LOCK:
                con = db()
                if legacy:                                   # як у перегляді: інакше «Прийняти» звіряло б не ту книгу
                    model = op_book.claim_dormant(con, model)
                now = op_book.diff(con, model)               # той самий перегляд: чим база стала тепер
                if _plan_text(now) != seen:
                    stale = now
                else:
                    mark = None if legacy else op_book.fingerprint(model)       # стара книга програмі своєю не стає
                    if legacy:
                        model = op_book.normalize_legacy(model, req.get("mapping") or {})
                    backup = named_backup(con, "перед перенесенням книги ОП" if legacy else "перед прийомом книги ОП")
                    plan = op_book.apply(con, model)
                    if mark:
                        with contextlib.suppress(sqlite3.Error):     # прийняту книгу далі вважаємо своєю: вона вся в базі
                            op_book.remember_sha(con, stable_hash.stable_sha_bytes(data), mark)
                    bump_state_version()
                    LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
        except op_book.BookError as e:
            body = {"error": "книгу не прийнято", "problems": e.problems[:200]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        for done in (path, seen_path):                       # прийнято чи застаріло — цей перегляд більше не потрібен
            with contextlib.suppress(OSError):
                os.remove(done)
        if stale is not None:
            body = {"error": "З часу перегляду облік ОП у програмі змінився. Перегляньте книгу ще раз.", "diff": stale}
            return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        body = {"ok": True, "diff": plan, "backup": os.path.basename(backup), "report": model.get("report", [])}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _pur_unit(self, con):
        """Реквізити частини для бланків — ті, що вписано в «Люди й МВО → Частина». Усе — текст: порожнє значення (null) бланк
        не друкує як «None»."""
        row = con.execute("SELECT value FROM app_setting WHERE key = 'unit'").fetchone()
        try:
            u = json.loads(row[0]) if row and row[0] else {}
        except ValueError:
            u = {}
        if not isinstance(u, dict):
            u = {}
        text = lambda key: str(u.get(key) or "")                 # noqa: E731
        name = text("legalName")
        m = re.search(r"частина\s+(\S+)", name, re.I)
        return {"name": name, "code": m.group(1) if m else "", "edrpou": text("edrpou"), "fundCode": text("fundCode"),
                "service": text("serviceFull"), "place": text("place"), "upperHq": text("upperHq"), "phone": text("phone")}

    def _pur_export(self):
        """Книга «Закупівлі» — у теку закупівель, цілою або ніяк: пишеться поруч і стає на місце одним кроком. Порожні бланки
        — поруч, окремим кроком: збій бланка книги не псує. Книгу, яку програма сама записала чи прийняла (її відбиток байтів
        або вмісту запам'ятано: purchases_book.own_book — вміст пізнає її й після «Зберегти» в Excel), перезаписує без звірки,
        хоч би база за цей час і змінилась; іншу — лише коли в ній нема внесеного руками, чого немає в програмі (інакше 409:
        спершу «Прийняти книгу…»). Книга, що назад не читається, — 409 «не читається» з переліком рядків (прийом її не виправить).
        У відповіді 200 може бути `readBack`: що не так із щойно записаною книгою (вона все одно на місці)."""
        import purchase_papers                                   # noqa: PLC0415
        import purchases_book                                    # noqa: PLC0415
        with STATE_LOCK:
            try:
                con = db()
            except StateBroken as e:
                return self._send(500, str(e).encode("utf-8"))
            roots = folders()
            path = os.path.join(roots["purchases"], "Закупівлі.xlsx")
            if os.path.exists(path):
                try:
                    own, model = purchases_book.own_book(con, path)      # своя — за байтами, а після Excel — за вмістом
                except purchases_book.BookError as e:    # назад не читається: «Прийняти книгу…» цього не виправить
                    body = {"error": "книга «Закупівлі.xlsx» не читається: виправте рядки з переліку (або приберіть файл) "
                                     "і вивантажте знову", "rows": e.problems[:50]}
                    return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
                except OSError:                      # файл тримає Excel чи він не читається: не «внесене руками»
                    body = {"error": "книга «Закупівлі.xlsx» зайнята або не читається: закрийте її в Excel і вивантажте знову"}
                    return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
                except Exception as e:               # noqa: BLE001 — несподіване: книгу не перезаписуємо, а відповідаємо
                    traceback.print_exc()
                    return self._send(500, f"{type(e).__name__}: {e}".encode("utf-8"))
                extra = []
                if not own:
                    try:
                        plan = purchases_book.diff(con, model)           # читається, але база її не прийме — те саме «руками»
                        extra = [k for name, res in plan.items() if name != "same" for k in res["new"] + res["changed"]]
                    except purchases_book.BookError as e:
                        extra = e.problems
                    except Exception as e:           # noqa: BLE001 — несподіване: книгу не перезаписуємо, а відповідаємо
                        traceback.print_exc()
                        return self._send(500, f"{type(e).__name__}: {e}".encode("utf-8"))
                if extra:
                    body = {"error": "у книзі є внесене руками, чого немає в програмі: спершу «Прийняти книгу…»",
                            "rows": extra[:50]}
                    return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
            try:
                got = purchases_book.export_book(con, path)
            except purchase_papers.PaperConflict:
                body = {"error": "книга «Закупівлі.xlsx» відкрита в Excel: закрийте її й вивантажте знову"}
                return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
            except OSError as e:                     # теку не створити, диск повний: відповідь, а не обрив зв'язку
                return self._send(500, str(e).encode("utf-8"))
            except Exception as e:                   # noqa: BLE001 — несподіване
                traceback.print_exc()
                return self._send(500, f"{type(e).__name__}: {e}".encode("utf-8"))
            try:
                unit = self._pur_unit(con)
            except Exception:                        # noqa: BLE001 — реквізитів нема: бланки без них не складаємо
                traceback.print_exc()
                unit = None
        if unit is None:
            got["blanksError"] = "не вдалося прочитати реквізити частини, бланки не складено"
        else:
            try:                                     # бланки — побічний продукт: книга вже на місці, що б із ними не сталось
                purchase_papers.save_blanks(roots, unit)
            except Exception as e:                   # noqa: BLE001 — PaperConflict, ValueError, OSError, AttributeError…
                if not isinstance(e, (purchase_papers.PaperConflict, ValueError, OSError, AttributeError)):
                    traceback.print_exc()
                got["blanksError"] = (str(e) or type(e).__name__)[:200]
        got["ok"] = True
        if self.remote:
            try:
                got.update(remote_any(path))
            except OSError as e:
                return self._send(500, str(e).encode("utf-8"))
        return self._send(200, json.dumps(got, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _pur_upload_dir(self, create=True):
        d = os.path.join(DATA, "вивантаження", ".прийом книги закупівель")
        if create:
            os.makedirs(d, exist_ok=True)
        return d

    def _pur_prune_uploads(self, days=1):
        """Файли перегляду, що не дочекались «Прийняти» понад добу, — геть (за кожного нового перегляду)."""
        old = time.time() - days * 86400
        with contextlib.suppress(OSError):
            for entry in os.scandir(self._pur_upload_dir(create=False)):
                with contextlib.suppress(OSError):
                    if entry.is_file() and entry.stat().st_mtime < old:
                        os.remove(entry.path)

    def _pur_preview(self):
        """Перегляд відмінностей книги від бази; файл лежить до «Прийняти» під своїм sha, а поруч (<sha>.json) — відмінності,
        які людина побачила: «Прийняти все» звіряє з ними те, що прийом зробив би тепер (`_pur_apply`). Sha — від вмісту файла
        й показаних відмінностей разом: два вікна, що переглянули той самий файл до й після чужого запису, мають кожне своє."""
        import hashlib                                           # noqa: PLC0415
        import purchases_book                                    # noqa: PLC0415
        self._pur_prune_uploads()
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            n = 0
        if n <= 0 or n > MAX_RESTORE:
            self._drain()
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        data = self.rfile.read(n)
        if len(data) != n:                                       # обрив зв'язку: з половини книги нічого не читаємо й не пишемо
            return self._send(400, "файл прийшов не повністю".encode("utf-8"))
        try:
            model = purchases_book.read_book(data)
            with STATE_LOCK:
                plan = purchases_book.diff(db(), model)        # проганяє прийом начисто й відкочує: база не змінюється
        except purchases_book.BookError as e:
            body = {"error": "книга не приймається", "problems": e.problems[:200]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        except Exception as e:                       # noqa: BLE001 — несподіване: відповідь, а не обрив зв'язку
            traceback.print_exc()
            return self._send(500, f"{type(e).__name__}: {e}".encode("utf-8"))
        seen = _plan_text(plan)
        sha = hashlib.sha256(data + b"\0" + seen.encode("utf-8")).hexdigest()
        stored = []
        try:
            folder = self._pur_upload_dir()
            for name, content in ((sha + ".json", seen.encode("utf-8")), (sha + ".xlsx", data)):
                stored.append(os.path.join(folder, name))
                with open(stored[-1], "wb") as f:
                    f.write(content)
        except OSError as e:                         # диск повний чи тека недоступна: відповідь, а не обрив зв'язку
            for path in stored:                      # без пари файлів прийняти нічого: половину не лишаємо
                with contextlib.suppress(OSError):
                    os.remove(path)
            return self._send(500, f"книгу не вдалося зберегти для прийому: {e}".encode("utf-8"))
        body = {"ok": True, "sha": sha, "diff": plan}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _pur_apply(self):
        """Прийняти книгу: копія «перед прийомом книги закупівель», тоді закупівлі в базі — як у файлі. Усе або нічого.

        Книга лягає на базу, якою та стала після перегляду: інше вікно могло за цей час додати закупівлю, і прийом мовчки
        прибрав би її. Тож під тим самим замком, що й прийом, відмінності рахуються знову: не ті, що людина бачила при перегляді
        (<sha>.json), — 409 з новими відмінностями, і нічого не змінено (ні копії, ні прийому)."""
        import purchases_book                                    # noqa: PLC0415
        req = self._json_body()
        if req is None:
            return                                 # завелике тіло: відповідь 413 уже надіслано
        sha = re.sub(r"[^0-9a-f]", "", str(req.get("sha") or ""))
        folder = self._pur_upload_dir(create=False)
        path, seen_path = os.path.join(folder, sha + ".xlsx"), os.path.join(folder, sha + ".json")
        seen = None
        if sha and os.path.exists(path):
            try:
                with open(seen_path, encoding="utf-8") as f:
                    seen = _plan_text(json.loads(f.read()))
            except (OSError, ValueError):            # немає того, що бачили при перегляді, — звіряти нема з чим
                seen = None
        if seen is None:
            return self._send(400, "оберіть книгу ще раз: перегляд застарів".encode("utf-8"))
        stale = None
        try:
            with open(path, "rb") as f:
                data = f.read()
            model = purchases_book.read_book(data)
            with STATE_LOCK:
                con = db()
                now = purchases_book.diff(con, model)            # той самий прийом начисто й відкат: чим база стала тепер
                if _plan_text(now) != seen:
                    stale = now
                else:
                    backup = named_backup(con, "перед прийомом книги закупівель")
                    plan = purchases_book.apply(con, model)
                    with contextlib.suppress(sqlite3.Error):     # прийняту книгу далі вважаємо своєю: вона вся в базі
                        purchases_book.remember_sha(con, stable_hash.stable_sha_bytes(data),
                                                    purchases_book.fingerprint(model))
                    bump_state_version()
                    LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
        except (purchases_book.BookError, state_db.SaveError) as e:
            problems = e.problems if isinstance(e, purchases_book.BookError) else [str(e)]
            body = {"error": "книгу не прийнято", "problems": problems[:200]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        except Exception as e:                       # noqa: BLE001 — несподіване: відповідь, а не обрив зв'язку
            traceback.print_exc()
            return self._send(500, f"{type(e).__name__}: {e}".encode("utf-8"))
        if stale is not None:
            body = {"error": "З часу перегляду закупівлі змінились. Перегляньте книгу ще раз.", "diff": stale}
            return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        for done in (path, seen_path):
            with contextlib.suppress(OSError):
                os.remove(done)
        body = {"ok": True, "diff": plan, "backup": os.path.basename(backup)}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _book_export(self, book):
        """Книга «Облік СП» («Облік РП») — у теку з налаштувань. Книгу, яку програма сама записала чи прийняла
        (її відбиток байтів або вмісту запам'ятано: book_xlsx.own_book — вміст пізнає її й після «Зберегти» в
        Excel), перезаписує без звірки, хоч би облік у програмі за цей час змінився. Іншу — лише коли в ній немає
        внесеного руками, чого немає в базі: нових і змінених документів, нових позицій, нових і змінених актів сухпаю
        (інакше 409: спершу «Прийняти книгу…»). Книга ОП — `_op_export`."""
        import book_xlsx                                         # noqa: PLC0415
        layout = book_xlsx.LAYOUTS[book]
        path = os.path.join(folders()[BOOK_FOLDER[book]], layout.file_name)
        with STATE_LOCK:
            con = db()
            if os.path.exists(path):
                try:
                    own, have = book_xlsx.own_book(con, path, layout)     # своя — за байтами, а після Excel — за вмістом
                    extra = []
                    if not own:
                        plan = book_xlsx.diff(con, have, layout)
                        acts = plan.get("acts") or {}                     # акти сухпаю — лише в книзі СП
                        extra = (plan["docs"]["new"] + plan["docs"]["changed"] + plan["items"]["new"]
                                 + acts.get("new", []) + acts.get("changed", []))
                except book_xlsx.BookError as e:
                    extra = e.problems
                except OSError as e:
                    extra = [f"файл зайнятий: {e}"]
                if extra:
                    body = {"error": "у книзі є внесене руками, чого немає в програмі: спершу «Прийняти книгу…»",
                            "rows": extra[:50]}
                    return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
            try:
                os.makedirs(os.path.dirname(path), exist_ok=True)
                got = book_xlsx.export_book(con, path, layout, own=True)     # записана книга далі своя
            except PermissionError:
                body = {"error": f"книга «{layout.file_name}» відкрита в Excel: закрийте її й вивантажте знову"}
                return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
            row = con.execute("SELECT value FROM app_setting WHERE key = 'book_export'").fetchone()
            try:
                dates = json.loads(row[0]) if row else {}
            except ValueError:
                dates = {}
            dates = dates if isinstance(dates, dict) else {}
            dates[book] = time.strftime("%Y-%m-%d")
            con.execute("INSERT INTO app_setting(key, value) VALUES('book_export', ?) "
                        "ON CONFLICT(key) DO UPDATE SET value = excluded.value", (json.dumps(dates, ensure_ascii=False),))
            bump_state_version()
        got["ok"] = True
        if self.remote:
            got.update(remote_any(path))
        return self._send(200, json.dumps(got, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _book_upload_dir(self, book):
        d = os.path.join(DATA, "вивантаження", f".прийом книги {book}")
        os.makedirs(d, exist_ok=True)
        return d

    def _book_preview(self, book):
        """Перегляд змін книги проти бази; файл лежить до «Прийняти» під своїм sha, а поруч (<sha>.json) — відмінності,
        які людина побачила: «Прийняти» звіряє з ними те, що прийом зробив би тепер (`_book_apply`). Sha — від вмісту
        файла й показаних відмінностей разом, як у книги ОП. Для старої книги — місця, які вона називає, і пропозиція,
        з чим їх зіставити; архівна позиція старої книги без рядків із кодом іншої книги не переноситься
        (`drop_foreign_archived`), а спляча позиція іншої книги віддає код діючій позиції старої (`claim_dormant`):
        кожна така — перший рядок звіту."""
        import hashlib                                           # noqa: PLC0415
        import book_xlsx                                         # noqa: PLC0415
        layout = book_xlsx.LAYOUTS[book]
        n = int(self.headers.get("Content-Length", 0) or 0)
        if n <= 0 or n > MAX_RESTORE:
            self._drain()
            return self._send(413, "файл порожній або завеликий".encode("utf-8"))
        data = self.rfile.read(n)
        legacy = "legacy=1" in self.path
        try:
            model = book_xlsx.read_book(data, layout, legacy=legacy)
            with STATE_LOCK:
                con = db()
                if legacy:                                           # без архівної позиції без рядків, код якої чужий
                    model = book_xlsx.drop_foreign_archived(con, model, layout)
                    model = book_xlsx.claim_dormant(con, model, layout)    # спляча позиція іншої книги віддає код цій
                plan = book_xlsx.diff(con, model, layout)             # код позиції іншої книги — відмова, як і в читанні
                subs = [r[0] for r in con.execute("SELECT name FROM subdivision WHERE is_active = 1 ORDER BY sort, id")]
        except book_xlsx.BookError as e:
            body = {"error": "книга не приймається", "problems": e.problems[:200]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        seen = _plan_text(plan)
        sha = hashlib.sha256(data + b"\0" + seen.encode("utf-8")).hexdigest()
        folder = self._book_upload_dir(book)
        for name, content in ((sha + ".json", seen.encode("utf-8")), (sha + ".xlsx", data)):
            with open(os.path.join(folder, name), "wb") as f:
                f.write(content)
        places = book_xlsx.legacy_places(model) if legacy else []
        # «Зауваження» («Поправки» старої книги): що сказало читання книги, і акти сухпаю не за правилами (`remarks`).
        body = {"ok": True, "sha": sha, "diff": plan, "places": places,
                "suggest": book_xlsx.suggest_places(places, subs, layout) if legacy else {},
                "report": model.get("report", []) + plan.get("remarks", [])}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _book_apply(self, book):
        """Прийняти книгу: копія бази «перед прийомом книги …» (чи «перед перенесенням…»), тоді книга в
        базі стає такою, як у файлі. Усе або нічого.

        Книга лягає на базу, якою та стала після перегляду: інше вікно могло за цей час змінити облік книги,
        і прийом мовчки переписав би його. Тож під тим самим замком, що й прийом, відмінності рахуються знову:
        не ті, що людина бачила (<sha>.json), — 409 з новими відмінностями, і нічого не змінено (ні копії, ні
        прийому); файли застарілого перегляду прибираються. Прийнята книга (не стара) далі — своя
        (book_xlsx.remember_sha): вивантаження перезапише її без звірки. Як `_op_apply`."""
        import book_xlsx                                         # noqa: PLC0415
        layout = book_xlsx.LAYOUTS[book]
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except ValueError:
            req = {}
        sha = re.sub(r"[^0-9a-f]", "", str(req.get("sha") or ""))
        folder = self._book_upload_dir(book)
        path, seen_path = os.path.join(folder, sha + ".xlsx"), os.path.join(folder, sha + ".json")
        seen = None
        if sha and os.path.exists(path):
            try:
                with open(seen_path, encoding="utf-8") as f:
                    seen = _plan_text(json.loads(f.read()))
            except (OSError, ValueError):            # немає того, що бачили при перегляді, — звіряти нема з чим
                seen = None
        if seen is None:
            return self._send(400, "оберіть книгу ще раз: перегляд застарів".encode("utf-8"))
        with open(path, "rb") as f:
            data = f.read()
        legacy = bool(req.get("legacy"))
        stale = None
        try:
            model = book_xlsx.read_book(data, layout, legacy=legacy)
            with STATE_LOCK:
                con = db()
                if legacy:                                   # як у перегляді: інакше «Прийняти» звіряло б не ту книгу
                    model = book_xlsx.drop_foreign_archived(con, model, layout)
                    model = book_xlsx.claim_dormant(con, model, layout)
                now = book_xlsx.diff(con, model, layout)     # той самий перегляд: чим база стала тепер
                if _plan_text(now) != seen:
                    stale = now
                else:
                    mark = None if legacy else book_xlsx.fingerprint(model)     # стара книга програмі своєю не стає
                    if legacy:
                        model = book_xlsx.normalize_legacy(model, req.get("mapping") or {}, layout)
                    backup = named_backup(con, f"перед перенесенням книги {book}" if legacy else f"перед прийомом книги {book}")
                    plan = book_xlsx.apply(con, model, layout)
                    if mark:
                        with contextlib.suppress(sqlite3.Error):     # прийняту книгу далі вважаємо своєю: вона вся в базі
                            book_xlsx.remember_sha(con, layout, stable_hash.stable_sha_bytes(data), mark)
                    bump_state_version()
                    LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
        except book_xlsx.BookError as e:
            body = {"error": "книгу не прийнято", "problems": e.problems[:200]}
            return self._send(422, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        for done in (path, seen_path):                       # прийнято чи застаріло — цей перегляд більше не потрібен
            with contextlib.suppress(OSError):
                os.remove(done)
        if stale is not None:
            body = {"error": f"З часу перегляду облік {book} у програмі змінився. Перегляньте книгу ще раз.", "diff": stale}
            return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        body = {"ok": True, "diff": plan, "backup": os.path.basename(backup),
                "report": model.get("report", []) + plan.get("remarks", [])}
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _sp_q1prod(self):
        """«1прод» рядків списання сухпаю за днями з Добовки (найновіший файл «Добовка*.xlsx» у теці
        «Добовка»); квартал, що прийшов з книги чи вписаний людиною, не перераховується. Пошкоджена Добовка — 400 і ті
        самі слова, що й збій запитів /api/dobovka/*; прогін, що нічого не змінив, версії стану не піднімає."""
        import suhpay_days                                       # noqa: PLC0415
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
            req = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
        except ValueError:
            req = {}
        days_from = None
        if req.get("daysFrom"):
            try:
                days_from = datetime.date.fromisoformat(str(req["daysFrom"])[:10])
            except ValueError:
                return self._send(400, "дата «з якого дня» — РРРР-ММ-ДД".encode("utf-8"))
        path = suhpay_days.newest_dobovka(folders().get("dobovka", ""))
        try:
            with STATE_LOCK:
                got = suhpay_days.fill_q1prod(db(), path, days_from)
                if got["changed"]:                           # прогін, що нічого не змінив, не змушує вікна перечитувати стан
                    bump_state_version()
                    LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
        except (OSError, ValueError) as e:
            return self._send(422, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        except Exception:                                # noqa: BLE001 — пошкоджена Добовка: відповідь словами, а не обрив зв'язку
            traceback.print_exc()                        # подробиці — у консоль, як у запитах Добовки
            return self._send_json(400, {"ok": False, "error": "Добовку не прочитано."})
        got.update(ok=True, dobovka=os.path.basename(path) if path else "")
        return self._send(200, json.dumps(got, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _open_scan(self, reveal=False):
        """Відкрити файл програмою Windows або показати його в теці. Відкривається лише те, що можна
        підшити (SCAN_EXT): у теці служби може лежати що завгодно, а відкриття запускає файл.

        «Показати в теці» показує й каталог: теку справи відкривають саму, а не за її першим файлом. Шлях — усередині кореня теки
        (ті самі перевірки, що й для файла: угору, диск, мережеве ім'я й посилання — відмова). У теці служби (з ключем) каталог за
        проханням `make` створюється, якщо його ще немає, — і показується; у «Дані обліку/скани» нічого не створюється. Створення
        не залежить від OBLIK_NO_OPEN: той лише не дає Провіднику відкритися. Теки з READ_ONLY_FOLDERS (Добовка) лише
        показуються, якщо вони є: `make` для них ігнорується."""
        try:
            n = max(0, int(self.headers.get("Content-Length", 0)))
            spec = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        except (ValueError, RecursionError):                      # RecursionError: тисячі вкладених дужок
            spec = None
        if not isinstance(spec, dict):
            return self._send(400, "запит має бути об'єктом JSON зі шляхом до файла".encode("utf-8"))
        full, key = self._scan_file(spec)
        is_dir = False
        if not full and reveal:
            root = folders().get(key) if key else os.path.join(DATA, "скани")
            if root:
                try:
                    full = dir_path(spec.get("path"), root, make=bool(key and key not in READ_ONLY_FOLDERS and spec.get("make")))
                except OSError as e:
                    return self._send(500, f"теку не створено: {e}".encode("utf-8"))
                is_dir = bool(full)
        if not full:
            where = next((label for k, label, _ in FOLDERS if k == key), key) if key else "Дані обліку/скани"
            return self._send(404, f"файла немає в теці «{where}»".encode("utf-8"))
        if not reveal and os.path.splitext(full)[1].lower() not in SCAN_EXT:
            return self._send(415, BAD_OPEN.encode("utf-8"))
        ok = False
        if not os.environ.get("OBLIK_NO_OPEN") and sys.platform.startswith("win"):
            try:
                # Провідник ділить свій командний рядок за комами, а список аргументів лапкує лише шлях із пробілом: «Каструлі,ін»
                # без пробіла відкрився б не там. Каталог відкриває `os.startfile` (командного рядка немає), файл Провідник
                # виділяє командою одним рядком із лапками, які ставимо самі.
                if reveal and not is_dir:
                    subprocess.Popen(f'explorer /select,"{full}"')     # noqa: S603, S607
                else:
                    os.startfile(full)                                 # noqa: S606
                ok = True
            except OSError:
                ok = False
        body = json.dumps({"ok": True, "opened": ok}, ensure_ascii=False).encode("utf-8")
        self._send(200, body, MIME[".json"])

    def _save_scan(self):
        """Файл, підшитий із програми: лягає в «Дані обліку/скани/<рік>» під
        ім'ям «дата №номер назва» (або «дата <підпис> назва», якщо сторінка
        передала підпис, як-от «відомість №3 склад»), а сторінці повертається
        шлях для посилання. Фото майна й документи інвентаризації сторінка кладе
        у свою підтеку (X-Folder: «майно/10101», «інвентаризації/2026-12-25»).
        Наявний файл (чи каталог) з таким іменем не чіпається — до імені додається «(2)». Під справжнім
        іменем файл з'являється лише цілим; обірване завантаження (тіла менше за заявлене) не пишеться.
        Перейменування, якому на мить заважає антивірус чи індексатор, повторюється (RENAME_TRIES разів).

        З X-Folder-Key (ключ із FOLDERS) файл лягає в теку служби з налаштувань: у підтеку
        X-Folder (до чотирьох рівнів; без неї — у саму теку) під ім'ям X-Name, якщо воно дане.
        Відповідь повертає ще й теку та відбиток вмісту (sha): за ним файл знаходять після перекладки.
        Теки з READ_ONLY_FOLDERS (Добовка) файлів не приймають: 403, і нічого не створюється."""
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_SCAN:
            self._drain()
            return self._send(413, "файл порожній або завеликий (понад 40 МБ)".encode("utf-8"))
        name = unquote(self.headers.get("X-File-Name", "") or "скан")
        date = (self.headers.get("X-Doc-Date", "") or "")[:10]
        no = unquote(self.headers.get("X-Doc-No", "") or "").strip()
        label = unquote(self.headers.get("X-Doc-Label", "") or "").strip() or (f"№{no}" if no else "")
        stem, ext = os.path.splitext(os.path.basename(name.replace("\\", "/")))
        ext = ext.lower()
        # Тіло читається й тоді, коли файл не приймаємо: відповідь посеред
        # непрочитаного запиту Windows обриває, і сторінка бачила «зв'язок
        # розірвано» замість пояснення.
        body = self.rfile.read(n)
        if len(body) != n:
            # Браузер обірвав завантаження: обрізаний файл не зберігається.
            return self._send(400, "файл надійшов не повністю: завантаження перервано".encode("utf-8"))
        key = unquote(self.headers.get("X-Folder-Key", "") or "").strip()
        if key in READ_ONLY_FOLDERS:
            return self._send(403, READ_ONLY_FOLDERS[key].encode("utf-8"))      # Добовка: ні файла, ні каталогу
        if ext not in SCAN_EXT:
            return self._send(415, BAD_TYPE.encode("utf-8"))
        year = date[:4] if re.match(r"\d{4}-\d{2}-\d{2}$", date) else time.strftime("%Y")
        root = folders().get(key) if key else os.path.join(DATA, "скани")
        if key and not root:
            return self._send(400, f"невідома тека «{key}»".encode("utf-8"))
        # Підтека — лише зі звичайних імен: без «..», без дисків, не глибше трьох рівнів
        # (у теці служби — чотирьох).
        parts = [BAD_FILE_CHARS.sub("-", p).strip(" .")
                 for p in unquote(self.headers.get("X-Folder", "") or "").replace("\\", "/").split("/")]
        parts = [p[:80] for p in parts if p][:4 if key else 3]
        folder = os.path.join(root, *(parts or ([] if key else [year])))
        os.makedirs(folder, exist_ok=True)
        named = BAD_FILE_CHARS.sub("-", unquote(self.headers.get("X-Name", "") or "")).strip(" .")[:150]
        base = named or BAD_FILE_CHARS.sub("-", " ".join(x for x in (date, label, stem.strip()) if x))[:120].strip(" .") or "скан"
        # Файл пишеться під тимчасовим іменем і стає під справжнє лише цілим: поки він пишеться, перелік і
        # прив'язка його не бачать, а збій чи обрив лишає тимчасовий файл, який прибирається, а не обрізаний
        # документ. Ім'я займає саме перейменування: у Windows воно не замінює ні файл, ні каталог, тож два
        # вікна, що зберігають один документ разом, не перезапишуть одне одного — другому дістанеться «(2)».
        part = None
        try:
            fd, part = tempfile.mkstemp(dir=folder, suffix=".part")
            with os.fdopen(fd, "wb") as f:
                f.write(body)
            target, k, held = os.path.join(folder, base + ext), 2, 0
            while True:
                try:
                    os.rename(part, target)
                    break
                except FileExistsError:
                    target = os.path.join(folder, f"{base} ({k}){ext}")
                    k += 1
                except PermissionError:
                    # Щойно записаний файл на мить може тримати антивірус чи індексатор Windows: ім'я тут ні до чого,
                    # тож те саме перейменування повторюється, а не береться наступне ім'я.
                    held += 1
                    if held >= RENAME_TRIES:
                        raise
                    time.sleep(RENAME_PAUSE)
            part = None
        except BaseException:
            if part:
                with contextlib.suppress(OSError):
                    os.remove(part)
            raise
        rel = os.path.relpath(target, root).replace(os.sep, "/")
        answer = {"ok": True, "folder": key, "path": rel, "file": os.path.basename(target), "size": len(body),
                  "sha": stable_hash.stable_sha_bytes(body)}
        self._send(200, json.dumps(answer, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _read_json(self, limit):
        """Тіло запиту, прочитане як JSON: (код, значення). 413 — тіло понад `limit` (його вичитано й відкинуто),
        400 — не JSON чи не об'єкт, 200 — об'єкт (порожнє тіло — порожній об'єкт)."""
        try:
            n = int(self.headers.get("Content-Length", 0) or 0)
        except ValueError:
            n = 0
        if n > limit:
            self._drain()
            return 413, None
        try:
            got = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n > 0 else {}
        except (ValueError, RecursionError):                      # RecursionError: тисячі вкладених дужок
            return 400, None
        return (200, got) if isinstance(got, dict) else (400, None)

    def _json_body(self, limit=MAX_JSON):
        """Тіло запиту — об'єкт JSON; усе інше (порожнє, зіпсоване, не об'єкт) дає порожній об'єкт.
        None — тіло понад `limit`: його вичитано й відкинуто, а відповідь 413 уже надіслано."""
        code, got = self._read_json(limit)
        if code == 413:
            self._send(413, "запит завеликий".encode("utf-8"))
            return None
        return got if code == 200 else {}

    def _folder_link(self, req):
        """Файл, покладений у теку служби руками: його розмір, відбиток і тип — для запису про нього.
        Прив'язується лише те, що й завантажується (SCAN_EXT)."""
        full = folder_path(req.get("folder"), req.get("path"))
        if not full:
            return self._send(404, "файла в теці немає".encode("utf-8"))
        ext = os.path.splitext(full)[1].lower()
        if ext not in SCAN_EXT:
            return self._send(415, BAD_TYPE.encode("utf-8"))
        try:
            body = {"ok": True, "file": os.path.basename(full), "size": os.path.getsize(full),
                    "sha": file_sha(full), "mime": MIME.get(ext, "application/octet-stream")}
        except OSError as e:                       # файл зайнятий іншою програмою чи недоступний
            return self._send(500, str(e).encode("utf-8"))
        return self._send(200, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _files_find(self, req):
        """Зниклі файли — за відбитком у межах своєї теки (після перекладки тек). Запис знаходить файл, чий стабільний або
        звичайний відбиток збігається з його `sha`: нові записи тримають стабільний (`stable_hash`), старі — звичайний SHA-256.

        Файли за посиланням (junction) на каталог поза текою не беруться: сервер їх усе одно не віддає.
        Знаходяться лише файли тих типів, що підшиваються (SCAN_EXT): покинутий тимчасовий .part документом не є, як і «~$…»,
        що Office кладе поруч із відкритим документом."""
        roots = folders()
        asked = req.get("files")
        want = [f for f in (asked if isinstance(asked, list) else []) if isinstance(f, dict)
                and isinstance(f.get("folder"), str) and f["folder"] in roots
                and isinstance(f.get("path"), str) and isinstance(f.get("sha"), str) and f["sha"]
                and not folder_path(f["folder"], f["path"])]
        found = []
        for key in sorted({f["folder"] for f in want}):
            root = roots[key]
            if not os.path.isdir(root):
                continue
            base = os.path.realpath(root)
            mine = [f for f in want if f["folder"] == key]
            sizes = {f["size"] if isinstance(f.get("size"), int) else -1 for f in mine}
            for dp, dirs, fs in os.walk(root):
                # За посиланням чи з'єднанням (junction) на каталог не йдемо: на місце поза текою — бо звідти
                # файли не віддаються, а на предка чи на саму теку — бо обхід ходив би колом.
                dirs[:] = [d for d in dirs if not _is_link(os.path.join(dp, d))
                           and _inside(base, os.path.realpath(os.path.join(dp, d)))]
                for name in fs:
                    if os.path.splitext(name)[1].lower() not in SCAN_EXT or name.startswith(OFFICE_OWNER):
                        continue                   # лише документи: покинутий tmp….part чи «~$…» Office може збігтися за вмістом
                    full = os.path.join(dp, name)
                    try:
                        if -1 not in sizes and os.path.getsize(full) not in sizes:
                            continue
                        if not _inside(base, os.path.realpath(full)):
                            continue
                        shas = stable_hash.shas(full)
                    except OSError:
                        continue
                    for f in mine:
                        if f["sha"] in shas and not any(x["folder"] == key and x["was"] == f["path"] for x in found):
                            found.append({"folder": key, "was": f["path"],
                                          "path": os.path.relpath(full, root).replace(os.sep, "/")})
        return self._send(200, json.dumps({"found": found}, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _pur_paper(self):
        """Папір закупівлі — у теку з налаштувань; на іншому ПК — завантаженням. Відбиток у відповіді — остаточний: імена
        Excel книга отримує ще до того, як стане під своє ім'я (purchase_papers), тож маршрут нічого не перераховує."""
        import purchase_papers                                   # noqa: PLC0415
        spec = self._json_body()
        if spec is None:
            return                                 # завелике тіло: відповідь 413 уже надіслано
        try:
            got = purchase_papers.save(spec, folders())
        except purchase_papers.PaperConflict as e:
            body = {"error": str(e), "changed": e.changed, "busy": e.busy}
            return self._send(409, json.dumps(body, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        except (ValueError, KeyError, TypeError, AttributeError) as e:       # AttributeError: `unit` не об'єкт тощо
            return self._send(422, json.dumps({"error": str(e)}, ensure_ascii=False).encode("utf-8"), MIME[".json"])
        except OSError as e:                       # теку не створити, диск повний: відповідь, а не обрив зв'язку
            return self._send(500, str(e).encode("utf-8"))
        except Exception as e:                     # noqa: BLE001 — несподіване
            traceback.print_exc()
            return self._send(500, f"{type(e).__name__}: {e}".encode("utf-8"))
        full = folder_path(got["folder"], got["path"])
        if not full:
            return self._send(500, "папір записано, але файла в теці не знайдено".encode("utf-8"))
        if self.remote:
            # Лише посилання на завантаження: `path` лишається відносним до теки, за ним сторінка знаходить файл
            # (remote_any повертає ще й шлях копії на основному ПК, який запис про файл зіпсував би).
            try:
                got["download"] = remote_any(full)["download"]
            except OSError as e:
                return self._send(500, str(e).encode("utf-8"))
        got["ok"] = True
        got["opened"] = False if self.remote else (open_file(full) if spec.get("open", True) else False)
        return self._send(200, json.dumps(got, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _send_json(self, code, obj):
        return self._send(code, json.dumps(obj, ensure_ascii=False).encode("utf-8"), MIME[".json"])

    def _object_body(self, limit=MAX_JSON):
        """Тіло запиту — об'єкт JSON (той самий `_read_json`, що й у `_json_body`, але суворо). Не JSON чи не об'єкт — 400,
        понад `limit` — 413: відповідь (JSON зі словами) тоді вже надіслано, а повертається None."""
        code, got = self._read_json(limit)
        if code != 200:
            self._send_json(code, {"ok": False, "error": "Запит завеликий." if code == 413 else "Запит не прочитано."})
            return None
        return got

    def _op_act(self, what, kind="op"):
        """Акти списання за нормами: пропозиція (`preview`), складання й виправлення (`save`), файли пакета (`files`),
        видалення (`delete`). `kind` — вид акта: «op» (посуд, серветки, миючі — `op_acts`) чи «sp» (акти сухпаю —
        `sp_acts`, пакет — `sp_act_export`, тека «Акти сухпаю»); решта — спільне.

        Виправлення (`save` з `docId`) і видалення вимагають `was` — яким акт був у вікні, коли його відкрили (номер і дата
        не порожні): без нього 400. Інший акт під тим самим id чи акт, виправлений деінде, — 422 (op_acts).

        Пакет паперів пише в базу записи про файли акта, тож версія стану змінюється після пакета, а не до нього. Акт уже
        записано, а пакет не склався, — версія змінюється теж, а відповідь 500 каже, що акт збережено: файли добираються
        «Перескласти файли». Для пропозиції, яку складено за типовим періодом (його не названо в запиті), період, що не
        складається, — не відмова: вікно відкривається з типовими значеннями, без рядків і з причиною в `warnings`.

        Файл пакета в теці правили чи склали руками (op_act_export.conflicts) — 409 з `changed`: «Зберегти» не записує
        нічого (ні акта, ні файлів), «Перескласти файли» — файлів; `force: true` — людина погодилась переписати.
        Видалення — як будь-якого документа: спершу копія бази (backup_state(force=True)); без копії акт не видаляється."""
        import op_act_export                                     # noqa: PLC0415
        import op_acts                                           # noqa: PLC0415
        import sp_act_export                                     # noqa: PLC0415
        import sp_acts                                           # noqa: PLC0415
        mod, export, key = (sp_acts, sp_act_export, "spActs") if kind == "sp" else (op_acts, op_act_export, "opActs")
        req = self._object_body()
        if req is None:
            return                                   # відповідь (400 чи 413) уже надіслано
        if what == "delete" or (what == "save" and _names_act(req)):
            was = req.get("was")
            if not (isinstance(was, dict) and all(str(was.get(k) or "").strip() for k in ("number", "date"))):
                return self._send_json(400, {"ok": False, "error": ACT_WITHOUT_WAS})
        force = req.get("force") is True
        out, saved = {"ok": True}, False
        try:
            with STATE_LOCK:
                try:
                    con = db()
                except StateBroken as e:
                    return self._send_json(500, {"ok": False, "error": str(e)})
                if what == "preview" and kind == "sp":   # акт сухпаю: типові значення — разом з першою пропозицією
                    out.update(sp_acts.preview(con, req, time.strftime("%Y-%m-%d")))
                    return self._send_json(200, out)
                if what == "preview":
                    spec = dict(req)
                    filled = not spec.get("from") or not spec.get("to")
                    if filled:                           # період не названо: типовий — з дня після попереднього акта
                        spec.update(op_acts.defaults(con, spec.get("series"), spec.get("point"),
                                                     spec.get("date") or time.strftime("%Y-%m-%d")))
                        issue = op_acts.point(con, spec["point"])["sub_kind"] == "склад"
                        out.update(defaults={k: spec[k] for k in ("from", "to", "date", "number")},
                                   signers=op_acts.default_signers(con, spec["point"], spec["date"]),
                                   papers=op_acts.default_papers(spec["number"], spec["from"], spec["to"], spec["date"], issue))
                    try:
                        out.update(op_acts.compute(con, spec))
                    except state_db.SaveError as e:
                        if not filled:
                            raise
                        out.update(lines=[], warnings=[str(e)])      # напр. попередній акт уже сягає за дату нового
                    return self._send_json(200, out)
                if what == "delete":
                    try:                                 # видалене — лише з копією бази, де воно ще є
                        backup_state(force=True)
                    except (OSError, sqlite3.Error) as e:            # людині — слова, текст помилки — у консоль
                        print(f"Акт ОП/МЗ: копію бази перед видаленням не зроблено — {e!r}")
                        return self._send_json(500, {"ok": False, "error": "Копію бази перед видаленням не зроблено: "
                                                                          "перевірте місце на диску й доступ до теки копій. "
                                                                          "Акт не видалено."})
                    out["number"] = op_acts.delete(con, req.get("docId"), who=self.who, was=req.get("was"),
                                                   locked=req.get("locked") is True)
                    bump_state_version()
                    LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
                    return self._send_json(200, out)
                if what == "save":
                    if not force:                        # файл пакета правили руками — питання, перш ніж щось записати
                        try:
                            changed = sp_act_export.conflicts(con, folders()["spActs"], {
                                "number": req.get("number"), "date": str(req.get("date") or ""),
                                "label": " ".join(str(req.get("label") or "").split())}) if kind == "sp" else \
                                op_act_export.conflicts(con, folders()["opActs"], str(req.get("series") or ""),
                                                        str(req.get("date") or "")[:4],
                                                        " ".join(str(req.get("number") or "").split()))
                        except (KeyError, ValueError, OSError):
                            changed = []                 # серія чи дата не ті — відмовить сам op_acts.save
                        if changed:
                            raise op_act_export.PackageConflict(changed)
                    doc = mod.save(con, req, who=self.who)
                    saved = True
                    out.update(docId=doc, number=" ".join(str(req.get("number") or "").split()), sig=op_acts.sig_of(con, doc))
                else:
                    doc = req.get("docId")
                try:
                    out.update(export.write_package(con, doc, folders()[key], force=force))
                    saved = True                         # записи про файли пакета теж лягли в базу
                finally:
                    if saved:
                        bump_state_version()
                        LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
        except op_act_export.PackageConflict as e:
            body = {"ok": False, "error": str(e), "changed": e.changed}
            if saved and "docId" in out:                 # акт записано, а файли — ні: вікно стає цим актом
                body.update(docId=out["docId"], number=out["number"], sig=out["sig"],
                            error=f"Акт {out['number']} збережено, а файли не переписано: {e}")
            return self._send_json(409, body)
        except state_db.SaveError as e:
            if saved and "docId" in out:
                return self._send_json(422, {"ok": False, "docId": out["docId"], "number": out["number"], "sig": out["sig"],
                                             "error": f"Акт {out['number']} збережено, а файли не складено: {e}"})
            return self._send_json(422, {"ok": False, "error": str(e)})
        except Exception as e:                           # noqa: BLE001 — диск, права, шаблон, база: слова, а не обрив зв'язку
            if not isinstance(e, (OSError, sqlite3.Error)):
                traceback.print_exc()
            why = str(e) if isinstance(e, (OSError, sqlite3.Error)) else f"{type(e).__name__}: {e}"
            if saved and "docId" in out:                 # акт у базі лишився
                return self._send_json(500, {"ok": False, "docId": out["docId"], "number": out["number"], "sig": out["sig"],
                                             "error": f"Акт {out['number']} збережено, а файли не складено: {why}"})
            return self._send_json(500, {"ok": False, "error": why})
        if self.remote:
            try:
                out.update(remote_package(out["files"], os.path.basename(out["folder"])))
            except OSError as e:
                return self._send_json(500, {"ok": False, "docId": out.get("docId"), "number": out.get("number"),
                                             "error": f"Файли складено, а для завантаження не підготовлено: {e}"})
        return self._send_json(200, out)

    def _op_act_reveal(self, kind="op"):
        """«Відкрити теку» акта — на основному ПК; тека має лежати в теці актів свого виду з налаштувань."""
        import sp_act_export                                     # noqa: PLC0415
        import sp_acts                                           # noqa: PLC0415
        import op_act_export                                     # noqa: PLC0415
        import op_acts                                           # noqa: PLC0415
        req = self._object_body()
        if req is None:
            return
        try:
            with STATE_LOCK:
                a = (sp_acts if kind == "sp" else op_acts).act_of(db(), req.get("docId"))
            root = folders()["spActs" if kind == "sp" else "opActs"]
            folder = sp_act_export.act_dir(root, a) if kind == "sp" else \
                op_act_export.act_dir(root, a["series"], a["date"][:4], a["number"])
            if not os.path.isdir(folder) or not _inside(os.path.realpath(root), os.path.realpath(folder)):
                return self._send(404, "Теки акта ще немає: «Перескласти файли».".encode("utf-8"))
            return self._send_json(200, {"ok": True, "opened": open_file(folder)})
        except StateBroken as e:
            return self._send(500, str(e).encode("utf-8"))
        except state_db.SaveError as e:
            return self._send(404, str(e).encode("utf-8"))
        except Exception:                                # noqa: BLE001 — відповідь словами, а не обрив зв'язку
            traceback.print_exc()                        # подробиці — у консоль
            return self._send(500, "Теку акта не відкрито.".encode("utf-8"))

    def _sp_report(self):
        """Дні рапорту для акта сухпаю: {report, text?} → аркуш «Сухпай» вставкою (`text`) чи найновішої Добовки теки
        «Добовка» → дні, особи, підрозділ, акти, уже вписані в ці дні (`dobovka.report_days`). Ні в Добовку, ні в базу
        нічого не пишеться. Відмова — словами, речення з однією крапкою; несподіваний збій — теж словами (як `_dobovka`)."""
        import dobovka                                           # noqa: PLC0415
        req = self._object_body(MAX_SCAN)
        if req is None:
            return
        report = " ".join(str(req.get("report") or "").split())
        if not report:
            return self._send_json(400, {"ok": False, "error": "Вкажіть номер рапорту."})
        out = {"ok": True}
        try:
            if str(req.get("text") or "").strip():
                got = dobovka.parse_paste(req["text"])
                if got["kind"] != "sukhpai":
                    return self._send_json(422, {"ok": False, "error": "Вставте аркуш «Сухпай» Добовки: Ctrl+A, Ctrl+C."})
            else:
                path = dobovka.newest(folders()["dobovka"])
                if not path:
                    return self._send_json(404, {"ok": False, "error": "Теку Добовки не задано або в ній немає «Добовка*.xlsx»: "
                                                                        "«Налаштування» → «Теки» → «Добовка»; чи вставте аркуш «Сухпай»."})
                try:
                    with open(path, "rb") as f:
                        got = dobovka.read_sukhpai(f.read())
                except OSError as e:                         # тримає інша програма, немає доступу: слова — людині, шлях — у консоль
                    print(f"Добовка: {path} не прочитано — {e}")
                    return self._send_json(422, {"ok": False, "error": f"Файл «{os.path.basename(path)}» не прочитано: "
                                                                        "його тримає інша програма чи немає доступу."})
                out["file"] = os.path.basename(path)
            hit = dobovka.report_days(got["sukhpai"], report)
        except Exception:                                # noqa: BLE001 — відповідь словами, а не обрив зв'язку
            traceback.print_exc()                        # подробиці — у консоль
            return self._send_json(400, {"ok": False, "error": "Добовку не прочитано."})
        if hit is None:
            if got["problems"]:
                return self._send_json(404, {"ok": False, "error": _sukhpai_refusal(out.get("file"), got["problems"])})
            sheet = f"в аркуші «Сухпай» файла «{out['file']}»" if "file" in out else "у вставленому аркуші «Сухпай»"
            return self._send_json(404, {"ok": False, "error": f"Рапорту №{report} немає {sheet}."})
        out.update(hit)
        return self._send_json(200, out)

    def _dobovka(self, what):
        """Добовка — лише читання: вставка (текст із табуляціями) чи книга — найсвіжіша з теки «Добовка» або передана
        в тілі запиту. Ні в Добовку, ні в базу нічого не пишеться: відповідь — що прочитано і чого не вдалося."""
        import dobovka                                           # noqa: PLC0415
        query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
        arg = lambda k: (query.get(k) or [""])[0]                # noqa: E731
        out = {"ok": True}
        try:
            if what == "paste":
                req = self._object_body(MAX_SCAN)
                if req is None:
                    return
                # `end` — кінець періоду акта: стовпець чисел не пише днів після нього.
                got = dobovka.parse_paste(str(req.get("text") or ""), req.get("start"), req.get("end"))
                day, point = str(req.get("date") or ""), str(req.get("point") or "")
            else:
                try:
                    n = int(self.headers.get("Content-Length", 0) or 0)
                except ValueError:
                    n = 0
                if n > MAX_SCAN:
                    self._drain()
                    return self._send_json(413, {"ok": False, "error": "Файл завеликий (понад 40 МБ)."})
                data = self.rfile.read(n) if n > 0 else b""
                day, point = arg("date"), arg("point")
                if not data:
                    path = dobovka.newest(folders()["dobovka"])
                    if not path:
                        return self._send_json(404, {"ok": False, "error": "Теку Добовки не задано або в ній немає «Добовка*.xlsx»: "
                                                                            "«Налаштування» → «Теки» → «Добовка»."})
                    try:
                        with open(path, "rb") as f:
                            data = f.read()
                        saved = time.strftime("%Y-%m-%d %H:%M", time.localtime(os.path.getmtime(path)))
                    except OSError as e:                     # тримає інша програма, немає доступу: слова — людині, шлях — у консоль
                        print(f"Добовка: {path} не прочитано — {e}")
                        return self._send_json(422, {"ok": False, "error": f"Файл «{os.path.basename(path)}» не прочитано: "
                                                                            "його тримає інша програма чи немає доступу."})
                    out.update(file=os.path.basename(path), saved=saved)
                got = dobovka.read_file(data)
            signers = got.pop("signers")
            if day and point:
                out["signersDate"], out["signersAt"] = dobovka.signers_for(signers, day, point)
            out.update(got)
        except Exception:                                # noqa: BLE001 — відповідь словами, а не обрив зв'язку
            traceback.print_exc()                        # подробиці — у консоль
            return self._send_json(400, {"ok": False, "error": "Добовку не прочитано."})
        return self._send_json(200, out)

    def _ui_key(self):
        """Налаштування вікна (оформлення, чернетки) — свої в кожної людини."""
        return f"ui@{self.who}" if self.remote else "ui"

    def _post(self):
        """Вивантаження в Excel: сторінка описує таблицю, сервер пише .xlsx
        у «Дані обліку/вивантаження» й одразу відкриває його в Excel (на іншому ПК —
        віддає файл браузеру). /api/scan — підшити скан до документа."""
        route = self.path.split("?", 1)[0]
        if self.remote and route in HOST_ONLY:
            self._drain()
            return self._send(403, "Це можна зробити лише на основному ПК, де стоїть база.".encode("utf-8"))
        if route == "/api/network":
            try:
                return self._set_network()
            except (OSError, ValueError) as e:
                return self._send(500, str(e).encode("utf-8"))
        if route == "/api/scan":
            try:
                return self._save_scan()
            except (OSError, ValueError) as e:
                return self._send(500, str(e).encode("utf-8"))
        if route in ("/api/open", "/api/reveal"):
            try:
                return self._open_scan(reveal=route == "/api/reveal")
            except (OSError, ValueError) as e:
                return self._send(500, str(e).encode("utf-8"))
        if route == "/api/restore":
            try:
                return self._restore_backup()
            except (OSError, ValueError, sqlite3.Error, SchemaTooNewError, SchemaTooOldError) as e:
                return self._send(500, str(e).encode("utf-8"))
        if route == "/api/copy":
            return self._copy_away()
        if route == "/api/restore-file":
            try:
                return self._restore_file()
            except (OSError, ValueError, sqlite3.Error) as e:
                return self._send(500, str(e).encode("utf-8"))
        if route == "/api/scan-check":
            # Сторінка питає, чи всі підшиті файли справді лежать у теці:
            # запис у базі є, а файл могли не скопіювати разом із текою даних.
            spec = self._json_body(MAX_CHECK)
            if spec is None:
                return                             # завелике тіло: відповідь 413 уже надіслано
            listed = spec.get("paths")
            paths = [str(x) for x in (listed if isinstance(listed, list) else [])][:5000]
            asked = spec.get("files")
            files = [f for f in (asked if isinstance(asked, list) else []) if isinstance(f, dict)][:5000]
            missing = [p for p in paths if not scan_path(p)]
            missing_files = [f for f in files if not folder_path(f.get("folder"), f.get("path"))]
            body = json.dumps({"missing": missing, "missingFiles": missing_files}, ensure_ascii=False).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        if route == "/api/mtz-read":
            try:
                return self._read_mtz()
            except (OSError, ValueError) as e:
                return self._send(400, str(e).encode("utf-8"))
        if route == "/api/folders":
            return self._set_folders()
        if route == "/api/form2/submitted":
            return self._form2_upload(submitted=True)
        if route == "/api/form2/map-read":
            return self._form2_upload(submitted=False)
        if route == "/api/form2/submit":
            try:
                n = int(self.headers.get("Content-Length", 0) or 0)
                req = json.loads(self.rfile.read(n).decode("utf-8") or "{}") if n else {}
                year = int(req.get("year"))
            except (ValueError, TypeError):
                return self._send(400, "рік звіту — число".encode("utf-8"))
            with STATE_LOCK:
                rows = form2.snapshot(db(), year)
                bump_state_version()
                LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
            return self._send(200, json.dumps({"ok": True, "rows": rows}).encode("utf-8"), MIME[".json"])
        if route.startswith("/api/opysy/"):
            return self._opysy(route)
        if route == "/api/op-fes":
            return self._op_fes()
        # Книги обліку: вивантажити, переглянути, прийняти. ОП — свій модуль (з актами списання), СП і РП —
        # рушій book_xlsx; /api/op-book/* — так кличе сторінка 1.11.0.
        book_route = re.match(r"^/api/(?:book/(op|sp|rp)|op-book)/(export|preview|apply)$", route)
        if book_route:
            book = BOOK_URL[book_route.group(1) or "op"]
            action = book_route.group(2)
            if action == "export":
                self._drain()
                return self._op_export() if book == "ОП" else self._book_export(book)
            if action == "preview":
                return self._op_preview() if book == "ОП" else self._book_preview(book)
            return self._op_apply() if book == "ОП" else self._book_apply(book)
        if route == "/api/sp/q1prod":
            return self._sp_q1prod()
        if route == "/api/pur-book/export":
            self._drain()
            return self._pur_export()
        if route == "/api/pur-book/preview":
            return self._pur_preview()
        if route == "/api/pur-book/apply":
            return self._pur_apply()
        if route == "/api/history-read":
            try:
                return self._read_history()
            except (OSError, ValueError) as e:
                return self._send(400, str(e).encode("utf-8"))
        if route in ("/api/folder-link", "/api/files-find"):
            req = self._json_body()
            if req is None:
                return                             # завелике тіло: відповідь 413 уже надіслано
            return self._folder_link(req) if route == "/api/folder-link" else self._files_find(req)
        if route == "/api/pur-paper":
            return self._pur_paper()
        if route in ("/api/op-act/preview", "/api/op-act/save", "/api/op-act/files", "/api/op-act/delete"):
            return self._op_act(route.rsplit("/", 1)[-1])
        if route == "/api/op-act/reveal":
            return self._op_act_reveal()
        if route in ("/api/sp-act/preview", "/api/sp-act/save", "/api/sp-act/files", "/api/sp-act/delete"):
            return self._op_act(route.rsplit("/", 1)[-1], "sp")
        if route == "/api/sp-act/reveal":
            return self._op_act_reveal("sp")
        if route == "/api/sp-act/report":
            return self._sp_report()
        if route in ("/api/dobovka/read", "/api/dobovka/paste"):
            return self._dobovka(route.rsplit("/", 1)[-1])
        if route != "/api/excel":
            return self._send(404, b"not found")
        try:
            import book47_export                                # noqa: PLC0415
            import excel_export                                 # noqa: PLC0415
            import excel_names                                  # noqa: PLC0415
            import history_import                               # noqa: PLC0415
            import mtz_export                                   # noqa: PLC0415
            import op_request                                   # noqa: PLC0415
            import techact_export                               # noqa: PLC0415
            import valuation_export                             # noqa: PLC0415
            n = int(self.headers.get("Content-Length", 0))
            spec = json.loads(self.rfile.read(n).decode("utf-8"))
            folder = os.path.join(DATA, "вивантаження")
            # Бланки служби заповнюються кожен своєю функцією; решта — таблиця.
            writer = {"invoice": excel_export.save_invoice,
                      "recon": excel_export.save_recon,
                      "recon-journal": excel_export.save_recon_journal,
                      "inventory": excel_export.save_inventory,
                      "book47": book47_export.save_book47,
                      "mtz": mtz_export.save_mtz,
                      "history-template": history_import.save_template,
                      # Відомість залишкової вартості в бланку Додатка 1 до Методики.
                      "valuation": valuation_export.save_valuation,
                      # Акт якісного (технічного) стану — у Word, за бланком.
                      "tech_act": techact_export.save_tech_act,
                      # Форма 21/Прод у бланку вищого штабу — зі звіту по базі.
                      "form21": lambda s, f: form21.save_form21(db(), s, f),
                      # Комплект: зведена, управління й кожен батальйон — книгою й окремими файлами.
                      "form21set": lambda s, f: form21.save_form21_set(db(), s, f),
                      # Книги обліку № 47 і № 14 за рік — паперові томи й електронні, по базі.
                      "journals": lambda s, f: journals.save_journals(db(), s, f),
                      # Звіт-заявка 2/прод у бланку А2788 і проєкт пояснювальної — у теку звітів.
                      "form2": lambda s, f: form2.save_package(db(), s, folders()["reports"]),
                      "form2note": lambda s, f: form2.save_note(db(), s, folders()["reports"]),
                      # Звіт про продовольчу тару 11/прод за квартал — у теку звітів «<рік>\<N> квартал\11прод».
                      "form11": lambda s, f: form11_book(s),
                      # Заявка на посуд, миючі й серветки на 30 днів за нормами наказу №390 — у Word.
                      "op_request": lambda s, f: op_request.save_request(db(), s, folders()["requests"]),
                      }.get(spec.get("kind"), excel_export.save)
            path = writer(spec, folder)
            # Шапка на кожній сторінці й область друку — іменами, які розуміє Excel цього
            # комп'ютера. Готову книгу тримає інша програма — вона лишається зі стандартними.
            if path.lower().endswith(".xlsx"):
                with contextlib.suppress(OSError):
                    excel_names.localize_file(path)
            if self.remote:
                # Файл міг лягти в теку з налаштувань (пакет 2/прод) — тоді віддаємо його копію.
                body = json.dumps(dict({"ok": True, "opened": False}, **remote_any(path)),
                                  ensure_ascii=False).encode("utf-8")
                return self._send(200, body, MIME[".json"])
            opened = open_file(path)
            body = json.dumps({"ok": True, "path": path, "opened": opened},
                              ensure_ascii=False).encode("utf-8")
            self._send(200, body, MIME[".json"])
        except Exception as e:                                  # noqa: BLE001
            body = json.dumps({"ok": False, "error": str(e)}, ensure_ascii=False)
            self._send(500, body.encode("utf-8"), MIME[".json"])

    def _put_ui(self):
        """Налаштування вікна окремо від обліку — без звірки версії."""
        try:
            n = int(self.headers.get("Content-Length", 0))
            ui = json.loads(self.rfile.read(n).decode("utf-8"))
            if not isinstance(ui, dict):
                return self._send(422, "налаштування вікна мають бути об'єктом".encode("utf-8"))
            with STATE_LOCK:
                save_ui(ui, self._ui_key())
                version = state_version()
            body = json.dumps({"ok": True, "version": version}).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        except (ValueError, OSError, sqlite3.Error, StateBroken) as e:
            return self._send(500, str(e).encode("utf-8"))

    def _put(self):
        path, _, query = self.path.partition("?")
        if path == "/api/ui":
            return self._put_ui()
        if path != "/api/state":
            return self._send(404, b"not found")
        try:
            n = int(self.headers.get("Content-Length", 0))
            body = self.rfile.read(n)
            state = json.loads(body.decode("utf-8"))
            if not isinstance(state, dict):
                return self._send(422, "стан обліку має бути об'єктом з розділами".encode("utf-8"))
            with STATE_LOCK:
                seen = self.headers.get("X-State-Version")
                if seen and seen != state_version():
                    msg = "дані змінено в іншому вікні програми"
                    return self._send(409, msg.encode("utf-8"))
                units = save_state(state, force_backup="backup=1" in query, replace_papers="papers=replace" in query,
                                   ui_key=self._ui_key())
                LAST_WRITE.update(who=self.who, at=time.strftime("%H:%M"))
                # Id щойно внесених документів: вікно впише їх у свої рядки, і
                # виправлення оновить запис, а не створить документ наново. Так
                # само — id щойно заведених одиниць реєстру й рапортів про знищення.
                answer = json.dumps({"ok": True, "version": state_version(),
                                     "ids": state_db.doc_ids(db()), "units": units,
                                     "reports": state_db.LAST_SAVE["reports"]}, ensure_ascii=False)
            self._send(200, answer.encode("utf-8"), MIME[".json"])
        except state_db.SaveError as e:
            # Запис, який база не приймає (перекриті строки, дві записи на ту саму
            # дату): повтор нічого не дасть, тож окремий код — вікно не повторює
            # запис кожні 5 секунд, а каже людині, що виправити.
            self._send(422, str(e).encode("utf-8"))
        except (ValueError, OSError, sqlite3.Error) as e:
            self._send(500, str(e).encode("utf-8"))
        except Exception as e:                                  # noqa: BLE001
            # Несподівана помилка запису не має обривати зв'язок без відповіді:
            # вікно тоді бачить «програма не відповідає» і повторює той самий
            # запис без кінця. Відповідь — словами, слід — у консолі.
            traceback.print_exc()
            self._send(500, f"{type(e).__name__}: {e}".encode("utf-8"))


def _plan_text(plan):
    """Відмінності книги від бази (`purchases_book.diff`, `op_book.diff`) одним рядком JSON із відсортованими ключами: так
    порівнюються «що людина бачила при перегляді» й «що прийом зробив би тепер»."""
    return json.dumps(plan, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def remote_any(path):
    """Що віддати браузеру іншого ПК, коли файл ліг у теку з налаштувань (поза «вивантаженням»,
    звідки його віддає `api/file`): його копію у «вивантаженні»."""
    base = os.path.join(DATA, "вивантаження")
    if not os.path.realpath(path).startswith(os.path.realpath(base) + os.sep):
        os.makedirs(base, exist_ok=True)
        copy = os.path.join(base, os.path.basename(path))
        shutil.copy2(path, copy)
        path = copy
    return remote_export(base, path)


def remote_package(files, name):
    """Файли акта для іншого ПК: копія в «вивантаження/<назва теки акта>» і zip цієї теки на завантаження."""
    base = os.path.join(DATA, "вивантаження")
    pkg = os.path.join(base, name)
    os.makedirs(pkg, exist_ok=True)
    for f in files:
        shutil.copy2(f, os.path.join(pkg, os.path.basename(f)))
    return remote_export(base, os.path.join(pkg, os.path.basename(files[0])))


def remote_export(folder, path):
    """Що віддати браузеру іншого ПК: сам файл або — коли вивантаження лягло в теку
    (комплект 21/Прод, книги за рік) — цю теку одним zip-архівом."""
    rel = os.path.relpath(path, folder)
    top = rel.split(os.sep)[0]
    target = path
    if top != rel:
        target = os.path.join(folder, top + ".zip")
        import zipfile                                         # noqa: PLC0415
        with zipfile.ZipFile(target, "w", zipfile.ZIP_DEFLATED) as z:
            for dp, _, fs in os.walk(os.path.join(folder, top)):
                for f in sorted(fs):
                    full = os.path.join(dp, f)
                    z.write(full, os.path.relpath(full, folder))
    name = os.path.relpath(target, folder).replace(os.sep, "/")
    return {"path": target, "download": "api/file?p=" + quote(name)}


def form11_book(spec):
    """Книга 11/прод кварталу в теці звітів; читання бази — під замком, як усі читання."""
    with STATE_LOCK:
        return form11.save_book(db(), spec, folders()["reports"])


def open_file(path):
    """Відкриває файл програмою, призначеною в системі (для .xlsx — Excel)."""
    if os.environ.get("OBLIK_NO_OPEN"):
        return False                         # перевірки без вікон Excel
    try:
        if sys.platform.startswith("win"):
            os.startfile(path)               # noqa: S606
        elif sys.platform == "darwin":
            subprocess.Popen(["open", path])
        else:
            subprocess.Popen(["xdg-open", path])
        return True
    except OSError:
        return False


def _rooted(rel):
    """Шлях із диском, коренем чи мережевим ім'ям — не відносний до теки, а отже, чужий для неї."""
    text = str(rel or "")
    return bool(ntpath.splitdrive(text)[0]) or text[:1] in ("/", "\\")


def _inside(root, full):
    """`full` лежить усередині теки `root` (обидва — після realpath) і не збігається з нею.
    Корінь диска вже кінчається роздільником, тож `root + os.sep` для нього нічого б не пропускало."""
    prefix = root if root.endswith(os.sep) else root + os.sep
    return full.startswith(prefix) and full != prefix


def _is_link(path):
    """Символьне посилання чи з'єднання (junction) на каталог."""
    junction = getattr(os.path, "isjunction", lambda p: False)           # до Python 3.12 з'єднань не розрізняє
    return os.path.islink(path) or junction(path)


def scan_path(rel, root=None):
    """Повний шлях до скана або None, якщо його немає чи він веде за межі теки.

    Без `root` шукає в «Дані обліку/скани», з `root` — у теці служби з налаштувань (див. `folder_path`).

    Ім'я файла шукається й у зведеному, і в розкладеному вигляді Unicode («ї» =
    «і» + дві крапки): тека даних могла пройти через систему, яка нормалізує
    імена по-своєму, і тоді точний шлях із бази не збігається з тим, що на диску.
    """
    # Шлях із диском, коренем чи мережевим ім'ям — відмова ще до першого звернення до диска: навіть щоб лише
    # перевірити, чи шлях у межах теки, Windows відкрила б мережеве ім'я (\\хост\ресурс) входом на чужу машину.
    if _rooted(rel):
        return None
    root = os.path.realpath(root or os.path.join(DATA, "скани"))
    full = os.path.realpath(os.path.join(root, str(rel or "")))
    if not _inside(root, full):
        return None
    if os.path.isfile(full):
        return full
    import unicodedata                                      # noqa: PLC0415
    head, tail = os.path.split(full)
    if not os.path.isdir(head):
        head_alt = None
        for form in ("NFC", "NFD"):
            cand = unicodedata.normalize(form, head)
            if os.path.isdir(cand):
                head_alt = cand
                break
        if head_alt is None:
            return None
        head = head_alt
    want = unicodedata.normalize("NFC", tail).lower()
    try:
        for entry in os.listdir(head):
            found = os.path.join(head, entry)
            # Підтека з таким самим іменем — не файл, віддати її не можна.
            if unicodedata.normalize("NFC", entry).lower() == want and os.path.isfile(found):
                # Знайдене за іншим написанням може бути посиланням за межі теки: перевірка та сама, що й для точного шляху.
                real = os.path.realpath(found)
                if _inside(root, real):
                    return real
    except OSError:
        pass
    return None


def folder_path(key, rel):
    """Файл у теці з налаштувань (ключ FOLDERS) — лише в її межах; None, якщо ключа чи файла немає."""
    root = folders().get(str(key or ""))
    return scan_path(rel, root) if root else None


def dir_path(rel, root, make=False):
    """Повний шлях до каталогу `rel` усередині теки `root` або None: шлях виводить за межі теки (вгору, диск, мережеве ім'я,
    посилання), каталогу немає, а створювати його не веліли. Сама тека `root` теж каталог (порожній `rel`). Перевірки ті самі,
    що й для файла (`scan_path`): відмова шляху від кореня чи з диском — до будь-якого звернення до диска.

    make — створити каталог (з усім проміжним), якщо його ще немає: після тих самих перевірок, лише всередині теки. Що Windows
    не дає створити (ім'я, якого вона не приймає, файл на місці проміжного каталогу, недоступний диск) — OSError нагору."""
    if _rooted(rel):
        return None
    text = str(rel or "")
    try:
        base = os.path.realpath(root)
        full = os.path.realpath(os.path.join(base, text))
    except (ValueError, OSError):
        return None
    if full != base and not _inside(base, full):
        return None
    if os.path.isdir(full):
        return full
    import unicodedata                                      # noqa: PLC0415
    for form in ("NFC", "NFD"):                              # тека могла пройти через систему, що зводить імена по-своєму
        alt = os.path.realpath(os.path.join(base, unicodedata.normalize(form, text)))
        if alt != full and _inside(base, alt) and os.path.isdir(alt):
            return alt
    if make and not os.path.lexists(full):
        os.makedirs(full, exist_ok=True)
        return full
    return None


def file_sha(path):
    """Відбиток вмісту файла: за ним програма знаходить файл після перекладки тек. Це стабільний відбиток (`stable_hash`):
    для .xls він не залежить від мітки часу, яку Excel дописує, коли файл просто відкрили для правки."""
    return stable_hash.stable_sha(path)


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def find_browser():
    """Edge або Chrome для вікна без адресного рядка.

    Спершу питаємо реєстр (App Paths) — так знаходимо браузер там, де його
    реально встановили, а не лише за типовими шляхами."""
    import winreg
    key = ("SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\")
    for name in ("msedge.exe", "chrome.exe"):
        for hive in (winreg.HKEY_LOCAL_MACHINE, winreg.HKEY_CURRENT_USER):
            try:
                with winreg.OpenKey(hive, key + name) as k:
                    path = winreg.QueryValueEx(k, "")[0].strip('"')
                if os.path.exists(path):
                    return path
            except OSError:
                pass
    for p in EDGE_CANDIDATES:
        if os.path.exists(p):
            return p
    return None


WINDOW_PROFILE = "oblik-tz-ps-window-"


def sweep_window_profiles(older_than=6 * 3600):
    """Прибирає профілі вікна, що лишилися після аварійного завершення.

    Профіль вікна живе в тимчасовій теці й видаляється, коли програму закрили
    як слід. Якщо ж її зняли з процесів, тека лишалася назавжди — по кілька
    десятків мегабайт за кожен такий раз."""
    root = tempfile.gettempdir()
    now = time.time()
    try:
        names = os.listdir(root)
    except OSError:
        return
    for name in names:
        if not name.startswith(WINDOW_PROFILE):
            continue
        path = os.path.join(root, name)
        try:
            if os.path.isdir(path) and now - os.path.getmtime(path) > older_than:
                shutil.rmtree(path, ignore_errors=True)
        except OSError:
            pass


def window_size():
    """Розмір вікна під робочу область екрана, у логічних пікселях.

    Не більше 1500×940 (стільки треба таблицям на великому моніторі) і не менше
    1100×700 (нижче програма вже не читається — тоді хай буде прокрутка)."""
    try:
        import ctypes
        from ctypes import wintypes
        user32 = ctypes.windll.user32
        try:
            ctypes.windll.shcore.SetProcessDpiAwareness(1)     # фізичні пікселі
        except (AttributeError, OSError):
            pass
        rect = wintypes.RECT()
        if not user32.SystemParametersInfoW(0x30, 0, ctypes.byref(rect), 0):  # SPI_GETWORKAREA
            raise OSError("робоча область невідома")
        try:
            scale = user32.GetDpiForSystem() / 96.0
        except AttributeError:
            scale = 1.0
        w = int((rect.right - rect.left) / scale) - 24
        h = int((rect.bottom - rect.top) / scale) - 48
        return max(1100, min(1500, w)), max(700, min(940, h))
    except Exception:                                   # noqa: BLE001 — будь-який збій: типовий розмір
        return 1500, 940


def window_args(browser, url, profile):
    """Командний рядок вікна програми.

    Профіль браузера щоразу новий, і Edge на комп'ютері, де Windows увійшла в
    обліковий запис Microsoft, сприймає це як перший запуск: сам входить у запис,
    вмикає синхронізацію й кидає поверх програми вікно «Данные браузера теперь
    синхронизируются». Тому Edge відкриває вікно InPrivate — без входу,
    синхронізації й першого запуску. Облік від цього нічого не втрачає: стан
    живе в «Дані обліку», а не в браузері."""
    w, h = window_size()
    args = [browser, f"--app={url}", f"--user-data-dir={profile}",
            f"--window-size={w},{h}", "--window-position=12,12",
            "--no-first-run", "--no-default-browser-check",
            "--disable-sync",
            "--disable-features=Translate,AutofillServerCommunication,msImplicitSignin"]
    if os.path.basename(browser).lower() == "msedge.exe":
        args.insert(1, "--inprivate")
    return args


RUNNING = ".програма запущена"
# Чи слухає сервер мережу (налаштування могли змінити без перезапуску).
NET_LISTENING = {"on": False}


class NetServer(ThreadingHTTPServer):
    """Сервер для інших ПК. Порт — лише свій: у Windows SO_REUSEADDR дав би другій програмі
    (інша частина на тому самому ПК) «зайняти» той самий порт, і запити йшли б навмання."""
    allow_reuse_address = False


def close_database():
    """Закриває з'єднання чисто: SQLite прибирає -wal і -shm, і теку даних можна
    копіювати як є. Вихід процесу без close() лишав їх поруч із базою."""
    with STATE_LOCK:
        con = _DB_CON["con"]
        if con is not None:
            try:
                con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            con.close()
        _DB_CON.update(path=None, con=None)


def already_running():
    """Порт уже запущеної копії програми з цією ж текою даних або None.

    Два вікна на один файл стану перезаписують одне одного: зміни, внесені в
    першому, зникають, щойно друге збереже свій застарілий стан. Тому друга
    копія не запускається, а відсилає людину до першої."""
    path = os.path.join(DATA, RUNNING)
    try:
        with open(path, encoding="utf-8") as f:
            port = int(json.load(f)["port"])
    except (OSError, ValueError, KeyError, TypeError):
        return None
    import urllib.request
    try:
        with urllib.request.urlopen(f"http://127.0.0.1:{port}/api/ping", timeout=1.5) as r:
            if r.read().decode("utf-8", "ignore") == APP_NAME:
                return port
    except OSError:
        pass
    return None                                   # позначка лишилась після збою


def mark_running(port):
    try:
        with open(os.path.join(DATA, RUNNING), "w", encoding="utf-8") as f:
            json.dump({"port": port, "pid": os.getpid()}, f)
    except OSError:
        pass


def unmark_running():
    path = os.path.join(DATA, RUNNING)
    try:
        with open(path, encoding="utf-8") as f:
            if json.load(f).get("pid") != os.getpid():
                return
        os.remove(path)
    except (OSError, ValueError):
        pass


def say(text):
    if getattr(sys, "frozen", False):
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, text, APP_NAME, 0x40)
    else:
        print(text)


def main():
    global DATA, STATE
    DATA = data_dir(probe=True)             # тут, а не при імпорті: теку створює лише запуск
    STATE = os.path.join(DATA, "стан обліку.json")
    if already_running():
        say(f"«{APP_NAME}» уже відкрито. Знайдіть його вікно на панелі завдань.")
        return
    sweep_window_profiles()
    server = None
    cfg = net_cfg()
    if cfg.get("on") and cfg.get("code"):
        # Інші ПК знаходять програму за сталою адресою: ім'я цього ПК і порт.
        try:
            port = int(cfg.get("port") or network.DEFAULT_PORT)
            server = NetServer(("0.0.0.0", port), Handler)
            NET_LISTENING["on"] = True
        except (OSError, ValueError) as e:
            say(f"Робота в мережі: порт {cfg.get('port')} зайнятий чи недоступний ({e}). "
                "Програма відкриється лише на цьому ПК.")
    if server is None:
        port = free_port()
        server = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    mark_running(port)
    url = f"http://127.0.0.1:{port}/index.html"

    browser = find_browser()
    profile = os.path.join(tempfile.gettempdir(), f"{WINDOW_PROFILE}{port}")
    if browser:
        proc = subprocess.Popen(window_args(browser, url, profile))
        try:
            proc.wait()
        except KeyboardInterrupt:
            pass
    else:
        # Ні Edge, ні Chrome не знайдено — відкриваємо у браузері за замовчуванням.
        # У зібраній програмі консолі немає, тому тримаємо процес модальним вікном.
        import webbrowser
        webbrowser.open(url)
        if getattr(sys, "frozen", False):
            import ctypes
            ctypes.windll.user32.MessageBoxW(
                0,
                f"{APP_NAME} відкрито у браузері за замовчуванням.\n\n"
                f"Адреса: {url}\nДані: {DATA}\n\n"
                "Натисніть OK, коли закінчите роботу — програма завершиться.",
                APP_NAME, 0x40)
        else:
            print(f"{APP_NAME}: {url}\nCtrl+C — зупинити.")
            try:
                while True:
                    time.sleep(1)
            except KeyboardInterrupt:
                pass

    server.shutdown()
    close_database()
    unmark_running()
    shutil.rmtree(profile, ignore_errors=True)


if __name__ == "__main__":
    main()
