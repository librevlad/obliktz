// Облік ТЗ ПС · сторінка · Описи 572.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ------------------------------------------------------------------ Описи 572
  /** «Звіти › Описи 572»: чернетки інвентаризаційних описів запасів з книг обліку (сухі пайки, тара, посуд, миючі
   *  засоби, серветки) за типовою формою № 572 рушієм iprod (api/opysy/…). Значення частини — конфіг JSON поряд з
   *  описами (наказ, комісія, місця, МВО, «станом на»): вписують на основному ПК й запам'ятовують; з іншого ПК поле
   *  вимкнено, а працює запам'ятований конфіг. «Перевірити» — хід без запису, «Скласти описи» — xlsx у теку конфігу (з
   *  іншого ПК файл ще й завантажується браузером); хід і підсумок — під карткою. Описи продуктів і води — випуск 2.0.0. */
  const OV = { st: null, loading: '', busy: false, done: null };

  async function ovPost(route, body) {
    const r = await fetch(`api/opysy/${route}`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}) });
    const text = await r.text();
    if (!r.ok) throw new Error(text);
    return JSON.parse(text);
  }

  const ovReq = () => (state.ovConfig ? { config: state.ovConfig } : {});

  async function ovLoad(key) {
    OV.loading = key;
    let got;
    try {
      got = await ovPost('state', JSON.parse(key));
    } catch (e) {
      got = { ok: false, why: String(e.message || e) };
    }
    if (OV.loading !== key) return;
    OV.loading = '';
    OV.st = Object.assign(got, { req: key });
    if (state.view === 'opysy') render();
  }

  async function ovRun(dry) {
    OV.busy = true;
    OV.done = null;
    render();
    let got;
    try {
      got = await ovPost('run', Object.assign(ovReq(), { dry }));
    } catch (e) {
      got = { ok: false, why: String(e.message || e) };
    }
    OV.busy = false;
    OV.done = got;
    if (got.ok && got.download) {                        // з іншого ПК файл лежить на основному, а браузер забирає його собі
      const a = document.createElement('a');
      a.href = got.download; a.download = '';
      document.body.appendChild(a); a.click(); a.remove();
    }
    if (got.ok) toast(got.summary);
    else toast(got.stop || got.why, true);
    OV.st = null;                                        // «файл є» — перечитати
    render();
  }

  async function ovOpen() {
    try {
      const got = await ovPost('open', ovReq());
      if (!got.ok) toast(got.why, true);
    } catch (e) {
      toast(String(e.message || e), true);
    }
  }

  function ovLog() {
    const v = OV.done;
    if (!v) return '';
    return `<div class="ov-log"><p class="set-note"><b>${esc(v.ok || v.out ? v.summary : 'Не складено')}</b></p>${
      v.ok ? '' : `<div class="callout callout--bad">${esc(v.stop || v.why || '')}</div>`}${
      (v.log || []).map((x) => `<div class="ov-log__line">${esc(x)}</div>`).join('')}</div>`;
  }

  function renderOpysy() {
    const top = head('звіти / описи 572', 'Описи 572');
    if (!native) return { head: top, body: '<div class="pad">Описи складаються в програмі на комп’ютері.</div>' };
    const key = JSON.stringify(ovReq());
    const st = OV.st && OV.st.req === key ? OV.st : null;
    if (!st && OV.loading !== key) setTimeout(() => ovLoad(key), 0);
    const ready = !!(st && st.ok && !st.why);
    const books = st && st.books ? ` · книги: ${st.books.map((b) => `${b.file} (${b.program ? 'з програми' : 'файлом'})`).join(', ')}` : '';
    const note = !st ? '<p class="set-note">Читаю конфіг…</p>'
      : !st.ok ? `<p class="set-note num-bad">${esc(st.why || 'Не прочитано.')}</p>`
        : st.why ? `<p class="set-note num-warn">${esc(me.remote && !st.config ? 'Конфіг описів вписують на основному ПК' : st.why)}</p>`
          : `<p class="set-note">Станом на ${esc(st.stan_na)} · місця: ${esc(st.mista.join(', '))} · файл: ${esc(st.out)}${
            st.exists ? ' (є)' : ''}${esc(books)}</p>`;
    const acts = OV.busy ? '<span class="set-note">Складаю…</span>'
      : `<button type="button" class="btn" data-act="ov-open"${st && st.config && !me.remote ? '' : ' disabled'}
          title="${me.remote ? 'На основному ПК' : 'Тека конфігу'}">Відкрити теку</button>
        <button type="button" class="btn" data-act="ov-dry"${ready ? '' : ' disabled'} title="Хід без запису">Перевірити</button>
        <button type="button" class="btn btn--primary" data-act="ov-run"${ready ? '' : ' disabled'}>Скласти описи</button>`;
    return {
      head: top,
      body: `<div class="card" id="opysy-knyhy"><div class="card__head"><div class="card__title">Сухпай і посуд</div></div>
        <div class="set-form"><p class="set-note">З книг СП і ОП програми: місця зберігання, категорії й субрахунки, знищене й не проведене у ФЕС окремим рядком</p>
          <div class="field"><label>Конфіг описів</label><input data-ov="config" value="${esc(state.ovConfig || (st && st.config) || '')}"
            title="${me.remote ? 'Вписують на основному ПК' : 'JSON частини: наказ, комісія, місця, МВО'}"${me.remote ? ' disabled' : ''}></div>
          ${note}<div class="set-form__acts ov-acts">${acts}</div></div>${ovLog()}</div>`,
    };
  }

  /** Дії Описів 572 (`ov-…`). */
  function ovAction(name) {
    switch (name) {
      case 'ov-run': return ovRun(false);
      case 'ov-dry': return ovRun(true);
      case 'ov-open': return ovOpen();
      default: return null;
    }
  }
