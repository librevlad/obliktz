# -*- coding: utf-8 -*-
"""Робота кількох людей по мережі.

Програма й база стоять на одному ПК — основному. Інші відкривають програму в Edge чи
Chrome за адресою основного ПК (http://ІМ'Я-ПК:8770/) і вносять одночасно. Основний ПК
має бути ввімкнений, а програма на ньому — відкрита.

Налаштування лежать поруч із базою — `Дані обліку/мережа.json`: увімкнено чи ні, порт,
ім'я людини на самому основному ПК, код доступу (лише його відбиток із сіллю) і секрет
перепусток. Людина з іншого ПК один раз вписує своє ім'я й код — і отримує перепустку в
куці браузера: ім'я, час видачі й підпис секретом. Новий код міняє секрет, і всі видані
перепустки втрачають силу. Головне вікно на самому основному ПК (127.0.0.1) перепустки
не потребує.

Код ходить мережею частини відкритим текстом (HTTP): це захист від випадкового входу,
а не від того, хто перехоплює мережу.
"""
import base64
import hashlib
import hmac
import json
import os
import secrets
import socket
import threading
import time

FILE = "мережа.json"
DEFAULT_PORT = 8770
COOKIE = "oblik"
TOKEN_DAYS = 120
LOCAL = {"127.0.0.1", "::1", "::ffff:127.0.0.1"}
NAME_MAX = 40
TRIES = 5                     # невдалих спроб коду поспіль — і пауза
PAUSE = 60                    # секунд


def path(data: str) -> str:
    return os.path.join(data, FILE)


def load(data: str) -> dict:
    """Налаштування мережі; файла немає — мережу вимкнено."""
    try:
        with open(path(data), encoding="utf-8") as f:
            cfg = json.load(f)
        if not isinstance(cfg, dict):
            cfg = {}
    except (OSError, ValueError):
        cfg = {}
    cfg.setdefault("on", False)
    cfg.setdefault("port", DEFAULT_PORT)
    cfg.setdefault("host_name", "")
    return cfg


def save(data: str, cfg: dict) -> None:
    """Запис цілим файлом: обрив не лишає половини налаштувань."""
    tmp = path(data) + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(cfg, f, ensure_ascii=False, indent=1)
    os.replace(tmp, path(data))


def _hash(salt: str, code: str) -> str:
    return hashlib.pbkdf2_hmac("sha256", code.encode("utf-8"), salt.encode("utf-8"), 120_000).hex()


def set_code(cfg: dict, code: str) -> None:
    """Новий код доступу: свіжа сіль і свіжий секрет — старі перепустки більше не діють."""
    cfg["salt"] = secrets.token_hex(8)
    cfg["code"] = _hash(cfg["salt"], code)
    cfg["secret"] = secrets.token_hex(32)


def check_code(cfg: dict, code: str) -> bool:
    if not cfg.get("code") or not cfg.get("salt"):
        return False
    return hmac.compare_digest(_hash(cfg["salt"], str(code or "")), cfg["code"])


def clean_name(name) -> str:
    """Ім'я людини для журналу змін: без зайвих пробілів і керівних символів."""
    s = " ".join(str(name or "").split())
    s = "".join(ch for ch in s if ch.isprintable() and ch not in "<>\"'`")
    return s[:NAME_MAX]


def _b64(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).decode("ascii").rstrip("=")


def _unb64(text: str) -> bytes:
    return base64.urlsafe_b64decode(text + "=" * (-len(text) % 4))


def issue(cfg: dict, name: str, now: float | None = None) -> str:
    """Перепустка: ім'я й час видачі, підписані секретом."""
    payload = _b64(json.dumps({"n": name, "t": int(now if now is not None else time.time())},
                              ensure_ascii=False).encode("utf-8"))
    sig = hmac.new(cfg["secret"].encode("ascii"), payload.encode("ascii"), hashlib.sha256).hexdigest()[:40]
    return f"{payload}.{sig}"


def read(cfg: dict, token: str | None, now: float | None = None) -> str | None:
    """Ім'я з перепустки або None: підпис не той, строк минув, перепустку видано до зміни коду."""
    if not token or "." not in token or not cfg.get("secret"):
        return None
    payload, sig = token.rsplit(".", 1)
    want = hmac.new(cfg["secret"].encode("ascii"), payload.encode("ascii"), hashlib.sha256).hexdigest()[:40]
    if not hmac.compare_digest(sig, want):
        return None
    try:
        data = json.loads(_unb64(payload).decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        return None
    age = (now if now is not None else time.time()) - int(data.get("t", 0))
    if age < 0 or age > TOKEN_DAYS * 86400:
        return None
    return clean_name(data.get("n")) or None


def cookie_of(header: str | None) -> str | None:
    """Перепустка з заголовка Cookie."""
    for part in (header or "").split(";"):
        k, _, v = part.strip().partition("=")
        if k == COOKIE:
            return v
    return None


def set_cookie(token: str) -> str:
    return f"{COOKIE}={token}; Path=/; Max-Age={TOKEN_DAYS * 86400}; HttpOnly; SameSite=Strict"


def drop_cookie() -> str:
    return f"{COOKIE}=; Path=/; Max-Age=0; HttpOnly; SameSite=Strict"


class Gate:
    """Підбір коду: після TRIES невдалих спроб з однієї адреси — пауза PAUSE секунд."""

    def __init__(self):
        self._lock = threading.Lock()
        self._fails: dict[str, list] = {}

    def wait(self, ip: str, now: float | None = None) -> int:
        """Скільки секунд ця адреса ще має чекати (0 — можна пробувати)."""
        now = time.time() if now is None else now
        with self._lock:
            n, until = self._fails.get(ip, [0, 0])
            return max(0, int(until - now + 0.999)) if until > now else 0

    def fail(self, ip: str, now: float | None = None) -> None:
        now = time.time() if now is None else now
        with self._lock:
            n, until = self._fails.get(ip, [0, 0])
            n += 1
            if n >= TRIES:
                self._fails[ip] = [0, now + PAUSE]
            else:
                self._fails[ip] = [n, until]

    def ok(self, ip: str) -> None:
        with self._lock:
            self._fails.pop(ip, None)


def addresses(port: int) -> list[str]:
    """Адреси, за якими програму відкривають з інших ПК: ім'я комп'ютера й його IPv4."""
    host = socket.gethostname()
    out = [f"http://{host}:{port}/"]
    try:
        ips = sorted({ai[4][0] for ai in socket.getaddrinfo(host, None, socket.AF_INET)})
    except OSError:
        ips = []
    out += [f"http://{ip}:{port}/" for ip in ips if not ip.startswith("127.")]
    return out


LOGIN_PAGE = """<!doctype html>
<html lang="uk"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Облік ТЗ ПС — вхід</title>
<style>
  :root { --bg: #f2f3ef; --card: #fff; --ink: #1f2a1b; --muted: #5f6b58; --line: #cfd5c8; --accent: #3f5233; --bad: #9b2f22; }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--ink);
         font: 15px/1.45 "Segoe UI", system-ui, sans-serif; }
  form { background: var(--card); border: 1px solid var(--line); border-radius: 8px; padding: 28px 30px; width: min(360px, 90vw);
         display: grid; gap: 14px; }
  h1 { font-size: 18px; margin: 0; }
  p { margin: 0; color: var(--muted); font-size: 13px; }
  label { display: grid; gap: 5px; font-size: 12px; color: var(--muted); text-transform: uppercase; letter-spacing: .04em; }
  input { font: inherit; padding: 8px 10px; border: 1px solid var(--line); border-radius: 5px; color: var(--ink); }
  input:focus { outline: 2px solid var(--accent); outline-offset: 1px; }
  button { font: inherit; font-weight: 600; padding: 9px; border: 0; border-radius: 5px; background: var(--accent); color: #fff; cursor: pointer; }
  .err { color: var(--bad); font-size: 13px; min-height: 1em; }
</style></head>
<body><form id="f" autocomplete="on">
  <h1>Облік ТЗ ПС</h1>
  <p>Програма працює на основному ПК служби. Впишіть своє ім'я — воно стоятиме в журналі змін — і код доступу.</p>
  <label>Ваше ім'я<input id="n" name="name" required maxlength="40" autocomplete="name" autofocus></label>
  <label>Код доступу<input id="c" name="code" type="password" required autocomplete="current-password"></label>
  <div class="err" id="e"></div>
  <button type="submit">Увійти</button>
</form>
<script>
document.getElementById('f').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const e = document.getElementById('e');
  e.textContent = '';
  try {
    const r = await fetch('api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: document.getElementById('n').value, code: document.getElementById('c').value }) });
    if (r.ok) { location.replace('./'); return; }
    e.textContent = (await r.text()) || 'Не вдалося ввійти.';
  } catch (x) { e.textContent = 'Основний ПК не відповідає.'; }
});
</script></body></html>
"""
