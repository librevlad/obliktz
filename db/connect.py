"""Відкриття бази, прагми й міграції."""
import re
import sqlite3
from pathlib import Path

def _migrations_dir() -> Path:
    """Тека з міграціями. У зібраній програмі вони лежать поруч із кодом у
    тимчасовій теці розпакування, а не в дереві проєкту."""
    import sys
    base = getattr(sys, "_MEIPASS", None)
    if base:
        packed = Path(base) / "migrations"
        if packed.is_dir():
            return packed
    return Path(__file__).parent / "migrations"


MIGRATIONS_DIR = _migrations_dir()
APP_SCHEMA_VERSION = 25


class SchemaTooNewError(Exception):
    pass


class SchemaTooOldError(Exception):
    """До першого випуску міграції 001–023 злито в один файл схеми: базу зі
    схемою 1–22 уже нічим оновити."""


def _migration_files() -> list[tuple[int, Path]]:
    out = []
    for f in sorted(MIGRATIONS_DIR.glob("*.sql")):
        m = re.match(r"(\d+)_", f.name)
        if m:
            out.append((int(m.group(1)), f))
    return out


def current_version(con: sqlite3.Connection) -> int:
    try:
        return con.execute(
            "SELECT COALESCE(MAX(version), 0) FROM schema_version").fetchone()[0]
    except sqlite3.OperationalError:
        return 0


def checked_version(con: sqlite3.Connection) -> int:
    """Версія схеми бази — якщо програма вміє таку базу відкрити й оновити."""
    have = current_version(con)
    if have > APP_SCHEMA_VERSION:
        raise SchemaTooNewError(
            f"База створена новішою версією програми (схема {have}, "
            f"програма знає {APP_SCHEMA_VERSION}). Оновіть програму.")
    files = _migration_files()
    if files and 0 < have < files[0][0]:
        raise SchemaTooOldError(
            f"База створена старою збіркою програми (схема {have}): ця версія "
            f"оновлює бази від схеми {files[0][0]}.")
    return have


def apply_migrations(con: sqlite3.Connection) -> int:
    have = checked_version(con)
    for version, path in _migration_files():
        if version <= have:
            continue
        con.executescript(path.read_text(encoding="utf-8"))
        con.execute(
            "INSERT INTO schema_version(version, applied_at) "
            "VALUES (?, strftime('%Y-%m-%dT%H:%M:%SZ','now'))", (version,))
        con.commit()
    return current_version(con)


def open_db(path: Path, *, migrate: bool = True) -> sqlite3.Connection:
    con = sqlite3.connect(path, isolation_level=None)
    con.row_factory = sqlite3.Row
    # Вбудований lower() у SQLite розуміє лише латиницю: «Кухня» лишається
    # «Кухня», і пошук за «кухн» нічого не знаходить. Уся номенклатура тут
    # українською, тому регістр згортає Python.
    con.create_function("lower_uk", 1, lambda s: s.lower() if s else s,
                        deterministic=True)
    con.execute("PRAGMA foreign_keys = ON")
    con.execute("PRAGMA journal_mode = WAL")
    con.execute("PRAGMA synchronous = FULL")
    if migrate:
        try:
            apply_migrations(con)
        except (SchemaTooNewError, SchemaTooOldError):
            con.close()
            raise
    else:
        have = current_version(con)
        if have > APP_SCHEMA_VERSION:
            con.close()
            raise SchemaTooNewError(
                f"База створена новішою версією програми (схема {have}).")
    return con


def close_db(con: sqlite3.Connection) -> None:
    """WAL лишає поруч -wal і -shm; після checkpoint теку можна копіювати."""
    try:
        con.execute("PRAGMA wal_checkpoint(TRUNCATE)")
    finally:
        con.close()
