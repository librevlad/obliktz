// Облік ТЗ ПС · сторінка · що потребує уваги.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ ЩО ПОТРЕБУЄ УВАГИ
  /** Перелік справ на Зведенні — від того, що ламає облік, до довідкового. Кожен
   *  пункт веде туди, де його закривають; порожній перелік — усе гаразд. */
  let attActs = [];
  /** Підшиті файли, яких немає в теці «скани»: запис у базі чи в стані є, а
   *  файл не скопіювали разом із текою даних. Перевіряє сервер програми —
   *  сторінка сама диск не бачить. Список живе до перезапуску вікна. */
  let missingFiles = null;
  /** Час останньої автоматичної копії — щоб видно було, чи вона взагалі є. */
  let lastBackup = '';
  /** «2026-09-12 19:35» від сервера — у вигляді документів: «12.09.2026 19:35». */
  const fmtStamp = (s) => (s ? fmtDate(String(s).slice(0, 10)) + String(s).slice(10) : '');
  async function checkFiles() {
    if (!native) return;
    const paths = new Set(), kept = new Map();
    for (const list of [...scans.values(), ...docScans.values()]) for (const f of list) if (f.path) paths.add(f.path);
    for (const f of (store.scans || [])) {
      if (!f.path) continue;
      // Файл у теці служби шукається в ній, а не в «скани»: інакше кожен папір закупівлі був би «не знайдений».
      if (f.folder) kept.set(`${f.folder}|${f.path}`, { folder: f.folder, path: f.path }); else paths.add(f.path);
    }
    try {
      const r = await fetch('api/scan-check', { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [...paths], files: [...kept.values()] }) });
      const j = await r.json();
      missingFiles = (j.missing || []).concat((j.missingFiles || []).map((f) => `${SERVICE_FOLDERS[f.folder] || f.folder}: ${f.path}`));
      if (missingFiles.length) render();
    } catch (e) { missingFiles = null; }
    try {
      const list = await fetch('api/backups', { cache: 'no-store' }).then((r) => r.json());
      lastBackup = fmtStamp((list[0] || {}).time || '');
    } catch (e) { lastBackup = ''; }
  }

  function showMissingFiles() {
    const rows = (missingFiles || []).map((p) => `<div class="tbl__row tbl__row--plain">
        <div class="c-txt">${esc(p)}</div></div>`).join('');
    modalOpen('Підшиті файли, яких немає в теці',
      `<div class="panel"><div class="panel__note">Покладіть файли назад у «Дані обліку/скани» чи в названу перед шляхом теку служби
        з тими самими іменами або підшийте наново.</div></div>
      <div class="tbl" style="--tbl-min:640px">${rows}</div>`);
  }

  /** Один номер на два документи того самого виду в різні дати — привід
   *  подивитися: служба могла почати нумерацію накладних з «1» наново. */
  function reusedNumbers() {
    const by = new Map();
    for (const r of docs) {
      const no = String(r.no).trim();
      if (!/\d/.test(no)) continue;                       // «Рапорт», «б/н» — не номер
      const k = r.kind + '|' + normNo(no);
      // Номер показуємо так, як він у папері, а не зведеним до малих літер.
      if (!by.has(k)) by.set(k, { kind: r.kind, no, dates: new Set() });
      by.get(k).dates.add(r.d);
    }
    return [...by.values()].filter((x) => x.dates.size > 1)
      .map((x) => ({ kind: x.kind, no: x.no, dates: [...x.dates].sort() }));
  }
  /** Стани документа, з якими він ще не дійшов до ФЕС: «роздрукувати», «на підписі», «їде на ФЕС» (власник 23.10.2026). */
  const FES_LATE_STATES = ['роздрукувати', 'на підписі', 'їде на ФЕС'];
  /** Документи, що понад 14 днів у такому стані (від дня, коли стан поставили): `docFes` — `store.docFes`, `t` — сьогодні. */
  function fesLate(docFes, t) {
    return Object.values(docFes || {}).filter((f) => FES_LATE_STATES.includes(f.status) && f.date && daysBetween(f.date, t) > 14);
  }
  function attentionItems() {
    const t = today();
    const out = [];
    // У кожного пункту є не лише «що не так», а й що зараз зробити: людина
    // читає рядок і бачить наступний крок, а не стрілку в невідомість.
    const add = (lvl, n, text, fn, hint = '', act = '') => {
      if (n) out.push({ lvl, n, text, fn, hint, act });
    };
    const neg = [];
    for (const [k, v] of balances().map) {
      if (v < -1e-9) { const i = k.indexOf('|'); neg.push({ code: k.slice(0, i), sub: k.slice(i + 1), v }); }
    }
    add('bad', neg.length, `${plural(neg.length, 'мінусовий залишок', 'мінусові залишки', 'мінусових залишків')}`,
      () => go('item', { itemCode: neg[0].code }),
      neg.slice(0, 3).map((x) => `${(itemBy.get(x.code) || {}).name || x.code} у «${x.sub}» ${fmtNum(x.v)}`).join('; '),
      'Відкрити картку позиції');
    const draftsOpen = Object.entries(state.drafts || {}).filter(([, v]) => hasContent(v));
    if (state.draft && !state.editing && hasContent(state.draft)
      && !draftsOpen.some(([k]) => k === slotOf(state.draft.kind, state.draft.book || 'ТЗ'))) {
      draftsOpen.push([slotOf(state.draft.kind, state.draft.book || 'ТЗ'), state.draft]);
    }
    add('warn', draftsOpen.length, `${plural(draftsOpen.length, 'незавершений документ', 'незавершені документи',
      'незавершених документів')} у формі`, () => go('moves', { moveKind: draftsOpen[0][1].kind,
      book: draftsOpen[0][1].book || 'ТЗ', formOpen: true }),
      draftsOpen.map(([, v]) => `${KIND_NAME[v.kind] || 'рапорт'}${v.head.no ? ' ' + numNo(v.head.no) : ''}`).join(', '),
      'Дописати документ');
    const due = reconSubs(t).filter((x) => x.pos && reconStatus(x.sub).kind !== 'ok');
    const staleSigned = allRecon().filter(signedStale);
    add('warn', staleSigned.length, `${plural(staleSigned.length, 'підписана відомість звірки', 'підписані відомості звірки', 'підписаних відомостей звірки')}, під якими облік змінився заднім числом`,
      () => go('recon', { reconId: staleSigned.length === 1 ? staleSigned[0].id : null }),
      staleSigned.slice(0, 3).map((r) => `${r.sub} на ${fmtDate(r.to)}`).join(', '), 'Відкрити');
    add('warn', due.length, `${plural(due.length, 'підрозділ', 'підрозділи', 'підрозділів')} без звірки понад місяць або з непідписаною відомістю`, () => go('recon', { reconId: null }),
      due.slice(0, 4).map((x) => x.sub).join(', ') + (due.length > 4 ? '…' : ''),
      `Скласти звірки · ${due.length}`);
    // Два різні діла: запис без акта — скласти акт; запис зі складеним, але не проведеним
    // актом — провести його. Кожна кнопка веде на відібрані записи й підсвічує найдавніший.
    const byRep = (a, b) => ((a.reportDate || a.date) < (b.reportDate || b.date) ? -1 : 1);
    const stale = allDestroyed().filter((x) => x.status === 'рапорт подано' && openAt(x, t) && daysBetween(x.date, t) > 30).sort(byRep);
    add('warn', stale.length, `${plural(stale.length, 'запис', 'записи', 'записів')} знищеного без акта списання понад 30 днів`,
      () => { tfOf('dz').st = 'open'; go('destroyed', { q: '', dzFocus: stale[0].id }); },
      `найдавніший — ${fmtDate(stale[0] ? stale[0].date : t)}`,
      `Скласти акт списання · ${stale.length}`);
    const drafted = allDestroyed().filter((x) => x.status === 'включено до акта' && openAt(x, t)).sort(byRep);
    add('warn', drafted.length, `${plural(drafted.length, 'запис', 'записи', 'записів')} знищеного з актом, який ще не проведено`,
      () => { tfOf('dz').st = 'act'; go('destroyed', { q: '', dzFocus: drafted[0].id }); },
      [...new Set(drafted.map((x) => numNo(x.act)))].slice(0, 4).join(', '),
      `Провести акт · ${drafted.length}`);
    // Закритий підрозділ із майном: перейменували чи розформували, а майно
    // лишилося числитись — його треба передати накладною.
    const closedHeld = subs.filter((x) => !x.active && Math.abs(balSub(x.name)) > 1e-9);
    add('warn', closedHeld.length, `${plural(closedHeld.length, 'закритий підрозділ', 'закриті підрозділи',
      'закритих підрозділів')} із майном на обліку`, () => subHandOver(closedHeld[0].name),
      closedHeld.slice(0, 3).map((x) => `${x.name} — ${fmtNum(balSub(x.name))} од.`).join('; '),
      'Передати майно');
    const noMvo = reconSubs(t).filter((x) => x.pos && !mvoAt(x.sub, t));
    add('warn', noMvo.length, `${plural(noMvo.length, 'підрозділ', 'підрозділи', 'підрозділів')} з майном без МВО`,
      () => go('people', { peopleTab: 'resp', personId: null }), noMvo.slice(0, 4).map((x) => x.sub).join(', '),
      `Призначити МВО · ${noMvo.length}`);
    add('info', histOn() ? 1 : 0, 'увімкнено режим «вношу історію»',
      () => go('moves'), 'перемикач режиму в формі документа', 'Вимкнути режим');
    const inv = (store.inventories || []).filter((x) => x.status !== 'завершено');
    add('info', inv.length, plural(inv.length, 'інвентаризація не завершена', 'інвентаризації не завершені', 'інвентаризацій не завершено'), () => go('stocktake', { stId: inv[0].id, stSub: '' }),
      inv.map((x) => `станом на ${fmtDate(x.date)}`).join(', '), 'Продовжити опис');
    // Строки наказу про інвентаризацію: найближчий невиконаний — за місяць до нього.
    for (const x of inv) {
      const open = () => go('stocktake', { stId: x.id, stSub: '' });
      const due = stNextDue(x, t);
      if (due && due.left <= 30) {
        out.push({ lvl: due.kind === 'late' ? 'bad' : due.kind === 'soon' ? 'warn' : 'info', n: Math.abs(due.left) || '!',
          text: due.kind === 'late' ? `${plural(-due.left, 'день', 'дні', 'днів')} після строку ${due.what}, ${fmtDate(due.due)}`
            : due.left ? `${plural(due.left, 'день', 'дні', 'днів')} до строку ${due.what}, ${fmtDate(due.due)}`
              : `сьогодні строк ${due.what}`,
          fn: open, hint: '', act: 'Відкрити інвентаризацію' });
      }
      const late = stLate(x, t);
      add('warn', late.length, `${plural(late.length, 'підрозділ', 'підрозділи', 'підрозділів')} з простроченим днем інвентаризації за планом`,
        open, late.slice(0, 4).join(', ') + (late.length > 4 ? '…' : ''), 'Відкрити план');
    }
    // Відомість МТЗ: строк подання за минулий місяць і надходження, яким ще не вказано джерело.
    const mc = mtzCtl(t);
    if (mc) {
      const what = `подання відомості МТЗ за ${monthName(mc.ym)}`;
      out.push({ lvl: mc.kind === 'late' ? 'bad' : mc.kind === 'soon' ? 'warn' : 'info', n: Math.abs(mc.left) || '!',
        text: mc.kind === 'late' ? `${plural(-mc.left, 'день', 'дні', 'днів')} після строку ${what}, ${fmtDate(mc.due)}`
          : mc.left ? `${plural(mc.left, 'день', 'дні', 'днів')} до ${what}, ${fmtDate(mc.due)}` : `сьогодні строк ${what}`,
        fn: () => go('mtz', { mtzMonth: mc.ym }), hint: '', act: 'Відкрити відомість' });
    }
    const bare = mtzBare(t);
    add('warn', bare.length, `${plural(bare.length, 'надходження', 'надходження', 'надходжень')} без джерела для відомості МТЗ`,
      () => { tfOf('mtz').st = 'bare'; go('mtz', { mtzMonth: null }); },
      [...new Set(bare.map((x) => numNo(x.no)))].slice(0, 5).join(', '), `Вказати джерело · ${bare.length}`);
    const y = t.slice(0, 4);
    if (t >= `${y}-10-15` && !allInv().some((x) => x.date.startsWith(y) && x.kind === 'щорічна')) {
      add('info', 1, `щорічна інвентаризація ${y} року ще не заведена`, () => go('stocktake', { stId: null }),
        '', 'Завести інвентаризацію');
    }
    const mineNoScan = new Set(docs.filter((r) => r.mine && !scansOf(r).length).map(keyOfRow));
    add('info', mineNoScan.size, `${plural(mineNoScan.size, 'внесений документ', 'внесені документи', 'внесених документів')} без скану паперу`,
      () => go('moves', { noScan: true, onlyMine: true, movesLimit: 200 }), '',
      `Підшити скани · ${mineNoScan.size}`);
    add('bad', (missingFiles || []).length, `${plural((missingFiles || []).length, 'підшитий файл', 'підшиті файли',
      'підшитих файлів')} не знайдено в теках`, () => showMissingFiles(),
      (missingFiles || []).slice(0, 2).join('; '), 'Показати перелік');
    const off = invMismatch();
    add('info', off.length, `${plural(off.length, 'позиція', 'позиції', 'позицій')}: інвентарні номери не там, де майно`,
      () => go('inv', { q: off[0].code }), off.slice(0, 2).map((x) => `${x.code} «${x.sub}»: номерів ${x.n}, числиться ${fmtNum(x.q, '0')}`)
        .join('; '), 'Перенести номери');
    const reused = reusedNumbers();
    add('info', reused.length, `${plural(reused.length, 'номер', 'номери', 'номерів')} використано на кілька дат`,
      () => go('moves', { q: reused[0].no, movesLimit: 200 }),
      reused.slice(0, 3).map((x) => `${KIND_NAME[x.kind].toLowerCase()} ${numNo(x.no)}: ${x.dates.map(fmtDate).join(', ')}`).join('; '),
      'Переглянути документи');
    const short = staffRows(t).filter((g) => g.staffed && g.short > 0);
    add('info', short.length, `${plural(short.length, 'табельна позиція', 'табельні позиції', 'табельних позицій')} із некомплектом`, () => go('supply'),
      `разом ${fmtNum(short.reduce((a, g) => a + g.short, 0))} од.`, 'Відкрити штат');
    const unsure = tzItems().filter((i) => !assetSure(i) && balCode(i.code) > 1e-9);
    add('info', unsure.length, `${plural(unsure.length, 'позиція', 'позиції', 'позицій')} з непідтвердженим видом обліку`,
      () => go('nomen', { assetF: 'unsure', group: '', sub: '', q: '', onlyShort: false }),
      'уточніть у ФЕС, необоротний актив це чи запаси', 'Показати перелік');
    if (native && !me.remote && items.some((i) => bookOfItem(i) === 'ОП')) {
      // Книга «Облік ОП» — запасний шлях: коли програма недоступна, ведуть останнє вивантаження.
      const last = (D.meta || {}).opBookExport || '';
      const days = last ? daysBetween(last, t) : null;
      add('info', days == null || days >= 7 ? 1 : 0,
        days == null ? 'книгу «Облік ОП» ще не вивантажували'
          : `книгу «Облік ОП» не вивантажували ${cnt(days, 'день', 'дні', 'днів')}`,
        () => go('j47', { book: 'ОП' }), 'запасний шлях обліку посуду й миючих', 'Вивантажити');
    }
    // Акти списання за нормами: з 4-го числа — акт ОП/МЗ за минулий місяць, якщо його ще не складено; і акти, д/д яких
    // змінилися після складання (Добовку поправили заднім числом).
    if (items.some((i) => bookOfItem(i) === 'ОП' && i.perRation) && (store.points || []).length) {
      const pm = monthAdd(t.slice(0, 7), -1);
      const due = +t.slice(8, 10) >= 4 ? actsDue(`${pm}-01`, monthEnd(pm)) : [];
      add('warn', due.length, `${due.length > 1 ? 'акти' : 'акт'} ${due.join(' і ')} за ${monthName(pm)} не складено`,
        () => { regReset('oacts'); go('acts', { book: 'ОП', actsTab: 'acts' }); }, 'щомісяця до 3-го числа', 'Скласти');
      const changed = Object.values(store.acts || {}).filter((a) => a.daysChanged).length;
      add('info', changed, `дні д/д змінилися після складання: ${cnt(changed, 'акт', 'акти', 'актів')}`,
        () => { regReset('oacts'); tfOf('oacts').days = '1'; go('acts', { book: 'ОП', actsTab: 'acts' }); },
        'Добовку поправили заднім числом', 'Переглянути');
    }
    for (const book of Object.keys(BOOKS)) {
      // Книги «Облік СП» і «Облік РП» — запасний шлях, як і книга ОП.
      if (!native || me.remote || !items.some((i) => bookOfItem(i) === book)) continue;
      const last = ((D.meta || {}).bookExport || {})[book] || '';
      const days = last ? daysBetween(last, t) : null;
      add('info', days == null || days >= 7 ? 1 : 0,
        days == null ? `книгу «${BOOKS[book].file}» ще не вивантажували`
          : `книгу «${BOOKS[book].file}» не вивантажували ${cnt(days, 'день', 'дні', 'днів')}`,
        () => go('j47', { book }), `запасний шлях обліку ${BOOKS[book].of}`, 'Вивантажити');
    }
    const late = fesLate(store.docFes, t);
    add('info', late.length, `${plural(late.length, 'документ', 'документи', 'документів')} понад 14 днів «роздрукувати», «на підписі» чи «їде на ФЕС»`,
      () => go('moves', { movesFes: late[0] ? late[0].status : '' }), '', 'Показати');
    if (native && !me.remote) {
      // Автоматичні копії лежать на тому самому диску, що й база: втрата теки
      // чи диска забирає їх разом з обліком. Копію поза комп’ютером людина
      // робить сама — програма лише не дає про це забути.
      const last = store.ui.lastCopy || '';
      const days = last ? daysBetween(last, t) : null;
      add('info', days == null || days >= 30 ? 1 : 0,
        days == null ? 'копії бази поза комп’ютером ще не робили'
          : `копію бази поза комп’ютером не робили ${cnt(days, 'день', 'дні', 'днів')}`,
        () => copyAway(),
        'автоматичні копії лежать на тому самому диску, що й база',
        'Зберегти копію');
    }
    return out;
  }

  function attentionCard() {
    const list = attentionItems();
    attActs = list.map((x) => x.fn);
    if (!list.length) {
      return `<div class="card att-card att-card--ok" style="margin-bottom:12px"><div class="card__head">
        <div class="card__title">Потребує уваги</div><div class="panel__spacer"></div>
        <span class="panel__count">зауважень немає</span></div></div>`;
    }
    return `<div class="card att-card" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">Потребує уваги</div></div>
      ${list.map((x, i) => `<div class="att att--${x.lvl}" data-act="att" data-i="${i}">
        <span class="att__n">${x.n}</span><span class="att__text">${esc(x.text)}${x.hint
          ? `<small>${esc(x.hint)}</small>` : ''}</span>
        <span class="att__go">${esc(x.act || 'Відкрити')} →</span></div>`).join('')}
    </div>`;
  }
