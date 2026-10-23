// Облік ТЗ ПС · сторінка · люди й посадовці, вкладення.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ============================================================ ЛЮДИ Й ПОСАДОВЦІ
  /** Довідник «Військовослужбовці», як у ЗСУпрод: людина — ім'я частинами й
   *  історія звань і посад із датами. Документ на дату бере звання й посаду,
   *  чинні тоді, а не сьогодні: у торішньому описі лишається те, що було.
   *  «МВО й посадовці» — хто за який підрозділ відповідав і з якого по яке
   *  число, і посадовці частини, що підписують документи служби.
   *
   *  Початкові записи — з бази (з описів інвентаризації); далі довідник живе
   *  у внесених даних і правиться тут. */
  const ROLES = [
    ['командир', 'Командир військової частини', 'затверджує акт інвентаризації'],
    ['начальник логістики', 'Начальник логістики', 'ознайомлюється з актом'],
    ['начальник служби', 'Начальник продовольчої служби', 'перевіряє описи, підписує відомості'],
    ['бухгалтер', 'Бухгалтер ФЕС', 'вносить облікові дані в описи'],
    ['начальник ФЕС', 'Начальник ФЕС', ''],
  ];
  const roleName = (role) => (ROLES.find((r) => r[0] === role) || [role, role])[1];
  const RANKS = ['солдат', 'старший солдат', 'молодший сержант', 'сержант', 'старший сержант',
    'головний сержант', 'штаб-сержант', 'майстер-сержант', 'старший майстер-сержант',
    'головний майстер-сержант', 'молодший лейтенант', 'лейтенант', 'старший лейтенант', 'капітан',
    'майор', 'підполковник', 'полковник', 'бригадний генерал', 'працівник ЗСУ'];

  /** Довідники — люди, МВО, посадовці, дислокація, підрозділи — лежать у базі
   *  й правляться там само. Програма бере їх із витягу, який будується з живої
   *  бази при запуску, і туди ж повертає: поділу «база / моє» немає, тому й
   *  зливати нічого не треба. Ідентифікатор запису приходить із бази й не
   *  змінюється, тож посилання (МВО на людину, підписанти опису) переживають
   *  і перезапуск, і перезбірку. */
  const basePerson = (r) => ({
    id: r[0], surname: r[1] || '', name: r[2] || '', patr: r[3] || '', note: r[4] || '',
    hist: (r[5] || []).map((h) => ({ date: h[0] || '', rank: h[1] || '', pos: h[2] || '', basis: h[3] || '' })),
  });
  const baseMvo = (r) => ({ id: r[5], sub: r[0], person: r[1],
    from: r[2] || '', to: r[3] || '', note: r[4] || '' });
  const baseOfficial = (r) => ({ id: r[5], role: r[0], person: r[1],
    from: r[2] || '', to: r[3] || '', note: r[4] || '' });
  const baseLocation = (r) => ({ id: r[0], from: r[1] || '', place: r[2] || '', note: r[3] || '' });
  /** Реквізити частини для бланків: назва юридичної особи, ЄДРПОУ, повна назва
   *  служби й скільки днів дійсна накладна; для паперів закупівель — відомчий код
   *  розпорядника коштів, вищий штаб і телефон служби (у базі їх немає: порожні,
   *  доки не вписані). Місця складання тут немає: його дає дислокація за датами
   *  (`locationAt`), друге джерело правди не заводять. Початкові — з бази, правлять їх у
   *  «Люди й МВО → Частина»: переїхала частина чи змінилася назва служби —
   *  міняють тут, а не в самому бланку Excel. */
  const UNIT_FIELDS = [
    ['legalName', 'Найменування юридичної особи', 'Військова частина А0000',
      'як у шапці бланка накладної'],
    ['edrpou', 'Код за ЄДРПОУ', '00000000', ''],
    ['serviceFull', 'Служба забезпечення', 'Продовольча служба тилу логістики',
      'повна назва, як у документах'],
    ['validDays', 'Накладна дійсна, днів', '1', 'скільки днів після дати операції'],
    ['actForm', 'Форма акта списання', 'Додаток 10 до наказу №… від …', 'рядок над «ЗАТВЕРДЖУЮ»'],
    ['opening', 'Початок обліку', '', 'документів із ранішою датою програма не приймає', 'date'],
    ['fundCode', 'Відомчий код розпорядника коштів', '', 'для форм 1/фс і 9/фс'],
    ['upperHq', 'Вищий штаб', 'А0000', 'кому йде супровід через СЕДО'],
    ['phone', 'Телефон служби', '(000)-000-00-00', 'виконавець у 9/фс'],
  ];
  /** Умовне найменування частини («А0000») — з найменування юридичної особи в
   *  реквізитах; без нього — порожньо, і тексти обходяться без числа. */
  const unitCode = () => (String(unitInfo().legalName || '').match(/частина\s+(\S+)/i) || [])[1] || '';
  const unitGen = () => (unitCode() ? `військової частини ${unitCode()}` : 'військової частини');
  function unitInfo() {
    const base = {
      legalName: D.meta.legalName || 'Військова частина',
      edrpou: D.meta.edrpou || '',
      serviceFull: D.meta.serviceFull || D.meta.service || '',
      validDays: D.meta.validDays || 1,
      actForm: '',                             // у базі його немає: лише правка частини, з якої його бере бланк акта за нормами
      opening: D.meta.opening || '',
      fundCode: '',
      upperHq: '',
      phone: '',
    };
    const mine = store.unit || {};
    const out = {};
    for (const [k] of UNIT_FIELDS) out[k] = String(mine[k] ?? '').trim() || base[k];
    out.validDays = Math.max(0, Math.min(365, Number(out.validDays) || 1));
    // Початок обліку — дата, і не в майбутньому: інша — та, що в базі.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(out.opening) || out.opening > today()) out.opening = base.opening;
    return out;
  }
  /** Шапка вивантажень: «Військова частина А0000 · продовольча служба». */
  const unitTop = () => `${unitInfo().legalName} · ${unitInfo().serviceFull}`;

  /** Скорочення служби, зрозумілі не всім одразу. Підказка на наведення — не
   *  підручник, але новій людині не треба питати, що таке МВО. */
  const GLOSSARY = {
    'МВО': 'матеріально відповідальна особа',
    'ВМТЗ': 'взвод матеріально-технічного забезпечення',
    'РМЗ': 'рота матеріального забезпечення',
    'РВП': 'ремонтно-відновлювальний підрозділ',
    'ФЕС': 'фінансово-економічна служба частини',
    'ФЄС': 'фінансово-економічна служба частини',
    'ТЗ': 'технічні засоби продовольчої служби',
    'зав. №': 'заводський номер',
    '21/Прод': 'табель до штату з нормою технічних засобів на підрозділ',
    '3/Прод': 'табель до штату з нормою для їдалень і кухонь',
    'б/н': 'без номера',
    'ППД': 'пункт постійної дислокації',
    'МТЗ': 'матеріально-технічні засоби',
    'КПКВ': 'код програмної класифікації видатків',
    'КЕКВ': 'код економічної класифікації видатків',
  };
  const hintFor = (text) => {
    const key = Object.keys(GLOSSARY).find((k) => String(text) === k
      // «ТЗ №17» — частина номера документа, а не скорочення.
      || new RegExp(`(^|[\\s(«·])${k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?!\\s*№)([\\s)»,.·]|$)`).test(String(text)));
    return key ? `${key} — ${GLOSSARY[key]}` : '';
  };

  const peopleReady = new WeakSet();
  function peopleInit() {
    if (peopleReady.has(store)) return;
    peopleReady.add(store);
    // Робочі переліки — копія того, що в базі. Правки з них ідуть назад у базу
    // цілком, тому жодного «що з бази, а що моє» розрізняти не треба.
    store.people = (D.people || []).map(basePerson);
    store.mvo = (D.mvo || []).map(baseMvo);
    store.cmdrs = (D.cmdrs || []).map(baseMvo);
    store.officials = (D.officials || []).map(baseOfficial);
    store.locations = (D.locations || []).map(baseLocation);
    store.subs = (D.subs || []).map(baseSub);
    delete store.baseSeen;                 // пам'ять про злиття більше не потрібна
    delete store.baseSig;
    rebuildSubs(store.subs, subMentions());
  }

  /** Назви підрозділів, згаданих у внесених даних. Потрібні двічі: щоб знати,
   *  чи задіяний підрозділ, доданий у програмі, і щоб не дати видалити той, на
   *  якому щось висить. */
  function subMentions() {
    const set = new Set();
    const add = (x) => { const v = String(x || '').trim(); if (v) set.add(v); };
    const d = store.docs || {};
    for (const r of (d.incoming || [])) { add(r[3]); add(r[4]); }
    for (const r of (d.movement || [])) { add(r[3]); add(r[4]); }
    for (const r of (d.writeoffs || [])) add(r[3]);
    for (const r of (store.destroyed || [])) add(r.sub);
    for (const r of (store.recon || [])) add(r.sub);
    for (const r of (store.mvo || [])) add(r.sub);
    for (const r of (store.cmdrs || [])) add(r.sub);
    // Норми — через normsInit: до першого показу штату їх у store ще немає, і
    // підрозділ лише з нормою вважався б незадіяним.
    for (const r of normsInit()) add(r.sub);
    for (const x of (store.inventories || [])) for (const k of Object.keys(x.mvo || {})) add(k);
    // Пункт харчування списує з підрозділу: такий підрозділ задіяний, хоч би документів на ньому ще не було.
    for (const p of (store.points || [])) add(pointPlace(p));
    return set;
  }

  /** Скільки разів підрозділ згадано в обліку — у базі й у внесеному. Нуль
   *  означає, що запис довідника можна виправити чи прибрати без наслідків. */
  function subUses(name) {
    if (!name) return 0;
    return (subMentions().has(name) ? 1 : 0)
      + ledger.filter((e) => e.sub === name || e.cnt === name).length
      + subs.filter((s) => s.parent === name).length
      + (D.norms || []).filter((r) => r[2] === name).length
      + inventory.filter((r) => r.sub === name).length
      + (store.recon || []).filter((r) => r.sub === name).length
      + (store.mvo || []).filter((r) => r.sub === name).length
      + (store.cmdrs || []).filter((r) => r.sub === name).length
      // Звірки й інвентаризації з бази теж: інакше видалення «проходило», а
      // база його відхиляла, і підрозділ повертався після перезапуску.
      + allRecon().filter((r) => r.base && r.sub === name).length
      + allInv().filter((x) => (x.mvo || {})[name] != null || (x.scope || []).includes(name)).length
      + (store.points || []).filter((p) => pointPlace(p) === name).length
      + (baseRefs.get(name) || 0);
  }
  /** Місце складання документів на дату: останній запис дислокації, не пізніший за неї. */
  function locationAt(date) {
    peopleInit();
    const list = (store.locations || []).filter((r) => r.place && (!r.from || !date || r.from <= date));
    return (lastFrom(list) || {}).place || '';
  }
  const personBy = (id) => (id && (store.people || []).find((p) => p.id === id)) || null;
  const byDate = (a, b) => (a.date || '').localeCompare(b.date || '');
  /** Звання й посада на дату: останній запис історії, не пізніший за неї. */
  function personAt(p, date) {
    if (!p) return { rank: '', pos: '' };
    const hist = (p.hist || []).slice().sort(byDate);
    let cur = hist[0] || { rank: '', pos: '' };
    for (const h of hist) if (!h.date || !date || h.date <= date) cur = h;
    return { rank: cur.rank || '', pos: cur.pos || '' };
  }
  const isInitial = (s) => String(s || '').replace(/\./g, '').trim().length <= 1;
  const upper = (s) => String(s || '').trim().toUpperCase();
  /** Ім'я для підпису: «Тарас ПЕТРЕНКО»; якщо відомі лише ініціали — «ПЕТРЕНКО Т. Г.». */
  function pSign(p) {
    if (!p) return '';
    if (p.name && !isInitial(p.name)) return `${p.name.trim()} ${upper(p.surname)}`;
    const ini = (s) => (s && s.trim() ? s.trim()[0].toUpperCase() + '.' : '');
    return [upper(p.surname), [ini(p.name), ini(p.patr)].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  }
  /** «ПЕТРЕНКО Т. Г.» — у складі комісії. */
  function pShort(p) {
    if (!p) return '';
    const ini = (s) => (s && s.trim() ? s.trim()[0].toUpperCase() + '.' : '');
    return [upper(p.surname), [ini(p.name), ini(p.patr)].filter(Boolean).join(' ')].filter(Boolean).join(' ');
  }
  /** Повністю: «ПЕТРЕНКО Тарас Григорович». */
  const pFull = (p) => (p ? [upper(p.surname), p.name, p.patr].filter((x) => x && String(x).trim())
    .map((x, i) => (i && isInitial(x) ? String(x).replace(/\.$/, '').trim() + '.' : String(x).trim())).join(' ') : '');
  /** Підписант для бланка: посада й звання на дату, ім'я у формі підпису. */
  function signer(p, date, short = false) {
    if (!p) return { pos: '', rank: '', name: '' };
    const at = personAt(p, date);
    return { pos: at.pos, rank: at.rank, name: short ? pShort(p) : pSign(p) };
  }
  const openOn = (r, date) => (!r.from || r.from <= date) && (!r.to || r.to > date);
  const lastFrom = (list) => list.slice().sort((a, b) => (a.from || '').localeCompare(b.from || '')).pop();
  function mvoAt(sub, date) {
    peopleInit();
    return personBy((lastFrom(store.mvo.filter((r) => r.sub === sub && openOn(r, date))) || {}).person);
  }
  function officialAt(role, date) {
    peopleInit();
    return personBy((lastFrom(store.officials.filter((r) => r.role === role && openOn(r, date))) || {}).person);
  }
  function cmdrAt(sub, date) {
    peopleInit();
    return personBy((lastFrom(store.cmdrs.filter((r) => r.sub === sub && openOn(r, date))) || {}).person);
  }
  /** Командир (начальник) підрозділу на дату: свій, а де свого не призначено — вищого
   *  підрозділу. Командир частини описів підрозділів не підписує. */
  function cmdrFor(sub, date, depth = 0) {
    const sb = subBy.get(sub);
    if (!sb || sb.type === 'бригада' || depth > 4) return null;
    return cmdrAt(sub, date) || (sb.parent ? cmdrFor(sb.parent, date, depth + 1) : null);
  }
  /** Призначення зі строком дії трьох видів: МВО підрозділу, командир підрозділу, посадовець
   *  частини. Запис той самий — різняться перелік і те, до чого його прив'язано. */
  const ASSIGN = {
    mvo: { list: () => store.mvo, set: (v) => { store.mvo = v; }, key: 'sub', tag: 'mvo|', name: (w) => `МВО «${w}»` },
    cmdr: { list: () => store.cmdrs, set: (v) => { store.cmdrs = v; }, key: 'sub', tag: 'cmdr|', name: (w) => `командир «${w}»` },
    role: { list: () => store.officials, set: (v) => { store.officials = v; }, key: 'role', tag: 'role|', name: (w) => roleName(w) },
  };
  const assignKind = (k) => (ASSIGN[k] ? k : 'mvo');
  const upFirst = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
  /** Хто підписує накладну за підрозділ: його МВО на дату, а в батальйону без
   *  власного — командир його ВМТЗ (майно батальйону числиться там), далі вгору
   *  по дереву до батальйону. Бригада й сторонні одержувачі МВО не мають. */
  function mvoFor(sub, date, depth = 0) {
    const sb = subBy.get(sub);
    if (!sb || sb.type === 'бригада' || depth > 4) return null;
    const own = mvoAt(sub, date);
    if (own) return own;
    const vmtz = subs.find((s) => s.parent === sub && / · ВМТЗ$/.test(s.name));
    const viaVmtz = vmtz && mvoAt(vmtz.name, date);
    return viaVmtz || (sb.parent ? mvoFor(sb.parent, date, depth + 1) : null);
  }
  /** Скільки разів людина згадана в призначеннях, інвентаризаціях, довіреностях закупівель («кому») і закупівлях (відповідальний). */
  function personUses(id) {
    // Інвентаризації з бази теж: людина, що підписала торішній опис, має
    // лишитися в довіднику, інакше база видалення відхиляла мовчки.
    const inv = allInv().filter((x) => x.head === id || (x.members || []).includes(id)
      || Object.values(x.sign || {}).includes(id) || Object.values(x.mvo || {}).includes(id)
      || Object.values(x.cmdr || {}).includes(id)
      || Object.values(x.plan || {}).some((p) => p && p.who === id)).length;
    // Закупівлі теж: база знімає посилання на видалену людину мовчки («ON DELETE SET NULL»), і довіреність лишилася б без «кому».
    const pur = (store.purDocs || []).filter((d) => d.person === id).length + (store.purchases || []).filter((p) => p.person === id).length;
    return store.mvo.filter((r) => r.person === id).length + store.cmdrs.filter((r) => r.person === id).length
      + store.officials.filter((r) => r.person === id).length + inv + pur;
  }
  const peopleSorted = () => store.people.slice().sort((a, b) =>
    upper(a.surname).localeCompare(upper(b.surname), 'uk') || String(a.name).localeCompare(String(b.name), 'uk'));
  /** Перелік людей для вибору: ПІБ і звання на дату. */
  function personOptions(sel, date, empty = '— оберіть —') {
    return `<option value="">${esc(empty)}</option>` + peopleSorted().map((p) => {
      const rank = personAt(p, date).rank;
      return `<option value="${esc(p.id)}"${p.id === sel ? ' selected' : ''}>${esc(pFull(p))}${rank ? ', ' + esc(rank) : ''}</option>`;
    }).join('');
  }

  function renderPeople() {
    peopleInit();
    const tab = state.peopleTab || 'people';
    const TABS = [['people', 'Військовослужбовці'], ['resp', 'МВО й посадовці'],
      ['loc', 'Дислокація'], ['unit', 'Частина']];
    const seg = `<div class="seg">${TABS
      .map(([k, l]) => `<button type="button" data-act="pp-tab" data-v="${k}"${tab === k ? ' class="is-on"' : ''}>${l}</button>`)
      .join('')}</div>`;
    return {
      head: head('довідники / люди', (TABS.find((t) => t[0] === tab) || TABS[0])[1], seg
        + (tab === 'people' ? searchBox('Пошук: прізвище, звання, посада')
          + '<button class="btn btn--primary" data-act="pp-new">+ Військовослужбовець</button>'
          : tab === 'loc' ? '<button class="btn btn--primary" data-act="loc-add">+ Нове місце</button>' : '')),
      body: `${flashBlock()}${tab === 'people' ? peopleBody() : tab === 'loc' ? locBody()
        : tab === 'unit' ? unitBody() : respBody()}`,
    };
  }

  /** Дислокація частини: де складаються документи. Накладна бере «місце
   *  складання» на свою дату, як і підписантів. */
  function locBody() {
    const list = (store.locations || []).slice().sort((a, b) => (b.from || '').localeCompare(a.from || ''));
    const cur = locationAt(state.asOf);
    const rows = list.map((r) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:160px"><input class="rc-in" type="date" data-loc="${esc(r.id)}" data-k="from" value="${esc(r.from)}"></div>
        <div class="c-txt" style="flex:0 0 280px"><input class="rc-in rc-in--wide" data-loc="${esc(r.id)}" data-k="place"
          value="${esc(r.place)}" placeholder="с. Іванівка"></div>
        <div class="c-txt"><input class="rc-in rc-in--wide" data-loc="${esc(r.id)}" data-k="note" value="${esc(r.note)}"
          placeholder="наказ №, дата"></div>
        <div class="c-acts">${rowBtn('loc-del', '✕ Видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити помилковий запис' })}</div>
      </div>`).join('');
    return `<div class="panel"><div class="panel__note">Місце складання документів на ${fmtDate(state.asOf)}:
        <b>${esc(cur || 'не вказано')}</b>. Після переїзду додайте новий запис.</div></div>
      <div class="card card--scroll"><div class="tbl" style="--tbl-min:780px;--acts:110px">
        <div class="tbl__head"><div class="tbl__h c-date" style="width:160px">з дати</div>
          <div class="tbl__h c-txt" style="flex:0 0 280px">місце складання</div>
          <div class="tbl__h c-txt">підстава</div><div class="tbl__h c-acts"></div></div>
        ${rows || '<div class="tbl__row tbl__row--plain"><div class="c-txt">Записів ще немає. Додайте перший кнопкою «+ Нове місце».</div></div>'}
      </div></div>`;
  }

  /** Реквізити частини — те з бланка накладної, що з часом змінюється. */
  function unitBody() {
    const cur = unitInfo();
    const fields = UNIT_FIELDS.map(([k, label, , hint, type]) => `<div class="field">
      <label>${esc(label)}</label>
      <input data-uf="${k}" value="${esc(cur[k])}" autocomplete="off"${type === 'date' ? ` type="date" max="${today()}"` : ''}>
      ${hint ? `<div class="field__hint">${esc(hint)}</div>` : ''}</div>`).join('');
    return `<div class="panel"><div class="panel__note">Очистіть поле, щоб повернути значення з бази.</div></div>
      <div class="card form"><div class="card__head"><div class="card__title">Реквізити частини</div></div>
        <div class="form__grid">${fields}</div>
        <div class="card__foot"><span class="panel__count">У шапці вивантажень: ${esc(unitTop())}</span></div>
      </div>`;
  }

  function locationAdd() {
    peopleInit();
    const from = state.asOf || today();
    const same = (store.locations || []).find((x) => x.from === from);
    if (same) {
      // Два місця з однієї дати база не приймає — ведемо до наявного.
      toast(`Місце з ${fmtDate(from)} уже є — змініть його або звітну дату.`, true);
      $(`[data-loc="${same.id}"][data-k="place"]`)?.focus();
      return;
    }
    const r = { id: uid(), from, place: '', note: '' };
    store.locations = (store.locations || []).concat([r]);
    save(true, true);
    render();
    $(`[data-loc="${r.id}"][data-k="place"]`)?.focus();
  }

  function locationDelete(id) {
    const r = (store.locations || []).find((x) => x.id === id);
    if (!r) return;
    if (!confirm(`Видалити запис «${r.place || 'без назви'}» з ${fmtDate(r.from)}? Документи на ці дати візьмуть попереднє місце.`)) return;
    store.locations = store.locations.filter((x) => x.id !== id);
    logChange('дислокацію видалено', 'loc|' + r.from, `${r.place} з ${fmtDate(r.from)}`);
    save(true, true);
    render();
  }

  function peopleBody() {
    const date = state.asOf;
    const words = qWords(state.q);
    const mvoOf = (id) => store.mvo.filter((r) => r.person === id && openOn(r, date));
    const cmdOf = (id) => store.cmdrs.filter((r) => r.person === id && openOn(r, date));
    const offOf = (id) => store.officials.filter((r) => r.person === id && openOn(r, date));
    const rolesOf = (id) => mvoOf(id).map((r) => 'МВО ' + r.sub).concat(cmdOf(id).map((r) => 'командир ' + r.sub),
      offOf(id).map((r) => roleName(r.role)));
    const list = peopleSorted().filter((p) => {
      const at = personAt(p, date);
      return !words.length || hitAll(words, pFull(p), at.rank, at.pos, p.note);
    });
    const reg = registry({
      id: 'pp', rows: list, headSearch: true, allCount: store.people.length, minWidth: '900px',
      filters: [
        { type: 'seg', key: 'role', options: [['', 'усі'], ['mvo', 'МВО'], ['cmdr', 'командири'], ['off', 'посадовці'],
          ['none', 'без призначень']],
          test: (p, v) => (v === 'mvo' ? mvoOf(p.id).length > 0 : v === 'cmdr' ? cmdOf(p.id).length > 0
            : v === 'off' ? offOf(p.id).length > 0 : !rolesOf(p.id).length) },
      ],
      columns: [
        { key: 'name', label: 'прізвище, ім’я, по батькові', cls: 'c-name', first: 1, sort: (p) => pFull(p),
          cell: (p) => `<b>${esc(pFull(p) || 'без прізвища')}</b>${p.note ? `<small>${esc(p.note)}</small>` : ''}` },
        { key: 'rank', label: 'звання', cls: 'c-txt', style: 'flex:0 0 160px', first: 1, sort: (p) => personAt(p, date).rank || '',
          cell: (p) => esc(personAt(p, date).rank || '—') },
        { key: 'pos', label: 'посада', cls: 'c-txt', first: 1, sort: (p) => personAt(p, date).pos || '',
          cell: (p) => esc(personAt(p, date).pos || '—') },
        { key: 'roles', label: 'відповідає за', cls: 'c-txt', style: 'flex:0 1 260px', first: 1, sort: (p) => rolesOf(p.id).join(', '),
          cell: (p) => esc(rolesOf(p.id).join(', ') || '—') },
      ],
      row: (p) => ({ cls: state.personId === p.id ? 'is-sel' : '', attrs: `data-act="pp-open" data-id="${esc(p.id)}"` }),
      count: (shown) => (shown.length === store.people.length ? cnt(shown.length, 'особа', 'особи', 'осіб')
        : `${shown.length} із ${store.people.length}`),
      empty: 'Військовослужбовців ще немає.',
      emptyFiltered: 'Нікого не знайдено.',
    });
    return `${state.personId ? personCard(personBy(state.personId)) : ''}${reg.panel}
      <div class="card card--scroll">${reg.table}</div>`;
  }

  function personCard(p) {
    if (!p) return '';
    const hist = (p.hist || []).map((h, i) => ({ h, i })).sort((a, b) => byDate(a.h, b.h));
    const rows = hist.map(({ h, i }) => `<div class="tbl__row tbl__row--plain">
        <div class="c-date" style="width:150px"><input class="rc-in" type="date" data-ph="${i}" data-k="date" value="${esc(h.date)}"></div>
        <div class="c-txt" style="flex:0 0 190px"><input class="rc-in rc-in--wide" list="rank-list" data-ph="${i}" data-k="rank"
          value="${esc(h.rank)}" placeholder="звання"></div>
        <div class="c-txt"><input class="rc-in rc-in--wide" data-ph="${i}" data-k="pos" value="${esc(h.pos)}" placeholder="посада"></div>
        <div class="c-txt" style="flex:0 1 220px"><input class="rc-in rc-in--wide" data-ph="${i}" data-k="basis"
          value="${esc(h.basis)}" placeholder="наказ №, дата"></div>
        <div class="c-acts">${rowBtn('ph-del', '✕ Видалити', `data-i="${i}"`, { bad: true, title: 'Видалити запис', off: p.hist.length <= 1 })}</div>
      </div>`).join('');
    const field = (k, label, ph) => `<div class="field"><label>${label}</label>
      <input data-pf="${k}" value="${esc(p[k] || '')}" placeholder="${esc(ph)}" autocomplete="off"></div>`;
    const resp = store.mvo.filter((r) => r.person === p.id)
      .map((r) => `МВО «${r.sub}» з ${fmtDate(r.from)}${r.to ? ' по ' + fmtDate(r.to) : ''}`)
      .concat(store.cmdrs.filter((r) => r.person === p.id)
        .map((r) => `командир «${r.sub}» з ${fmtDate(r.from)}${r.to ? ' по ' + fmtDate(r.to) : ''}`))
      .concat(store.officials.filter((r) => r.person === p.id)
        .map((r) => `${roleName(r.role)} з ${fmtDate(r.from)}${r.to ? ' по ' + fmtDate(r.to) : ''}`));
    return `<div class="card form" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${esc(pFull(p) || 'Новий військовослужбовець')}</div>
        <div class="panel__spacer"></div>
        <button class="btn" data-act="pp-close">Закрити</button>
        <button class="btn btn--danger" data-act="pp-del">Видалити</button></div>
      <div class="form__grid">
        ${field('surname', 'Прізвище', 'ПЕТРЕНКО')}${field('name', 'Ім’я', 'Тарас або Т.')}
        ${field('patr', 'По батькові', 'Григорович або Г.')}
        <div class="field"><label>Примітка</label><input data-pf="note" value="${esc(p.note || '')}"
          placeholder="напр. «переведений», «не служить»"></div>
      </div>
      <div class="pad" style="padding-top:4px"><div class="panel__note">Нове звання чи посаду додавайте окремим записом із датою наказу.</div></div>
      <div class="card--scroll"><div class="tbl" style="--tbl-min:820px;--acts:110px">
        <div class="tbl__head"><div class="tbl__h c-date" style="width:150px">з дати</div>
          <div class="tbl__h c-txt" style="flex:0 0 190px">звання</div><div class="tbl__h c-txt">посада</div>
          <div class="tbl__h c-txt" style="flex:0 1 220px">підстава</div><div class="tbl__h c-acts"></div></div>
        ${rows}</div></div>
      <div class="card__foot"><button class="btn" data-act="ph-add">+ Зміна звання чи посади</button>
        <div class="panel__spacer"></div>
        <span class="panel__count">${esc(resp.join('; ') || 'відповідальних призначень немає')}</span></div>
    </div>
    <datalist id="rank-list">${RANKS.map((r) => `<option value="${esc(r)}">`).join('')}</datalist>`;
  }

  /** Людина без прізвища й імені (або з прочерком замість них). */
  const blankPerson = (p) => !p || (!String(p.surname || '').replace(/[—–\-\s.]/g, '')
    && !String(p.name || '').trim() && !String(p.patr || '').trim());
  function personNew() {
    peopleInit();
    const p = { id: uid(), surname: '', name: '', patr: '', note: '',
      hist: [{ date: today(), rank: '', pos: '', basis: '' }] };
    store.people.push(p);
    save();
    state.personId = p.id;
    state.q = '';
    render();
    $('[data-pf="surname"]')?.focus();
  }

  function personDelete() {
    const p = personBy(state.personId);
    if (!p) return;
    const n = personUses(p.id);
    if (n) {
      alert(`Не можна видалити «${pFull(p)}»: згадано в ${cnt(n, 'записі', 'записах', 'записах')} (призначення, інвентаризації, довіреності, закупівлі). `
        + 'Напишіть у примітці «не служить».');
      return;
    }
    if (!confirm(`Видалити «${pFull(p) || 'без прізвища'}» з довідника?`)) return;
    store.people = store.people.filter((x) => x.id !== p.id);
    state.personId = null;
    save(true, true);
    render();
  }

  function respBody() {
    const date = state.asOf;
    const holders = reconSubs(date).filter((x) => x.pos).map((x) => x.sub);
    const allSubs = [...new Set(holders.concat(store.mvo.map((r) => r.sub)))]
      .sort((a, b) => (subBy.get(a)?.order ?? 999) - (subBy.get(b)?.order ?? 999));
    const who = (r) => {
      const p = personBy(r.person);
      const at = personAt(p, date);
      return p ? `<b class="lnk" data-act="pp-open" data-id="${esc(p.id)}" title="Відкрити картку військовослужбовця">${esc(pSign(p))}</b>
        <small>${esc([at.rank, at.pos].filter(Boolean).join(', '))}</small>${
          r.note ? `<small title="Підстава призначення">${esc(r.note)}</small>` : ''}` : '<span class="num-bad">людину видалено</span>';
    };
    // Запис історії можна виправити (дату, людину, строк, підставу): пропущене
    // колись призначення чи помилкова дата — не привід видаляти все пізніше.
    const kindOf = (r) => (r.role ? 'role' : store.cmdrs.includes(r) ? 'cmdr' : 'mvo');
    const DEL = { mvo: 'mvo-del', cmdr: 'cmdr-del', role: 'off-del' };
    const edit = (r) => rowBtn('as-edit', '✎ Виправити', `data-id="${esc(r.id)}" data-v="${kindOf(r)}"`,
      { title: 'Виправити дату, людину, строк чи підставу' });
    const del = (r) => rowBtn(DEL[kindOf(r)], '✕ Видалити', `data-id="${esc(r.id)}"`, { bad: true, title: 'Видалити помилковий запис' });
    // Історія призначень — кілька слів на запис, тож і кнопки при них дрібніші.
    const histOf = (list, cur) => list.filter((r) => r !== cur).map((r) =>
      `<span title="${esc(r.note || '')}">${esc(pSign(personBy(r.person)) || '—')} ${fmtDate(r.from)}–${r.to ? fmtDate(r.to) : '…'}</span>`
      + ` <span class="acts__more">${edit(r)}${del(r)}</span>`).join('; ');
    const mvoData = allSubs.map((sub) => {
      const list = store.mvo.filter((r) => r.sub === sub).sort((x, y) => (y.from || '').localeCompare(x.from || ''));
      return { sub, list, cur: list.find((r) => openOn(r, date)), has: holders.includes(sub), sb: subBy.get(sub) };
    });
    const nameOfCur = (x) => (x.cur ? pSign(personBy(x.cur.person)) || '' : '');
    // Без майна МВО не потрібен: такий рядок — лише історія, а не справа до виконання.
    const mvoReg = registry({
      id: 'mvo', rows: mvoData, minWidth: '980px', panelCls: 'panel--inset', placeholder: 'Пошук: підрозділ, прізвище',
      search: (x) => [x.sub, nameOfCur(x)],
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі'], ['none', 'не призначено'], ['set', 'призначено']],
          test: (x, v) => (v === 'set' ? !!x.cur : !x.cur && x.has) },
        { type: 'toggle', key: 'has', label: 'з майном', test: (x) => x.has },
      ],
      columns: [
        { key: 'sub', label: 'підрозділ', cls: 'c-name', first: 1, sort: (x) => x.sb?.order ?? 999,
          cell: (x) => `<b>${esc(x.sub)}</b><small>${esc([x.sb?.type || '', x.sb && !x.sb.active ? 'закритий'
            : x.has ? '' : 'майна немає'].filter(Boolean).join(', '))}</small>` },
        { key: 'who', label: `МВО на ${fmtDate(date)}`, cls: 'c-txt', first: 1, sort: nameOfCur,
          cell: (x) => (x.cur ? who(x.cur) : x.has ? '<span class="num-bad">не призначено</span>' : '<span class="c-num--dim">—</span>') },
        { key: 'from', label: 'з дати', cls: 'c-date', sort: (x) => (x.cur ? x.cur.from || '' : ''), cell: (x) => (x.cur ? fmtDate(x.cur.from) : '—') },
        { key: 'hist', label: 'раніше', cls: 'c-txt', style: 'flex:0 1 300px', cell: (x) => `<small>${histOf(x.list, x.cur)}</small>` },
        { key: 'acts', label: '', cls: 'c-acts', cell: (x) => (x.cur ? `${edit(x.cur)}${rowBtn('mvo-end', 'Закрити', `data-id="${esc(x.cur.id)}"`,
          { title: 'Людина більше не відповідає: закрити призначення датою' })}${del(x.cur)}` : '') },
      ],
      acts: '250px',
      row: (x) => ({ cls: `tbl__row--plain${x.cur || !x.has ? '' : ' is-due'}` }),
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')
        : `${shown.length} із ${all.length}`} · без МВО ${all.filter((x) => !x.cur && x.has).length}`,
    });
    // Командири: підрозділи з майном, їхні вищі підрозділи (командир батальйону підписує й за
    // його їдальню та ВМТЗ, де свого не призначено) і ті, де призначення вже були.
    const above = holders.map((sub) => (subBy.get(sub) || {}).parent)
      .filter((p) => p && subBy.get(p) && subBy.get(p).type !== 'бригада');
    const cmdSubs = [...new Set(holders.concat(above, store.cmdrs.map((r) => r.sub)))]
      .sort((a, b) => (subBy.get(a)?.order ?? 999) - (subBy.get(b)?.order ?? 999));
    const cmdData = cmdSubs.map((sub) => {
      const list = store.cmdrs.filter((r) => r.sub === sub).sort((x, y) => (y.from || '').localeCompare(x.from || ''));
      const cur = list.find((r) => openOn(r, date));
      return { sub, list, cur, up: cur ? null : cmdrFor(sub, date), has: holders.includes(sub), sb: subBy.get(sub) };
    });
    const cmdName = (x) => (x.cur ? pSign(personBy(x.cur.person)) || '' : x.up ? pSign(x.up) : '');
    const cmdReg = registry({
      id: 'cmdr', rows: cmdData, minWidth: '980px', panelCls: 'panel--inset', placeholder: 'Пошук: підрозділ, прізвище',
      search: (x) => [x.sub, cmdName(x)],
      filters: [
        { type: 'seg', key: 'st', options: [['', 'усі'], ['none', 'не призначено'], ['set', 'призначено']],
          test: (x, v) => (v === 'set' ? !!(x.cur || x.up) : !x.cur && !x.up && x.has) },
        { type: 'toggle', key: 'has', label: 'з майном', test: (x) => x.has },
      ],
      columns: [
        { key: 'sub', label: 'підрозділ', cls: 'c-name', first: 1, sort: (x) => x.sb?.order ?? 999,
          cell: (x) => `<b>${esc(x.sub)}</b><small>${esc([x.sb?.type || '', x.sb && !x.sb.active ? 'закритий'
            : x.has ? '' : 'майна немає'].filter(Boolean).join(', '))}</small>` },
        { key: 'who', label: `командир на ${fmtDate(date)}`, cls: 'c-txt', first: 1, sort: cmdName,
          cell: (x) => (x.cur ? who(x.cur) : x.up ? `${esc(pSign(x.up))}<small>за вищим підрозділом</small>`
            : x.has ? '<span class="num-bad">не призначено</span>' : '<span class="c-num--dim">—</span>') },
        { key: 'from', label: 'з дати', cls: 'c-date', sort: (x) => (x.cur ? x.cur.from || '' : ''), cell: (x) => (x.cur ? fmtDate(x.cur.from) : '—') },
        { key: 'hist', label: 'раніше', cls: 'c-txt', style: 'flex:0 1 300px', cell: (x) => `<small>${histOf(x.list, x.cur)}</small>` },
        { key: 'acts', label: '', cls: 'c-acts', cell: (x) => (x.cur ? `${edit(x.cur)}${rowBtn('cmdr-end', 'Закрити', `data-id="${esc(x.cur.id)}"`,
          { title: 'Командир вибув: закрити призначення датою' })}${del(x.cur)}` : '') },
      ],
      acts: '250px',
      row: (x) => ({ cls: `tbl__row--plain${x.cur || x.up || !x.has ? '' : ' is-due'}` }),
      count: (shown, all) => `${shown.length === all.length ? cnt(all.length, 'підрозділ', 'підрозділи', 'підрозділів')
        : `${shown.length} із ${all.length}`} · без командира ${all.filter((x) => !x.cur && !x.up && x.has).length}`,
    });
    const roleRows = ROLES.map(([role, label, what]) => {
      const list = store.officials.filter((r) => r.role === role).sort((a, b) => (b.from || '').localeCompare(a.from || ''));
      const cur = list.find((r) => openOn(r, date));
      return `<div class="tbl__row tbl__row--plain${cur ? '' : ' is-due'}">
        <div class="c-name"><b>${esc(label)}</b><small>${esc(what)}</small></div>
        <div class="c-txt">${cur ? who(cur) : '<span class="num-bad">не призначено</span>'}</div>
        <div class="c-date">${cur ? fmtDate(cur.from) : '—'}</div>
        <div class="c-txt" style="flex:0 1 300px"><small>${histOf(list, cur)}</small></div>
        <div class="c-acts">${cur ? `${edit(cur)}${rowBtn('off-end', 'Закрити', `data-id="${esc(cur.id)}"`,
          { title: 'Посадовець вибув без наступника: закрити призначення датою' })}${del(cur)}` : ''}</div>
      </div>`;
    }).join('');
    const a = state.assign || {};
    const subOpts = pickableSubs(a.sub).filter((sb) => sb.type !== 'бригада').map((sb) =>
      `<option value="${esc(sb.name)}"${a.sub === sb.name ? ' selected' : ''}>${esc(sb.name)}</option>`).join('');
    const roleOpts = ROLES.map(([r, l]) => `<option value="${esc(r)}"${a.role === r ? ' selected' : ''}>${esc(l)}</option>`).join('');
    const tbl = (title, rows, first) => `<div class="card card--scroll" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${title}</div></div>
      <div class="tbl" style="--tbl-min:980px;--acts:250px"><div class="tbl__head"><div class="tbl__h c-name">${first}</div>
        <div class="tbl__h c-txt">чинна особа на ${fmtDate(date)}</div><div class="tbl__h c-date">з дати</div>
        <div class="tbl__h c-txt" style="flex:0 1 300px">раніше</div><div class="tbl__h c-acts"></div></div>
        ${rows}</div></div>`;
    return `<div class="panel"><div class="panel__note">Нове призначення діє з указаної дати й тією самою датою
        завершує попереднє. Помилковий запис в історії можна виправити або видалити кнопками в рядку.</div></div>
      <div class="card form" style="margin-bottom:12px">
        <div class="card__head"><div class="card__title">${a.id ? 'Виправити запис' : 'Призначити'}</div>
          ${a.id ? '' : `<div class="seg" style="margin-left:12px">${[['mvo', 'МВО підрозділу'], ['cmdr', 'командира підрозділу'],
            ['role', 'посадовця']].map(([k, l]) =>
            `<button type="button" data-act="as-kind" data-v="${k}"${(a.kind || 'mvo') === k ? ' class="is-on"' : ''}>${l}</button>`).join('')}</div>`}</div>
        <div class="form__grid">
          ${(a.kind || 'mvo') !== 'role'
            ? `<div class="field"><label>Підрозділ</label><select data-as="sub"${a.id ? ' disabled' : ''}><option value="">— оберіть —</option>${subOpts}</select></div>`
            : `<div class="field"><label>Посада</label><select data-as="role"${a.id ? ' disabled' : ''}><option value="">— оберіть —</option>${roleOpts}</select></div>`}
          <div class="field"><label>Хто</label><select data-as="person">${personOptions(a.person, a.from || date)}</select></div>
          <div class="field"><label>З дати</label><input type="date" data-as="from" value="${esc(a.from || date)}"></div>
          ${a.id ? `<div class="field"><label>По дату</label><input type="date" data-as="to" value="${esc(a.to || '')}"
            title="Перший день, коли людина вже не відповідає; порожньо — чинне"></div>` : ''}
          <div class="field"><label>Підстава</label><input data-as="note" value="${esc(a.note || '')}" placeholder="наказ №, дата"></div>
        </div>
        <div class="card__foot"><button class="btn btn--primary" data-act="as-add">${a.id ? 'Зберегти запис' : 'Призначити'}</button>
          ${a.id ? '<button class="btn" data-act="as-cancel">Скасувати</button>' : ''}
          <span class="panel__count">${a.id ? 'Строк дії не може перекривати сусідні призначення'
            : 'Призначення з давнішою датою стане в історію на своє місце. Нову людину спершу додайте на вкладці «Військовослужбовці»'}</span></div>
      </div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Матеріально відповідальні особи підрозділів</div></div>
        ${mvoReg.panel}<div class="card--scroll">${mvoReg.table}</div></div>
      <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Командири (начальники) підрозділів</div></div>
        ${cmdReg.panel}<div class="card--scroll">${cmdReg.table}</div></div>
      ${tbl('Посадовці частини, що підписують документи служби', roleRows, 'посада')}`;
  }

  /** Нове призначення: попереднє відкрите закривається тією самою датою. */
  function assignAdd() {
    peopleInit();
    const a = state.assign || {};
    const kind = assignKind(a.kind);
    const K = ASSIGN[kind];
    const from = a.from || state.asOf;
    const what = a[K.key];
    if (!what || !a.person) { toast(K.key === 'sub' ? 'Оберіть підрозділ і людину.' : 'Оберіть посаду й людину.', true); return; }
    if (a.id) return assignFix(kind, a);
    const list = K.list().filter((r) => r[K.key] === what);
    if (list.some((r) => (r.from || '') === from)) {
      toast(`Призначення з ${fmtDate(from)} уже є. Виправте той запис кнопкою ✎.`, true);
      return;
    }
    // Пропущене колись призначення стає в історію на своє місце: діє до
    // наступного запису, а попередній закінчується його датою.
    const next = list.filter((r) => (r.from || '') > from).sort((x, y) => (x.from < y.from ? -1 : 1))[0];
    for (const r of list) if ((r.from || '') < from && (!r.to || r.to > from)) r.to = from;
    const rec = { id: uid(), person: a.person, from, to: next ? next.from : '', note: a.note || '', [K.key]: what };
    K.list().push(rec);
    logChange('призначено', K.tag + what,
      `${upFirst(K.name(what))}: ${pSign(personBy(rec.person))} з ${fmtDate(from)}${rec.note ? ' (' + rec.note + ')' : ''}`);
    save(true, true);
    state.assign = { kind };
    state.flash = `${upFirst(K.name(what))}: ${pSign(personBy(rec.person))} з ${fmtDate(from)}.`;
    render();
  }

  function assignEnd(id, kind = 'mvo') {
    const K = ASSIGN[assignKind(kind)];
    const arr = K.list();
    const r = arr.find((x) => x.id === id);
    if (!r) return;
    const what = K.key === 'sub' ? r.sub : roleName(r.role);
    const to = prompt(`Закрити призначення «${what}». З якої дати людина більше не відповідає? (РРРР-ММ-ДД)`, today());
    if (!to) return;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(to) || (r.from && to <= r.from)) { toast('Дата має бути пізнішою за дату призначення.', true); return; }
    // Строк не може зайти на наступне призначення того самого підрозділу чи посади.
    const next = arr.filter((x) => x.id !== r.id && x[K.key] === r[K.key]
      && (x.from || '') > (r.from || '')).sort((a, b) => (a.from < b.from ? -1 : 1))[0];
    if (next && to > next.from) {
      toast(`З ${fmtDate(next.from)} «${what}» уже ${pSign(personBy(next.person))}. `
        + 'Закрийте не пізніше цієї дати.', true);
      return;
    }
    r.to = to;
    logChange('призначення закрито', K.tag + r[K.key], `${upFirst(K.name(r[K.key]))}: ${pSign(personBy(r.person))} по ${fmtDate(to)}`);
    save(true, true);
    render();
  }

  /** Виправлення запису призначення: людина, строк, підстава. Строк не має
   *  заходити на сусідні записи того самого підрозділу чи посади. */
  function assignFix(kind, a) {
    const K = ASSIGN[assignKind(kind)];
    const arr = K.list();
    const r = arr.find((x) => x.id === a.id);
    if (!r) { state.assign = { kind }; return render(); }
    const from = a.from || r.from || '';
    const to = a.to || '';
    if (to && to <= from) { toast('«По» має бути пізніше за «з».', true); return; }
    const hit = arr.find((x) => x.id !== r.id && x[K.key] === r[K.key]
      && (x.from || '') < (to || '9999') && from < (x.to || '9999'));
    if (hit) {
      toast(`Строк перекривається із записом ${pSign(personBy(hit.person))} з ${fmtDate(hit.from)}`
        + `${hit.to ? ' по ' + fmtDate(hit.to) : ''}. Спершу виправте той запис.`, true);
      return;
    }
    const before = `${pSign(personBy(r.person))} ${fmtDate(r.from)}–${r.to ? fmtDate(r.to) : '…'}${r.note ? ' (' + r.note + ')' : ''}`;
    Object.assign(r, { person: a.person, from, to, note: a.note || '' });
    logChange('призначення виправлено', K.tag + r[K.key],
      `${upFirst(K.name(r[K.key]))}: ${before} → ${pSign(personBy(r.person))} ${fmtDate(r.from)}–${r.to ? fmtDate(r.to) : '…'}${r.note ? ' (' + r.note + ')' : ''}`);
    state.assign = { kind };
    save(true, true);
    render();
  }

  function assignDelete(kind, id) {
    const K = ASSIGN[assignKind(kind)];
    const arr = K.list();
    const r = arr.find((x) => x.id === id);
    if (!r) return;
    if (!confirm(`Видалити запис «${upFirst(K.name(r[K.key]))}: ${pSign(personBy(r.person))}`
      + ` з ${fmtDate(r.from)}»?\n\nЯкщо змінилася людина, не видаляйте, а призначте нову.`)) return;
    // Нове призначення закрило попереднє своєю датою (assignAdd). Видалення
    // помилкового запису повертає попереднє: воно знову діє до наступного
    // запису, якщо такий є, інакше без кінця. Раніше підрозділ лишався без
    // чинного МВО, і це ніде не було видно.
    const same = (x) => x.id !== r.id && x[K.key] === r[K.key];
    const next = arr.filter((x) => same(x) && (x.from || '') > (r.from || '')).sort((a, b) => (a.from < b.from ? -1 : 1))[0];
    const back = arr.filter((x) => same(x) && x.to && x.to === r.from);
    for (const x of back) x.to = next ? next.from : '';
    K.set(arr.filter((x) => x.id !== id));
    logChange('призначення видалено', K.tag + r[K.key],
      `${upFirst(K.name(r[K.key]))}: ${pSign(personBy(r.person))} з ${fmtDate(r.from)}`
      + (back.length ? `; знову чинне: ${back.map((x) => pSign(personBy(x.person))).join(', ')}` : ''));
    save(true, true);
    render();
  }

  /** Поля довідників, що живуть не на екрані людей: запис підрозділу, строки
   *  норм і штат табельної позиції по підрозділах. */
  function bindDirs() {
    $('#scroll').querySelectorAll('[data-sd]').forEach((el) => el.addEventListener('change', () => {
      const r = subById(el.dataset.id);
      if (!r) return;
      const v = el.value.trim();
      if (el.dataset.sd === 'name') {
        if (!v || (v !== r.name && subBy.has(v))) {
          toast(v ? `Підрозділ «${v}» уже є в довіднику.` : 'Назва не може бути порожньою.', true);
          return render();
        }
        if (v !== r.name && subUses(r.name)) {
          toast('За підрозділом є записи в обліку. Змініть назву кнопкою «Виправити назву» чи «Перейменувати».', true);
          return render();
        }
      }
      // Дерево не має дат: нове підпорядкування підрозділу з документами змінює
      // й підсумки минулих дат (роллап, охоплення звірок та інвентаризацій).
      if (el.dataset.sd === 'parent' && v !== r.parent && subUses(r.name)
        && !confirm(`«${r.name}» переходить ${v ? `у «${v}»` : 'на верхній рівень'}.\n\n`
          + 'Зведення, штат і охоплення звірок та інвентаризацій за минулі дати теж рахуватимуться по-новому. Змінити?')) {
        return render();
      }
      if (el.dataset.sd === 'parent' && v !== r.parent) {
        logChange('підпорядкування змінено', 'sub|' + r.name, `«${r.name}»: ${r.parent ? '«' + r.parent + '»' : 'верхній рівень'} → ${v ? '«' + v + '»' : 'верхній рівень'}`);
      }
      r[el.dataset.sd] = v;
      return subsChanged(false);
    }));
    $('#scroll').querySelectorAll('[data-sn]').forEach((el) => el.addEventListener('change', () => {
      state.subNew = Object.assign({}, state.subNew, { [el.dataset.sn]: el.value.trim() });
    }));
    $('#scroll').querySelectorAll('[data-sr]').forEach((el) => el.addEventListener('change', () => {
      state.subRen = Object.assign({}, state.subRen, { [el.dataset.sr]: el.value.trim() });
    }));
    $('#scroll').querySelectorAll('[data-nm]').forEach((el) => el.addEventListener('change', () => {
      const n = normById(el.dataset.nm);
      if (!n) return;
      const k = el.dataset.k;
      if (k === 'from' || k === 'to') {
        // Строки перевіряються тут, а не базою: «по» пізніше за «з» і без
        // перекриття з іншими нормами тієї самої позиції підрозділу.
        const next = Object.assign({}, n, { [k]: el.value.trim() });
        const same = (x) => x.id !== n.id && x.sub === n.sub && (n.code ? x.code === n.code
          : x.form === n.form && x.line === n.line);
        const hit = normsInit().filter(same).find((x) => (x.from || '') < (next.to || '9999')
          && (next.from || '') < (x.to || '9999'));
        const bad = next.to && next.to <= (next.from || '')
          ? '«По» має бути пізніше за «з».'
          : hit ? `Строк перекривається з нормою ${fmtNum(hit.qty)} з ${fmtDate(hit.from) || 'початку'}`
            + `${hit.to ? ' по ' + fmtDate(hit.to) : ''} — спершу змініть її.` : '';
        if (bad) { toast(bad, true); el.value = n[k] || ''; return; }
      }
      const it = n.code ? itemBy.get(n.code) : null;
      const what = n.code ? `${n.code} «${it ? cleanName(it.name) : 'позиція'}»` : `«${n.line}» (${n.form})`;
      const before = k === 'qty' ? fmtNum(n.qty, '0') : k === 'basis' ? n.basis || '—' : fmtDate(n[k]) || '—';
      if (k === 'qty') {
        const v = Math.max(0, parseFloat(String(el.value).replace(',', '.')) || 0);
        // Нуль у строку норми — це видалення норми разом з історією: лише за згодою.
        if (!v && !confirm(`Штат 0: видалити норму ${what} для «${n.sub}»?\n\n`
          + 'Вона зникне й із розрахунків минулих дат. Якщо штат змінився — закрийте норму датою «по».')) {
          el.value = String(n.qty);
          return;
        }
        n.qty = v;
      } else n[k] = el.value.trim();
      if (!n.qty) store.norms = store.norms.filter((x) => x.id !== n.id);
      const after = !n.qty ? 'видалено' : k === 'qty' ? fmtNum(n.qty, '0') : k === 'basis' ? n.basis || '—' : fmtDate(n[k]) || '—';
      const label = { qty: 'штат', from: 'з', to: 'по', basis: 'підстава' }[k] || k;
      logChange(n.qty ? 'штат змінено' : 'норму видалено', 'norm|' + n.id, `${what}, ${n.sub}: ${label} ${before} → ${after}`);
      save(true, true);
      render();
    }));
    $('#scroll').querySelectorAll('[data-lcadd]').forEach((el) => el.addEventListener('change', () => {
      const key = el.dataset.lcadd, code = el.value;
      if (!code) return;
      const form = key.slice(0, key.indexOf('|'));
      const other = reportLines.find((l) => l.form === form && l.form + '|' + l.line !== key && l.codes.includes(code));
      if (other && !confirm(`Код ${code} уже в рядку «${other.line}» форми ${form}: наявність рахувалася б в обох.\n\n`
        + 'Прив’язати й сюди?')) { el.value = ''; return; }
      lineCodesSet(key, (lineCodes.get(key) || []).concat([code]).sort());
    }));
    $('#scroll').querySelectorAll('[data-nmadd]').forEach((el) => el.addEventListener('change', () => {
      const [form, line] = String(el.dataset.nmadd).split('|');
      if (!el.value) return;
      normSet({ sub: el.value, form, line }, 1, state.asOf, true);   // «чинна з …», як обіцяє підпис
      save(true, true);
      render();
    }));
    $('#scroll').querySelectorAll('[data-snorm]').forEach((el) => el.addEventListener('change', () => {
      const [form, line, sub] = String(el.dataset.snorm).split('|');
      const v = parseFloat(String(el.value).replace(',', '.'));
      normSet({ sub, form, line }, v > 0 ? v : 0, state.asOf);
      save(true, true);
      render();
    }));
  }

  function bindPeople() {
    if (state.view !== 'people') return;
    const p = personBy(state.personId);
    $('#scroll').querySelectorAll('[data-pf]').forEach((el) => el.addEventListener('change', () => {
      if (!p) return;
      let v = el.value.trim();
      if (el.dataset.pf === 'surname') v = v.toUpperCase();
      p[el.dataset.pf] = v;
      save();
      render();
    }));
    $('#scroll').querySelectorAll('[data-ph]').forEach((el) => el.addEventListener('change', () => {
      const h = p && p.hist[+el.dataset.ph];
      if (!h) return;
      h[el.dataset.k] = el.value.trim();
      save();
      render();
    }));
    $('#scroll').querySelectorAll('[data-as]').forEach((el) => el.addEventListener('change', () => {
      state.assign = Object.assign(state.assign || {}, { [el.dataset.as]: el.value });
      if (el.dataset.as === 'from') render();
    }));
    $('#scroll').querySelectorAll('[data-uf]').forEach((el) => el.addEventListener('change', () => {
      store.unit = Object.assign({}, store.unit, { [el.dataset.uf]: el.value.trim() });
      save();
      render();
    }));
    $('#scroll').querySelectorAll('[data-loc]').forEach((el) => el.addEventListener('change', () => {
      const r = (store.locations || []).find((x) => x.id === el.dataset.loc);
      if (!r) return;
      r[el.dataset.k] = el.value.trim();
      save();
      render();
    }));
  }

  // ============================================================ ВКЛАДЕННЯ
  /** Файли до чого завгодно: скани документів, фото шильдика кухні, наказ
   *  про інвентаризацію. Ключ — до чого підшито:
   *    ключ документа — документ, «recon|id» — відомість звірки, «item|код» —
   *    позиція номенклатури, «unit|код|зав.№» — окрема одиниця, «st|id» —
   *    інвентаризація. Файл лежить у «Дані обліку/скани», у стані — посилання. */
  const IMG_EXT = /\.(jpe?g|png|gif|bmp|webp)$/i;
  const PDF_EXT = /\.pdf$/i;
  /** Теки служби, куди програма кладе файли закупівель (ключі — ті самі, що в `FOLDERS` сервера), і як їх називають. */
  const SERVICE_FOLDERS = { purchases: 'Закупівлі', receipts: 'Прибутково-видаткові документи', fesRegisters: 'Реєстри на ФЕС' };
  /** Посилання на файл: у «Дані обліку/скани» або (з ключем теки) в одній із тек служби — `теки/<ключ>/<шлях>`. */
  const fileUrl = (path, folder = '') => (folder ? 'теки/' + encodeURIComponent(folder) + '/' : 'скани/')
    + String(path).split('/').map(encodeURIComponent).join('/');
  const fmtSize = (n) => (!n ? '' : n < 1024 ? n + ' Б' : n < 1048576 ? Math.round(n / 1024) + ' КБ'
    : (n / 1048576).toFixed(1).replace('.', ',') + ' МБ');
  const fileIcon = (path) => (PDF_EXT.test(path) ? 'PDF' : /\.(docx?|odt|rtf)$/i.test(path) ? 'DOC'
    : /\.(xlsx?|ods|csv)$/i.test(path) ? 'XLS' : /\.(zip|rar|7z)$/i.test(path) ? 'ZIP'
      : /\.(p7s|asice|asics|sig)$/i.test(path) ? 'КЕП' : IMG_EXT.test(path) ? 'IMG' : 'ФАЙЛ');
  /** Файли за ключем. Документ — «вид|дата|номер|від|кому»: скани з бази за
   *  записом документа, підшиті тут — за цим ключем, давні, підшиті до
   *  «дата|номер», — на кожному документі з цими датою й номером. */
  const filesOf = (key) => {
    // Рапорт із бази — за записом документа: скани, підшиті в базі.
    const rp = /^dz\|(\d+)$/.exec(key);
    if (rp) {
      return (docScans.get(+rp[1]) || []).concat((store.scans || []).filter((x) => x.key === key)
        .map((x) => ({ file: x.file, path: x.path, mime: x.mime, size: x.size, mine: true, added: x.added, folder: x.folder || '',
          made: !!x.made, sha: x.sha || '' })));
    }
    const m = DOC_FILE_KEY.exec(key);
    const legacy = m ? m[2] + '|' + m[3] : null;
    const base = m ? idsOfDoc(key).flatMap((id) => docScans.get(id) || []).concat(scans.get(legacy) || [])
      : (scans.get(key) || []);
    return base.concat((store.scans || []).filter((x) => x.key === key || (legacy && x.key === legacy))
      .map((x) => ({ file: x.file, path: x.path, mime: x.mime, size: x.size, mine: true, added: x.added, folder: x.folder || '',
        made: !!x.made, sha: x.sha || '' })));
  };

  /** Куди й під яким ім'ям покласти файл, підшитий до ключа. */
  function fileTarget(key) {
    const [kind, a, b] = String(key).split('|');
    if (kind === 'recon') {
      const r = reconById(a);
      return r ? { key, date: r.date, no: r.no || '', label: `відомість${r.no ? ' №' + r.no : ''} ${r.sub}` } : null;
    }
    if (kind === 'item') return { key, date: today(), no: '', label: a, folder: `майно/${a}` };
    if (kind === 'unit') return { key, date: today(), no: '', label: `${a} зав.№${b}`, folder: `майно/${a}` };
    if (kind === 'paper') {
      const p = paperById(a);
      return p ? { key, date: p.date || today(), no: p.no || '', label: PAPER[p.kind].one, folder: p.kind === 'valuation' ? 'відомості залишкової вартості' : 'акти ЯТС' } : null;
    }
    if (kind === 'st') {
      const inv = invById(a);
      return inv ? { key, date: today(), no: '', label: `інвентаризація ${inv.date}`,
        folder: `інвентаризації/${inv.date}` } : null;
    }
    if (kind === 'dz') {
      const r = allDestroyed().find((x) => reportKey(x) === key);
      return r ? { key, date: r.reportDate || r.date, no: r.report || '', label: `рапорт ${r.sub}`, folder: 'рапорти' } : null;
    }
    // Папери закупівель лягають у теки служби (Закупівлі, Прибутково-видаткові документи) під іменами служби.
    if (kind === 'bud' || kind === 'purver' || kind === 'purdoc') {
      const w = purFolderFor(key);
      return w ? Object.assign({ key, date: today(), no: '' }, { folderKey: w.folder, folder: w.dir, name: w.name }) : null;
    }
    // Документ: «вид|дата|номер|від|кому».
    return DOC_FILE_KEY.test(key) ? { key, date: a, no: b } : null;
  }

  /** Картка «Файли»: мініатюри фото, значки решти, клац — перегляд. */
  function filesCard(key, title, hint) {
    const list = filesOf(key);
    const items = list.map((f, i) => `<div class="file" data-vw="${i}" data-vw-key="${esc(key)}" title="${esc(f.file)}${f.note ? '&#10;' + esc(f.note) : ''}">
        ${native && IMG_EXT.test(f.path) ? `<img class="file__thumb" src="${fileUrl(f.path, f.folder)}?w=320" loading="lazy" alt="">`
          : `<span class="file__ico">${fileIcon(f.path)}</span>`}
        <span class="file__name">${esc(f.file)}</span>
        <span class="file__meta">${esc([f.kind, fmtSize(f.size), f.added ? fmtDate(f.added) : ''].filter(Boolean).join(' · '))}</span>
        ${f.mine ? `<button type="button" class="ico-btn ico-btn--bad file__del" data-act="scan-del" data-path="${esc(f.path)}"
          data-folder="${esc(f.folder || '')}" title="Відв’язати файл">✕</button>` : ''}
      </div>`).join('');
    return `<div class="card files" style="margin-bottom:12px">
      <div class="card__head"><div class="card__title">${esc(title)}</div><div class="panel__spacer"></div>
        <span class="panel__count">${list.length ? cnt(list.length, 'файл', 'файли', 'файлів') : esc(hint || '')}</span>
        ${native ? `<button class="btn" data-act="file-add" data-key="${esc(key)}">+ Додати файл</button>` : ''}</div>
      ${list.length ? `<div class="files__grid">${items}</div>`
        : `<div class="files__empty">${native ? 'Перетягніть сюди скан, фото чи документ або натисніть «+ Додати файл».'
          : 'Файли додаються в програмі на комп’ютері.'}</div>`}
    </div>`;
  }

  /** Перегляд файла поверх екрана: фото й PDF — тут же, решта — у своїй програмі. */
  function openViewer(key, idx) {
    if (!native) { toast('Файли переглядаються в програмі на комп’ютері.', true); return; }
    state.viewer = { key, idx: +idx || 0 };
    viewerRender();
  }
  function viewerClose() { state.viewer = null; viewerRender(); }
  function viewerRender() {
    let el = $('#viewer');
    const v = state.viewer;
    const list = v ? filesOf(v.key) : [];
    if (!v || !list.length) { if (el) el.remove(); state.viewer = null; return; }
    v.idx = Math.max(0, Math.min(v.idx, list.length - 1));
    const f = list[v.idx];
    const url = fileUrl(f.path, f.folder);
    if (!el) {
      el = document.createElement('div');
      el.id = 'viewer';
      el.className = 'viewer';
      el.addEventListener('click', (e) => {
        const b = e.target.closest('[data-vw-do]');
        if (e.target === el) return viewerClose();
        if (!b) return;
        const what = b.dataset.vwDo;
        if (what === 'close') viewerClose();
        else if (what === 'prev' || what === 'next') { state.viewer.idx += what === 'next' ? 1 : -1; viewerRender(); }
        else if (what === 'open' || what === 'reveal') fileOpen(filesOf(state.viewer.key)[state.viewer.idx], what === 'reveal');
      });
      document.body.appendChild(el);
    }
    const body = IMG_EXT.test(f.path) ? `<img src="${url}" alt="${esc(f.file)}">`
      : PDF_EXT.test(f.path) ? `<iframe src="${url}" title="${esc(f.file)}"></iframe>`
        : `<div class="viewer__none"><div class="file__ico file__ico--big">${fileIcon(f.path)}</div>
            <p>«${esc(f.file)}»${f.size ? ' · ' + fmtSize(f.size) : ''}</p>
            <p>Цей файл відкривається окремою програмою.</p>
            <button class="btn btn--primary" data-vw-do="open">Відкрити</button></div>`;
    el.innerHTML = `<div class="viewer__box">
      <div class="viewer__bar">
        <b class="viewer__name" title="${esc(f.file)}">${esc(f.file)}</b>
        <span class="viewer__count">${list.length > 1 ? `${v.idx + 1} із ${list.length}` : ''}</span>
        ${list.length > 1 ? '<button class="btn btn--sm" data-vw-do="prev" title="Попередній файл (←)">◀</button>'
          + '<button class="btn btn--sm" data-vw-do="next" title="Наступний файл (→)">▶</button>' : ''}
        <button class="btn btn--sm" data-vw-do="open" title="Відкрити програмою Windows">Відкрити окремо</button>
        ${me.remote ? '' : '<button class="btn btn--sm" data-vw-do="reveal">Показати в теці</button>'}
        <button class="btn btn--sm" data-vw-do="close" title="Закрити (Esc)">✕</button>
      </div>
      <div class="viewer__body">${body}</div></div>`;
  }
  async function fileOpen(f, reveal = false) {
    if (!f) return;
    // З іншого ПК файл відкриває браузер: програми Windows основного ПК тут ні до чого.
    if (me.remote) { window.open(fileUrl(f.path, f.folder), '_blank'); return; }
    try {
      const r = await fetch(reveal ? 'api/reveal' : 'api/open', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ path: f.path, folder: f.folder || '' }) });
      if (!r.ok) throw new Error((await r.text()) || `помилка ${r.status}`);
    } catch (e) {
      toast(`Не вдалося відкрити «${f.file}»: ${e.message || e}`, true);
    }
  }
