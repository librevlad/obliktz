# -*- coding: utf-8 -*-
"""Відбиток вмісту файла, за яким програма впізнає свої файли: «той самий», «змінений руками», «переїхав».

Звичайний SHA-256 не годиться для старого формату .xls (контейнер OLE2). Excel, відкриваючи такий файл для правки,
навіть нічого не зберігши, дописує в кореневий запис каталогу контейнера поточний час. Відбиток після цього інший, хоч
ніхто нічого не правив, а програма відкриває щойно складений папір в Excel людини одразу й зустрічала б власний файл як
чужий. Тому для контейнера OLE2 у відбиток не входять мітки часу записів каталогу (байти 100..115 кожного запису:
«створено» і «змінено»); решта файла, до байта, входить. Для всього іншого (docx, xlsx, pdf, фото…) відбиток — звичайний
SHA-256. Файл, який Excel ще не відкривали, має нульові мітки, і його стабільний відбиток дорівнює звичайному: старі записи
зі звичайним відбитком таких файлів лишаються дійсними.

Щоб знайти сектори каталогу, контейнер розбирається за MS-CFB: заголовок → сектори FAT (109 у заголовку, решта —
ланцюжком секторів DIFAT) → ланцюжок секторів каталогу → ланцюжки потоків. Справний контейнер — це й ланцюжки, що не
перетинаються: кожен сектор належить одному з них (FAT, DIFAT, каталог, міні-FAT, потік). Інакше за запис каталогу
приймався б сектор FAT чи потоку, і обнулялись би байти, які мітками часу не є: два різні файли мали б однаковий відбиток.
Усе, що викликає сумнів, — обрізаний заголовок, непідтримуваний розмір сектора, сектор поза файлом, петля, задовгий чи
перехресний ланцюжок, — дає звичайний SHA-256 усього файла: краще не вгадати «стабільності», ніж помилитись. Кожен цикл
має обмеження кроків.

У теці та в записах про файли лежить стабільний відбиток; шукаючи й звіряючи, приймають обидва (`shas`): записи,
зроблені раніше, тримають звичайний."""
import hashlib
import os
import struct

OLE_MAGIC = bytes.fromhex("D0CF11E0A1B11AE1")
MAX_OLE = 40 * 1024 * 1024        # як launcher.MAX_SCAN: контейнер більший за завантажуване цілком у пам'ять не читаємо
BLOCK = 1 << 20                   # звичайний відбиток рахується блоками
ENDOFCHAIN = 0xFFFFFFFE           # кінець ланцюжка секторів у FAT
MINI_CUTOFF = 4096                # потік коротший за це лежить у міні-потоці; за специфікацією в заголовку завжди 4096
STAMP = 16                        # довжина поля часу запису каталогу: «створено» (8) + «змінено» (8), з байта 100
ZERO_STAMP = bytes(STAMP)


def _u32(data, at):
    return struct.unpack_from("<I", data, at)[0]


