# -*- coding: utf-8 -*-
"""Облік ТЗ ПС — запуск як програма Windows.

Піднімає локальний сервер на вільному порту (тільки 127.0.0.1, назовні нічого
не слухає) і відкриває вікно WebView2 без адресного рядка й вкладок. Коли на
основному ПК увімкнено роботу в мережі (⚙ → «Робота в мережі»), сервер слухає й
мережу на сталому порту, а інші ПК відкривають програму в браузері — з кодом доступу
(див. network.py). Стан
користувача — норми, проведені документи, записи знищення — лягає в ту саму
базу `Дані обліку/oblik.sqlite`, що й облік із паперів: один файл, який видно,
можна покласти в резервну копію або перенести на інший комп'ютер.

Коли вікно закривають, сервер зупиняється разом із програмою.
"""
import sys, os, re, io, json, socket, sqlite3, threading, subprocess, tempfile, shutil, time
import contextlib
import gc
import traceback
from collections import OrderedDict
from urllib.parse import quote, unquote, parse_qs
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

APP_NAME = "Облік ТЗ ПС"
ASSETS = ("index.html", "style.css", "app.js")
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
from db.connect import (apply_migrations, checked_version, current_version,   # noqa: E402
                        APP_SCHEMA_VERSION, SchemaTooNewError, SchemaTooOldError)
from build import export_app_data                     # noqa: E402
from build import verify_db                           # noqa: E402
from reports import form21, journals                  # noqa: E402

ROOT = base_dir()
DATA = data_dir()
STATE = os.path.join(DATA, "стан обліку.json")
STATE_LOCK = threading.Lock()
# Робота в мережі: налаштування з теки даних, підбір коду, хто записав останнім.
_NET = {"cfg": None, "data": None}
GATE = network.Gate()
LAST_WRITE = {"who": "", "at": ""}
# Що можна зробити лише на самому основному ПК: відновити базу з копії чи файла, зберегти
# копію діалогом Windows, відкрити файл чи теку програмою цього ПК, змінити налаштування мережі.
HOST_ONLY = {"/api/restore", "/api/restore-file", "/api/copy", "/api/reveal", "/api/open", "/api/network"}


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


