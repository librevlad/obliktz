# -*- coding: utf-8 -*-
"""Дистрибутив без даних власника: програма, чиста база, інструкція, вихідний код.

Чиста база будується конструктивно — з міграцій і загальних сідів, а не
вичищенням робочої: так у неї не потрапляє нічого з обліку частини. У ній є
схема, довідники (одиниці виміру, розділи табеля 21/Прод, види документів,
підрозділів і контрагентів), табельні форми 21/Прод, 2/Прод і 3/Прод з
каталогом табельних позицій (назви, одиниці й вид обліку — без цін, номерів
ФЕС, заводських номерів і приміток), дерево з двох вузлів («Військова
частина» і «склад») і порожні реквізити. Решту нова служба вносить сама —
про це «ПРОЧИТАЙТЕ.txt» поруч із програмою й «Інструкція користувача.docx».

Вихідний код кладеться поруч у теку «Вихідний код»: застосунок, лаунчер,
схема з міграціями, збірка, звіти — без тестів, сідів і витягів з даними
частини (їх у поставці немає навмисно, див. README у тій теці).

    python build/make_distro.py            # -> dist/Облік ТЗ ПС <версія> — дистрибутив <дата>.zip
                                           #    і тека релізу dist/релізи/<версія>/ для Google Drive
    python build/make_distro.py --db шлях  # лише чиста база

Той самий відбір вихідного коду іде на GitHub — `build/publish_github.py`.
"""
import argparse
import datetime
import fnmatch
import json
import re
import shutil
import sys
import zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "build")]

from db.connect import close_db, open_db                      # noqa: E402
from db.sqlscript import statements                            # noqa: E402
import migrate_to_db as MG                                     # noqa: E402
from make_manual import build_manual                           # noqa: E402
from build.version import APP_VERSION, APP_VERSION_DATE        # noqa: E402

EXTRACT = ROOT / "build" / "data" / "extract.json"
VERSIONS = ROOT / "docs" / "версії.md"
EXE = ROOT / "dist" / "Облік ТЗ ПС.exe"          # зібрана програма (build_exe.py)
# Табельні форми й каталог табельних позицій — загальні для служби.
CATALOG_SEEDS = ["form21_lines.sql", "form21_map.sql", "form3_lines.sql", "form2_lines.sql"]
# Номери ФЕС потрібні лише на мить — виставити вид обліку за правилом db/rules/asset_class.sql;
# далі стираються.
FES_SEEDS = ["fes_codes.sql", "nomen_enrich.sql"]
# У сідах форм поруч із рядками табеля й прив'язкою позицій лежить і штат
# частини (norm) — його в чисту базу не беремо: свій штат служба задає сама.
CATALOG_TABLES = {"report_form", "report_line", "nomen_report_line", "nomen"}
UNIT_DEFAULTS = {
    "unit_legal_name": "Військова частина", "unit_edrpou": "", "service_full": "Продовольча служба",
    "invoice_valid_days": "1", "service_chief": "", "accountant": "",
    "commission_head": "", "commission_members": "",
}
# Що не має лишитися в чистій базі: перелік для перевірки після збірки.
MUST_BE_EMPTY = ("document", "document_line", "document_link", "attachment", "person",
                 "person_history", "official", "responsible", "counterparty", "instance",
                 "instance_assignment", "instance_condition", "norm", "reconciliation",
                 "reconciliation_line", "inventory", "inventory_member", "inventory_mvo",
                 "inventory_file", "nomen_file", "unit_location", "subdivision_alias", "place",
                 "audit_log", "app_destroyed", "app_file", "app_inventory", "app_inventory_cell",
                 "app_log", "app_recon", "app_recon_line", "app_setting", "app_subst", "app_paper", "app_paper_version")

