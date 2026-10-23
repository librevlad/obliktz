// Облік ТЗ ПС · сторінка · пошук, документ на основі, розбіжності звірки.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ ПОШУК ПО ВСЬОМУ
  /** Ctrl+K з будь-якого екрана: позиція (код, назва, зав. №, інв. № з бирки),
   *  документ (номер, дата, маршрут), підрозділ, людина, відомість звірки,
   *  інвентаризація. ↑↓ Enter — перейти, Esc — закрити. */
  const pal = { active: 0, found: [] };
  function paletteOpen() {
    if ($('#palette')) { $('#palette input').focus(); return; }
    const el = document.createElement('div');
    el.id = 'palette';
    el.className = 'palette';
    el.innerHTML = `<div class="palette__box"><div class="palette__in"><span>⌕</span>
        <input placeholder="Пошук: позиція, документ, рапорт, підрозділ, людина, інв. №, зав. №"
          autocomplete="off" spellcheck="false"><kbd>Esc</kbd></div>
      <div class="palette__list"></div></div>`;
    el.addEventListener('mousedown', (e) => {
      if (e.target === el) { e.preventDefault(); paletteClose(); return; }
      const o = e.target.closest('[data-pi]');
      if (o) { e.preventDefault(); paletteGo(+o.dataset.pi); }
    });
    document.body.appendChild(el);
    const inp = el.querySelector('input');
    inp.addEventListener('input', () => { pal.active = 0; paletteRender(inp.value); });
    inp.addEventListener('keydown', (e) => {
      const n = pal.found.length;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (n) pal.active = (pal.active + (e.key === 'ArrowDown' ? 1 : n - 1)) % n;
        paletteRender(inp.value, true);
      } else if (e.key === 'Enter') { e.preventDefault(); paletteGo(pal.active); }
      else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); paletteClose(); }
    });
    pal.active = 0;
    paletteRender('');
    inp.focus();
  }
  function paletteClose() { const el = $('#palette'); if (el) el.remove(); }
  /** Вага результату: спершу те, що збіглося точно, і лише потім згадки.
   *  0 — інвентарний номер, 1 — код позиції, 2 — номер документа,
   *  3 — назва підрозділу чи прізвище, 4 — початок назви, 5 — просто згадка. */
  const EXACT = { inv: 0, code: 1, docNo: 2, name: 3, starts: 4, rest: 5, tail: 6 };
  function paletteSearch(q) {
    const words = qWords(q);
    const out = [];
    const asked = String(q || '').trim().toLowerCase();
    const same = (x) => String(x || '').trim().toLowerCase() === asked;
    const starts = (x) => asked.length > 1 && String(x || '').trim().toLowerCase().startsWith(asked);
    if (!words.length) {
      // Порожній запит — що було нещодавно: останні документи.
      const seen = new Set();
      for (const r of docs) {
        const k = keyOfRow(r);
        if (seen.has(k)) continue;
        seen.add(k);
        out.push({ type: 'документ', label: `${r.t || KIND_NAME[r.kind]} ${numNo(r.no)} від ${fmtDate(r.d)}`,
          meta: r.kind === 'wr' && !r.to ? r.from : `${r.from} → ${r.to}`, go: () => openDoc(k) });
        if (out.length >= 8) break;
      }
      return out;
    }
    const inv = invQuery(q);
    if (inv) {
      const it = itemBy.get(inv[0]);
      const range = inventory.find((r) => r.code === inv[0] && inv[1] >= r.from && inv[1] <= r.to);
      if (it) out.push({ rank: EXACT.inv, type: 'інв. номер', label: `${invNo(inv[0], inv[1])} · ${it.name}`,
        meta: range ? `за «${range.sub}»` : 'номер не видано', go: () => go('item', { itemCode: it.code }) });
    }
    let n = 0;
    for (const it of items) {
      if (!hitAll(words, it.code, it.name, it.serial || '', it.chassis || '', serialsOf.get(it.code) || '',
        it.old || '', it.fes || '')) continue;
      out.push({ rank: same(it.code) ? EXACT.code : same(it.serial) || same(it.chassis) ? EXACT.code
        : starts(it.code) || starts(it.name) ? EXACT.starts : EXACT.rest,
        type: 'позиція', label: `${it.code} · ${it.name}`, meta: `залишок ${fmtNum(balCode(it.code), '0')} ${it.unit || ''}`,
        go: () => go('item', { itemCode: it.code }) });
      if (++n >= 10) break;
    }
    n = 0;
    for (const sb of subs) {
      if (!hitAll(words, sb.name, sb.type, unitTitle(sb.name))) continue;
      out.push({ rank: same(sb.name) ? EXACT.name : starts(sb.name) ? EXACT.starts : EXACT.rest,
        type: 'підрозділ', label: sb.name, meta: sb.type, go: () => go('sub', { subName: sb.name }) });
      if (++n >= 6) break;
    }
    const seen = new Set();
    n = 0;
    // Документ шукається за всіма своїми рядками: заводський номер кухні
    // знаходить накладну, де ця кухня лише один із рядків.
    const docHay = new Map();
    for (const r of docs) {
      const k = keyOfRow(r);
      const extra = docWords(r).slice(1).join(' ');
      docHay.set(k, (docHay.get(k) || '') + ' ' + extra);
    }
    for (const r of docs) {
      const k = keyOfRow(r);
      if (seen.has(k)) continue;
      if (!hitAll(words, r.no, fmtDate(r.d), r.d, r.t || '', KIND_NAME[r.kind], docHay.get(k))) continue;
      seen.add(k);
      out.push({ rank: same(r.no) ? EXACT.docNo : starts(r.no) ? EXACT.starts : EXACT.rest,
        type: 'документ', label: `${r.t || KIND_NAME[r.kind]} ${numNo(r.no)} від ${fmtDate(r.d)}`,
        meta: r.kind === 'wr' && !r.to ? r.from : `${r.from} → ${r.to}`, go: () => openDoc(k) });
      if (++n >= 10) break;
    }
    n = 0;
    for (const p of store.people || []) {
      const at = personAt(p, state.asOf);
      if (!hitAll(words, pFull(p), at.rank, at.pos)) continue;
      out.push({ rank: same(p.surname) ? EXACT.name : starts(p.surname) ? EXACT.starts : EXACT.rest,
        type: 'людина', label: pFull(p), meta: [at.rank, at.pos].filter(Boolean).join(', '),
        go: () => go('people', { peopleTab: 'people', personId: p.id, q: '' }) });
      if (++n >= 6) break;
    }
    for (const r of allRecon()) {
      if (!hitAll(words, 'відомість звірка', r.no || '', r.sub, fmtDate(r.to))) continue;
      out.push({ rank: same(r.no) ? EXACT.docNo : EXACT.tail,
        type: 'звірка', label: `Відомість №${r.no || '—'} · ${r.sub}`, meta: `на ${fmtDate(r.to)} · ${r.status}`,
        go: () => reconOpen(r.id) });
      if (out.length > 60) break;
    }
    for (const x of allInv()) {
      if (!hitAll(words, 'інвентаризація', x.kind, fmtDate(x.date), x.orderNo || '')) continue;
      out.push({ rank: EXACT.tail, type: 'інвентаризація', label: `${x.kind} станом на ${fmtDate(x.date)}`,
        meta: x.base ? 'з бази' : x.status, go: () => go('stocktake', { stId: x.id, stSub: '' }) });
    }
    // Рапорти про знищення — за номером рапорту чи акта, підрозділом, обставинами
    // й заводським номером кухні: рапорт не документ руху, у стрічці його немає.
    const reports = new Map();
    for (const r of allDestroyed()) {
      const k = [r.report || '', r.sub, r.reportDate || r.date].join('|');
      const u = r.unit ? unitBy.get(String(r.unit)) : null;
      const x = reports.get(k) || { r, n: 0, hay: '' };
      x.n++;
      x.hay += ` ${r.act || ''} ${r.offNo || ''} ${r.note || ''} ${r.name || ''} ${(itemBy.get(r.code) || {}).name || ''} ${u ? u.serial || u.chassis || '' : ''}`;
      reports.set(k, x);
    }
    n = 0;
    for (const { r, n: lines, hay } of reports.values()) {
      if (!hitAll(words, 'рапорт знищення', r.report || '', r.sub, fmtDate(r.reportDate || r.date), hay)) continue;
      out.push({ rank: same(r.report) ? EXACT.docNo : EXACT.tail, type: 'рапорт',
        label: `Рапорт ${numNo(r.report || '—')} · ${r.sub}`, meta: `${fmtDate(r.reportDate || r.date)} · ${cnt(lines, 'рядок', 'рядки', 'рядків')}`,
        go: () => go('destroyed', { q: r.report || r.sub }) });
      if (++n >= 6) break;
    }
    // Сортування стабільне: усередині однакової ваги порядок лишається тим,
    // у якому збирали, — позиції за кодом, документи від найновіших.
    return out.sort((a, b) => (a.rank ?? EXACT.rest) - (b.rank ?? EXACT.rest)).slice(0, 60);
  }
  function paletteRender(q, keep = false) {
    const el = $('#palette');
    if (!el) return;
    if (!keep) pal.found = paletteSearch(q);
    const words = qWords(q);
    const list = el.querySelector('.palette__list');
    list.innerHTML = pal.found.length ? pal.found.map((o, i) => `<div class="palette__opt${i === pal.active ? ' is-active' : ''}" data-pi="${i}">
        <span class="palette__type">${esc(o.type)}</span><span class="palette__label">${hl(o.label, words)}</span>
        <span class="palette__meta">${esc(o.meta || '')}</span></div>`).join('')
      : `<div class="pick__empty">${q.trim() ? 'Нічого не знайдено.' : 'Введіть запит.'}</div>`;
    list.querySelector('.is-active')?.scrollIntoView({ block: 'nearest' });
  }
  function paletteGo(i) {
    const o = pal.found[i];
    if (!o) return;
    paletteClose();
    o.go();
  }

  // ============================================================ ДОКУМЕНТ НА ОСНОВІ
  /** «Повернути» — зворотна накладна тими самими рядками; «Копія» — той самий
   *  документ із сьогоднішньою датою й без номера. Незавершену чернетку того
   *  самого виду не затираємо без згоди. */
  function docBasedOn(key, mode) {
    const rows = docs.filter((r) => keyOfRow(r) === key);
    if (!rows.length || !leaveEditing()) return;
    const r0 = rows[0];
    const kind = r0.kind;
    // Зворотна накладна повертає ті самі партії й ті самі одиниці, що приїхали:
    // інакше повернення пішло б від найдавнішої партії одержувача.
    const back = mode === 'return';
    const at = new Map();
    const lines = [];
    for (const r of rows) {
      for (const p of (back ? rowParts(r) : [{ d: '', price: r.price, q: +r.q || 0 }])) {
        const ln = { code: r.code, qty: 0, note: '',
                     price: kind === 'in' ? (r.price ? String(r.price) : '')
                       : (back && p.d ? String(p.price) : ''),
                     lot: back && kind !== 'in' ? p.d || '' : '',
                     unit: back ? String(r.unit || '') : '' };
        const key = lineKeyOf(ln, kind);
        const have = at.get(key);
        if (have) { have.qty = round3(have.qty + p.q); continue; }
        ln.qty = p.q;
        at.set(key, ln);
        lines.push(ln);
      }
    }
    lines.forEach((ln) => { ln.qty = String(ln.qty); });
    const book = bookOf(r0.code);
    if (!freeDraftSlot(kind, book, `Замінити незавершену чернетку «${KIND_NAME[kind]}»?\n\nНаписане в ній буде втрачено.`)) return;
    const head = mode === 'return'
      ? { type: r0.t || 'Накладна', no: '', date: today(), from: r0.to, to: r0.from,
          basis: `повернення за документом ${numNo(r0.no)} від ${fmtDate(r0.d)}`, report: '', reportDate: '', act: '', note: '' }
      : { type: r0.t || '', no: '', date: today(), from: r0.from, to: r0.to || '', basis: basisOf(r0.note),
          report: '', reportDate: '', act: '', note: '' };
    state.editing = null;
    state.moveKind = kind;
    state.book = book;
    state.draft = { kind, book, head, lines: lines.concat([emptyLine()]) };
    state.flash = mode === 'return'
      ? `Зворотна накладна за документом ${numNo(r0.no)}: ${head.from} → ${head.to}, `
        + `${cnt(lines.length, 'найменування', 'найменування', 'найменувань')}. Перевірте кількості й впишіть номер.`
      : `Копія документа ${numNo(r0.no)}: ${cnt(lines.length, 'найменування', 'найменування', 'найменувань')}, дата сьогоднішня. Впишіть номер.`;
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
    $('#doc-form [name="no"]')?.focus();
  }

  /** «Усе майно відправника» — рядки з усім, що за ним числиться на дату документа. */
  function linesAll() {
    const dr = draft();
    const from = dr.head.from;
    const date = dr.head.date || today();
    if (!from) { toast('Оберіть відправника.', true); return; }
    const have = [];
    for (const it of items.filter((x) => bookOfItem(x) === (dr.book || 'ТЗ'))) {
      // Одиниці із заводськими номерами — своїми рядками, решта — кількістю.
      for (const u of (byLot() ? unitsAt(it.code, from, date) : [])) {
        have.push({ code: it.code, qty: '1', price: String(u.price), note: '', lot: u.d, unit: String(u.id) });
      }
      const q = (byLot() ? bulkAt(it.code, from, date) : availableAt(it.code, from, date))
        - (state.moveKind === 'dz' ? destroyedAt(it.code, from, date) : 0);
      if (q > 1e-9) have.push({ code: it.code, qty: String(round3(q)), price: '', note: '', lot: '', unit: '' });
    }
    if (!have.length) { toast(`За «${from}» на ${fmtDate(date)} нічого не числиться.`, true); return; }
    const filled = dr.lines.filter((l) => l.code || (l.other && String(l.name || '').trim()));
    if (filled.length && !confirm(`Замінити ${cnt(filled.length, 'рядок', 'рядки', 'рядків')} документа всім майном «${from}» `
      + `(${cnt(have.length, 'позиція', 'позиції', 'позицій')})?`)) return;
    dr.lines = have.concat([emptyLine()]);
    render();
    toast(`У документ внесено все, що числиться за «${from}» на ${fmtDate(date)}: ${cnt(have.length, 'позиція', 'позиції', 'позицій')}.`);
  }

  // ============================================================ РОЗБІЖНОСТІ ЗВІРКИ → ДОКУМЕНТИ
  /** Нестача понад знищене за рапортами й лишки з відомості — готовими чернетками. */
  function reconDiffs(r) {
    const defs = new Map(reconLines(r.sub, r.to).map((l) => [l.code + '|' + l.price, l.fact]));
    const short = [], over = [];
    for (const l of r.lines) {
      if (!l.code || l.fact == null) continue;
      const key = l.code + '|' + l.price;
      const base = defs.has(key) ? Math.min(defs.get(key), l.acc) : l.acc;
      if (l.fact < base - 1e-9) short.push({ code: l.code, qty: round3(base - l.fact), price: l.price, name: l.name });
      if (l.fact > l.acc + 1e-9) over.push({ code: l.code, qty: round3(l.fact - l.acc), price: l.price, name: l.name });
    }
    return { short, over };
  }
  function reconDiffPanel(r) {
    const { short, over } = reconDiffs(r);
    if (!short.length && !over.length) return '';
    const sum = (a) => a.reduce((s, x) => s + x.qty * (x.price || 0), 0);
    return `<div class="flash flash--warn" style="margin-bottom:12px"><span>Розбіжності за відомістю:
        ${short.length ? `нестача ${cnt(short.length, 'позиція', 'позиції', 'позицій')} на ${fmtMoney(sum(short))} грн` : ''}
        ${short.length && over.length ? ' · ' : ''}${over.length ? `лишки ${cnt(over.length, 'позиція', 'позиції', 'позицій')} на ${fmtMoney(sum(over))} грн` : ''}.
        Знищене за рапортами в нестачу не входить.</span>
      <span>${short.length ? '<button class="btn btn--sm" data-act="rc-doc" data-v="dz">Внести рапорт про знищення</button> '
        + '<button class="btn btn--sm" data-act="rc-doc" data-v="wr">Скласти акт списання</button>' : ''}
      ${over.length ? '<button class="btn btn--sm" data-act="rc-doc" data-v="in">Оприбуткувати лишки</button>' : ''}</span></div>`;
  }
  function reconToDoc(kind) {
    const r = reconById(state.reconId);
    if (!r || !leaveEditing()) return;
    const { short, over } = reconDiffs(r);
    const src = kind === 'in' ? over : short;
    if (!src.length) return;
    if (!freeDraftSlot(kind, 'ТЗ', 'Замінити незавершену чернетку?\n\nНаписане в ній буде втрачено.')) return;
    const basis = `відомість звірки №${r.no || '—'} від ${fmtDate(r.date)}`;
    const head = { type: '', no: '', date: r.to, from: kind === 'in' ? `лишки за звіркою (${r.sub})` : r.sub,
      to: kind === 'in' ? r.sub : '', basis, report: '', reportDate: '', act: '',
      note: kind === 'in' ? 'лишки, виявлені під час звірки' : 'нестача, виявлена під час звірки' };
    state.moveKind = kind;
    state.draft = { kind, head, lines: src.map((x) => {
      const ln = { code: x.code, qty: String(x.qty), note: '', lot: '', unit: '',
                   price: kind === 'in' && x.price ? String(x.price) : '' };
      if (kind === 'wr' && x.price) {
        // Ціна з відомості — це партія: списується саме вона, а не найдавніша.
        const lot = lotChoices(x.code, r.sub, r.to).find((l) => Math.abs(l.price - x.price) < 0.005);
        if (lot) { ln.lot = lot.d; ln.price = String(lot.price); }
      }
      return ln;
    }).concat([emptyLine()]) };
    state.flash = `Чернетку складено з відомості №${r.no || '—'} (${r.sub}): ${cnt(src.length, 'рядок', 'рядки', 'рядків')}. `
      + 'Перевірте кількості, впишіть номер і проведіть.';
    go('moves', { q: '', formOpen: true });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }
