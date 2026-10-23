// Облік ТЗ ПС · сторінка · забезпеченість сухпаєм.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ------------------------------------------------------------- забезпеченість сухпаєм
  /** Забезпеченість сухпаєм на дату: добові дачі по місцях (залишок × дободач; знищене списують актом) проти
   *  потреби «доби × особи на харчуванні». Осіб сервер бере з Добовки — «разом» пунктів харчування на дату чи
   *  найближчий раніший заповнений день; уписане людиною — важить. «У т.ч. ДПНП» — вітчизняні пайки (ДПНП, ДПНП-Р,
   *  ПНСП, ПНСП-Р; позиція без виду — за назвою). */
  const spSupplyKey = () => `${state.spDay || state.asOf}|${state.spPeople || ''}|${state.spDays || 3}`;

  async function spSupplyLoad() {
    const key = spSupplyKey();
    if (state.spLoading === key) return;
    state.spLoading = key;
    try {
      await flush();
      const [day, people, days] = key.split('|');
      const q = new URLSearchParams({ day, days });
      if (people) q.set('people', people);
      const r = await fetch(`api/sp/supply?${q}`);
      if (!r.ok) throw new Error(await r.text());
      state.spSupply = { key, data: await r.json() };
    } catch (e) {
      state.spSupply = { key, error: String(e.message || e) };
    } finally {
      state.spLoading = '';
      if (state.view === 'spsupply') renderKeepFocus();
    }
  }

  /** Звідки особи для підрахунку і що робити, коли їх звідти не взято: уписано, прочитано з Добовки, Добовки немає, файл не прочитано
   *  (`error` — причина від сервера), у файлі до цієї дати нічого не внесено. */
  function spPeopleNote(from, typed) {
    if (typed) return 'Осіб уписано.';
    if (from && from.day) return `Осіб — з Добовки «${from.file}» за ${fmtDate(from.day)}.`;
    if (from && from.error) return `Добовку не прочитано: ${from.error}. Уведіть кількість осіб.`;
    if (from) return `У Добовці «${from.file}» до цієї дати осіб немає: уведіть кількість осіб.`;
    return 'Добовки не знайдено: теку задають у «Налаштування» → «Теки» → «Добовка». Уведіть кількість осіб.';
  }

  /** Підпис рядка потреби: «Потреба: 1 доба × 100 осіб», «2 доби», «5 діб», «11 діб», «21 доба». */
  function spNeedLabel(days, people) {
    return `Потреба: ${cnt(days, 'доба', 'доби', 'діб')} × ${people} осіб`;
  }

  function renderSpSupply() {
    const key = spSupplyKey();
    const got = state.spSupply && state.spSupply.key === key ? state.spSupply : null;
    if (!got && state.spLoading !== key) setTimeout(spSupplyLoad, 0);
    const r = got && got.data;
    const top = head('сухпай / забезпеченість', 'Забезпеченість сухпаєм', `
      <label class="chip is-on"><span class="chip__label">на дату</span>
        <input type="date" data-sp="spDay" value="${esc(state.spDay || state.asOf)}"></label>
      <label class="chip${state.spPeople ? ' is-on' : ''}"><span class="chip__label">осіб</span>
        <input data-sp="spPeople" inputmode="numeric" style="width:80px" value="${esc(state.spPeople || '')}"
          placeholder="${esc(r && r.people ? String(r.people) : 'з Добовки')}"></label>
      <label class="chip is-on"><span class="chip__label">діб</span>
        <input data-sp="spDays" inputmode="numeric" style="width:44px" value="${esc(String(state.spDays || 3))}"></label>`);
    if (got && got.error) return { head: top, body: `<div class="pad">${esc(got.error)}</div>` };
    if (!r) return { head: top, body: '<div class="pad">Рахую забезпеченість…</div>' };
    const who = spPeopleNote(r.peopleFrom, state.spPeople);
    const row = (label, value, cls = '') => `<div class="tbl__row tbl__row--plain${cls}">
        <div class="c-name"><b>${esc(label)}</b></div><div class="c-num c-num--wide">${esc(value)}</div></div>`;
    const places = r.places.map((p) => row(p.name, fmtNum(p.dd))).join('');
    return {
      head: top,
      body: `<div class="panel"><div class="panel__note">${esc(who)}</div></div>
        <div class="card" style="margin-bottom:12px"><div class="card__head"><div class="card__title">Добові дачі по місцях</div></div>
          <div class="tbl">${places || row('Сухпаю на цю дату немає', '')}
            ${row('Разом', fmtNum(r.total, '0'), ' tbl__row--total')}
            ${row('у т.ч. ДПНП, комплектів', fmtNum(r.dpnp, '0'))}
            ${r.need ? row(spNeedLabel(r.days, r.people), fmtNum(r.need, '0'))
              + row(`Забезпеченість (ДПНП — ${fmtNum(r.pctDpnp, '0')} %)`, `${fmtNum(r.pct, '0')} %`, ' tbl__row--total') : ''}
          </div></div>`,
    };
  }
