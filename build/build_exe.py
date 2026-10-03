# -*- coding: utf-8 -*-
"""Збірка «Облік ТЗ ПС.exe» — один файл, без залежностей на машині користувача."""
import sys, os, subprocess, shutil

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, ROOT)
from build.version import APP_VERSION, APP_VERSION_DATE          # noqa: E402

APP = os.path.join(ROOT, "app")
NAME = "Облік ТЗ ПС"
WORK = os.path.join(ROOT, "build", "_pyi")


def version_info():
    """Відомості про версію для властивостей файла в Windows (вкладка «Докладно»)."""
    a, b, c = (int(x) for x in APP_VERSION.split("."))
    d = APP_VERSION_DATE
    return f"""# UTF-8
VSVersionInfo(
  ffi=FixedFileInfo(filevers=({a}, {b}, {c}, 0), prodvers=({a}, {b}, {c}, 0), mask=0x3f, flags=0x0,
                    OS=0x40004, fileType=0x1, subtype=0x0, date=(0, 0)),
  kids=[
    StringFileInfo([StringTable('042204B0', [
      StringStruct('FileDescription', '{NAME}'),
      StringStruct('FileVersion', '{APP_VERSION}'),
      StringStruct('ProductName', '{NAME}'),
      StringStruct('ProductVersion', '{APP_VERSION} від {d[8:10]}.{d[5:7]}.{d[:4]}'),
      StringStruct('OriginalFilename', '{NAME}.exe')])]),
    VarFileInfo([VarStruct('Translation', [0x0422, 1200])])
  ]
)
"""


def command(version_file):
    cmd = [sys.executable, "-m", "PyInstaller", "--noconfirm", "--clean", "--onefile", "--noconsole",
           "--name", NAME, "--icon", os.path.join(ROOT, "desktop", "icon.ico"),
           "--version-file", version_file,
           "--distpath", os.path.join(ROOT, "dist"),
           "--workpath", WORK,
           "--specpath", WORK]
    # data.js у збірку не йде: програма будує його з бази при запиті.
    for asset in ("index.html", "style.css", "app.js"):
        cmd += ["--add-data", os.path.join(APP, asset) + ";."]
    # Схема бази, бланк накладної служби й модулі вивантаження в Excel: модулі
    # імпортуються всередині обробника запиту, тому PyInstaller про них треба
    # сказати явно.
    cmd += ["--add-data", os.path.join(ROOT, "db", "migrations") + ";migrations",
            "--add-data", os.path.join(ROOT, "desktop", "templates") + ";templates",
            "--paths", os.path.join(ROOT, "desktop"), "--paths", ROOT,
            "--hidden-import", "excel_export", "--hidden-import", "inventory_export",
            "--hidden-import", "book47_export", "--hidden-import", "mtz_export",
            "--hidden-import", "history_import", "--hidden-import", "excel_names",
            "--hidden-import", "valuation_export", "--hidden-import", "techact_export",
            # Акт ЯТС складає python-docx: йому потрібні його шаблони документа.
            "--collect-data", "docx",
            "--hidden-import", "reports.form21", "--collect-submodules", "reports.journals"]
    cmd.append(os.path.join(ROOT, "desktop", "launcher.py"))
    return cmd


def main():
    sys.stdout.reconfigure(encoding="utf-8")
    os.makedirs(WORK, exist_ok=True)
    version_file = os.path.join(WORK, "version_info.txt")
    with open(version_file, "w", encoding="utf-8") as f:
        f.write(version_info())
    subprocess.run(command(version_file), check=True)
    built = os.path.join(ROOT, "dist", NAME + ".exe")
    shutil.copy2(built, os.path.join(ROOT, NAME + ".exe"))
    print(f"\n{NAME}.exe {APP_VERSION} — {os.path.getsize(built) / 1024 / 1024:.1f} МБ")

    # Програма шукає теку даних поруч із собою — інакше в dist лишиться .exe без
    # бази й без сканів. Копіюємо, щоб теку можна було віддати як є.
    src = os.path.join(ROOT, "Дані обліку")
    dst = os.path.join(ROOT, "dist", "Дані обліку")
    if os.path.isdir(src):
        for sub in ("oblik.sqlite", "скани"):
            s, d = os.path.join(src, sub), os.path.join(dst, sub)
            if os.path.isdir(s):
                shutil.copytree(s, d, dirs_exist_ok=True)
            elif os.path.exists(s):
                os.makedirs(dst, exist_ok=True)
                shutil.copy2(s, d)
        size = sum(os.path.getsize(os.path.join(p, f))
                   for p, _, fs in os.walk(dst) for f in fs)
        print(f"дані поруч із програмою — {size / 1024 / 1024:.1f} МБ у {dst}")


if __name__ == "__main__":
    main()
