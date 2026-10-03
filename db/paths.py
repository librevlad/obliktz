"""Розкладка теки даних.

Усе змінне лежить в одній підтеці поруч із програмою, щоб її можна було
скопіювати на інший комп'ютер і працювати далі. Тихого відкату в профіль
користувача тут навмисно немає: він розносить дані по двох машинах так, що
ніхто цього не помічає.
"""
import sys
from pathlib import Path

DATA_DIR_NAME = "Дані обліку"


class DataDirNotWritable(Exception):
    pass


def app_dir() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).parent
    return Path(__file__).resolve().parents[1]


def data_dir(base: Path | None = None) -> Path:
    d = Path(base or app_dir()) / DATA_DIR_NAME
    try:
        d.mkdir(parents=True, exist_ok=True)
        probe = d / ".write-test"
        probe.write_text("ok", encoding="utf-8")
        probe.unlink()
    except OSError as e:
        raise DataDirNotWritable(
            f"Тека даних недоступна для запису: {d}\n"
            f"Перенесіть програму туди, де є права на запис.") from e
    for sub in ("скани", "копії"):
        (d / sub).mkdir(exist_ok=True)
    return d


def db_path(base: Path | None = None) -> Path:
    return data_dir(base) / "oblik.sqlite"


def scans_dir(base: Path | None = None) -> Path:
    return data_dir(base) / "скани"


def backups_dir(base: Path | None = None) -> Path:
    return data_dir(base) / "копії"