# Вихідний код у поставці: що береться. Генератори початкових даних (make_*_seed,
# read_*, link_*, check_*), тести й початкові дані прив'язані до обліку конкретної
# частини — у поставку не входять.
SOURCE_GLOBS = {
    "app": ["*.html", "*.css", "*.js"],
    "desktop": ["*.py", "icon.ico", "templates/*.xlsx"],
    "db": ["*.py", "migrations/*.sql", "rules/*.sql", "seed/form21_lines.sql", "seed/form2_lines.sql",
           "seed/form3_lines.sql"],
    "reports": ["*.py"],
    "build": ["__init__.py", "build_exe.py", "export_app_data.py", "verify_db.py", "model.py", "version.py",
              "nomen_groups.py", "migrate_to_db.py", "make_distro.py", "make_manual.py", "check_seeds.py"],
    "docs": ["інструкція-користувача.md", "довідник-адміністратора.md", "довідник-розробника.md",
             "питання-і-відповіді.md", "версії.md"],
}

# Документи поставки з Markdown у Word: (джерело в docs/, назва файла в дистрибутиві).
MANUALS = [("інструкція-користувача.md", "Інструкція користувача.docx"),
           ("довідник-адміністратора.md", "Довідник адміністратора.docx"),
           ("питання-і-відповіді.md", "Питання і відповіді.docx")]

