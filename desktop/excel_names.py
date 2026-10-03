# -*- coding: utf-8 -*-
"""Заголовки й область друку — іменами, які розуміє Excel цього комп'ютера.

Шапку таблиці на кожній сторінці друку, область друку й діапазон фільтра книга .xlsx несе
у вбудованих іменах `_xlnm.Print_Titles`, `_xlnm.Print_Area` і `_xlnm._FilterDatabase`.
Excel з українським інтерфейсом цих імен у файлі не впізнає: вони стають звичайними
іменами, шапка на другій сторінці не друкується, область друку не діє (перевірено на Excel
LTSC 2021, збірка 14332; так само він не впізнає «Print_Titles» у `Names.Add` з макроса).
Ті самі імена, записані його мовою, — «Заголовки_для_друку», «Область_друку»,
«_ФільтрБазиДаних» — він приймає як вбудовані. Excel іншою мовою українських імен не знає,
а двох імен одразу книга нести не може: збережена в Excel, вона вже не відкривається без
конфлікту імен. Так само шкодить невпізнане ім'я фільтра: після зміни фільтра Excel
зберігає поруч із ним справжнє.

Тому готову книгу програма підганяє під Excel комп'ютера, де її вивантажили: мова
інтерфейсу Office береться з реєстру; українська — імена українські, решта — стандартні.
Модулі вивантаження про це не знають: вони задають `ws.print_title_rows` і `ws.print_area`
як завжди, а імена переписуються вже в записаному файлі (`localize_file`).
"""
import locale
import os
import re
import time
import zipfile

# Вбудовані імена мовою Excel: українською — як їх показує сам Excel (Name.NameLocal).
LOCAL = {"uk": {"Print_Titles": "Заголовки_для_друку", "Print_Area": "Область_друку",
                "_FilterDatabase": "_ФільтрБазиДаних"}}
OFFICES = ("16.0", "15.0", "14.0", "12.0")      # Office 2016–2024 і 365, 2013, 2010, 2007
TRIES, PAUSE = 5, 0.1                           # скільки разів і через скільки секунд пробувати замінити файл

_STANDARD = re.compile(r'(<definedName\b[^>]*?\bname=")_xlnm\.(Print_Titles|Print_Area|_FilterDatabase)(")')


def _registry(root: str, path: str, name: str):
    """Значення з реєстру Windows; None — коли його немає (чи це не Windows)."""
    try:
        import winreg                                       # noqa: PLC0415
    except ImportError:
        return None
    try:
        with winreg.OpenKey(getattr(winreg, root), path) as key:
            return winreg.QueryValueEx(key, name)[0]
    except OSError:
        return None


def _tag(value) -> str:
    """Мова з реєстру — назвою («uk-UA») чи числом Windows (1058) — у вигляді «uk-ua»."""
    if isinstance(value, str):
        return value.strip().lower()
    if isinstance(value, int) and value:
        return locale.windows_locale.get(value, f"lcid-{value}").replace("_", "-").lower()
    return ""


def office_language() -> str:
    """Мова інтерфейсу Excel на цьому комп'ютері: «uk-ua», «en-us»; порожньо — Office не видно.

    Спершу — мова, якою Excel запускали востаннє (її він записує сам), далі — мова, обрана в
    Office. Коли Office на комп'ютері два, рахується той, чий Excel відкриває книги. Змінна
    середовища OBLIK_EXCEL_LANG задає мову замість реєстру — для перевірок і розбору збою.
    """
    forced = os.environ.get("OBLIK_EXCEL_LANG", "").strip().lower()
    if forced:
        return forced
    current = re.search(r"\.(\d+)$", str(_registry("HKEY_CLASSES_ROOT", r"Excel.Application\CurVer", "") or ""))
    for version in ([f"{current[1]}.0"] if current else OFFICES):
        office = rf"Software\Microsoft\Office\{version}"
        for path, name in ((rf"{office}\Excel\Options", "LastUILang"),
                           (rf"{office}\Common\LanguageResources", "UILanguageTag"),
                           (rf"{office}\Common\LanguageResources", "UILanguage")):
            tag = _tag(_registry("HKEY_CURRENT_USER", path, name))
            if tag:
                return tag
    return ""


def local_names():
    """Вбудовані імена мовою Excel цього комп'ютера; None — стандартні."""
    return LOCAL.get(office_language().split("-")[0])


def localize_file(path) -> bool:
    """Переписує в записаній книзі заголовки для друку, область друку й ім'я фільтра іменами
    Excel цього комп'ютера.

    Повертає True, якщо книгу змінено. Для Excel іншою мовою, для книги без таких імен і для
    файла, який не є книгою .xlsx, файл лишається як був; решта вмісту книги не міняється ніколи.
    Книгу, яку тримає інша програма, замінити не вдасться: PermissionError, файл цілий.
    """
    names = local_names()
    if not names:
        return False
    path = os.fspath(path)
    try:
        with zipfile.ZipFile(path) as book:
            parts = [(item.filename, book.read(item.filename)) for item in book.infolist()]
    except zipfile.BadZipFile:
        return False                                        # не книга .xlsx — імен у ній немає
    changed = False
    for i, (name, data) in enumerate(parts):
        if name == "xl/workbook.xml":
            new = _STANDARD.sub(lambda m: m[1] + names[m[2]] + m[3], data.decode("utf-8")).encode("utf-8")
            changed, parts[i] = new != data, (name, new)
    if not changed:
        return False
    # Нова книга пишеться поруч і стає на місце старої одним кроком: недописаного файла не буває.
    fresh = path + ".names"
    try:
        with zipfile.ZipFile(fresh, "w", zipfile.ZIP_DEFLATED) as book:
            for name, data in parts:
                book.writestr(name, data)
        for attempt in range(TRIES):
            try:
                os.replace(fresh, path)
                break
            except PermissionError:
                # Щойно записаний файл на мить може тримати антивірус чи індексатор Windows.
                if attempt == TRIES - 1:
                    raise
                time.sleep(PAUSE)
    finally:
        if os.path.exists(fresh):
            os.remove(fresh)
    return True


def save_book(wb, path) -> None:
    """Записує книгу openpyxl і підганяє її імена під Excel цього комп'ютера."""
    wb.save(path)
    localize_file(path)
