// Облік ТЗ ПС · сторінка · журнал змін, закритий період.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ ЖУРНАЛ ЗМІН
  /** Хто що міняв — принаймні що й коли: провели, виправили (що саме), видалили,
   *  підписали, підшили. Тисячі останніх записів лежать разом з іншими даними. */
  function logChange(what, key, text) {
    store.log = store.log || [];
    const d = new Date();
    const t = new Date(d.getTime() - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16).replace('T', ' ');
    const rec = { t, what, key: key || '', text: text || '' };
    if (me.name) rec.who = me.name;               // хто вніс — коли працюють кілька людей
    store.log.push(rec);
    if (store.log.length > 3000) store.log.splice(0, store.log.length - 3000);
  }
  const logOf = (pred) => (store.log || []).filter(pred).slice().reverse();
  function historyCard(keys, title = 'Історія змін') {
    const set = new Set(keys);
    const list = logOf((x) => set.has(x.key));
    if (!list.length) return '';
    return `<div class="card" style="margin-top:12px"><div class="card__head"><div class="card__title">${esc(title)}</div>
        <div class="panel__spacer"></div><span class="panel__count">${cnt(list.length, 'запис', 'записи', 'записів')}</span></div>
      <div class="tbl" style="--tbl-min:640px">${list.slice(0, 30).map((x) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:130px">${esc(x.t)}</div><div class="c-tag" style="width:140px"><b>${esc(x.what)}</b></div>
        <div class="c-txt" title="${esc(x.text)}">${esc(x.text)}</div></div>`).join('')}</div></div>`;
  }

  /** Вікно поверх програми: копії даних, журнал змін. */
  function modalOpen(title, html, cls = '') {
    modalClose();
    const el = document.createElement('div');
    el.id = 'modal';
    el.className = 'viewer';
    el.innerHTML = `<div class="viewer__box modal__box${cls ? ' ' + cls : ''}"><div class="viewer__bar"><b class="viewer__name">${esc(title)}</b>
      <button class="btn btn--sm" data-md="close" title="Закрити (Esc)">✕</button></div>
      <div class="modal__body">${html}</div></div>`;
    // Поза вікном закриває лише натискання, що й почалось поза ним: виділення тексту в полі, відпущене за краєм вікна, браузер
    // теж зараховує натисканням на тло — і вікно акта з усім уписаним зникало б.
    let downOut = false;
    el.addEventListener('pointerdown', (e) => { downOut = e.target === el; });
    el.addEventListener('click', (e) => {
      if ((e.target === el && downOut) || e.target.closest('[data-md="close"]')) modalDismiss();
      downOut = false;
      const b = e.target.closest('[data-md-restore]');
      if (b) restoreBackup(b.dataset.mdRestore);
    });
    document.body.appendChild(el);
    return el;
  }
  function modalClose() { const el = $('#modal'); if (el) el.remove(); }
  /** Вікно закрила людина (✕, Esc, натискання поза вікном). Вікно, відкрите з вікна акта (вставка з Добовки), повертає до вікна
   *  акта з усім уписаним, як його «Скасувати»; закрите саме вікно акта — справу акта закінчено: без цього вставка на вкладці
   *  «Дободачі» вважала б себе вставкою у вже закритий акт. */
  function modalDismiss() {
    if (actWin && !$('#modal [data-oa-win]')) { actDraw(); return; }
    actWin = null;
    modalClose();
  }

  async function openBackups() {
    if (!native) { toast('Автоматичні копії є лише в програмі на комп’ютері.', true); return; }
    let list = [];
    try { list = await fetch('api/backups', { cache: 'no-store' }).then((r) => r.json()); } catch (e) { list = []; }
    const rows = list.map((b) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:150px"><b>${esc(fmtStamp(b.time))}</b></div>
        <div class="c-txt">${b.ok ? esc(`рядків документів: ${b.docs}, знищене: ${b.destroyed}, звірок: ${b.recon}`
          + `, інвентаризацій: ${b.inventories || 0}`) + (b.old_schema
          ? ' <small>копія попередньої версії програми, відновлюється з оновленням</small>' : '')
          : `<span class="num-bad">${esc(b.why || 'файл пошкоджено')}</span>`}</div>
        <div class="c-num" style="width:90px">${fmtSize(b.size)}</div>
        <div class="c-acts" style="flex-basis:120px">${b.ok ? `<button class="btn btn--sm" data-md-restore="${esc(b.name)}">Відновити</button>` : ''}</div>
      </div>`).join('');
    modalOpen('Копії даних', `<div class="panel"><div class="panel__note">Перед відновленням поточний стан теж зберігається в копію.</div></div>
      <div class="tbl" style="--tbl-min:720px">${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Копій ще немає.</div></div>'}</div>`);
  }
  async function restoreBackup(name) {
    if (!confirm(`Відновити дані з копії «${name}»?\n\nПоточний стан буде збережено в окрему копію.`)) return;
    try {
      const r = await fetch('api/restore', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name }) });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      saving.dirty = false;
      location.reload();
    } catch (e) {
      toast('Не вдалося відновити: ' + (e.message || e), true);
    }
  }
  /** Копія бази туди, куди покаже людина (флешка, інший диск чи комп’ютер).
   *  Вікно «Зберегти як» показує сама програма — сторінка шляхів не бачить.
   *  Дата останньої такої копії лишається в налаштуваннях: її видно на кнопці,
   *  а через 30 днів без копії Зведення нагадує. */
  async function copyAway() {
    if (!native) { exportState(); return; }
    // Копія бази — лише те, що вже записано у файл. Незаписане (смуга «Зміни НЕ
    // записано») спершу пробуємо записати; не вийшло — воно йде окремим файлом
    // JSON у завантаження, і «Відновити з файла…» його приймає.
    if (saving.dirty || saving.failed || saving.busy) {
      const ok = await flush();
      if (!ok) {
        if (!confirm('Останні зміни ще не записано у файл: копія бази їх не міститиме.\n\n'
          + 'Зберегти незаписане окремим файлом (JSON у теці завантажень), а потім зробити копію бази?')) return;
        exportState();
      }
    }
    let r;
    try {
      r = await fetch('api/copy', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dir: store.ui.copyDir || '' }) }).then((x) => x.json());
    } catch (e) { toast('Не вдалося зробити копію: ' + (e.message || e), true); return; }
    if (!r.ok) { if (!r.cancelled) toast('Не вдалося зробити копію: ' + (r.error || ''), true); return; }
    store.ui.lastCopy = today();
    if (r.dir) store.ui.copyDir = r.dir;
    save(true);
    toast(`Копію бази записано: ${r.path}`);
    refresh();
  }
  /** Копія бази, принесена файлом: відновлюється так само, як автоматична —
   *  поточний стан перед цим сам лягає в копії. */
  async function restoreFile(f) {
    if (!confirm(`Відновити дані з копії бази «${f.name}»?

Поточний стан буде збережено в окрему копію.`)) return;
    try {
      const r = await fetch('api/restore-file', { method: 'POST', body: f });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      saving.dirty = false;
      location.reload();
    } catch (e) {
      toast('Не вдалося відновити: ' + (e.message || e), true);
    }
  }
  /** «Перевірити базу…» — звірка за правилами обліку (та сама, що й у
   *  build/verify_db.py), але без Python: перелік перевірок із поясненнями. */
  async function openVerify() {
    if (!native) { toast('Перевірка бази є лише в програмі на комп’ютері.', true); return; }
    let list;
    try {
      const r = await fetch('api/verify', { cache: 'no-store' });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
      list = await r.json();
    } catch (e) { toast('Не вдалося перевірити: ' + (e.message || e), true); return; }
    // Порада (advisory) — стан звичайної роботи, як-от нові одиниці ще без
    // інвентарних номерів: показується як «увага», а не як збій обліку.
    const bad = list.filter((c) => !c.ok && !c.advisory);
    const warn = list.filter((c) => !c.ok && c.advisory);
    const mark = (c) => (c.ok ? ['num-ok', 'OK'] : c.advisory ? ['num-warn', 'УВАГА'] : ['num-bad', 'ЗБІЙ']);
    const rows = list.map((c) => `<div class="tbl__row tbl__row--plain">
        <div class="c-tag" style="width:64px"><b class="${mark(c)[0]}">${mark(c)[1]}</b></div>
        <div class="c-name"><b>${esc(c.name)}</b>${c.detail ? `<small>${esc(c.detail)}</small>` : ''}</div></div>`).join('');
    modalOpen('Перевірка бази', `<div class="panel"><div class="panel__note">${bad.length
      ? `Не сходиться: ${cnt(bad.length, 'перевірка', 'перевірки', 'перевірок')}.`
      : warn.length
        ? `Облік сходиться, є ${cnt(warn.length, 'зауваження', 'зауваження', 'зауважень')}.`
        : 'Усі перевірки пройдено.'}</div></div>
      <div class="tbl" style="--tbl-min:640px">${rows}</div>`);
  }
  /** Пам’ятка на одну сторінку: що це, що де лежить, щоденні дії, клавіші,
   *  копії, скорочення. Для того, хто приймає справи; друкується з тієї ж
   *  картки — на папері лишається тільки текст. */
  function openMemo() {
    const li = (arr) => arr.map((x) => `<li>${x}</li>`).join('');
    const html = `<div class="memo">
      <div class="memo__head"><h2>Пам’ятка з обліку технічних засобів продовольчої служби</h2>
        <button class="btn btn--sm" data-act="memo-print">Друк</button></div>
      <div class="memo__cols">
      <section>
        <h3>Що це й де лежить</h3>
        <ul>${li([
          'Програма веде облік ТЗ ПС: документи, залишки по підрозділах, штат і некомплект, знищене, звірки, інвентаризації, відомість МТЗ, журнали № 47 і № 14.',
          'Дані зберігаються у файлі <b>Дані обліку/oblik.sqlite</b> поруч із програмою. У тій самій теці: <b>скани</b> (скани й фото), <b>вивантаження</b> (файли Excel), <b>копії</b> (автоматичні копії).',
          'На інший комп’ютер програму переносять разом із текою «Дані обліку».',
        ])}</ul>
        <h3>Щоденні дії</h3>
        <div class="memo__pairs">${INTRO.map(([t, d]) => `<div><b>${esc(t)}</b><span>${esc(d)}</span></div>`).join('')}</div>
        <h3>Як провести документ</h3>
        <ol>${li([
          '«+ Новий документ» на вкладці «Документи».',
          'Вид документа, номер, дата, відправник і одержувач.',
          'Рядки: код або назва позиції, кількість.',
          'Перевірте підсумок і натисніть «Провести документ» (Ctrl+Enter).',
          '«Зберегти чернетку» відкладає незавершений документ. Проведений виправляють кнопкою «Виправити» в рядку; кожна правка записується в журнал змін.',
          'Знищене майно: рапорт — у «Техзасоби» → «Знищене», там само кнопка «Списати актом…» готує акт списання.',
        ])}</ol>
      </section>
      <section>
        <h3>Клавіші</h3>
        <div class="memo__pairs memo__pairs--keys">${[
          ['Ctrl+K', 'пошук по всій базі'],
          ['Enter', 'наступне поле форми'],
          ['Ctrl+Enter', 'провести документ'],
          ['Ctrl+Shift+Enter', 'провести й почати наступний'],
          ['↑ ↓', 'рядки таблиці'],
          ['Enter', 'відкрити рядок таблиці'],
          ['Esc', 'закрити картку'],
        ].map(([k, v]) => `<div><b>${k}</b><span>${v}</span></div>`).join('')}</div>
        <h3>Копії та безпека</h3>
        <ul>${li([
          'Програма робить копію не рідше ніж раз на 10 хвилин роботи й зберігає 60 останніх: «Налаштування» → «Автоматичні копії…».',
          '<b>Раз на місяць</b> зберігайте копію на флешку чи інший комп’ютер: «Налаштування» → «Зберегти копію бази…».',
          'Відновлення з такої копії: «Налаштування» → «Відновити з файла…». Перевірка бази: «Налаштування» → «Перевірити базу…».',
          'Друге вікно програми на тих самих даних не відкривається.',
        ])}</ul>
        <h3>Скорочення</h3>
        <div class="memo__gloss">${Object.entries(GLOSSARY).filter(([k]) => k !== 'ФЄС')
          .map(([k, v]) => `<div><b>${esc(k)}</b><span>${esc(v)}</span></div>`).join('')}</div>
      </section>
      </div>
      <div class="memo__foot">Пам’ятка станом на ${fmtDate(today())}. Картку «З чого почати» повертає кнопка «?» унизу зліва.</div>
    </div>`;
    modalOpen('Пам’ятка', html);
  }
  function printMemo() {
    document.body.classList.add('printing-memo');
    const done = () => document.body.classList.remove('printing-memo');
    window.addEventListener('afterprint', done, { once: true });
    setTimeout(done, 60000);
    window.print();
  }
  function openLog() {
    const list = logOf(() => true);
    const whats = [...new Set(list.map((x) => x.what))].sort((a, b) => a.localeCompare(b, 'uk'));
    // Хто вніс — лише коли з програмою працює кілька людей: записи, внесені до того, без імені.
    const whos = [...new Set(list.map((x) => x.who).filter(Boolean))].sort((a, b) => a.localeCompare(b, 'uk'));
    const spec = () => ({
      id: 'log', rows: list, minWidth: '760px', limit: REG_LIMIT, placeholder: 'Пошук: номер, підрозділ, позиція',
      search: (x) => [x.t, x.what, x.text, x.key || '', x.who || ''],
      filters: [
        { type: 'select', key: 'what', label: 'дія', all: 'усі', options: whats.map((w) => [w, w]), test: (x, v) => x.what === v },
        ...(whos.length ? [{ type: 'select', key: 'who', label: 'хто', all: 'усі', options: whos.map((w) => [w, w]),
          test: (x, v) => x.who === v }] : []),
        { type: 'period', key: 'd', label: 'дата', get: (x) => x.t },
      ],
      columns: [
        { key: 't', label: 'час', cls: 'c-date', style: 'width:130px', sort: (x) => x.t, cell: (x) => esc(x.t) },
        ...(whos.length ? [{ key: 'who', label: 'хто', cls: 'c-txt', style: 'flex:0 0 130px', sort: (x) => x.who || '',
          cell: (x) => esc(x.who || '') }] : []),
        { key: 'what', label: 'дія', cls: 'c-tag', style: 'width:170px', first: 1, sort: (x) => x.what, cell: (x) => `<span class="tag tag--mv">${esc(x.what)}</span>` },
        { key: 'text', label: 'зміст', cls: 'c-txt', first: 1, sort: (x) => x.text, cell: (x) => esc(x.text) },
      ],
      row: (x) => ({ cls: 'tbl__row--plain', title: x.text }),
      count: (shown, all) => (shown.length === all.length ? cnt(all.length, 'запис', 'записи', 'записів') : `${shown.length} із ${all.length}`),
      empty: 'Журнал змін порожній.',
    });
    const el = modalOpen('Журнал змін', '<div id="log-reg"></div>');
    const draw = () => {
      const reg = registry(spec());
      el.querySelector('#log-reg').innerHTML = reg.panel + reg.table;
      bindRegistry(el);
    };
    regRedraw.set('log', () => {
      if (document.body.contains(el)) return draw();
      regRedraw.delete('log');
      return render();
    });
    draw();
    const q = el.querySelector('input[data-tf-q="log"]');
    if (q) q.focus();
  }

  // ============================================================ ЗАКРИТИЙ ПЕРІОД
  /** Документ заднім числом після підписаної звірки чи завершеної інвентаризації
   *  міняє вже підписані цифри. Не забороняємо — помилки бувають, — але кажемо
   *  прямо, що саме доведеться переробити, і пишемо це в журнал змін. */
  /** «Вношу історію» — режим внесення старих документів. Облік за кілька років
   *  вносять пачкою, і кожен такий документ потрапляє в закритий період: без
   *  цього режиму програма перепитувала б про кожен. Режим видно на формі й у
   *  «Потребує уваги», а в журналі змін позначка «у закритому періоді» лишається. */
  const histOn = () => !!store.ui.hist;

  function periodLock(dates, subsHit) {
    const d = dates.filter(Boolean).sort()[0];
    if (!d) return '';
    const hits = [];
    for (const r of allRecon()) {
      if (r.status !== 'підписано' || r.to < d) continue;
      if (!subsHit.some((s) => s && (s === r.sub || inSubtree(r.sub, s)))) continue;
      hits.push(`підписано звірку з «${r.sub}» станом на ${fmtDate(r.to)} (відомість №${r.no || '—'})`);
    }
    const ACC = { 'щорічна': 'щорічну', 'позапланова': 'позапланову', 'чергова': 'чергову' };
    for (const x of allInv()) {
      if (x.status !== 'завершено' || x.date < d) continue;
      const sc = x.scope || [];
      if (sc.length && !subsHit.some((s) => s && inScope(x, s))) continue;
      hits.push(`завершено ${ACC[x.kind] || x.kind} інвентаризацію${sc.length ? ` (${scopeShort(sc)})` : ''} станом на ${fmtDate(x.date)}`);
    }
    if (!hits.length) return '';
    return `Документ від ${fmtDate(d)} потрапляє в закритий період: ${[...new Set(hits)].slice(0, 4).join('; ')}`
      + `${hits.length > 4 ? ' тощо' : ''}. Цифри в них зміняться, підписане доведеться переробити.`
      + '\n\nДля внесення старих документів увімкніть у формі режим «вношу історію».'
      + '\n\nПровести все одно?';
  }