SOURCE_README = """# Облік ТЗ ПС — облік технічних засобів продовольчої служби

Програма для Windows, якою продовольча служба військової частини веде облік
своїх технічних засобів: кухонь, термосів, холодильного та іншого обладнання.
Один файл `Облік ТЗ ПС.exe`, база SQLite в теці «Дані обліку» поруч із ним,
вікно в Edge чи Chrome на цьому ж комп'ютері. Інтернет, установка й сервер не
потрібні. Це код самої програми, без облікових даних: готову збірку (exe, чиста
база, інструкція) автор поширює окремо.

## Що вміє

- Рух майна: прихід, накладні на переміщення, акти списання, рапорти про знищення (знищене числиться, але не рахується наявним, доки не пройде акт). Документ — вид, дата, номер і маршрут; виправлення й видалення з журналом змін; режим «вношу історію» для старих паперів підряд.
- Залишки на будь-яку дату по підрозділах і партіях з цінами; власні інвентарні номери (видача, перенесення за майном) й одиниці із заводськими номерами; штат і потреба за табелем 21/Прод, заміни в штаті.
- Звірки з підрозділами за Додатком 1/9 з журналом результатів; розбіжності — одразу в документ.
- Інвентаризація: план проведення (підрозділи з майном та інші місця — продукти, вода), описи за формою наказу Мінфіну № 572 по кожній матеріально відповідальній особі, робочі описи, акт, протокол, реєстр для ФЕС, відомості про хід, строки наказу з нагадуванням.
- Відомість МТЗ — щомісячна відомість закуплених (отриманих) матеріально-технічних засобів зі звіркою з файлом частини.
- Закупівлі — надходження за довільний період із джерелом фінансування, КПКВ, КЕКВ і кодом видатків, частками, підсумками за розрізами й книгою Excel.
- Залишкова вартість — відомість за Додатком 1 до Методики (постанова КМУ № 759): майно з обліку, нормативні таблиці з редакціями, точний розрахунок із поясненням, бланк в Excel.
- Акти ЯТС — акт якісного (технічного) стану у Word за бланком; відомості й акти мають стан і незмінні затверджені версії.
- Книги обліку № 47 і № 14, форми 2/Прод, 3/Прод і 21/Прод (21/Прод — і комплектом одним натисканням: зведена, управління й кожен батальйон; майну, якому в бланку рядка немає, — власний рядок), відомість інвентарних номерів, накладна на бланку — у книгах Excel, розкладених для друку на А4; заголовки й область друку записуються іменами тієї мови, якою говорить Excel на комп'ютері.
- Люди й МВО: звання й посади з історією, матеріально відповідальні особи, командири підрозділів і посадовці зі строками — документ бере тих, хто відповідав на його дату; реквізити частини для бланків.
- Імпорт історії з Excel: нова служба вносить підрозділи, позиції й документи за минулі роки одним файлом за шаблоном програми; початок обліку — у реквізитах.
- Зведення: що потребує уваги — від'ємні залишки, незакриті документи, строки, знищене без акта. Автоматичні копії бази, іменовані копії й відновлення, перевірка цілісності (⚙ → «Перевірити базу…»).

## Теки

| Тека | Що це |
|---|---|
| `app/` | застосунок: `index.html`, `style.css`, `app.js` — уся логіка обліку виконується у вікні браузера |
| `desktop/` | `launcher.py` — сервер на 127.0.0.1 і вікно Edge/Chrome; `state_db.py` — запис стану в базу; вивантаження в Excel (`excel_export.py`, `inventory_export.py`, `book47_export.py`, `mtz_export.py`, `valuation_export.py`) і у Word (`techact_export.py`); `excel_names.py` — заголовки й область друку іменами, які розуміє Excel комп'ютера; `history_import.py` — шаблон і читання файла історії; бланки в `templates/` |
| `db/` | `connect.py` — відкриття бази й міграції; `migrations/` — схема бази: `023_schema.sql` і наступні зміни (виданий файл не правлять — новий файл із наступним номером); `rules/` — правила над даними, які перенос виконує після наповнення; `queries.py`; загальні сіди табельних форм у `seed/` |
| `build/` | `version.py` — версія програми; `build_exe.py` — збірка exe; `export_app_data.py` — витяг довідників для сторінки; `verify_db.py` — перевірки цілісності (⚙ → «Перевірити базу…»); `make_distro.py` і `make_manual.py` — цей дистрибутив і інструкція |
| `reports/` | звіти-довідки в Excel по базі (форми 2/Прод, 3/Прод, 21/Прод, відомість інвентарних номерів, описи) |
| `docs/` | інструкція користувача (джерело .docx); `версії.md` — що змінилося в кожній версії і як випустити наступну |

## Як зібрати програму

Python 3.13 і `pip install openpyxl pillow pyinstaller python-docx`.

    python build/build_exe.py      # -> dist/Облік ТЗ ПС.exe
    python desktop/launcher.py     # запуск із джерел: тека даних — desktop/Дані обліку

Програма шукає теку «Дані обліку» поруч із собою (з джерел — поруч із
`launcher.py`). Порожня база створюється сама при першому запуску міграціями;
чисту базу з каталогом табельних позицій беріть із теки «Дані обліку»
дистрибутива.

## Дані

Усе лежить у теці «Дані обліку» поруч із програмою: база `oblik.sqlite`,
`копії/` (автоматичні й іменовані копії бази), `вивантаження/` (книги Excel),
`скани/` (підшиті файли). Щоб перенести облік на інший комп'ютер, копіюють
теку цілком. Старіша версія програми базу новішої не відкриває; новіша
оновлює базу сама й перед цим знімає копію «… перед оновленням».

## Чого тут немає

Тестів, початкових даних і скриптів їх підготовки: вони прив'язані до обліку
конкретної служби й у публічний код не входять. Програма від них не залежить:
порожню базу створюють міграції, каталог табельних позицій — сіди в `db/seed/`.

Схема бази описана в коментарях `db/migrations/023_schema.sql` і наступних файлів міграцій;
правила роботи програми — в інструкції користувача (`docs/інструкція-користувача.md`);
що змінилося в кожній версії — `docs/версії.md`. Кожна версія тут — один коміт і мітка
`v<номер>`; робочий репозиторій автора окремий.
"""