def _find_stamps(data):
    """Зсуви полів часу всіх записів каталогу контейнера OLE2 у `data`; None, якщо це не справний контейнер."""
    n = len(data)
    if n < 512 or data[:8] != OLE_MAGIC:
        return None
    if struct.unpack_from("<H", data, 28)[0] != 0xFFFE:                      # порядок байтів: лише little-endian
        return None
    shift = struct.unpack_from("<H", data, 30)[0]
    if shift not in (9, 12) or _u32(data, 56) != MINI_CUTOFF:                 # сектори 512 чи 4096; межа міні-потоку 4096
        return None
    size = 1 << shift
    per = size // 4                                                           # записів у секторі FAT чи DIFAT
    sectors = n // size - 1                                                   # цілих секторів після заголовка
    present = -(-n // size) - 1                                               # секторів із бодай байтом (останній неповний)
    if sectors < 2:
        return None

    n_fat, declared = _u32(data, 44), _u32(data, 72)
    if not 1 <= n_fat <= sectors // per + 2 or declared > sectors:            # FAT мусить покривати файл, не більше
        return None
    fat_sectors = list(struct.unpack_from("<109I", data, 76))
    difat, after = [], _u32(data, 68)
    for _ in range(declared):                                                 # ланцюжок секторів DIFAT, скільки заявлено
        if after >= sectors:
            return None
        difat.append(after)
        row = struct.unpack_from(f"<{per}I", data, (after + 1) * size)        # per-1 номерів сектора FAT і посилання далі
        if len(fat_sectors) < n_fat:                                          # ланцюжок йдеться весь, а список росте лише до n_fat:
            fat_sectors += row[:per - 1]                                      # петля з одного сектора на 40 МБ дала б ~530 МБ
        after = row[per - 1]
    if len(fat_sectors) < n_fat:
        return None
    fat_sectors = fat_sectors[:n_fat]
    claimed = set(fat_sectors) | set(difat)                                   # зайняті службові сектори: FAT і DIFAT
    if len(claimed) != len(fat_sectors) + len(difat) or any(s >= sectors for s in claimed):
        return None                                                           # сектор двічі або поза файлом
    fat = []
    for sector in fat_sectors:
        fat += struct.unpack_from(f"<{per}I", data, (sector + 1) * size)

    def follow(start, whole=False):            # сектори ланцюжка або None (чужий сектор, поза файлом, петля)
        limit = sectors if whole else present  # цілим має бути лише каталог: потік може бути обрізаний
        chain, sector = [], start
        while sector != ENDOFCHAIN:
            if sector >= limit or sector >= len(fat) or sector in claimed or len(chain) > sectors:
                return None
            claimed.add(sector)
            chain.append(sector)
            sector = fat[sector]
        return chain

    directory = follow(_u32(data, 48), whole=True)
    if not directory:
        return None
    if _u32(data, 64) and follow(_u32(data, 60)) is None:                     # ланцюжок міні-FAT
        return None
    for sector in directory:                                                  # потоки: кожен у своїх секторах, а не в чужих
        for i in range(size // 128):
            entry = (sector + 1) * size + 128 * i
            kind = data[entry + 66]                                           # 2 — потік, 5 — кореневий запис (міні-потік)
            length = _u32(data, entry + 120) if shift == 9 else struct.unpack_from("<Q", data, entry + 120)[0]
            if kind in (2, 5) and length and not (kind == 2 and length < MINI_CUTOFF):
                if follow(_u32(data, entry + 116)) is None:
                    return None
    return [(sector + 1) * size + 128 * i + 100 for sector in directory for i in range(size // 128)]


def _stamp_offsets(data):
    try:
        return _find_stamps(data)
    except (struct.error, IndexError, OverflowError, ValueError):
        return None


def stable_sha_bytes(data):
    """Відбиток вмісту `data` (bytes чи подібне): для контейнера OLE2 — без полів часу каталогу, для решти — SHA-256."""
    stamps = _stamp_offsets(data) if len(data) <= MAX_OLE else None
    h = hashlib.sha256()
    if not stamps:
        h.update(data)
        return h.hexdigest()
    view, at = memoryview(data), 0
    for start in sorted(stamps):
        h.update(view[at:start])
        h.update(ZERO_STAMP)
        at = start + STAMP
    h.update(view[at:])
    return h.hexdigest()


def shas(path):
    """(стабільний, звичайний) відбитки файла за один прохід. Для файла не з OLE2 вони однакові, і файл читається блоками;
    контейнер OLE2 до MAX_OLE читається цілком."""
    with open(path, "rb") as f:
        head = f.read(len(OLE_MAGIC))
        if head == OLE_MAGIC and os.fstat(f.fileno()).st_size <= MAX_OLE:
            data = head + f.read()
            return stable_sha_bytes(data), hashlib.sha256(data).hexdigest()
        h = hashlib.sha256(head)
        for block in iter(lambda: f.read(BLOCK), b""):
            h.update(block)
        digest = h.hexdigest()
        return digest, digest


def stable_sha(path):
    """Відбиток файла, який програма записує й за яким пізніше його впізнає (див. модуль)."""
    return shas(path)[0]
