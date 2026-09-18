/**
 * The dashboard page.
 *
 * One self-contained HTML document: no build step, no framework, no network
 * requests to anywhere but this server. That last part is enforced by the
 * Content-Security-Policy the server sends, so a dashboard listing every
 * project and server the user owns cannot phone anywhere.
 *
 * All values from the API are inserted with `textContent`, never `innerHTML`,
 * so a project named `<img onerror=...>` is displayed rather than executed.
 */
export function renderPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>StateNest</title>
<style>
  :root {
    color-scheme: light dark;
    --bg: #fbfbfa;
    --panel: #ffffff;
    --border: #e4e4e1;
    --text: #1a1a18;
    --muted: #71716c;
    --accent: #2f6f4f;
    --warn: #9a6512;
    --danger: #a33a2a;
    --radius: 10px;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg: #131312;
      --panel: #1c1c1a;
      --border: #2f2f2c;
      --text: #ececea;
      --muted: #9a9a94;
      --accent: #74b894;
      --warn: #d8a656;
      --danger: #e08070;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--text);
    font: 15px/1.55 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  header {
    border-bottom: 1px solid var(--border);
    padding: 18px 24px;
    display: flex;
    gap: 20px;
    align-items: center;
    flex-wrap: wrap;
    position: sticky;
    top: 0;
    background: var(--bg);
    z-index: 2;
  }
  h1 { font-size: 16px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  h1 span { color: var(--muted); font-weight: 400; }
  nav { display: flex; gap: 4px; flex-wrap: wrap; }
  nav button {
    font: inherit; font-size: 14px;
    background: none; border: 1px solid transparent; color: var(--muted);
    padding: 5px 11px; border-radius: 7px; cursor: pointer;
  }
  nav button:hover { color: var(--text); }
  nav button[aria-selected="true"] { color: var(--text); background: var(--panel); border-color: var(--border); }
  #search {
    margin-left: auto; font: inherit; font-size: 14px;
    padding: 6px 11px; min-width: 220px;
    border: 1px solid var(--border); border-radius: 7px;
    background: var(--panel); color: var(--text);
  }
  main { padding: 24px; max-width: 1180px; margin: 0 auto; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(128px, 1fr)); gap: 12px; margin-bottom: 26px; }
  .stat { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 14px 16px; }
  .stat b { display: block; font-size: 26px; font-weight: 600; letter-spacing: -0.02em; }
  .stat span { color: var(--muted); font-size: 13px; }
  .cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(320px, 1fr)); gap: 14px; }
  .card { background: var(--panel); border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; }
  .card h3 { margin: 0 0 3px; font-size: 15px; font-weight: 620; }
  .card .desc { color: var(--muted); font-size: 13.5px; margin-bottom: 11px; }
  .row { display: flex; gap: 8px; align-items: baseline; flex-wrap: wrap; font-size: 13px; }
  .tag {
    font-size: 11.5px; padding: 2px 7px; border-radius: 5px;
    border: 1px solid var(--border); color: var(--muted);
  }
  .tag.active { color: var(--accent); border-color: currentColor; }
  .tag.paused, .tag.waiting { color: var(--warn); border-color: currentColor; }
  .blocker { color: var(--danger); }
  .path { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 12.5px; color: var(--muted); word-break: break-all; }
  .muted { color: var(--muted); }
  ul { margin: 7px 0 0; padding-left: 18px; }
  li { margin: 2px 0; }
  .feed-day { font-size: 12px; letter-spacing: 0.07em; text-transform: uppercase; color: var(--muted); margin: 22px 0 9px; }
  .empty { color: var(--muted); padding: 40px 0; text-align: center; }
  table { width: 100%; border-collapse: collapse; font-size: 14px; }
  th { text-align: left; font-weight: 550; color: var(--muted); font-size: 12px; text-transform: uppercase; letter-spacing: 0.05em; padding: 0 12px 8px 0; }
  td { padding: 9px 12px 9px 0; border-top: 1px solid var(--border); vertical-align: top; }
  .note { margin-top: 30px; color: var(--muted); font-size: 12.5px; border-top: 1px solid var(--border); padding-top: 14px; }
  button.link { background: none; border: none; color: inherit; font: inherit; padding: 0; cursor: pointer; text-align: left; }
  button.link:hover h3 { text-decoration: underline; }
</style>
</head>
<body>
<header>
  <h1>StateNest <span id="profile"></span></h1>
  <nav id="tabs">
    <button data-view="overview" aria-selected="true">Overview</button>
    <button data-view="projects" aria-selected="false">Projects</button>
    <button data-view="recent" aria-selected="false">Recent</button>
    <button data-view="machines" aria-selected="false">Machines</button>
    <button data-view="remotes" aria-selected="false">Servers</button>
  </nav>
  <input id="search" type="search" placeholder="Search your history..." autocomplete="off">
