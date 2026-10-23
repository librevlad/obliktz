// Облік ТЗ ПС · сторінка · імпорт історії, заявка на некомплект.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ ІМПОРТ ІСТОРІЇ
  /** Історія з Excel. Нова служба починає з чистої бази, а її журнали з 2022 року лежать у
   *  власних книгах. Файл за шаблоном програми (аркуші «Підрозділи», «Номенклатура»,
   *  «Документи») читає сервер, а тут його рядки проходять ті самі перевірки, що й форма
   *  документа, — у порядку дат, ніби документи вносили один за одним. Файл вноситься
   *  цілком або ніяк: історія, внесена наполовину, гірша за невнесену. */
  const IMP_KIND = { 'прихід': 'in', 'переміщення': 'mv', 'вибуття': 'wr', 'списання': 'wr', 'передача': 'wr',
    'знищення': 'dz', 'рапорт': 'dz', 'рапорт про знищення': 'dz' };
  const IMP_ORDER = { in: 0, mv: 1, wr: 2, dz: 3 };
  const IMP_SHEET = { subs: 'Підрозділи', items: 'Номенклатура', docs: 'Документи' };
  const IMP_SHOWN = 200;
  const impYes = (v) => /^(так|т|\+|1|true|yes|y)$/i.test(String(v || '').trim());

  /** Нові підрозділи з аркуша. Наявних не чіпає; підпорядкування — за назвою з програми
   *  або з того самого аркуша. */
  function impSubs(rows, bad) {
    const fresh = [];
    const names = new Set(rows.map((r) => r.name).filter(Boolean));
    const seen = new Set();
    for (const r of rows) {
      const err = (text) => bad.push({ sheet: IMP_SHEET.subs, row: r.row, text });
      if (!r.name) { err('немає назви підрозділу'); continue; }
      if (r.name.includes('|')) { err(`«${r.name}»: у назві не ставте «|»`); continue; }
      if (subBy.has(r.name) || seen.has(r.name)) continue;
      seen.add(r.name);
      if (r.parent === r.name) { err(`«${r.name}» підпорядкований сам собі`); continue; }
      if (r.parent && !subBy.has(r.parent) && !names.has(r.parent)) {
        err(`«${r.name}»: підрозділу «${r.parent}», якому він підпорядкований, немає ні в програмі, ні на аркуші`);
        continue;
      }
      const type = String(r.type || '').trim().toLowerCase() || 'рота';
      if (!SUB_KINDS.includes(type)) { err(`«${r.name}»: виду «${r.type}» немає. Є: ${SUB_KINDS.join(', ')}`); continue; }
      // Розформований підрозділ лишається в історії, але в нових документах його немає.
      const closed = impYes(r.closed);
      fresh.push({ id: uid(), name: r.name, parent: r.parent || '', type, active: !closed,
        note: r.note || (closed ? 'закритий' : '') });
    }
    // Підпорядкування по колу («А → Б → А») дерево не витримає: кожен рядок кола —
    // помилка з рядками файла, які його утворюють.
    const parentOf = new Map(subs.map((s) => [s.name, s.parent || '']));
    for (const s of fresh) parentOf.set(s.name, s.parent);
    const rowOf = new Map(rows.filter((r) => r.name).map((r) => [r.name, r.row]));
    const looped = new Set();
    for (const s of fresh) {
      const seen = [];
      let cur = s.name;
      while (cur && !seen.includes(cur)) { seen.push(cur); cur = parentOf.get(cur) || ''; }
      if (!cur || looped.has(s.name)) continue;
      const loop = seen.slice(seen.indexOf(cur)).concat(cur);
      looped.add(s.name);
      bad.push({ sheet: IMP_SHEET.subs, row: rowOf.get(s.name),
        text: `«${s.name}»: підпорядкування по колу — ${loop.map((n) => `«${n}»`).join(' → ')}`
          + ` (рядки ${[...new Set(loop.map((n) => rowOf.get(n)).filter(Boolean))].join(', ')})` });
    }
    return fresh.filter((s) => !looped.has(s.name));
  }

  /** Нові позиції з аркуша. Позиція, яка вже є в програмі, лишається як є: файл її не править. */
  function impItems(rows, bad, warn) {
    const fresh = [];
    const seen = new Map();
    const groupOf = (v) => {
      const t = String(v || '').trim();
      if (!t) return groupName.has('21.18') ? '21.18' : (D.groups[D.groups.length - 1] || [''])[0];
      if (groupName.has(t)) return t;
      const hit = D.groups.find(([, label]) => String(label).toLowerCase() === t.toLowerCase());
      return hit ? hit[0] : null;
    };
    for (const r of rows) {
      const err = (text) => bad.push({ sheet: IMP_SHEET.items, row: r.row, text });
      if (!r.code) { err('немає коду позиції'); continue; }
      if (seen.has(r.code)) { err(`код ${r.code} уже є в рядку ${seen.get(r.code)}`); continue; }
      seen.set(r.code, r.row);
      const have = itemBy.get(r.code);
      if (have) {
        if (r.name && normName(r.name) !== normName(have.name)) {
          warn.push({ sheet: IMP_SHEET.items, row: r.row,
            text: `код ${r.code} у програмі «${have.name}», у файлі «${r.name}». Лишається назва програми` });
        }
        continue;
      }
      if (!r.name) { err(`код ${r.code}: немає найменування`); continue; }
      if (!r.unit) { err(`код ${r.code}: немає одиниці виміру`); continue; }
      const group = groupOf(r.group);
      if (group == null) { err(`код ${r.code}: розділу «${r.group}» у табелі 21/Прод немає`); continue; }
      if (r.price === '?' || (r.price != null && !(r.price >= 0))) { err(`код ${r.code}: ціна не число`); continue; }
      const fes = String(r.fes || '').replace(/\s+/g, '');
      if (fes && !/^\d+$/.test(fes)) { err(`код ${r.code}: номер ФЕС пишуть лише цифрами`); continue; }
      // Номер ФЕС вирішує вид обліку так само, як у картці позиції: десять цифр із класом 10 чи 11.
      const byFes = fes ? fes.length === 10 && /^1[01]/.test(fes) : null;
      fresh.push({ code: r.code, name: r.name, unit: r.unit, group, price: Math.round((r.price || 0) * 100) / 100,
        nonrev: byFes ?? impYes(r.nonrev), fes, note: r.note || '', old: '', archived: '' });
    }
    return fresh;
  }

  /** Рядки аркуша «Документи» — у документи: той самий вид, дата, номер і маршрут складають
   *  один документ. Порядок — за датою; того самого дня спершу прихід, потім переміщення,
   *  вибуття й рапорти, а серед рівних — як у файлі. */
  function impDocs(rows, bad, priceOf, broken, warn = []) {
    const by = new Map();
    const named = new Set();
    rows.forEach((r, n) => {
      // Назва в рядку — для звірки з кодом: жодного спільного слова з назвою позиції — схоже, код не той.
      const it = r.name && r.code && !named.has(r.code) ? itemBy.get(r.code) : null;
      if (it && !mtzAlike(r.name, it.name)) {
        named.add(r.code);
        warn.push({ sheet: IMP_SHEET.docs, row: r.row, text: `код ${r.code} у програмі «${it.name}», у рядку «${r.name}». Перевірте код` });
      }
      const word = String(r.kind || '').trim().toLowerCase();
      const k = IMP_KIND[word];
      // Рядок приходу чи переміщення, який не пройшов, — це майно, якого далі бракуватиме.
      const err = (text) => {
        bad.push({ sheet: IMP_SHEET.docs, row: r.row, text });
        if (r.code && k !== 'wr' && k !== 'dz') broken.add(r.code);
      };
      const no = String(r.no || '').trim();
      const found = bad.length;
      if (!word) err('не вказано вид документа');
      else if (!k) err(`вид «${r.kind}» не розпізнано. Є: Прихід, Переміщення, Вибуття, Знищення`);
      if (!no) err('немає номера документа');
      if (!r.date) err(r.dateText ? `дата «${r.dateText}» не читається. Пишіть як 15.03.2022` : 'немає дати документа');
      if (!r.code) err('немає коду позиції');
      if (r.qty == null) err('немає кількості');
      else if (r.qty === '?' || !(r.qty > 0)) err('кількість має бути числом, більшим за нуль');
      if (r.price === '?' || (r.price != null && !(r.price >= 0))) err('ціна не число');
      if (bad.length > found) return;
      const from = String(r.from || '').trim();
      const to = k === 'in' ? String(r.to || '').trim() || 'склад' : k === 'dz' ? '' : String(r.to || '').trim();
      const key = [k, r.date, normNo(no), from, to].join('\u0000');
      let d = by.get(key);
      if (!d) {
        d = { k, n, row: r.row, lines: [],
          h: { type: r.type || MOVE_KINDS.find(([kk]) => kk === k)[2], no, date: r.date, from, to, basis: '', note: '',
            report: '', reportDate: '', act: '' } };
        by.set(key, d);
      }
      if (!d.h.basis && r.basis) d.h.basis = r.basis;
      if (k === 'dz' && !d.h.act && r.act) d.h.act = r.act;
      // Ціна: у приході — з рядка, а без неї — з аркуша «Номенклатура»; у рапорті — лише своя.
      const price = r.price != null ? r.price : (k === 'in' ? priceOf(r.code) : null);
      const ln = { code: r.code, qty: String(r.qty), price: (k === 'in' || k === 'dz') && price != null ? String(price) : '',
        note: r.note || '', lot: '', unit: '', row: r.row };
      // Та сама позиція двома рядками журналу (дві кухні — два рядки) — один рядок документа з сумою.
      const twin = k === 'dz' ? null : d.lines.find((x) => x.code === ln.code && x.price === ln.price && x.note === ln.note);
      if (twin) twin.qty = String(round3(+twin.qty + r.qty));
      else d.lines.push(ln);
    });
    return [...by.values()].sort((a, b) => (a.h.date < b.h.date ? -1 : a.h.date > b.h.date ? 1 : 0)
      || IMP_ORDER[a.k] - IMP_ORDER[b.k] || a.n - b.n);
  }

  /** Один документ файла — в облік, як його провела б форма: ті самі перевірки, той самий
   *  запис у журнал. Помилка лишає облік без цього документа й називає рядок файла. */
  function impPost(d, bad, warn, stat, broken) {
    const { k, h, lines } = d;
    const label = `${h.type} ${numNo(h.no)} від ${fmtDate(h.date)}`;
    // Прихід чи переміщення не пройшли — їхніх позицій далі бракуватиме. «Немає в наявності» за
    // такою позицією — наслідок, а не нова помилка: у звіт іде першопричина, наслідки лише лічаться.
    // Вибуття й рапорт, що не пройшли, нестачі далі не дають.
    const tainted = lines.some((l) => broken.has(l.code));
    let hidden = false;
    const fail = () => {
      if (k === 'in' || k === 'mv') for (const l of lines) broken.add(l.code);
      if (hidden) stat.after++;
    };
    const err = (text, row = d.row) => {
      if (tainted && /числиться|від’ємним/.test(text)) hidden = true;
      else bad.push({ sheet: IMP_SHEET.docs, row, text: `${label}: ${text}` });
    };
    // Форма дає вибрати підрозділ із переліку, файл — ні: назва має бути в довіднику.
    const found = bad.length;
    for (const [side, s] of (k === 'in' ? [['Кому', h.to]] : k === 'mv' ? [['Від кого', h.from], ['Кому', h.to]]
      : [['Від кого', h.from]])) {
      if (s && !subBy.has(s)) err(`«${side}»: підрозділу «${s}» немає ні в програмі, ні на аркуші «Підрозділи»`);
    }
    for (const ln of lines) {
      if (!itemBy.has(ln.code)) err(`коду ${ln.code} немає ні в програмі, ні на аркуші «Номенклатура»`, ln.row);
    }
    if (bad.length > found) { fail(); return; }
    // Документ, який уже є в обліку, файл удруге не вносить: той самий файл можна доповнити й подати знову.
    const there = k === 'dz'
      ? allDestroyed().some((x) => x.date === h.date && normNo(x.report) === normNo(h.no) && x.sub === h.from
        && lines.some((l) => l.code === x.code))
      : docs.some((r) => r.kind === k && r.d === h.date && normNo(r.no) === normNo(h.no) && r.from === h.from
        && (r.to || '') === (h.to || ''));
    if (there) { stat.skipped++; return; }
    state.moveKind = k;
    const dr = { kind: k, head: h, lines, warn: [] };
    const issues = checkDraft(dr, h, k);
    if (issues.length) { for (const t of issues) err(t); fail(); return; }
    const codes = new Set(lines.map((x) => x.code));
    // Номери в старих паперах повторюються законно: про повтор номера звіт мовчить, як і режим «вношу історію».
    const notes = dr.warn.filter((t) => !/ уже є (в обліку|на інший маршрут)/.test(t));
    if (k === 'dz') {
      const was = dzProfile(codes);
      for (const ln of lines) store.destroyed.push(dzRecord(h, ln, uid(), 'program'));
      dzCache = null;
      const over = newDzOver(codes, was);
      if (over) notes.push(dzOverMessage(over));
    } else {
      const before = negProfile(codes);
      const was = k === 'mv' ? dzProfile(codes) : null;
      const arr = store.docs[STORE_OF[k]];
      const at = arr.length;
      for (const row of rowsFromDraft(k, h, lines)) arr.push(row);
      const neg = newNegative(codes, before);
      if (neg) { arr.length = at; err(negMessage(neg, 'new')); fail(); return; }
      if (was) {
        dzCache = null;
        const over = newDzOver(codes, was);
        if (over) notes.push(dzOverMessage(over));
      }
    }
    recalc();
    for (const t of notes) warn.push({ sheet: IMP_SHEET.docs, row: d.row, text: `${label}: ${t}` });
    // Підписана звірка чи завершена інвентаризація після дати документа рахували без нього.
    if (periodLock([h.date], [h.from, k === 'wr' ? '' : h.to])) stat.locked++;
    stat.docs[k]++;
    stat.lines += lines.length;
    if (!stat.from || h.date < stat.from) stat.from = h.date;
    if (!stat.to || h.date > stat.to) stat.to = h.date;
  }

  /** Проганяє файл по обліку. keep=false — лише перевірка: облік повертається до того, яким
   *  був. keep=true — внесене лишається, якщо помилок немає. `undo` скасовує внесене. */
  function impRun(data, keep = false) {
    peopleInit();
    mergeOwnItems();
    const bad = [], warn = [];
    const snap = { incoming: store.docs.incoming.slice(), movement: store.docs.movement.slice(),
      writeoffs: store.docs.writeoffs.slice(), destroyed: store.destroyed.slice(), items: (store.items || []).slice(),
      subs: store.subs.slice(), moveKind: state.moveKind, editing: state.editing, editingReport: state.editingReport };
    const undo = () => {
      Object.assign(store.docs, { incoming: snap.incoming, movement: snap.movement, writeoffs: snap.writeoffs });
      store.destroyed = snap.destroyed;
      store.items = snap.items;
      store.subs = snap.subs;
      mergeOwnItems();
      recalc();
    };
    const stat = { subs: 0, items: 0, docs: { in: 0, mv: 0, wr: 0, dz: 0 }, lines: 0, skipped: 0, after: 0, locked: 0,
      from: '', to: '' };
    const broken = new Set();
    try {
      state.editing = null;
      state.editingReport = null;
      const newSubs = impSubs(data.subs || [], bad);
      if (newSubs.length) { store.subs = store.subs.concat(newSubs); rebuildSubs(store.subs, subMentions()); }
      const newItems = impItems(data.items || [], bad, warn);
      if (newItems.length) { store.items = (store.items || []).concat(newItems); mergeOwnItems(); applyPrices(); }
      stat.subs = newSubs.length;
      stat.items = newItems.length;
      // Ціна з аркуша «Номенклатура» — рядкам приходу без своєї, поки позиція ще не має ціни в програмі.
      const sheetPrice = new Map((data.items || []).filter((r) => r.price > 0).map((r) => [r.code, r.price]));
      const priceOf = (code) => ((itemBy.get(code) || {}).price > 0 ? null : sheetPrice.get(code) ?? null);
      for (const d of impDocs(data.docs || [], bad, priceOf, broken, warn)) impPost(d, bad, warn, stat, broken);
      if (stat.locked) {
        warn.push({ sheet: IMP_SHEET.docs, row: 0, text: `${cnt(stat.locked, 'документ', 'документи', 'документів')} у закритому періоді: `
          + 'підписані звірки й завершені інвентаризації рахували без них' });
      }
    } finally {
      state.moveKind = snap.moveKind;
      state.editing = snap.editing;
      state.editingReport = snap.editingReport;
    }
    if (bad.length || !keep) undo();
    bad.sort((a, b) => a.sheet.localeCompare(b.sheet, 'uk') || a.row - b.row);
    return { bad, warn, stat, undo };
  }

  const impCount = (st) => st.docs.in + st.docs.mv + st.docs.wr + st.docs.dz;
  /** «документів 245 (прихід 80, переміщення 140, вибуття 20, рапортів 5), рядків 730, …» */
  function impSummary(st) {
    const kinds = [['in', 'прихід'], ['mv', 'переміщення'], ['wr', 'вибуття'], ['dz', 'рапортів про знищення']]
      .filter(([k]) => st.docs[k]).map(([k, l]) => `${l} ${st.docs[k]}`).join(', ');
    return [impCount(st) ? `документів ${impCount(st)} (${kinds}), рядків ${st.lines}, з ${fmtDate(st.from)} по ${fmtDate(st.to)}`
      : 'документів 0',
    st.subs ? `нових підрозділів ${st.subs}` : '', st.items ? `нових позицій ${st.items}` : '',
    st.skipped ? `уже в обліку ${st.skipped}` : ''].filter(Boolean).join('; ');
  }

  function impOpen() {
    if (!native) { toast('Імпорт з Excel є лише в програмі на комп’ютері.', true); return; }
    state.imp = null;
    impShow();
  }
  function impShow() {
    const s = state.imp;
    const list = (title, rows, cls) => (rows.length ? `<div class="panel"><div class="panel__note"><b>${esc(title)}</b></div></div>
      <div class="tbl" style="--tbl-min:auto">${rows.slice(0, IMP_SHOWN).map((x) => `<div class="tbl__row tbl__row--plain">
        <div class="c-code" style="width:170px">${esc(x.sheet)}${x.row ? `, рядок ${esc(String(x.row))}` : ''}</div>
        <div class="c-txt ${cls}" style="white-space:normal">${esc(x.text)}</div></div>`).join('')}</div>
      ${rows.length > IMP_SHOWN ? `<div class="panel"><div class="panel__note">і ще ${rows.length - IMP_SHOWN}</div></div>` : ''}` : '');
    const res = s && s.res;
    const ready = res && !res.bad.length && (impCount(res.stat) || res.stat.subs || res.stat.items);
    modalOpen('Імпорт історії з Excel', `<div class="panel">
        <div class="panel__note">Файл за шаблоном програми: аркуші «Підрозділи», «Номенклатура», «Документи».
          Вноситься цілком або ніяк.</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="imp-template">Шаблон в Excel</button>
        <button class="btn${ready ? '' : ' btn--primary'}" data-act="imp-file">Обрати файл…</button></div>
      ${res ? `<div class="panel"><div class="panel__note" id="imp-sum">«${esc(s.file)}»: ${res.bad.length
    ? `помилок ${res.bad.length}${res.stat.after
      ? `, через них не пройшло ще ${cnt(res.stat.after, 'документ', 'документи', 'документів')}` : ''}.
            Нічого не внесено: виправте файл і оберіть його знову. Без помилок: ${esc(impSummary(res.stat))}.`
    : `${esc(impSummary(res.stat))}. ${ready ? 'Помилок немає.' : 'Вносити нічого.'}`}</div>
        <div class="panel__spacer"></div>
        ${res.bad.length ? '<button class="btn" data-act="imp-errors">Помилки в Excel</button>' : ''}
        ${ready ? '<button class="btn btn--primary" data-act="imp-apply">Внести в облік</button>' : ''}</div>
        ${list('Помилки', res.bad, 'num-bad')}${list('Зауваження', res.warn, 'num-warn')}` : ''}`);
  }
  function impPick() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = '.xlsx';
    inp.addEventListener('change', () => { if (inp.files && inp.files[0]) impRead(inp.files[0]); });
    inp.click();
  }
  async function impRead(file) {
    let got;
    try {
      const r = await fetch('api/history-read', { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' }, body: file });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      got = await r.json();
    } catch (e) {
      toast('Файл не прочитано: ' + (e.message || e), true);
      return;
    }
    state.imp = { file: file.name, data: got, res: impRun(got) };
    impShow();
  }
  /** Вносить перевірений файл: один запис у базу з копією перед ним. Якщо база не прийняла,
   *  облік повертається до того, яким був, а причина стає помилкою у звіті. */
  async function impApply() {
    const s = state.imp;
    if (!s || !s.data) return;
    const res = impRun(s.data, true);
    s.res = res;
    if (res.bad.length) { impShow(); return; }                  // облік змінився, поки вікно було відкрите
    logChange('історію імпортовано', 'imp', `«${s.file}»: ${impSummary(res.stat)}`);
    // Запис, який уже йде, несе стан до імпорту: чекаємо його й пишемо свій.
    if (saving.busy) await saving.busy;
    saving.dirty = true;
    saving.backup = true;
    const ok = (await flush()) === true;
    if (!ok) {
      const why = (($('#save-bar') || {}).textContent || 'база не прийняла запис').replace(/\s*Виправте це.*$/, '');
      res.undo();
      store.log.pop();
      clearTimeout(saving.retry);
      saving.failed = false;
      saveBar('');
      save(true);
      res.bad.push({ sheet: 'База', row: 0, text: why });
      render();
      impShow();
      return;
    }
    modalClose();
    state.imp = null;
    state.flash = `Історію внесено з «${s.file}»: ${impSummary(res.stat)}.`;
    recalc();
    go('moves', { q: '', movesKindF: '', movesFrom: '', movesTo: '', sub: '' });
  }
  function impTemplate() {
    peopleInit();
    toExcel({ kind: 'history-template', file: 'Шаблон імпорту історії',
      subs: subs.map((x) => [x.name, x.parent || '', x.type || '', x.active ? '' : 'так', x.note || '']),
      items: items.map((i) => [i.code, i.name, i.unit || '', i.group || '', +i.price > 0 ? +i.price : '',
        i.nonrev ? 'так' : 'ні', i.fes || '', i.note || '']),
      subKinds: SUB_KINDS, groups: D.groups });
  }
  function impErrors() {
    const res = state.imp && state.imp.res;
    if (!res || !res.bad.length) return;
    toExcel({ file: 'Помилки імпорту історії', sheets: [{ name: 'Помилки', orientation: 'landscape',
      title: 'Помилки імпорту історії', subtitle: `файл «${state.imp.file}»`,
      head: [['Аркуш', 'Рядок', 'Що не так']], widths: [18, 8, 110],
      rows: res.bad.map((x) => [x.sheet, x.row || '', x.text]) }] });
  }
  function impAction(act) {
    switch (act) {
      case 'imp-open': return impOpen();
      case 'imp-template': return impTemplate();
      case 'imp-file': return impPick();
      case 'imp-apply': return impApply();
      case 'imp-errors': return impErrors();
      default: return null;
    }
  }

  // ============================================================ ЗАЯВКА НА НЕКОМПЛЕКТ
  /** Форма 21/Прод у бланку вищого штабу: підрозділ зі «Штату» (порожньо — уся частина)
   *  на звітну дату. Бланк, назви рядків і формули — з самого бланка; книгу будує сервер. */
  function form21Excel() {
    return toExcel({ kind: 'form21', sub: state.sub || '', date: state.asOf, file: `21 Прод на ${state.asOf}` });
  }
  /** Комплект одним рухом: зведена за частину, управління (усе поза батальйонами) і кожен
   *  батальйон — книга з аркушем на кожного й ті самі форми окремими файлами в одній теці. */
  function form21SetExcel() {
    return toExcel({ kind: 'form21set', date: state.asOf, file: `21 Прод на ${state.asOf}`,
      note: 'Окремі файли за батальйонами й розшифровка до форми лежать у тій самій теці.' });
  }

  function shortageExcel() {
    const date = state.asOf;
    const rows = applySubst(staffRows(date, state.sub).filter((g) => g.form === state.staffForm), state.staffForm);
    const withS = !!((store.subst || []).some((x) => x.form === state.staffForm) && store.ui.withSubst);
    const list = rows.filter((g) => g.staffed && (withS ? g.shortS : g.short) > 0);
    if (!list.length) { toast('Некомплекту немає.'); return; }
    // «Де бракує» рахується так само, як графа «Некомплект»: наявність мінус
    // знищене, не списане, і з тими самими замінами — у межах кожного підрозділу.
    // Раніше знищене й заміни тут не враховувались, і суми не сходилися.
    const perSubRows = new Map();
    const rowsOf = (sb) => {
      if (!perSubRows.has(sb)) {
        const rs = staffRows(date, sb).filter((g) => g.form === state.staffForm);
        if (withS) applySubst(rs, state.staffForm);
        perSubRows.set(sb, new Map(rs.map((g) => [g.line, g])));
      }
      return perSubRows.get(sb);
    };
    const perSub = (g) => [...new Set(g.subs.map(([sb]) => sb))].map((sb) => {
      const x = rowsOf(sb).get(g.line);
      const s = x ? (withS ? x.shortS : x.short) : 0;
      return s > 1e-9 ? `${sb} — ${fmtNum(s)}` : '';
    }).filter(Boolean).join('; ');
    toExcel({ file: `Заявка на некомплект ${date}`, sheets: [{
      name: 'Заявка', orientation: 'landscape', top: [unitInfo().legalName, unitInfo().serviceFull],
      title: 'ЗАЯВКА на доукомплектування технічними засобами продовольчої служби',
      subtitle: `станом на ${fmtDate(date)} · форма ${state.staffForm}${state.sub ? ' · ' + state.sub : ''}${withS ? ' · з урахуванням замін' : ''}`,
      head: [['№', 'Табельна позиція', 'За штатом', 'Наявно', withS ? 'По заміні' : '', 'Некомплект', 'Де бракує']],
      widths: [5, 44, 11, 11, 11, 12, 60],
      rows: list.map((g, i) => [i + 1, g.line, g.qty, round3(g.fact), withS ? g.subIn || '' : '', withS ? g.shortS : g.short, perSub(g)]),
      num: [2, 3, 4, 5],
      total: ['', 'Разом', list.reduce((a, g) => a + g.qty, 0), round3(list.reduce((a, g) => a + g.fact, 0)), '',
        list.reduce((a, g) => a + (withS ? g.shortS : g.short), 0), ''],
      signs: ['Начальник продовольчої служби'],
    }] });
  }
