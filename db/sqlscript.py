"""Розбиття SQL-скрипта на оператори.

`executescript` не годиться: сіди коментовані, а частина значень містить крапку
з комою всередині тексту («…до 21/Прод за II кв; дата не вказана»). Наївний
`split(';')` ріже такий рядок навпіл і ламає оператор, тому розбір іде посимвольно
з урахуванням лапок і коментарів.
"""


def statements(text: str) -> list[str]:
    out, buf = [], []
    i, n = 0, len(text)
    in_str = False
    while i < n:
        ch = text[i]
        if in_str:
            buf.append(ch)
            if ch == "'":
                # Подвоєна лапка всередині рядка — це не кінець рядка.
                if i + 1 < n and text[i + 1] == "'":
                    buf.append(text[i + 1])
                    i += 2
                    continue
                in_str = False
            i += 1
            continue
        if ch == "'":
            in_str = True
            buf.append(ch)
            i += 1
            continue
        if ch == "-" and i + 1 < n and text[i + 1] == "-":
            while i < n and text[i] != "\n":
                i += 1
            continue
        if ch == ";":
            part = "".join(buf).strip()
            if part:
                out.append(part)
            buf = []
            i += 1
            continue
        buf.append(ch)
        i += 1
    tail = "".join(buf).strip()
    if tail:
        out.append(tail)
    return out