def backup_before_upgrade(con) -> str:
    """Копія бази перед оновленням схеми — у «Дані обліку/копії», з позначкою
    в імені. Без копії оновлення не йде: міграція може змінювати дані."""
    backups = os.path.join(DATA, "копії")
    stamp = time.strftime("%Y-%m-%d %H%M%S")
    target = os.path.join(backups, f"{BACKUP_NAME}{stamp} перед оновленням{BACKUP_EXT}")
    n = 2
    while os.path.exists(target):
        target = os.path.join(backups, f"{BACKUP_NAME}{stamp} перед оновленням-{n}{BACKUP_EXT}")
        n += 1
    try:
        os.makedirs(backups, exist_ok=True)
        con.execute("VACUUM INTO ?", (target,))
    except (OSError, sqlite3.Error) as e:
        raise StateBroken(f"перед оновленням бази не вдалося зберегти її копію: {e}") from e
    copy_away(target)
    return target


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
        if n > 0:
            self.rfile.read(n)

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
        """Налаштування мережі з ⚙ основного ПК. Діють після перезапуску програми."""
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
        base = os.path.realpath(os.path.join(DATA, "вивантаження"))
        full = os.path.realpath(os.path.join(base, rel))
        if not full.startswith(base + os.sep) or not os.path.isfile(full):
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
        if path == "api/backups":
            body = json.dumps(list_backups(), ensure_ascii=False).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        if path == "api/verify":
            # Звірка бази за правилами обліку — та сама, що й build/verify_db.py,
            # але для людини без Python: кнопка в ⚙.
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
                return self._send(500, str(e).encode("utf-8"))
            return self._send(200, body, MIME[".js"])
        if path in ASSET_CACHE:
            ext = os.path.splitext(path)[1]
            return self._send(200, ASSET_CACHE[path], MIME.get(ext, "application/octet-stream"))
        if path.startswith(SCANS):
            query = parse_qs(self.path.split("?", 1)[1]) if "?" in self.path else {}
            return self._send_scan(path[len(SCANS):], (query.get("w") or [""])[0])
        self._send(404, b"not found")

    def _send_scan(self, rel, w=""):
        """Скан первинного документа з теки даних; `w` — мініатюра фото.

        Шлях складається лише з того, що записано в базі, але приходить він від
        сторінки, тому перевіряється ще раз: за межі теки сканів вийти не можна.
        """
        full = scan_path(rel)
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

    def _scan_file(self):
        """Файл із теки сканів за шляхом, що прийшов від сторінки, — або None,
        якщо шлях виводить за межі теки чи файла немає."""
        n = int(self.headers.get("Content-Length", 0))
        spec = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
        return scan_path(spec.get("path"))

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

    def _open_scan(self, reveal=False):
        """Відкрити файл програмою Windows або показати його в теці."""
        full = self._scan_file()
        if not full:
            return self._send(404, "файла немає в теці «Дані обліку/скани»".encode("utf-8"))
        ok = False
        if not os.environ.get("OBLIK_NO_OPEN") and sys.platform.startswith("win"):
            try:
                if reveal:
                    subprocess.Popen(["explorer", "/select,", full])   # noqa: S603, S607
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
        Наявний файл не перезаписується — до імені додається «(2)»."""
        n = int(self.headers.get("Content-Length", 0))
        if n <= 0 or n > MAX_SCAN:
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
        if ext not in SCAN_EXT:
            return self._send(415, ("тип файла не підходить. Потрібні PDF, фото, документи "
                                    "Office, текст, архів або підписаний файл").encode("utf-8"))
        year = date[:4] if re.match(r"\d{4}-\d{2}-\d{2}$", date) else time.strftime("%Y")
        # Підтека — лише зі звичайних імен: без «..», без дисків, не глибше трьох рівнів.
        parts = [BAD_FILE_CHARS.sub("-", p).strip(" .")
                 for p in unquote(self.headers.get("X-Folder", "") or "").replace("\\", "/").split("/")]
        parts = [p[:60] for p in parts if p][:3]
        folder = os.path.join(DATA, "скани", *(parts or [year]))
        os.makedirs(folder, exist_ok=True)
        base = BAD_FILE_CHARS.sub("-", " ".join(x for x in (date, label, stem.strip()) if x))[:120].strip(" .") or "скан"
        target, k = os.path.join(folder, base + ext), 2
        while os.path.exists(target):
            target = os.path.join(folder, f"{base} ({k}){ext}")
            k += 1
        tmp = target + ".part"
        with open(tmp, "wb") as f:
            f.write(body)
        os.replace(tmp, target)
        rel = os.path.relpath(target, os.path.join(DATA, "скани")).replace(os.sep, "/")
        answer = {"ok": True, "path": rel, "file": os.path.basename(target), "size": n}
        self._send(200, json.dumps(answer, ensure_ascii=False).encode("utf-8"), MIME[".json"])

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
            n = int(self.headers.get("Content-Length", 0))
            spec = json.loads(self.rfile.read(n).decode("utf-8") or "{}")
            paths = [str(x) for x in (spec.get("paths") or [])][:5000]
            missing = [p for p in paths if not scan_path(p)]
            body = json.dumps({"missing": missing}, ensure_ascii=False).encode("utf-8")
            return self._send(200, body, MIME[".json"])
        if route == "/api/mtz-read":
            try:
                return self._read_mtz()
            except (OSError, ValueError) as e:
                return self._send(400, str(e).encode("utf-8"))
        if route == "/api/history-read":
            try:
                return self._read_history()
            except (OSError, ValueError) as e:
                return self._send(400, str(e).encode("utf-8"))
        if route != "/api/excel":
            return self._send(404, b"not found")
        try:
            import book47_export                                # noqa: PLC0415
            import excel_export                                 # noqa: PLC0415
            import excel_names                                  # noqa: PLC0415
            import history_import                               # noqa: PLC0415
            import mtz_export                                   # noqa: PLC0415
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
                      }.get(spec.get("kind"), excel_export.save)
            path = writer(spec, folder)
            # Шапка на кожній сторінці й область друку — іменами, які розуміє Excel цього
            # комп'ютера. Готову книгу тримає інша програма — вона лишається зі стандартними.
            if path.lower().endswith(".xlsx"):
                with contextlib.suppress(OSError):
                    excel_names.localize_file(path)
            if self.remote:
                body = json.dumps(dict({"ok": True, "opened": False}, **remote_export(folder, path)),
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


def scan_path(rel):
    """Повний шлях до скана або None, якщо його немає чи він веде за межі теки.

    Ім'я файла шукається й у зведеному, і в розкладеному вигляді Unicode («ї» =
    «і» + дві крапки): тека даних могла пройти через систему, яка нормалізує
    імена по-своєму, і тоді точний шлях із бази не збігається з тим, що на диску.
    """
    root = os.path.realpath(os.path.join(DATA, "скани"))
    full = os.path.realpath(os.path.join(root, str(rel or "")))
    if not full.startswith(root + os.sep):
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
            if unicodedata.normalize("NFC", entry).lower() == want:
                return os.path.join(head, entry)
    except OSError:
        pass
    return None


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
