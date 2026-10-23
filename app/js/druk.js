// Облік ТЗ ПС · сторінка · документи, внесені тут; друк; Excel.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ------------------------------------------------ документи, внесені тут
  const STORE_OF = { in: 'incoming', mv: 'movement', wr: 'writeoffs' };

  /** Рядки документа в стані програми: [вид, масив, індекси]. Тут усі
   *  документи — і з паперових журналів служби, і внесені в програмі. */
  function storeRowsOf(key) {
    const [kind, d, no, from, to] = key.split('|');
    const arr = store.docs[STORE_OF[kind]] || [];
    const idx = [];
    // Маршрут — частина ключа: той самий номер того самого дня на інший
    // підрозділ — інший документ, і правити треба саме його рядки.
    arr.forEach((r, i) => {
      if (r[0] !== d || String(r[2]).trim() !== no) return;
      if (from !== undefined && String(r[3] ?? '').trim() !== from) return;
      if (to !== undefined && String(r[4] ?? '').trim() !== to) return;
      idx.push(i);
    });
    return { kind, d, no, from, to, arr, idx };
  }

  /** «Накладна №17 від 02.03.2026» — назва документа за його ключем. */
  function docTitleOf(key) {
    const { kind, d, no, arr, idx } = storeRowsOf(key);
    return `${(idx.length && arr[idx[0]][1]) || KIND_NAME[kind] || 'Документ'} ${numNo(no)} від ${fmtDate(d)}`;
  }

  /** Перше місце, де залишок іде в мінус, або null.
   *
   *  Видалити прихід, з якого потім видавали, — означає створити видачу з
   *  нічого. Тому перед видаленням і після правки перераховується вся стрічка
   *  проводок по зачеплених позиціях, а не лише дата самого документа.
   */
  /** Найглибший мінус по кожній парі «код|підрозділ» у стрічці проводок. */
  function negProfile(codes) {
    const run = new Map(), worst = new Map();
    for (const e of buildLedger()) {
      if (!codes.has(e.code)) continue;
      const k = e.code + '|' + e.sub;
      const v = (run.get(k) || 0) + e.sg * e.q;
      run.set(k, v);
      if (v < -1e-9 && (!worst.has(k) || v < worst.get(k).v - 1e-9)) {
        worst.set(k, { code: e.code, sub: e.sub, d: e.d, no: e.no, v });
      }
    }
    return worst;
  }

  /** Мінус, якого до зміни не було (або глибший за той, що вже був).
   *
   *  Перевіряється вся стрічка далі по часу, а не лише дата документа: прихід,
   *  внесений заднім числом, чи видалений прихід, з якого потім видавали, дають
   *  мінус у пізніших документах. Мінуси, що вже є в базі, роботи не блокують —
   *  лише нові. */
  function newNegative(codes, before) {
    for (const [k, x] of negProfile(codes)) {
      const was = before.get(k);
      if (!was || x.v < was.v - 1e-9) return x;
    }
    return null;
  }

  /** Знищеного, ще не списаного, більше, ніж числиться: майно пішло з підрозділу
   *  вже після того, як його знищено, — рапорт або накладна хибні, а фактична
   *  наявність іде в мінус. Найгірше місце на кожну пару «код|підрозділ». */
  function dzProfile(codes) {
    const out = new Map();
    const gone = new Map();
    for (const r of allDestroyed()) {
      if (!codes.has(r.code)) continue;
      const k = r.code + '\u0000' + r.sub;
      if (!gone.has(k)) gone.set(k, []);
      gone.get(k).push([r.date, 0, +r.qty || 0]);
      if (r.status === 'списано' && r.actDate) gone.get(k).push([r.actDate, 0, -(+r.qty || 0)]);
    }
    if (!gone.size) return out;
    const led = buildLedger();
    for (const [k, evs] of gone) {
      const [code, sub] = k.split('\u0000');
      const all = led.filter((e) => e.code === code && e.sub === sub).map((e) => [e.d, e.sg * e.q, 0])
        .concat(evs).sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
      let stock = 0, dz = 0;
      all.forEach(([d, q, g], i) => {
        stock += q; dz += g;
        if (all[i + 1] && all[i + 1][0] === d) return;          // підсумок — на кінець дня
        const over = round3(dz - stock);
        if (over > 1e-9 && (!out.has(k) || over > out.get(k).over + 1e-9)) {
          out.set(k, { code, sub, d, over, stock: round3(stock), gone: round3(dz) });
        }
      });
    }
    return out;
  }
  function newDzOver(codes, before) {
    for (const [k, x] of dzProfile(codes)) {
      const was = before.get(k);
      if (!was || x.over > was.over + 1e-9) return x;
    }
    return null;
  }
  const dzOverMessage = (x) => `«${(itemBy.get(x.code) || {}).name || x.code}»: на ${fmtDate(x.d)} у «${x.sub}» `
    + `числиться ${fmtNum(x.stock, '0')}, а знищеного й ще не списаного — ${fmtNum(x.gone)}. `
    + 'Знищене не переміщують: спершу спишіть його актом або перевірте дату рапорту.';

  /** Перший розрив у ланцюжку одиниці із заводським номером: накладна видає її
   *  звідти, де її на той час немає. Видалити чи переписати документ, яким кухня
   *  приїхала, означає лишити пізнішу накладну без неї. */
  function unitBreak(units) {
    if (!units || !units.size) return null;
    const moves = new Map();
    for (const r of buildDocs()) {
      const id = String(r.unit || '');
      if (!id || !units.has(id)) continue;
      if (!moves.has(id)) moves.set(id, []);
      moves.get(id).push(r);
    }
    for (const [id, arr] of moves) {
      arr.sort((a, b) => (a.d < b.d ? -1 : a.d > b.d ? 1 : KIND_ORDER[a.kind] - KIND_ORDER[b.kind]));
      let holder = null;
      for (const r of arr) {
        if (r.kind === 'in') { holder = r.to; continue; }
        if (holder !== null && r.from !== holder) return { id, row: r, holder };
        holder = r.kind === 'wr' ? '' : r.to;
      }
    }
    return null;
  }

  function unitMessage(b) {
    const it = itemBy.get(b.row.code);
    return `${it ? cleanName(it.name) : b.row.code}, ${unitLabel(unitBy.get(String(b.id)))}: документ `
      + `${numNo(b.row.no)} від ${fmtDate(b.row.d)} видає її з «${b.row.from}», а за обліком вона `
      + `${b.holder ? `в «${b.holder}»` : 'ніде не числиться'}. Спершу виправте той документ.`;
  }

  /** Пояснення, чому зміна не пройшла, — з порадою під конкретну дію:
   *  новий документ забирає майно, яке пізніше вже видали; видалення чи
   *  виправлення лишає без майна пізніший документ. */
  function negMessage(neg, mode = 'edit') {
    const it = itemBy.get(neg.code);
    const what = `залишок «${it ? it.name : neg.code}» у «${neg.sub}» стане від’ємним (${fmtNum(neg.v)}) `
      + `за документом ${numNo(neg.no)} від ${fmtDate(neg.d)}. `;
    return what + (mode === 'new'
      ? 'Це майно пізніше видано. Зменште кількість або перевірте дату документа.'
      : 'Спершу виправте або видаліть той документ.');
  }

  function deleteDoc(key) {
    // Документ акта за нормами видаляється разом з актом — так само, як із вікна акта.
    const actId = actOfKey(key);
    if (actId) { actDelete(actState(actId)); return; }
    const { kind, d, no, arr, idx } = storeRowsOf(key);
    if (!idx.length) {
      alert('Документ не знайдено. Оновіть сторінку (F5).');
      return;
    }
    const rows = idx.map((i) => arr[i]);
    const names = rows.map((r) => {
      const code = r[5];
      const qty = r[6];
      const it = itemBy.get(code);
      return `  • ${it ? it.name : code} — ${fmtNum(qty)}`;
    }).join('\n');
    const files = filesOf(key).length;
    // Акт, яким списано знищене: після видалення воно знову знищене, не списане.
    const closing = kind === 'wr' ? allDestroyed().filter((x) => x.status === 'списано'
      && (x.actId ? actDocKey(x) === key : x.act && actDocsOf(x).some((w) => keyOfRow(w) === key))) : [];
    if (!confirm(`Видалити документ ${numNo(no)} від ${fmtDate(d)}?\n\n${names}\n\nУсі його рядки буде знято з обліку.`
      + (files ? `\nДо документа підшито ${cnt(files, 'файл', 'файли', 'файлів')}: ${files === 1 ? 'він лишиться' : 'вони лишаться'} в теці «скани».` : '')
      + (closing.length ? `\nЦим актом списано знищене за рапортами (${cnt(closing.length, 'запис', 'записи', 'записів')}): `
        + 'воно знову рахуватиметься знищеним, не списаним.' : ''))) return;
    const lock = periodLock([d], rows.flatMap((r) => [r[3], kind === 'wr' ? '' : r[4]]));  // одержувач вибуття — не підрозділ
    if (lock && !confirm(lock.replace('Провести все одно?', 'Видалити все одно?'))) return;
    const codes = new Set(rows.map((r) => r[5]));
    const units = new Set(rows.map((r) => String(rowUnit(kind, r) || '')).filter(Boolean));
    const before = negProfile(codes);
    const kept = arr.filter((_, i) => !idx.includes(i));
    const backup = arr.slice();
    store.docs[STORE_OF[kind]] = kept;
    const neg = newNegative(codes, before);
    const broke = neg ? null : unitBreak(units);
    if (neg || broke) {
      store.docs[STORE_OF[kind]] = backup;
      alert('Документ не видалено: ' + (neg ? negMessage(neg) : unitMessage(broke)));
      return;
    }
    logChange('видалено', key, `${kindName({ kind, to: kind === 'wr' ? rows[0][4] : '' })} ${numNo(no)} від ${fmtDate(d)}: ${names.replace(/\n\s*•\s*/g, '; ').replace(/^\s*•\s*/, '')}`
      + (lock ? ' — у закритому періоді' : ''));
    // Бюджетні реквізити надходження зникають разом із ним: новий документ під тим самим id починає з чистого.
    if (kind === 'in') for (const id of new Set(rows.map((r) => rowId('in', r)).filter(Boolean))) mtzForget(id);
    for (const id of new Set(rows.map((r) => rowId(kind, r)).filter(Boolean))) docFieldsForget(id);
    // Видалили документ, який саме виправляли: форма закривається, інакше
    // «Зберегти виправлення» внесло б його знову, уже новим документом.
    if (state.editing === key) { state.editing = null; state.draft = null; state.formOpen = false; }
    save(true, true);
    // Із картки видаленого документа повертаємось туди, звідки її відкрили.
    if (state.view === 'doc') state.view = state.docBack && state.docBack !== 'doc' ? state.docBack : 'moves';
    refresh();
    toast(`Документ ${numNo(no)} від ${fmtDate(d)} видалено.`);
  }

  /** Виправлення — це той самий документ у формі: рядки повертаються в
   *  чернетку, а оригінал лишається в обліку, доки нова редакція не пройде
   *  перевірок. Скасування правки нічого не змінює. */
  /** Проведено акт списання, а в підрозділі є знищене без акта на ті самі
   *  позиції — пропонуємо закрити ці записи цим актом, щоб знищене не
   *  віднімалось від наявності вдруге. */
  function offerDestroyedLink(h) {
    const key = docKey('wr', h.date, h.no, h.from, h.to || '');
    const rows = docs.filter((r) => keyOfRow(r) === key);
    // Скільки акт іще може закрити: його кількість мінус уже закрите ним. Запис,
    // що не вміщається цілим, не пропонуємо — інакше акт на 3 «закрив» би 5.
    const room = new Map();
    for (const r of rows) room.set(r.code, round3((room.get(r.code) || 0) + (+r.q || 0)));
    const units = new Set(rows.filter((r) => r.unit).map((r) => String(r.unit)));
    for (const x of allDestroyed()) {
      if (x.status !== 'списано' || !(x.actId ? actDocKey(x) === key
        : x.act && actDocsOf(x).some((w) => keyOfRow(w) === key))) continue;
      room.set(x.code, round3((room.get(x.code) || 0) - (+x.qty || 0)));
      if (x.unit) units.delete(String(x.unit));
    }
    const open = allDestroyed().filter((x) => x.sub === h.from && !x.act && !x.actId && x.status !== 'списано'
      && x.date <= h.date && room.get(x.code) > 0)
      .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
    const pick = [];
    let skipped = 0;
    for (const x of open) {
      const q = +x.qty || 0;
      if ((x.unit && !units.has(String(x.unit))) || room.get(x.code) < q) { skipped++; continue; }
      room.set(x.code, round3(room.get(x.code) - q));
      if (x.unit) units.delete(String(x.unit));
      pick.push(x);
    }
    if (!pick.length) return;
    const list = pick.map((x) => `  • ${(itemBy.get(x.code) || {}).name || x.code}${
      x.unit ? ' (' + unitLabel(unitBy.get(String(x.unit))) + ')' : ''} — ${fmtNum(x.qty)}, `
      + `рапорт №${x.report || '—'} від ${fmtDate(x.date)}`).join('\n');
    if (!confirm(`У «${h.from}» є знищене без акта на ці позиції:\n\n${list}\n\nЗакрити ці записи актом ${numNo(h.no)}?`
      + (skipped ? `\n\nЩе ${cnt(skipped, 'запис', 'записи', 'записів')} не вміщається в кількість акта — їх не включено.` : ''))) return;
    for (const x of pick) {
      const r = store.destroyed.find((y) => y.id === x.id);
      if (r) r.act = h.no;
    }
    dzCache = null;
    save();
  }

  /** Вийти з режиму виправлення — лише за згодою. Інакше форма нового документа
   *  відкривалась із заголовком «Виправлення документа», і проведення підміняло
   *  документ, що виправлявся. */
  function leaveEditing() {
    if (!state.editing && state.editingReport) {
      if (!confirm(`Скасувати виправлення рапорту ${numNo(state.editingReport.no)}?\n\nРапорт лишиться без змін.`)) return false;
      state.editingReport = null;
      state.draft = null;
      return true;
    }
    if (!state.editing) return true;
    const no = state.editing.split('|')[2];
    if (!confirm(`Скасувати виправлення документа ${numNo(no)}?\n\nДокумент лишиться без змін.`)) return false;
    state.editing = null;
    state.draft = null;
    return true;
  }

  /** Незавершену чернетку — у бік, перш ніж форма отримає інший документ. */
  function stashDraft() {
    if (!state.editing && !state.editingReport && state.draft && hasContent(state.draft)) {
      state.drafts = state.drafts || {};
      state.drafts[slotOf(state.draft.kind, state.draft.book || 'ТЗ')] = state.draft;
    }
  }

  /** «Зберегти чернетку»: чернетка лишається — просто прибираємо бланк з очей. Записуємо її одразу, а не за таймером: вікно можуть
   *  закрити наступної миті. Відкладена чернетка вже не відкрита: `stashDraft` лишає її й у `state.draft`, а якби так лишилося, після
   *  «Дописати» й проведення (`state.draft = null`) комірка віддала б проведену чернетку наступною формою — і в налаштуваннях вікна
   *  вона лягала б знову (провести її можна було б удруге). Порожню чернетку (нічого вписати) не чіпаємо: її шапку підставила програма. */
  function draftLater() {
    stashDraft();
    const d = state.draft;
    if (d && (state.drafts || {})[slotOf(d.kind, d.book || 'ТЗ')] === d) state.draft = null;
    keepDrafts();
    state.formOpen = false;
    render();
  }

  /** Місце під нову чернетку документа `kind` у книзі `book`. Незавершена чернетка тієї самої комірки (відкрита у формі чи вже
   *  відкладена) замінюється лише за згодою (`ask` — питання); відкрита у формі чернетка іншої комірки лягає у свою. Питання — ДО
   *  того, як щось відкладається: після «Скасувати» відкрита чернетка лишається лише у формі, а не ще й у комірці, звідки після
   *  проведення вона поверталась би наступною чернеткою (і її можна було б провести вдруге, подвоївши залишок). false — людина
   *  відмовилась, нічого не змінено. */
  function freeDraftSlot(kind, book, ask) {
    state.drafts = state.drafts || {};
    const slot = slotOf(kind, book);
    const open = !state.editing && !state.editingReport && state.draft && hasContent(state.draft) ? state.draft : null;
    const clash = open && slotOf(open.kind, open.book || 'ТЗ') === slot ? open : state.drafts[slot];
    if (clash && hasContent(clash) && !confirm(ask)) return false;
    stashDraft();
    delete state.drafts[slot];
    return true;
  }

  /** Примітка рядка в обліку: підстава документа, його примітка й примітка рядка
   *  через «; ». Так вона склалася в паперових журналах — і так її читає
   *  виправлення. */
  const composeNote = (h, ln) => [h.basis && 'підстава: ' + String(h.basis).replace(/;/g, ','),
    h.note, ln.note].filter(Boolean).join('; ');
  /** Обставини рапорту — підстава й обставини з шапки, спільні для всіх його
   *  рядків (примітка рядка — вони ж плюс свій текст). */
  const reportCirc = (h) => composeNote(h, {});
  /** Запис про знищення з рядка форми рапорту: техзасоби — позицією (з ціною
   *  за документом, коли її вказано), інше майно — назвою, кількістю, ціною й
   *  документом списання; акта програми в нього немає. */
  function dzRecord(h, ln, id, origin) {
    const rec = { id, date: h.date, sub: h.from, code: ln.other ? '' : ln.code, qty: +ln.qty, report: h.no,
      reportDate: h.reportDate || '', circ: reportCirc(h), lnote: ln.note || '', note: composeNote(h, ln), origin };
    if (String(ln.price ?? '').trim() !== '') rec.price = +ln.price;
    if (ln.other) {
      return Object.assign(rec, { other: true, name: String(ln.name || '').trim(), uom: String(ln.uom || '').trim(),
        offNo: String(ln.offNo || '').trim(), offDate: ln.offDate || '', act: '' });
    }
    return Object.assign(rec, { act: h.act || '' }, ln.unit ? { unit: String(ln.unit) } : {});
  }

  /** Чернетка з рядків документа — те саме, що в папері: рядок на кожну ціну
   *  партії, на кожну одиницю із заводським номером і на кожну примітку. База
   *  могла розкласти рядок на кілька партій — вони збираються назад в один. */
  function draftFromRows(kind, rows) {
    const first = rows[0];
    const noteOf = (r) => String(r[7] || '');
    const basisOf1 = (n) => (n.startsWith('підстава: ') ? n.split('; ')[0].slice(10) : '');
    const basis = basisOf1(noteOf(first));
    // Підстава спільна для всього документа; різна по рядках — лишається в них.
    const shared = !!basis && rows.every((r) => basisOf1(noteOf(r)) === basis);
    const rest = (r) => {
      const parts = noteOf(r).split('; ');
      if (shared) parts.shift();
      return parts.join('; ');
    };
    const lines = new Map();
    for (const r of rows) {
      const price = +r[8] || 0;
      const lot = kind === 'in' ? '' : String(r[9] || '');
      const ln = { code: String(r[5]),
                   qty: +r[6] || 0,
                   price: kind === 'in' ? String(price || '') : (lot ? String(price) : ''),
                   note: rest(r), lot, unit: String(rowUnit(kind, r) || '') };
      const have = lines.get(lineKeyOf(ln, kind));
      if (!have) { lines.set(lineKeyOf(ln, kind), ln); continue; }
      if (lot && lot < have.lot) have.lot = lot;
      have.qty = round3(have.qty + ln.qty);
    }
    return {
      kind,
      head: { type: first[1] || '', no: String(first[2]).trim(), date: first[0], from: first[3],
              to: first[4] || '', basis: shared ? basis : '',
              report: '', reportDate: '', act: '', note: '' },
      lines: [...lines.values()].map((ln) => Object.assign(ln, { qty: String(ln.qty) })),
    };
  }

  /** Рядки журналу з чернетки: поля паперу, ціна, дата партії, службовий хвіст
   *  (id документа в базі й походження) і одиниця із заводським номером. */
  function rowsFromDraft(k, h, lines, tail = []) {
    const id = tail[1] || 0, origin = tail[2] || 'program';
    return lines.map((ln) => {
      const svc = k === 'in' ? [linePrice(ln, k)] : [ln.lot ? +ln.price || 0 : 0, ln.lot || ''];
      if (id || ln.unit) {
        if (k === 'in') svc.push(h.date);      // прихід сам є партією — від своєї дати
        svc.push(id, origin);
        if (ln.unit) svc.push(+ln.unit || ln.unit);
      }
      const head = [h.date, h.type, h.no, h.from, k === 'in' ? (h.to || 'склад') : h.to || ''];
      return head.concat([ln.code, +ln.qty, composeNote(h, ln)], svc);
    });
  }

  function editDoc(key) {
    // Кількість акта за нормами — лише за нормою: його документ правиться у вікні акта, форма вибуття не відкривається.
    const actId = actOfKey(key);
    if (actId) { actOpen(actId); return; }
    const { kind, arr, idx } = storeRowsOf(key);
    if (!idx.length) {
      alert('Документ не знайдено. Оновіть сторінку (F5).');
      return;
    }
    if (state.editing && state.editing !== key && !leaveEditing()) return;
    stashDraft();
    state.moveKind = kind;
    state.draft = draftFromRows(kind, idx.map((i) => arr[i]));
    state.draft.book = bookOf(state.draft.lines[0] ? state.draft.lines[0].code : '');
    state.draft.lines.push(emptyLine());
    state.editing = key;
    state.formOpen = true;
    go('moves', { q: '', formOpen: true, book: state.draft.book });
    $('#doc-form')?.scrollIntoView({ block: 'start' });
  }

  // ------------------------------------------------ друк документа
  const W_ONES = { m: ['', 'один', 'два', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"],
                   f: ['', 'одна', 'дві', 'три', 'чотири', "п'ять", 'шість', 'сім', 'вісім', "дев'ять"] };
  const W_TEENS = ['десять', 'одинадцять', 'дванадцять', 'тринадцять', 'чотирнадцять',
    "п'ятнадцять", 'шістнадцять', 'сімнадцять', 'вісімнадцять', "дев'ятнадцять"];
  const W_TENS = ['', '', 'двадцять', 'тридцять', 'сорок', "п'ятдесят", 'шістдесят',
    'сімдесят', 'вісімдесят', "дев'яносто"];
  const W_HUND = ['', 'сто', 'двісті', 'триста', 'чотириста', "п'ятсот", 'шістсот',
    'сімсот', 'вісімсот', "дев'ятсот"];
  function words999(n, g) {
    const out = [];
    if (n >= 100) { out.push(W_HUND[Math.floor(n / 100)]); n %= 100; }
    if (n >= 10 && n <= 19) out.push(W_TEENS[n - 10]);
    else { if (n >= 20) { out.push(W_TENS[Math.floor(n / 10)]); n %= 10; } if (n) out.push(W_ONES[g][n]); }
    return out.join(' ');
  }
  /** Сума прописом у форматі, що вже стоїть у документах служби:
   *  «Дві тис. триста сорок п'ять грн. 60 коп.» */
  function moneyWords(sum) {
    const kop = Math.round(sum * 100);
    let n = Math.floor(kop / 100);
    const k = String(kop % 100).padStart(2, '0');
    if (n === 0) return `Нуль грн. ${k} коп.`;
    const parts = [];
    for (const [v, label, g] of [[1e9, 'млрд.', 'm'], [1e6, 'млн.', 'm'], [1e3, 'тис.', 'f']]) {
      if (n >= v) { parts.push(words999(Math.floor(n / v), g), label); n %= v; }
    }
    if (n) parts.push(words999(n, 'f'));
    const t = parts.filter(Boolean).join(' ');
    return `${t[0].toUpperCase()}${t.slice(1)} грн. ${k} коп.`;
  }

  /** Кількість прописом: «Чотири», «Три цілих 5 десятих» не вигадуємо —
   *  дробова частина лишається цифрами, як у бланках служби. */
  function qtyWords(q) {
    const whole = Math.floor(q), frac = Math.round((q - whole) * 1000);
    let t = whole === 0 ? 'нуль' : '';
    if (whole) {
      let n = whole;
      const parts = [];
      for (const [v, label, g] of [[1e9, 'млрд.', 'm'], [1e6, 'млн.', 'm'], [1e3, 'тис.', 'f']]) {
        if (n >= v) { parts.push(words999(Math.floor(n / v), g), label); n %= v; }
      }
      if (n) parts.push(words999(n, 'f'));
      t = parts.filter(Boolean).join(' ');
    }
    t = t[0].toUpperCase() + t.slice(1);
    return frac ? `${t} ціла ${frac} тисячних` : t;
  }

  /** Коротке повідомлення в куті вікна. На відміну від плашки над формою,
   *  його видно на будь-якому екрані — вивантажують і з журналів, і з довідників. */
  function toast(text, bad = false) {
    const el = document.createElement('div');
    el.className = 'toast' + (bad ? ' toast--bad' : '');
    el.textContent = text;
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('toast--out'), 5500);
    setTimeout(() => el.remove(), 6200);
  }

  // ------------------------------------------------ вивантаження в Excel
  /** Друк іде через Excel: програма складає таблицю, сервер пише .xlsx у
   *  «Дані обліку/вивантаження» й одразу відкриває його. Без сервера (файл
   *  відкрито просто в браузері) — CSV, який Excel теж відкриє. */
  async function toExcel(spec) {
    if (!native) {
      const sh = (spec.sheets || [])[0];
      if (!sh) { alert('Вивантаження в Excel доступне в програмі на комп’ютері.'); return; }
      const flat = (row) => row.flatMap((c) => (c && typeof c === 'object'
        ? [c.t].concat(Array((c.span || 1) - 1).fill('')) : [c]));
      downloadCsv(spec.file || 'вивантаження', [...(sh.head || []).map(flat), ...(sh.rows || [])]);
      return;
    }
    try {
      const r = await fetch('api/excel', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spec),
      });
      const j = await r.json();
      if (!j.ok) throw new Error(j.error || 'помилка вивантаження');
      if (j.download) {
        // З іншого ПК: файл лягає на основному ПК, а браузер забирає його собі в «Завантаження».
        const a = document.createElement('a');
        a.href = j.download;
        a.download = '';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => a.remove(), 1000);
        toast(`Файл завантажено: ${String(j.path || '').split(/[\\/]/).pop()}` + (spec.note ? `. ${spec.note}` : ''));
        return;
      }
      toast((j.opened ? `Відкрито ${spec.word ? 'у Word' : 'в Excel'}: ${j.path}` : `Файл збережено: ${j.path}`)
        + (spec.note ? `. ${spec.note}` : ''));
    } catch (e) {
      toast(`Не вдалося вивантажити ${spec.word ? 'у Word' : 'в Excel'}: ${e.message}`, true);
    }
  }

  function downloadCsv(name, rows) {
    // \u0414\u0430\u0442\u0438 \u2014 \u044f\u043a \u0443 \u0434\u043e\u043a\u0443\u043c\u0435\u043d\u0442\u0430\u0445 \u0441\u043b\u0443\u0436\u0431\u0438: 11.09.2026, \u0430 \u043d\u0435 2026-09-11.
    const cell = (c) => (typeof c === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(c) ? fmtDate(c) : String(c ?? ''));
    const csv = '\ufeff' + rows.map((r) => r.map((c) =>
      `"${cell(c).replace(/"/g, '""')}"`).join(';')).join('\r\n');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    a.download = `${String(name).replace(/(\d{4})-(\d{2})-(\d{2})/g, '$3.$2.$1')}.csv`;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }

  const OPERATION = { mv: 'Розподіл (видача)', in: 'Надходження', wr: 'Списання' };

  /** Документ у Excel. Накладна й прихід — на бланку служби «Накладна
   *  (вимога)», Додаток 25; акт списання — таблицею з підписами комісії. */
  function docExcel(key) {
    const [kind, d, no] = key.split('|');
    const rows = docs.filter((r) => keyOfRow(r) === key);
    if (!rows.length) return;
    const first = rows[0];
    const basis = basisOf(first.note);
    let qty = 0, sum = 0;
    const lines = rows.flatMap((r) => rowParts(r).map((p) => {
      const it = itemBy.get(r.code) || {};
      const u = r.unit ? unitBy.get(String(r.unit)) : null;
      qty += p.q; sum += p.price * p.q;
      // Номер одиниці стоїть у бланку поруч із назвою — так його пишуть у папері;
      // категорія — її, на дату документа. Кількістю категорія не відома — порожньо.
      return { name: (it.name || r.code) + (u ? `, ${unitLabel(u)}` : ''), code: r.code,
               uom: it.unit || '', cat: u ? catAt(u, d) : '', price: p.price, qty: p.q, note: cleanNote(r.note) };
    }));
    const nWords = `${cnt(rows.length, 'найменування', 'найменування', 'найменувань')}`;
    if (kind !== 'wr') {
      // Підписанти й місце складання — з довідників на дату накладної: торішня
      // накладна друкується тими, хто тоді відповідав, і там, де її складали.
      const who = (p) => (p ? signer(p, d) : null);
      const spec = {
        kind: 'invoice', file: `Накладна ${no} від ${d}`, no, date: d,
        operation: OPERATION[kind], basis, place: locationAt(d), unit: unitInfo(),
        sender: first.from, receiver: first.to,
        sender_person: kind === 'in' ? null : who(mvoFor(first.from, d)),
        receiver_person: who(mvoFor(first.to, d)),
        chief: who(officialAt('начальник служби', d)),
        accountant: who(officialAt('бухгалтер', d)),
        fes: who(officialAt('начальник ФЕС', d)),
        lines, qty_words: `${qtyWords(qty)} (усього ${nWords})`, sum_words: moneyWords(sum),
      };
      // Кого немає в довідниках на дату документа — того рядок у бланку
      // порожній; мовчати про це не можна, бо накладну підпишуть як є.
      const missing = [
        [spec.place, 'місце складання (вкладка «Дислокація»)'],
        [kind === 'in' || spec.sender_person, `МВО «${first.from}»`],
        [spec.receiver_person, `МВО «${first.to}»`],
        [spec.chief, 'начальник служби'],
        [spec.accountant, 'бухгалтер ФЕС'],
        [spec.fes, 'начальник ФЕС'],
      ].filter(([x]) => !x).map(([, name]) => name);
      if (missing.length) {
        toast(`У накладній лишаться порожні рядки. На ${fmtDate(d)} не знайдено: `
          + `${missing.join(', ')}. Додайте в «Довідники» → «Люди й МВО».`, true);
      }
      return toExcel(spec);
    }
    // Назва — з виду паперу («Акт ПП ОЗ», «Витяг із наказу»), а не завжди «акт
    // списання»; примітки рядків — окремою графою, як у папері.
    const paper = String(first.t || '').trim() || (first.to ? 'Акт ПП' : 'Акт списання');
    // «Акт ПП» у бланку — повністю: «Акт приймання-передачі».
    const title = paper.replace(/^акт\s+пп(?=\s|$)/i, 'Акт приймання-передачі');
    const notes = lines.some((x) => x.note);
    return toExcel({
      file: `${paper} ${no} від ${d}`,
      sheets: [{
        name: paper.replace(/[[\]:*?\/\\]/g, ' ').slice(0, 31), orientation: notes ? 'landscape' : 'portrait',
        top: [unitInfo().legalName, unitInfo().serviceFull],
        title: `${title.toUpperCase()} № ${no}`, subtitle: `від ${fmtDate(d)}`,
        lines: (first.to ? [`Передає: ${unitInfo().legalName || 'військова частина'}, ${first.from}`, `Приймає: ${first.to}`]
          : [`Підрозділ: ${first.from}`]).concat(basis ? [`Підстава: ${basis}`] : []),
        head: [['№ з/п', 'Найменування', 'Код', 'Од. вим.', 'Кількість', 'Ціна, грн', 'Сума, грн']
          .concat(notes ? ['Примітка'] : [])],
        widths: [6, 46, 11, 9, 11, 12, 14].concat(notes ? [36] : []),
        rows: lines.map((x, i) => [i + 1, x.name, x.code, x.uom, x.qty, x.price || '', x.price * x.qty || '']
          .concat(notes ? [x.note || ''] : [])),
        num: [4], money: [5, 6], total: ['', 'Разом', '', '', qty, '', sum].concat(notes ? [''] : []),
        after: [`Усього ${nWords}, ${qtyWords(qty).toLowerCase()} од. На суму: ${moneyWords(sum)}`],
        signs: first.to ? ['Передав (посада, звання, підпис, ПІБ)', 'Прийняв (посада, звання, підпис, ПІБ)']
          : ['Голова комісії (посада, звання, підпис, ПІБ)', 'Члени комісії (посада, звання, підпис, ПІБ)'],
      }],
    });
  }

  /** Сторінка книги № 47 для бланка: значення граф так, як їх пише book47_export. */
  function j47Spec(code) {
    const { it, blocks, rows } = j47Model(code);
    return {
      code, name: it.name, uom: it.unit || '', price: +it.price || 0, prices: lotPricesText(it.code), blocks,
      rows: rows.map(({ r, inQ, outQ, run, cells, party }) => ({
        rec: r.d, type: r.t, no: String(r.no), date: r.d, party,
        in: inQ || null, out: outQ || null, total: run,
        // У графі підрозділу — лише залишок, який змінив цей документ.
        cells: cells.map((c) => (c.hit ? c.bal : null)),
      })),
    };
  }

  /** Журнал № 47 у Excel — на бланку Додатка 47: сторінка поточної позиції
   *  або вся книга (титул, зміст і по аркушу на кожну позицію з рухом). */
  function j47Excel(all = false) {
    if (!native) {
      if (all) { toast('Уся книга вивантажується в програмі на комп’ютері.', true); return; }
      const x = j47Spec(state.j47code);
      const head = ['Дата запису', 'Найменування документа', 'Номер документа', 'Дата документа',
        'Постачальник (одержувач)', 'Надійшло', 'Вибуло', 'Перебуває'].concat(x.blocks);
      downloadCsv(`Журнал 47 — ${x.code}`, [head, ...x.rows.map((r) => [fmtDate(r.rec), r.type, r.no,
        fmtDate(r.date), r.party, r.in ?? '', r.out ?? '', r.total].concat(r.cells.map((v) => v ?? '')))]);
      return;
    }
    const build = () => {
      const list = (all ? j47Options().map((o) => o.value) : [state.j47code]).map(j47Spec);
      const one = list[0];
      return toExcel({
        kind: 'book47', book: all, unit: unitInfo().legalName.replace(/^Військова частина\s*/i, ''),
        service: unitInfo().serviceFull, items: list,
        file: all ? `Книга обліку № 47 станом на ${fmtDate(today())}`
          : `Журнал 47 — ${one.code} ${one.name || ''}`.slice(0, 110),
      });
    };
    if (!all) return build();
    // Уся книга — по сторінці на кожну позицію з рухом, це десятки секунд:
    // спершу кажемо про це, і лише після того, як напис намалювався, рахуємо.
    toast('Готуємо всю книгу, це може тривати до хвилини…');
    return new Promise((resolve) => setTimeout(() => resolve(build()), 60));
  }

  /** Журнал № 14 у Excel: по аркушу на кожні десять позицій — як розворот
   *  канонічної книги, і жодна позиція не відпадає. */
  function j14Excel() {
    const sub = state.j14sub;
    const lines = chrono(docs.filter((r) => (r.from === sub || r.to === sub) && bookOf(r.code) === state.book));
    const codes = [...new Set(lines.map((r) => r.code))].sort((a, b) => a.localeCompare(b));
    const sheets = [];
    for (let p = 0; p < codes.length; p += J14_PER_PAGE) {
      const shown = codes.slice(p, p + J14_PER_PAGE);
      const set = new Set(shown);
      const run = new Map(shown.map((c) => [c, 0]));
      const rows = lines.filter((r) => set.has(r.code)).map((r) => {
        const counter = r.kind === 'mv' ? (r.to === sub ? r.from : r.to) : r.kind === 'in' ? r.from : 'списано';
        const cells = shown.flatMap((c) => {
          let plus = 0, minus = 0;
          if (r.code === c) { if (r.to === sub) plus = r.q; if (r.from === sub) minus = r.q; }
          const cur = (run.get(c) || 0) + plus - minus;
          run.set(c, cur);
          return [plus || '', minus || '', r.code === c ? cur : ''];
        });
        return [fmtDate(r.d), r.t, `${r.no} від ${fmtDate(r.d)}`, counter].concat(cells);
      });
      const head1 = ['Дата запису', 'Найменування документа', 'Номер і дата документа', 'Постачальник (одержувач)']
        .concat(shown.map((c) => ({ t: `${c} · ${(itemBy.get(c) || {}).name || ''}`, span: 3 })));
      const head2 = ['', '', '', ''].concat(shown.flatMap(() => ['надійшло', 'вибуло', 'становить']));
      sheets.push({
        name: `стор. ${sheets.length + 1}`, orientation: 'landscape',
        top: [unitTop()],
        title: 'КНИГА обліку наявності та руху військового майна (склад, підрозділ)',
        subtitle: `${sub} · сторінка ${sheets.length + 1}`,
        head: [head1, head2], widths: [11, 15, 20, 22].concat(shown.flatMap(() => [8, 8, 9])),
        rows, num: shown.flatMap((_, i) => [4 + i * 3, 5 + i * 3, 6 + i * 3]),
      });
    }
    if (!sheets.length) { alert('У цьому підрозділі руху немає.'); return; }
    return toExcel({ file: `Журнал 14 — ${sub}`, sheets });
  }

  /** Відомість інвентарних номерів: аркуш на підрозділ, діапазонами. */
  function invExcel() {
    const bySub = new Map();
    for (const r of regRows(inventorySpec())) {
      if (!bySub.has(r.sub)) bySub.set(r.sub, []);
      bySub.get(r.sub).push(r);
    }
    const sheets = [...bySub.entries()].map(([sub, list]) => ({
      name: sub, orientation: 'portrait',
      top: [unitTop()],
      title: 'ВІДОМІСТЬ інвентарних номерів', subtitle: `${sub} · номери наносяться на кожну одиницю`,
      head: [['№', 'Код', 'Найменування', 'Інвентарні номери', 'Одиниць']],
      widths: [5, 9, 52, 26, 9],
      rows: list.map((r, i) => {
        const it = itemBy.get(r.code) || {};
        const span = r.from === r.to ? invNo(r.code, r.from) : `${invNo(r.code, r.from)} — ${invNo(r.code, r.to)}`;
        return [i + 1, r.code, it.name || '', span, r.to - r.from + 1];
      }),
      num: [4], total: ['', '', 'Разом одиниць', '', list.reduce((a, r) => a + r.to - r.from + 1, 0)],
    }));
    if (!sheets.length) { alert('Одиниць із заводськими номерами ще немає — нема чого вивантажувати.'); return; }
    return toExcel({ file: `Відомість інвентарних номерів ${state.asOf}`, sheets });
  }

  /** Будь-який список на екрані — таблицею з тими самими фільтрами. */
  function listExcel() {
    const [name, rows] = exportRows();
    const head = rows[0], body = rows.slice(1);
    const numCols = head.map((_, i) => i).filter((i) => body.length && body.every((r) => r[i] === '' || typeof r[i] === 'number'));
    return toExcel({
      file: `Облік ТЗ — ${name} ${state.asOf}`,
      sheets: [{
        name, orientation: head.length > 6 ? 'landscape' : 'portrait',
        top: [unitTop()],
        title: name[0].toUpperCase() + name.slice(1), subtitle: `станом на ${fmtDate(state.asOf)}`,
        head: [head], widths: head.map((h) => (/найменування|примітка/.test(h) ? 44 : /підрозділ|звідки|куди/.test(h) ? 20 : 12)),
        rows: body, num: numCols,
      }],
    });
  }