README_TXT = """ОБЛІК ТЕХНІЧНИХ ЗАСОБІВ ПРОДОВОЛЬЧОЇ СЛУЖБИ
Програма для Windows. Версія {version} від {date}

ЗАПУСК
1. Розпакуйте теку цілком туди, де дозволено запис: у «Документи», на робочий стіл або на флешку.
   У теці мають бути «Облік ТЗ ПС.exe» і тека «Дані обліку».
2. Потрібен Microsoft Edge або Google Chrome. Інтернет не потрібен.
3. Запустіть «Облік ТЗ ПС.exe». Зміни записуються одразу; щоб завершити роботу, закрийте вікно.

ПЕРШИЙ ЗАПУСК
На Зведенні картка «Перший запуск» веде до кожного кроку.
1. Реквізити частини: «Люди й МВО», вкладка «Частина».
2. Підрозділи: батальйони, їхні їдальні й ВМТЗ, роти, склад.
   Документи виписуються на їдальню чи ВМТЗ, а не на батальйон.
3. Номенклатура: каталог табельних позицій уже є, нові позиції додаються кнопкою «+ Нова позиція».
4. Люди й МВО: військовослужбовці, МВО підрозділів, посадовці для підписів.
5. Залишки на дату початку обліку: «Документи», «+ Новий документ», «Прихід»,
   тип «Перенос залишків», окремий документ на кожен підрозділ.
6. Історія з Excel: підрозділи, позиції й документи за минулі роки одним файлом за шаблоном
   програми — замість кроків 2, 3 і 5. Шаблон і перевірку файла дає сама програма.
7. Штат: «Штат і потреба», норми табеля 21/Прод.

ДАНІ
База: «Дані обліку/oblik.sqlite».
Автоматичні копії: «Дані обліку/копії».
Файли Excel: «Дані обліку/вивантаження».
Скани: «Дані обліку/скани».
Раз на місяць зберігайте копію бази на флешку: ⚙ → «Зберегти копію бази…».
Щоб перенести облік на інший комп'ютер, скопіюйте теку повністю.

ДОКУМЕНТАЦІЯ
Інструкція користувача: «Інструкція користувача.docx».
Коротка пам'ятка в програмі: ⚙ → «Пам'ятка для служби…».
Що змінилося у версіях: «Версії.txt».
Вихідний код і опис збирання: тека «Вихідний код», файл README.md;
той самий код в інтернеті — github.com/librevlad/obliktz.
"""


UNIT_CODE = re.compile(r"\s*\bА\d{4}\b")


def without_unit_code(text):
    """Рядок без умовного найменування частини: «в/ч А0000» → «в/ч», зайві пробіли злито."""
    return re.sub(r"\s{2,}", " ", UNIT_CODE.sub("", text or "")).strip()


def readme_text():
    """«ПРОЧИТАЙТЕ.txt» із версією програми."""
    d = APP_VERSION_DATE
    return README_TXT.format(version=APP_VERSION, date=f"{d[8:10]}.{d[5:7]}.{d[:4]}")


def versions_text():
    """«Версії.txt» поруч із програмою: що змінилося в кожній версії. З `docs/версії.md`
    береться вступ і самі версії; як випускати наступну — розділ для розробника, він
    лишається у «Вихідному коді»."""
    out, keep = [], True
    for line in VERSIONS.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            keep = line[3:4].isdigit()
        if keep:
            out.append(re.sub(r"^#+ ", "", line).replace("`", ""))
    return "\n".join(out).strip() + "\n"


def whats_new_text(version=APP_VERSION):
    """Запис про одну версію з `docs/версії.md` — «Що нового» поруч із дистрибутивом і тіло
    коміту публікації."""
    out, keep = [], False
    for line in VERSIONS.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            if keep:
                break
            keep = line[3:].startswith(f"{version} ")
        if keep:
            out.append(re.sub(r"^#+ ", "", line).replace("`", ""))
    if not out:
        raise SystemExit(f"у {VERSIONS.name} немає запису про версію {version}")
    return "\n".join(out).strip() + "\n"


RELEASES = "релізи"


def release_folder(out_dir, archive, folder):
    """Тека релізу для Google Drive — `dist/релізи/<версія>/`: дистрибутив, інструкція окремим
    файлом, «Що нового» цієї версії й перелік усіх версій. Власник переносить теку цілком."""
    rel = Path(out_dir) / RELEASES / APP_VERSION
    if rel.exists():
        shutil.rmtree(rel)
    rel.mkdir(parents=True)
    archive, folder = Path(archive), Path(folder)
    shutil.copy2(archive, rel / archive.name)
    for _, name in MANUALS:
        shutil.copy2(folder / name, rel / name)
    (rel / f"Що нового {APP_VERSION}.txt").write_text(whats_new_text(), encoding="utf-8-sig")
    (rel / "Версії.txt").write_text(versions_text(), encoding="utf-8-sig")
    return rel


def catalog_name(name):
    """Назва для каталогу поставки: без заводського номера, шасі, року випуску й номера,
    дописаного до назви з бухгалтерського обліку."""
    s = str(name or "")
    s = re.sub(r",?\s*(заводськ\w*\s+номер|зав\.)\s*№?.*$", "", s, flags=re.I)
    s = re.sub(r",\s*\d{9,10}\s*$", "", s)
    s = re.sub(r"\s+без паспортів.*$", "", s, flags=re.I)
    s = re.sub(r",?\s*\d{4}(/\d{4})?\s*р\.?\s*/?\s*в\.?\s*$", "", s)
    return s.strip(" ,")


def make_clean_db(path):
    """Чиста база: схема, довідники, табельні форми й каталог, два вузли дерева."""
    path = Path(path)
    for p in (path, Path(str(path) + "-wal"), Path(str(path) + "-shm")):
        if p.exists():
            p.unlink()
    con = open_db(path)
    try:
        rep = MG.MigrationReport()
        MG._seed_lookups(con)
        D = json.loads(EXTRACT.read_text(encoding="utf-8"))
        MG._load_nomen(con, D, rep)
        for name in CATALOG_SEEDS + FES_SEEDS:
            for st in statements((MG.SEED_DIR / name).read_text(encoding="utf-8")):
                m = re.match(r"\s*(?:INSERT\s+INTO|UPDATE)\s+(\w+)", st, re.I)
                if m and m.group(1).lower() in CATALOG_TABLES:
                    con.execute(st)
        con.executescript((MG.RULES_DIR / "asset_class.sql").read_text(encoding="utf-8"))
        # Каталог — лише табельні позиції; жодних номерів ФЕС, приміток, старих кодів і цін.
        con.execute("DELETE FROM nomen WHERE id NOT IN (SELECT nomen_id FROM nomen_report_line)")
        con.execute("UPDATE nomen SET fes_code = NULL, old_code = NULL, note = NULL, "
                    "app_price_kop = NULL, archived_at = NULL, source = 'seed'")
        # Назва позиції каталогу — марка, без прикмет окремої одиниці: заводського номера, шасі,
        # року випуску, номера в бухгалтерії. Позиції, що після цього звуться однаково, — одна.
        con.create_function("catalog_name", 1, catalog_name)
        con.execute("UPDATE nomen SET name = catalog_name(name)")
        for name, keep in con.execute("SELECT name, MIN(id) FROM nomen GROUP BY name HAVING COUNT(*) > 1").fetchall():
            twins = [r[0] for r in con.execute("SELECT id FROM nomen WHERE name = ? AND id <> ?", (name, keep))]
            for twin in twins:
                con.execute("INSERT OR IGNORE INTO nomen_report_line(nomen_id, report_line_id) "
                            "SELECT ?, report_line_id FROM nomen_report_line WHERE nomen_id = ?", (keep, twin))
                con.execute("DELETE FROM nomen_report_line WHERE nomen_id = ?", (twin,))
                con.execute("DELETE FROM nomen WHERE id = ?", (twin,))
        # Підпис частини під бланком лежить в окремому сіді й сюди не йде; якщо умовне
        # найменування частини («А» і чотири цифри) все ж потрапить у рядок форми —
        # лишаємо лише посаду. Самого коду частини тут не названо: цей файл іде в поставку.
        con.create_function("without_unit_code", 1, without_unit_code)
        con.execute("UPDATE report_line SET name = without_unit_code(name) "
                    "WHERE name GLOB '*А[0-9][0-9][0-9][0-9]*'")
        kinds = dict(con.execute("SELECT code, id FROM subdivision_kind"))
        con.execute("INSERT INTO subdivision(name, kind_id, parent_id, sort) VALUES('Військова частина', ?, NULL, 1)",
                    (kinds["бригада"],))
        root = con.execute("SELECT id FROM subdivision WHERE name = 'Військова частина'").fetchone()[0]
        con.execute("INSERT INTO subdivision(name, kind_id, parent_id, sort) VALUES('склад', ?, ?, 2)",
                    (kinds["склад"], root))
        for key, value in UNIT_DEFAULTS.items():
            con.execute("INSERT OR REPLACE INTO settings(key, value) VALUES(?, ?)", (key, value))
        con.execute("DELETE FROM audit_log")           # слід від наповнення — ні до чого
        for table in MUST_BE_EMPTY:
            n = con.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
            if n:
                raise SystemExit(f"чиста база не порожня: {table} — {n} рядків")
        con.execute("VACUUM")
    finally:
        close_db(con)
    return path


