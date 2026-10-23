// Облік ТЗ ПС · сторінка · книги «Облік СП» і «Облік РП»: панель книги, вивантаження, прийом, перенесення.
// Модулі сторінки — класичні скрипти зі спільними іменами; порядок завантаження — index.html.
'use strict';

  // ------------------------------------------------------------- книги СП і РП
  /** Запасний шлях книг СП і РП — як у книги ОП: вивантажити «Облік СП.xlsx», прийняти книгу, яку вели
   *  руками, і — поки книга в програмі порожня — перенести стару книгу з таблицею місць. Вікно прийому книги СП
   *  називає й акти сухпаю. Книга ОП має свої функції (opBookPanel, opImport…): її вікно прийому несе ще й акти
   *  списання. */
  function bookPanel(book) {
    const b = BOOKS[book];
    const last = ((D.meta || {}).bookExport || {})[book] || '';
    const empty = !docs.some((r) => bookOf(r.code) === book);
    return `<div class="panel">
        <div class="panel__note">Книга «${esc(b.file)}»: ${last ? `вивантажено ${fmtDate(last)}` : 'ще не вивантажували'}${
          b.unofficial ? ' · неофіційний облік' : ''}</div>
        <div class="panel__spacer"></div>
        ${native ? `<button class="btn" data-act="book-export" data-book="${book}">Вивантажити книгу</button>
        <button class="btn" data-act="book-import" data-book="${book}">Прийняти книгу…</button>${empty
          ? `<button class="btn" data-act="book-legacy" data-book="${book}">Перенести стару книгу…</button>` : ''}` : ''}
      </div>`;
  }
  const bookLegacyBtn = (book) => (native
    ? `<button class="btn" data-act="book-legacy" data-book="${book}">Перенести стару книгу…</button>` : '');
  /** Порожня книга СП чи РП — не те саме, що фільтри, які нічого не лишили: веде до першого запису. */
  function bookEmptyItems(book) {
    const b = BOOKS[book];
    return emptyBlock('◌', b.items, `Заведіть позицію або перенесіть стару книгу «${b.file}».`,
      '<button class="btn btn--primary" data-act="item-new">+ Нова позиція</button>' + bookLegacyBtn(book));
  }
  function bookEmptyDocs(book) {
    const b = BOOKS[book];
    return emptyBlock('⇆', b.docs, `Внесіть прихід або перенесіть стару книгу «${b.file}».`,
      (formOpen() ? '' : '<button class="btn btn--primary" data-act="doc-new">+ Новий документ</button>') + bookLegacyBtn(book));
  }
  function bookEmptyJournal(view, book) {
    const b = BOOKS[book];
    return {
      head: head(`${b.crumb} / книги обліку`, view === 'j14' ? 'Книга обліку підрозділу' : 'Книга обліку наявності та руху',
        journalSeg(view)),
      body: bookPanel(book) + emptyBlock('▦', `У книзі ${book} ще немає записів`,
        `Внесіть прихід у «Документи» розділу «${b.label}», прийміть книгу «${b.file}» або перенесіть стару книгу.`),
    };
  }

  async function bookExport(book) {
    try {
      await flush();
      const r = await fetch(`api/book/${BOOKS[book].slug}/export`, { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const j = await r.json();
      if (r.status === 409) {
        modalOpen('Книгу не вивантажено', `<div class="pad"><p>${esc(j.error)}</p>${listHtml(j.rows)}</div>`, 'modal__box--form');
        return;
      }
      if (!j.ok) throw new Error(j.error || `помилка ${r.status}`);
      if (j.download) {
        const a = document.createElement('a');
        a.href = j.download; a.download = '';
        document.body.appendChild(a); a.click(); a.remove();
      }
      // Книга лягла, але назад читається не вся (скажімо, дата з опискою в році): книга на місці, а що в ній не так — рядком на
      // кожну причину, щоб виправити до того, як нею вести облік руками.
      const back = Array.isArray(j.readBack) ? j.readBack.filter(Boolean) : [];
      if (back.length) {
        modalOpen('Книгу вивантажено', `<div class="pad"><p>${esc(`Книгу вивантажено: ${j.path}.`)} Назад вона читається не вся:</p>
          ${listHtml(back)}</div>`, 'modal__box--form');
        return;
      }
      toast(`Книгу вивантажено: ${j.path}`);
    } catch (e) { toast(`Не вдалося вивантажити книгу: ${e.message || e}`, true); }
  }

  /** Книга, яку переглядають: «Прийняти» на базі, що змінилась після перегляду (409), переглядає той самий файл наново. */
  let bookFile = null;
  /** Перегляд книги проти програми. Для старої книги — ще поправки й таблиця місць: місце, яке програма
   *  впізнала (батальйон → його «· ВМТЗ»), уже вибране; решту людина зіставляє сама, «як є» — місце
   *  з тією самою назвою в «Підрозділах». */
  async function bookImport(file, book, legacy) {
    const b = BOOKS[book];
    bookFile = { file, book, legacy };
    let j;
    try {
      await flush();
      const r = await fetch(`api/book/${b.slug}/preview` + (legacy ? '?legacy=1' : ''), { method: 'POST', body: file });
      j = await r.json();
    } catch (e) { toast(`Книгу не прочитано: ${e.message || e}`, true); return; }
    if (!j.ok) {
      modalOpen('Книга не приймається', `<div class="pad">${listHtml(j.problems || [j.error])}</div>`, 'modal__box--form');
      return;
    }
    const d = j.diff;
    const acts = d.acts || {};                                           // книга РП і старі відповіді — без актів
    const part = (title, arr) => (arr && arr.length ? `<h4>${esc(title)} · ${arr.length}</h4>${listHtml(arr.slice(0, 50))}` : '');
    const places = (j.places || []).map((p) => {
      const want = (j.suggest || {})[p] || '';
      return `<div class="field"><label>${esc(p)}</label>
        <select data-book-place="${esc(p)}"><option value="">як є</option>${subs.filter((sb) => sb.active).map((sb) =>
          `<option${sb.name === want ? ' selected' : ''}>${esc(sb.name)}</option>`).join('')}</select></div>`;
    }).join('');
    modalOpen(legacy ? `Перенесення старої книги ${book}` : `Прийняти книгу ${book}`, `<div class="pad op-preview">
      ${d.same ? '<p>Книга збігається з програмою.</p>' : ''}
      ${part('Нові документи', d.docs.new)}${part('Змінені документи', d.docs.changed)}${part('Прибрані документи', d.docs.removed)}
      ${part('Нові позиції', d.items.new)}${part('Змінені позиції', d.items.changed)}${part('Прибрані позиції', d.items.removed)}
      ${part('Нові акти', acts.new)}${part('Змінені акти', acts.changed)}${part('Прибрані акти', acts.removed)}
      ${part('Нові місця', d.subs)}
      ${places ? `<h4>Місця старої книги → підрозділи програми</h4><div class="form__grid">${places}</div>` : ''}
      ${part(legacy ? 'Поправки' : 'Зауваження', j.report)}
      <div class="set-form__acts"><button class="btn btn--primary" data-act="book-apply" data-book="${book}"
        data-sha="${esc(j.sha)}" data-legacy="${legacy ? 1 : 0}">Прийняти</button></div></div>`, 'modal__box--form');
  }

  async function bookApply(sha, legacy, book) {
    const mapping = {};
    document.querySelectorAll('#modal [data-book-place]').forEach((el) => { if (el.value) mapping[el.dataset.bookPlace] = el.value; });
    if (!confirm(`Прийняти книгу? Книга ${book} у програмі стане такою, як у файлі${legacy ? ' (з поправками)' : ''}; `
      + 'перед цим програма збереже копію бази.')) return;
    await flush();
    let j = {};
    let status = 0;
    try {
      const r = await fetch(`api/book/${BOOKS[book].slug}/apply`, { method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha, legacy, mapping }) });
      status = r.status;
      j = await r.json().catch(() => ({}));
    } catch (e) { j = { problems: [String(e.message || e)] }; }
    if (status === 409 && j.diff && bookFile) {                          // облік книги змінився після перегляду: той самий файл — наново
      toast(j.error || `Облік ${book} змінився після перегляду.`, true);
      await bookImport(bookFile.file, bookFile.book, bookFile.legacy);
      return;
    }
    if (!j.ok) {
      modalOpen('Книгу не прийнято', `<div class="pad">${listHtml(j.problems || [j.error || `помилка ${status}`])}</div>`, 'modal__box--form');
      return;
    }
    sync.leaving = true;
    location.reload();
  }

  /** «1прод» рядків списання сухпаю — за днями з Добовки (сервер, найновіша «Добовка*.xlsx» теки «Добовка»);
   *  квартал, уписаний людиною, лишається. Сервер пише квартали в базу, тож вікно бере стан наново, як після
   *  прийому книги закупівель; внесене у вікні записується першим, а не вийшло — «1прод» не розраховується. */
  async function spQ1prod() {
    if (await flush() !== true) { toast('Внесене в цьому вікні ще не записано: «1прод» не розраховано.', true); return; }
    let j = {};
    try {
      const r = await fetch('api/sp/q1prod', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      j = await r.json().catch(() => ({}));
      if (!r.ok || !j.ok) throw new Error(j.error || `помилка ${r.status}`);
    } catch (e) { toast(`«1прод» не розраховано: ${e.message || e}`, true); return; }
    const note = `«1прод» розраховано. Змінено рядків: ${j.changed || 0}.`
      + (j.dobovka ? ` Добовка «${j.dobovka}».`
        : ' Добовки в теці немає: акти програми розподілено за їхніми днями рапорту, інші — за датою акта.')
      + (j.no_act ? ` Днів Добовки без акта: ${j.no_act}.` : '');
    syncFresh({ note });
    if (!sync.leaving) { sync.leaving = true; location.reload(); }          // сховища вікна нема: оновлюємось без слова
  }

  /** Дії книг СП і РП (`book-…`, книга — у data-book). */
  function bookAction(name, d) {
    const book = d.book;
    if (!BOOKS[book]) return null;
    switch (name) {
      case 'book-export': return bookExport(book);
      case 'book-import': return pickFile('.xlsx', (f) => bookImport(f, book, false));
      case 'book-legacy': return pickFile('.xlsx', (f) => bookImport(f, book, true));
      case 'book-apply': return bookApply(d.sha, d.legacy === '1', book);
      case 'book-q1prod': return spQ1prod();
      default: return null;
    }
  }