</header>
<main id="main"><p class="empty">Loading...</p></main>

<script>
(() => {
  'use strict';
  const main = document.getElementById('main');
  const tabs = document.getElementById('tabs');
  const searchBox = document.getElementById('search');

  const get = (path) => fetch(path, { headers: { accept: 'application/json' } }).then((r) => r.json());

  /** Build an element. Text always goes through textContent. */
  function el(tag, opts = {}, children = []) {
    const node = document.createElement(tag);
    if (opts.class) node.className = opts.class;
    if (opts.text !== undefined) node.textContent = String(opts.text);
    if (opts.title) node.title = opts.title;
    if (opts.onClick) { node.addEventListener('click', opts.onClick); }
    for (const child of children) if (child) node.appendChild(child);
    return node;
  }

  function show(...nodes) {
    main.replaceChildren(...nodes.filter(Boolean));
  }

  function empty(message) {
    return el('p', { class: 'empty', text: message });
  }

  // ---- Overview -----------------------------------------------------------
  async function viewOverview() {
    const data = await get('/api/overview');
    document.getElementById('profile').textContent = '\\u00b7 ' + data.profile;

    const t = data.totals;
    const stats = el('div', { class: 'stats' }, [
      stat(t.projects, 'projects'),
      stat(t.by_status.active || 0, 'active'),
      stat(t.by_status.paused || 0, 'paused'),
      stat(t.stale, 'stale (30d+)'),
      stat(t.blocked, 'blocked'),
      stat(t.deployments, 'deployments'),
      stat(t.machines, 'machines'),
      stat(t.remotes, 'servers'),
    ]);

    const blocked = data.blocked.length
      ? el('div', {}, [
          el('div', { class: 'feed-day', text: 'Blocked' }),
          el('div', { class: 'cards' }, data.blocked.map((p) =>
            el('div', { class: 'card' }, [
              el('h3', { text: p.name }),
              el('ul', {}, p.blockers.map((b) => el('li', { class: 'blocker', text: b }))),
            ]))),
        ])
      : null;

    show(stats, blocked, footnote());
  }

  function stat(value, label) {
    return el('div', { class: 'stat' }, [el('b', { text: value }), el('span', { text: label })]);
  }

  // ---- Projects -----------------------------------------------------------
  async function viewProjects() {
    const { projects } = await get('/api/projects');
    if (!projects.length) return show(empty('No projects registered yet. Run: statenest scan ~/Projects'));

    show(el('div', { class: 'cards' }, projects.map(projectCard)), footnote());
  }

  function projectCard(p) {
    const here = p.locations.find((l) => l.is_current);
    return el('div', { class: 'card' }, [
      el('button', { class: 'link', onClick: () => openProject(p.id) }, [el('h3', { text: p.name })]),
      p.description ? el('div', { class: 'desc', text: p.description }) : null,
      el('div', { class: 'row' }, [
        el('span', { class: 'tag ' + p.status, text: p.status }),
        el('span', { class: 'muted', text: p.last_activity }),
        ...p.environments.map((e) => el('span', { class: 'tag', text: e })),
      ]),
      p.current_focus ? el('p', { class: 'muted', text: p.current_focus }) : null,
      here ? el('div', { class: 'path', text: here.path + (here.branch ? '  (' + here.branch + ')' : '') }) : null,
      p.blockers.length ? el('ul', {}, p.blockers.map((b) => el('li', { class: 'blocker', text: b }))) : null,
    ]);
  }

  async function openProject(id) {
    const d = await get('/api/project?id=' + encodeURIComponent(id));
    if (d.error) return show(empty(d.error));

    const section = (title, items) =>
      items && items.length
        ? el('div', {}, [el('div', { class: 'feed-day', text: title }), el('ul', {}, items.map((i) => el('li', { text: i })))])
        : null;

    show(
      el('button', { class: 'link muted', text: '\\u2190 all projects', onClick: () => render('projects') }),
      el('h2', { text: d.project.name }),
      d.project.description ? el('p', { class: 'desc', text: d.project.description }) : null,
      el('div', { class: 'row' }, [
        el('span', { class: 'tag ' + d.project.status, text: d.project.status }),
        el('span', { class: 'muted', text: d.last_activity }),
        d.project.repository ? el('span', { class: 'muted', text: d.project.repository.identity }) : null,
      ]),
      d.current_focus ? el('p', { text: d.current_focus }) : null,
      section('Recently completed', d.completed),
      section('Blockers', d.blockers),
      section('Next', d.next),
      d.decisions.length
        ? el('div', {}, [
            el('div', { class: 'feed-day', text: 'Decisions' }),
            el('ul', {}, d.decisions.map((x) =>
              el('li', {}, [el('span', { text: x.title }), el('span', { class: 'muted', text: '  ' + x.when })]))),
          ])
        : null,
      d.locations.length
        ? el('div', {}, [
            el('div', { class: 'feed-day', text: 'Where it lives' }),
            el('ul', {}, d.locations.map((l) =>
              el('li', {}, [
                el('span', { text: l.machine + (l.is_current ? ' (this machine)' : '') }),
                el('div', { class: 'path', text: l.path }),
              ]))),
          ])
        : null,
      d.deployments.length
        ? el('div', {}, [
            el('div', { class: 'feed-day', text: 'Deployed' }),
            el('ul', {}, d.deployments.map((x) =>
              el('li', { text: x.environment + ': ' + (x.ssh_alias || x.server || 'unknown') + (x.path ? ' ' + x.path : '') }))),
          ])
        : null,
      d.checkpoints.length
        ? el('div', {}, [
            el('div', { class: 'feed-day', text: 'Checkpoints' }),
            el('ul', {}, d.checkpoints.map((c) =>
              el('li', {}, [
                el('span', { class: 'muted', text: c.when + (c.branch ? '  ' + c.branch : '') }),
                el('div', { text: c.summary }),
              ]))),
          ])
        : null,
      footnote(),
    );
  }

  // ---- Recent -------------------------------------------------------------
  async function viewRecent() {
    const { entries } = await get('/api/recent');
    if (!entries.length) return show(empty('No recorded activity yet.'));

    const nodes = [];
    let lastWhen = null;
    for (const e of entries) {
      if (e.relative !== lastWhen) {
        nodes.push(el('div', { class: 'feed-day', text: e.relative }));
        lastWhen = e.relative;
      }
      nodes.push(el('div', { class: 'card' }, [
        el('button', { class: 'link', onClick: () => openProject(e.project_id) }, [el('h3', { text: e.project })]),
        el('p', { text: e.summary }),
        e.next[0] ? el('p', { class: 'muted', text: 'next: ' + e.next[0] }) : null,
        e.blockers[0] ? el('p', { class: 'blocker', text: 'blocked: ' + e.blockers[0] }) : null,
      ]));
    }
    show(el('div', {}, nodes), footnote());
  }

  // ---- Machines and servers ----------------------------------------------
  async function viewMachines() {
    const { machines } = await get('/api/machines');
    show(table(['Machine', 'OS', 'Type', 'Projects', 'Last seen'],
      machines.map((m) => [m.name + (m.is_current ? '  (this machine)' : ''), m.os, m.type, String(m.projects), m.last_seen])),
      footnote());
  }

  async function viewRemotes() {
    const { remotes } = await get('/api/remotes');
    if (!remotes.length) return show(empty('No servers registered. Run: statenest remote import-ssh'));
    show(table(['Server', 'Environment', 'Address', 'Provider', 'Projects'],
      remotes.map((r) => [r.name, r.environment, r.ssh_alias || r.host || '-', r.provider || '-', r.projects.join(', ') || '-'])),
      el('p', { class: 'note', text: 'Addresses only. StateNest stores no credentials and cannot connect anywhere.' }));
  }

  function table(headers, rows) {
    return el('table', {}, [
      el('thead', {}, [el('tr', {}, headers.map((h) => el('th', { text: h })))]),
      el('tbody', {}, rows.map((cells) => el('tr', {}, cells.map((c) => el('td', { text: c }))))),
    ]);
  }

  // ---- Search -------------------------------------------------------------
  async function runSearch(query) {
    const { results } = await get('/api/search?q=' + encodeURIComponent(query));
    if (!results.length) return show(empty('Nothing found for "' + query + '".'));
    show(table(['Where', 'Project', 'Match', 'When'],
      results.map((r) => [r.scope, r.project || '-', r.excerpt, r.when || '-'])), footnote());
  }

  function footnote() {
    return el('p', { class: 'note', text: 'Read-only view of ~/.statenest on this machine. Nothing here leaves your computer.' });
  }

  // ---- Wiring -------------------------------------------------------------
  const VIEWS = { overview: viewOverview, projects: viewProjects, recent: viewRecent, machines: viewMachines, remotes: viewRemotes };

  function render(view) {
    for (const button of tabs.querySelectorAll('button')) {
      button.setAttribute('aria-selected', String(button.dataset.view === view));
    }
    (VIEWS[view] || viewOverview)().catch((error) => show(empty(String(error))));
  }

  tabs.addEventListener('click', (event) => {
    const view = event.target.dataset && event.target.dataset.view;
    if (view) { searchBox.value = ''; render(view); }
  });

  let searchTimer;
  searchBox.addEventListener('input', () => {
    clearTimeout(searchTimer);
    const query = searchBox.value.trim();
    searchTimer = setTimeout(() => (query ? runSearch(query) : render('overview')), 180);
  });

  get('/api/overview').then((d) => { document.getElementById('profile').textContent = '\\u00b7 ' + d.profile; });
  render('overview');
})();
</script>
</body>
</html>`;
}