def source_files():
    """Файли вихідного коду для поставки: (шлях у проєкті, шлях у дистрибутиві)."""
    out = []
    for folder, patterns in SOURCE_GLOBS.items():
        base = ROOT / folder
        for p in sorted(base.rglob("*")):
            if not p.is_file() or "__pycache__" in p.parts:
                continue
            rel = p.relative_to(base).as_posix()
            if any(fnmatch.fnmatch(rel, pat) for pat in patterns):
                out.append((p, Path("Вихідний код") / folder / rel))
    return out


def copy_sources(folder):
    for src, rel in source_files():
        dst = folder / rel
        dst.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(src, dst)
    (folder / "Вихідний код" / "README.md").write_text(SOURCE_README, encoding="utf-8")


def build(out_dir=None, exe=EXE):
    out_dir = Path(out_dir) if out_dir else ROOT / "dist"
    exe = Path(exe)
    if not exe.exists():
        raise SystemExit(f"немає програми: {exe} — спершу python build/build_exe.py")
    folder = out_dir / "Облік ТЗ ПС"
    if folder.exists():
        shutil.rmtree(folder)
    (folder / "Дані обліку").mkdir(parents=True)
    shutil.copy2(exe, folder / exe.name)
    make_clean_db(folder / "Дані обліку" / "oblik.sqlite")
    for src, name in MANUALS:
        build_manual(source=VERSIONS.parent / src, out=folder / name)
    (folder / "ПРОЧИТАЙТЕ.txt").write_text(readme_text(), encoding="utf-8-sig")
    (folder / "Версії.txt").write_text(versions_text(), encoding="utf-8-sig")
    copy_sources(folder)
    stamp = datetime.date.today().isoformat()
    archive = out_dir / f"Облік ТЗ ПС {APP_VERSION} — дистрибутив {stamp}.zip"
    if archive.exists():
        archive.unlink()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(folder.rglob("*")):
            z.write(p, p.relative_to(out_dir))
    return archive, folder


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", help="лише чиста база у вказаний файл")
    ap.add_argument("--out", help="тека для дистрибутива (типово dist/)")
    a = ap.parse_args()
    if a.db:
        p = make_clean_db(a.db)
        print(f"чиста база: {p} ({p.stat().st_size / 1024:.0f} КБ)")
    else:
        archive, folder = build(a.out)
        size = sum(f.stat().st_size for f in folder.rglob("*") if f.is_file())
        print(f"{archive}  ({archive.stat().st_size / 1024 / 1024:.1f} МБ; у теці {size / 1024 / 1024:.1f} МБ)")
        for f in sorted(folder.rglob("*")):
            if f.is_file() and "Вихідний код" not in f.parts:
                print("  ", f.relative_to(folder), f"{f.stat().st_size / 1024:.0f} КБ")
        n = sum(1 for f in folder.rglob("*") if f.is_file() and "Вихідний код" in f.parts)
        print(f"   Вихідний код/ — {n} файлів")
        rel = release_folder(Path(a.out) if a.out else ROOT / "dist", archive, folder)
        print(f"тека релізу для Google Drive: {rel}")
        for f in sorted(rel.iterdir()):
            print("  ", f.name, f"{f.stat().st_size / 1024:.0f} КБ")
