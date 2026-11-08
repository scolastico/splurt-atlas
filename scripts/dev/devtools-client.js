// The development tools panel, injected into the page by the Vite plugin.
// It polls /__atlas_dev/status, shows whether the published map data is
// current, starts background regenerations, edits the map selection, lists
// snapshots and shows live viewer statistics. Plain DOM in a shadow root, so
// it never collides with the viewer's styles.
(() => {
  const STATUS_URL = document.currentScript?.dataset.status || '/__atlas_dev/status';
  const API = '/__atlas_dev';
  const POLL_MS = 1000;
  const STORAGE_KEY = 'atlas-devtools';

  const STYLES = `
:host { all: initial; font: 13px/1.45 system-ui, sans-serif; color: #e3eef7; }
* { box-sizing: border-box; }
button { font: inherit; color: inherit; cursor: pointer; }
.launcher { position: fixed; bottom: 12px; left: 50%; transform: translateX(-50%); z-index: 2147483000; display: flex; align-items: center; gap: 7px;
  padding: 5px 11px 5px 9px; border-radius: 999px; border: 1px solid #3b4a58; background: #121c27f2; backdrop-filter: blur(6px);
  letter-spacing: .08em; font-size: 11px; font-weight: 600; text-transform: uppercase; box-shadow: 0 4px 14px #0006; }
.launcher:hover { border-color: #7ddfc6; }
.launcher.attention { border-color: #e6c85a; box-shadow: 0 0 0 1px #e6c85a66, 0 4px 14px #0006; }
.launcher.attention .badge { background: #e6c85a; color: #1a1400; }
.launcher.error .badge { background: #ff6f78; color: #2a0b0e; }
.launcher.published .badge { background: #7ddfc6; color: #06211b; }
.dot { width: 9px; height: 9px; border-radius: 50%; background: #7a8a99; box-shadow: 0 0 0 2px #0004; }
.dot.fresh { background: #67d58f; } .dot.stale { background: #e6c85a; } .dot.running { background: #6fb6ff; animation: pulse 1.2s infinite; }
.dot.published { background: #7ddfc6; animation: pulse 1.2s infinite; } .dot.error { background: #ff6f78; } .dot.offline { background: #7a8a99; }
@keyframes pulse { 50% { opacity: .35; } }
.badge { border-radius: 999px; min-width: 16px; text-align: center; padding: 0 5px; font-size: 11px; font-weight: 700; line-height: 16px; }
.panel { position: fixed; top: 0; right: 0; bottom: 0; width: min(420px, 100vw); z-index: 2147483001; display: none; flex-direction: column;
  background: #0f1821; border-left: 1px solid #2d3a47; box-shadow: -8px 0 30px #0008; }
.panel.open { display: flex; }
header { display: flex; flex-shrink: 0; align-items: center; gap: 10px; padding: 12px 14px; border-bottom: 1px solid #243040; }
header h1 { font-size: 13px; margin: 0; letter-spacing: .1em; text-transform: uppercase; flex: 1; }
header .close { background: none; border: 0; font-size: 18px; color: #9fb0c0; padding: 2px 6px; }
nav { display: flex; flex-shrink: 0; border-bottom: 1px solid #243040; overflow-x: auto; }
nav button { flex: 1; background: none; border: 0; border-bottom: 2px solid transparent; padding: 9px 6px; color: #9fb0c0; font-size: 12px; white-space: nowrap; }
nav button[aria-selected="true"] { color: #e3eef7; border-bottom-color: #7ddfc6; }
section { flex: 1; min-height: 0; overflow: auto; padding: 14px; display: none; }
section.active { display: block; }
section[data-tab="progress"].active { display: flex; flex-direction: column; }
section[data-tab="progress"] > :not(.log) { flex-shrink: 0; }
h2 { font-size: 11px; letter-spacing: .1em; text-transform: uppercase; color: #7ddfc6; margin: 14px 0 6px; }
h2:first-child { margin-top: 0; }
dl { display: grid; grid-template-columns: auto 1fr; gap: 3px 12px; margin: 0; }
dt { color: #9fb0c0; } dd { margin: 0; word-break: break-all; }
.actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 10px 0; }
.btn { padding: 6px 11px; border-radius: 5px; border: 1px solid #3b4a58; background: #1a2733; }
.btn:hover { border-color: #7ddfc6; } .btn:disabled { opacity: .45; cursor: default; }
.btn.primary { background: #1f4a42; border-color: #2f7f6c; } .btn.danger { border-color: #7d3a40; }
.notice { padding: 9px 11px; border-radius: 6px; border: 1px solid #3b4a58; background: #15202b; margin: 8px 0; }
.notice.stale { border-color: #8a7a2c; } .notice.published { border-color: #2f7f6c; } .notice.error { border-color: #7d3a40; } .notice.running { border-color: #35628f; }
progress { width: 100%; height: 10px; accent-color: #7ddfc6; }
ul { margin: 6px 0; padding-left: 18px; } li { margin: 3px 0; }
.log { flex: 1 1 auto; min-height: 120px; font-family: ui-monospace, monospace; font-size: 11px; overflow: auto; background: #0b1218; border: 1px solid #243040; border-radius: 6px; padding: 6px 8px; }
.log div { white-space: pre-wrap; } .log time { color: #6f8191; margin-right: 6px; }
label.row { display: flex; align-items: center; gap: 8px; padding: 4px 0; }
label.row small { color: #6f8191; }
.muted { color: #9fb0c0; } code { font-family: ui-monospace, monospace; font-size: 12px; background: #1a2733; padding: 0 4px; border-radius: 3px; }
.snapshot { border: 1px solid #243040; border-radius: 6px; padding: 8px 10px; margin: 6px 0; }
.snapshot strong { font-family: ui-monospace, monospace; font-size: 11px; }
.tag { font-size: 10px; text-transform: uppercase; letter-spacing: .08em; border-radius: 3px; padding: 1px 5px; background: #1f4a42; color: #9fe3d1; margin-left: 6px; }
`;

  const html = (strings, ...values) =>
    strings.reduce((out, part, index) => out + part + (values[index] ?? ''), '');
  const escape = (value) =>
    String(value ?? '').replace(
      /[&<>"']/g,
      (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char],
    );
  const megabytes = (bytes) => `${(bytes / 1048576).toFixed(1)} MB`;
  const clock = (time) => new Date(time).toLocaleTimeString();
  const ago = (time) => {
    const seconds = Math.max(0, Math.round((Date.now() - time) / 1000));
    if (seconds < 60) return `${seconds}s ago`;
    if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
    return `${(seconds / 3600).toFixed(1)} h ago`;
  };

  async function api(route, body) {
    const response = await fetch(
      `${API}/${route}`,
      body === undefined
        ? undefined
        : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || `${route}: HTTP ${response.status}`);
    return data;
  }

  /** What the status dot summarizes. */
  function overall(status) {
    if (!status) return { kind: 'offline', text: 'Dev server unreachable' };
    if (!status.serving) return { kind: 'running', text: status.message || 'Preparing map data' };
    const job = status.generation?.job;
    if (job?.phase === 'running')
      return { kind: 'running', text: `Regenerating · ${Math.round(job.percent || 0)}%` };
    if (job?.phase === 'published' && !status.generation?.stale)
      return { kind: 'published', text: 'New map data ready, reload to use it' };
    if (job?.phase === 'error') return { kind: 'error', text: 'Generation failed' };
    if (status.external) return { kind: 'running', text: 'An export is running in another process' };
    if (status.generation?.stale) return { kind: 'stale', text: 'Map data is out of date' };
    if (status.upstream?.behind) return { kind: 'stale', text: 'Upstream has new commits' };
    return { kind: 'fresh', text: 'Map data is current' };
  }

  class DevTools {
    constructor() {
      this.host = document.createElement('div');
      this.host.id = 'atlas-devtools';
      const shadow = this.host.attachShadow({ mode: 'open' });
      shadow.innerHTML = html`<style>
          ${STYLES}
        </style>
        <button class="launcher" aria-expanded="false" title="Atlas dev tools">
          <span class="dot"></span>Dev<span class="badge" hidden></span>
        </button>
        <div class="panel" role="dialog" aria-label="Atlas dev tools">
          <header>
            <span class="dot"></span>
            <h1>Atlas dev tools</h1>
            <button class="close" aria-label="Close">×</button>
          </header>
          <nav role="tablist"></nav>
          <section data-tab="overview"></section>
          <section data-tab="changes"></section>
          <section data-tab="maps"></section>
          <section data-tab="progress"></section>
          <section data-tab="snapshots"></section>
          <section data-tab="viewer"></section>
        </div>`;
      this.shadow = shadow;
      this.tabs = [
        ['overview', 'Overview'],
        ['changes', 'Changes'],
        ['maps', 'Maps'],
        ['progress', 'Progress'],
        ['snapshots', 'Snapshots'],
        ['viewer', 'Viewer'],
      ];
      this.status = null;
      this.snapshots = null;
      this.mapDraft = null;
      this.settings = this.loadSettings();
      this.tab = this.settings.tab || 'overview';
      this.open = !!this.settings.open;
      this.renderChrome();
      document.body.append(this.host);
      this.poll();
    }

    loadSettings() {
      try {
        return JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
      } catch {
        return {};
      }
    }

    saveSettings(patch) {
      this.settings = { ...this.settings, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(this.settings));
      } catch {}
    }

    $(selector) {
      return this.shadow.querySelector(selector);
    }

    renderChrome() {
      const nav = this.$('nav');
      nav.innerHTML = this.tabs
        .map(([id, label]) => html`<button role="tab" data-tab="${id}">${label}</button>`)
        .join('');
      nav.onclick = (event) => {
        const button = event.target.closest('[data-tab]');
        if (button) this.showTab(button.dataset.tab);
      };
      this.$('.launcher').onclick = () => this.toggle(!this.open);
      this.$('.close').onclick = () => this.toggle(false);
      this.shadow.addEventListener('keydown', (event) => {
        if (event.key === 'Escape') this.toggle(false);
      });
      this.toggle(this.open);
      this.showTab(this.tab);
    }

    toggle(open) {
      this.open = open;
      this.$('.panel').classList.toggle('open', open);
      this.$('.launcher').setAttribute('aria-expanded', String(open));
      this.saveSettings({ open });
      if (open) this.render();
    }

    showTab(tab) {
      this.tab = tab;
      for (const button of this.shadow.querySelectorAll('nav [data-tab]'))
        button.setAttribute('aria-selected', String(button.dataset.tab === tab));
      for (const section of this.shadow.querySelectorAll('section'))
        section.classList.toggle('active', section.dataset.tab === tab);
      this.saveSettings({ tab });
      if (tab === 'snapshots') void this.loadSnapshots();
      this.render();
    }

    async poll() {
      try {
        const response = await fetch(STATUS_URL, { cache: 'no-store' });
        this.status = response.ok ? await response.json() : null;
      } catch {
        this.status = null;
      }
      this.render();
      setTimeout(() => this.poll(), POLL_MS);
    }

    async loadSnapshots() {
      try {
        this.snapshots = await api('snapshots');
      } catch {
        this.snapshots = [];
      }
      this.render();
    }

    render() {
      const summary = overall(this.status);
      for (const dot of this.shadow.querySelectorAll('.dot')) dot.className = `dot ${summary.kind}`;
      this.$('.launcher').title = summary.text;
      const badge = this.$('.badge');
      // The launcher itself signals attention while the panel is closed.
      const attention = { stale: '!', error: '!', published: '↻' }[summary.kind];
      const launcher = this.$('.launcher');
      launcher.className = `launcher ${attention ? 'attention' : ''} ${summary.kind}`;
      badge.hidden = !attention;
      badge.textContent = attention || '';
      badge.title = summary.text;
      if (!this.open) return;
      const renderers = {
        overview: this.renderOverview,
        changes: this.renderChanges,
        maps: this.renderMaps,
        progress: this.renderProgress,
        snapshots: this.renderSnapshots,
        viewer: this.renderViewer,
      };
      const section = this.$(`section[data-tab="${this.tab}"]`);
      const focused = this.shadow.activeElement;
      if (focused && section.contains(focused) && focused.matches('input, button')) return; // do not disturb interaction
      const oldLog = section.querySelector('.log');
      const logOffset = oldLog?.scrollTop || 0,
        oldHeight = oldLog?.scrollHeight || 0;
      section.innerHTML = renderers[this.tab].call(this);
      const newLog = section.querySelector('.log');
      if (newLog && logOffset > 0) newLog.scrollTop = logOffset + newLog.scrollHeight - oldHeight;
      this.bind(section);
    }

    bind(section) {
      for (const button of section.querySelectorAll('[data-action]'))
        button.onclick = async () => {
          button.disabled = true;
          try {
            await this.action(button.dataset.action, button.dataset);
          } catch (error) {
            alert(error.message);
          } finally {
            button.disabled = false;
            this.render();
          }
        };
      for (const input of section.querySelectorAll('[data-map]'))
        input.onchange = () => {
          const selected = new Set(
            this.mapDraft || this.status.maps.selected || this.status.maps.available.map((map) => map.id),
          );
          if (input.checked) selected.add(input.dataset.map);
          else selected.delete(input.dataset.map);
          this.mapDraft = [...selected];
          this.render();
        };
    }

    async action(name, data) {
      switch (name) {
        case 'generate':
          return api('generate', { full: false });
        case 'full':
          if (confirm('Rebuild every selected map from scratch? This ignores all cached results.'))
            return api('generate', { full: true });
          return;
        case 'cancel':
          return api('cancel', {});
        case 'reload':
          location.reload();
          return;
        case 'retry':
          return api('retry', {});
        case 'maps-save':
          await api('maps', { maps: this.mapDraft });
          this.mapDraft = null;
          return;
        case 'maps-preset': {
          const { available, defaults } = this.status.maps;
          if (data.preset === 'all') this.mapDraft = available.map((map) => map.id);
          else if (data.preset === 'none') this.mapDraft = [];
          else if (data.preset === 'defaults')
            this.mapDraft = defaults.filter((id) => available.some((map) => map.id === id));
          else if (data.preset === 'current') {
            const id = new URLSearchParams(location.hash.slice(1)).get('m');
            this.mapDraft = id ? [id] : [];
          }
          return;
        }
        case 'maps-discard':
          this.mapDraft = null;
          return;
        case 'snapshot-delete':
          if (confirm(`Delete snapshot ${data.id}? This cannot be undone.`)) {
            await api('snapshots/delete', { id: data.id });
            await this.loadSnapshots();
          }
          return;
        case 'upstream-check':
          return api('upstream/check', {});
        case 'upstream-pull':
          if (
            confirm(
              'Fetch the latest upstream commit into .source and check it out? Your local atlas data stays until you regenerate.',
            )
          )
            return api('upstream/pull', {});
          return;
        case 'copy-link':
          await navigator.clipboard.writeText(location.href);
          return;
        case 'clear-storage': {
          const dev = window.__atlasDev;
          if (dev?.clearStorage) await dev.clearStorage();
          else indexedDB.deleteDatabase('splurt-atlas-assets-v1');
          location.reload();
          return;
        }
      }
    }

    renderOverview() {
      const status = this.status;
      const summary = overall(status);
      if (!status)
        return html`<div class="notice error">
          The development server does not answer. Is <code>pnpm dev</code> still running?
        </div>`;
      const dataset = status.dataset;
      const job = status.generation?.job;
      const running = job?.phase === 'running';
      const stale = status.generation?.stale;
      let notice = '';
      if (!status.serving) notice = html`<div class="notice running">${escape(status.message)}</div>`;
      else if (running)
        notice = html`<div class="notice running">
          <strong>Regenerating in the background.</strong> The viewer keeps using the published data
          meanwhile.<br /><progress max="100" value="${Math.round(job.percent || 0)}"></progress>
          <div class="muted">${escape(job.message)}</div>
        </div>`;
      else if (job?.phase === 'published' && !stale)
        notice = html`<div class="notice published">
          <strong>New map data is ready.</strong> Reload the page to switch to the new snapshot.
        </div>`;
      else if (job?.phase === 'error')
        notice = html`<div class="notice error">
          <strong>The last generation failed.</strong><br />${escape(job.message)}
        </div>`;
      else if (stale)
        notice = html`<div class="notice stale">
          <strong>Regeneration recommended.</strong> ${stale.changes.length}
          change${stale.changes.length === 1 ? '' : 's'} detected since the data was generated; see the
          Changes tab.
        </div>`;
      else if (status.external)
        notice = html`<div class="notice running">
          <strong>An export is running in another process.</strong><br /><span class="muted"
            >${escape(status.external.message)}</span
          >
        </div>`;
      else notice = html`<div class="notice"><strong>Map data is current.</strong> Nothing to do.</div>`;
      const selection = status.maps.selected;
      return html`<h2>Status</h2>
        ${notice}
        <div class="actions">
          <button class="btn primary" data-action="generate" ${running || !status.serving ? 'disabled' : ''}>
            Regenerate
          </button>
          <button class="btn" data-action="full" ${running || !status.serving ? 'disabled' : ''}>
            Full rebuild
          </button>
          <button class="btn danger" data-action="cancel" ${running ? '' : 'disabled'}>Cancel</button>
          ${job?.phase === 'published'
            ? html`<button class="btn primary" data-action="reload">Reload page</button>`
            : ''}
          ${job?.phase === 'error' && !status.serving
            ? html`<button class="btn" data-action="retry">Retry preparation</button>`
            : ''}
        </div>
        <h2>Published data</h2>
        ${dataset
          ? html`<dl>
              <dt>Snapshot</dt>
              <dd><code>${escape(dataset.snapshot || 'public/data')}</code></dd>
              <dt>Upstream</dt>
              <dd><code>${escape((dataset.commit || '').slice(0, 12))}</code></dd>
              <dt>Generated</dt>
              <dd>
                ${dataset.generated
                  ? `${escape(clock(dataset.generated))} (${escape(ago(dataset.generated))})`
                  : 'unknown (not generated by this server)'}
              </dd>
              <dt>Maps</dt>
              <dd>${escape(dataset.maps.map((map) => map.name).join(', '))}</dd>
            </dl>`
          : html`<div class="muted">No catalog is published yet.</div>`}
        <h2>Upstream</h2>
        ${this.renderUpstream()}
        <h2>Next generation</h2>
        <dl>
          <dt>Maps</dt>
          <dd>
            ${selection === null ? 'all stations' : escape(selection.join(', ')) || 'none'}
            <span class="muted"
              >(${status.maps.saved
                ? 'saved in dev tools'
                : status.maps.environment !== null
                  ? 'from ATLAS_DEV_MAPS'
                  : 'default subset'})</span
            >
          </dd>
          <dt>Mode</dt>
          <dd>
            ${escape(status.generation?.mode || 'unknown')}: changes are reported here and regenerate only on
            request; a missing dataset is prepared automatically.
          </dd>
        </dl>
        <p class="muted">${escape(summary.text)}</p>`;
    }

    renderChanges() {
      const stale = this.status?.generation?.stale;
      if (!this.status) return html`<div class="muted">No status yet.</div>`;
      if (!stale)
        return html`<div class="notice">
          <strong>Nothing changed.</strong> The published data matches the generator files, the upstream
          checkout and the map selection.
        </div>`;
      const kinds = {
        file: 'Generator file',
        upstream: 'Upstream checkout',
        maps: 'Map selection',
        stamp: 'Provenance',
      };
      return html`<div class="notice stale">
          Detected ${escape(ago(stale.since))}. The published data was generated from different inputs;
          regenerate to apply them.
        </div>
        <ul>
          ${stale.changes
            .map(
              (change) =>
                html`<li>
                  <strong>${escape(kinds[change.kind] || change.kind)}:</strong> ${escape(change.detail)}
                </li>`,
            )
            .join('')}
        </ul>
        <div class="actions"><button class="btn primary" data-action="generate">Regenerate now</button></div>
        <p class="muted">Edits to the viewer itself never need a regeneration; Vite reloads them.</p>`;
    }

    renderMaps() {
      const maps = this.status?.maps;
      if (!maps) return html`<div class="muted">No status yet.</div>`;
      const selected = new Set(this.mapDraft || maps.selected || maps.available.map((map) => map.id));
      const dirty = this.mapDraft !== null;
      const rows = maps.available
        .map(
          (map) =>
            html`<label class="row"
              ><input type="checkbox" data-map="${escape(map.id)}" ${selected.has(map.id) ? 'checked' : ''} />
              ${escape(map.name)} <small>${escape(map.id)}</small></label
            >`,
        )
        .join('');
      return html`<p class="muted">
          Only the selected stations are converted locally. Saving marks the data stale; regenerate to apply
          the new selection.
          ${maps.available.length ? '' : 'The upstream checkout is missing, so no stations are listed yet.'}
        </p>
        <div class="actions">
          <button class="btn" data-action="maps-preset" data-preset="defaults">Default subset</button>
          <button class="btn" data-action="maps-preset" data-preset="all">All</button>
          <button class="btn" data-action="maps-preset" data-preset="current">Current map</button>
          <button class="btn" data-action="maps-preset" data-preset="none">None</button>
        </div>
        ${rows}
        <div class="actions">
          <button class="btn primary" data-action="maps-save" ${dirty ? '' : 'disabled'}>
            Save selection (${selected.size})
          </button>
          <button class="btn" data-action="maps-discard" ${dirty ? '' : 'disabled'}>Discard</button>
        </div>
        <p class="muted">
          Saved selections live in <code>.cache/dev-settings.json</code> and override
          <code>ATLAS_DEV_MAPS</code>.
        </p>
        ${this.renderOmitted()}`;
    }

    renderUpstream() {
      const upstream = this.status?.upstream;
      const busy = this.status?.generation?.job?.phase === 'running';
      if (!upstream) return html`<p class="muted">The upstream repository has not been checked yet.</p>`;
      const rows = html`<dl>
        <dt>Repository</dt>
        <dd>
          ${escape(upstream.repository || 'unknown')}${upstream.custom
            ? ' <span class="muted">(the checkout points elsewhere; it is left alone)</span>'
            : ''}
        </dd>
        <dt>Local</dt>
        <dd><code>${escape((upstream.local || '').slice(0, 12) || '-')}</code></dd>
        ${upstream.custom
          ? ''
          : html`<dt>Latest</dt>
              <dd>
                <code>${escape((upstream.remote || '').slice(0, 12) || '-')}</code>${upstream.branch
                  ? ` on ${escape(upstream.branch)}`
                  : ''}
              </dd>`}
        <dt>Checked</dt>
        <dd>${escape(ago(upstream.checked))}, repeats daily</dd>
      </dl>`;
      let note = '';
      if (upstream.error) note = html`<div class="notice error">${escape(upstream.error)}</div>`;
      else if (upstream.behind)
        note = html`<div class="notice stale">
          <strong>Upstream has new commits.</strong> Pulling moves the checkout to the latest default-branch
          commit; the data then counts as out of date and a regeneration converts the new maps.
        </div>`;
      return html`${note}${rows}
        <div class="actions">
          <button class="btn" data-action="upstream-check">Check now</button>
          <button
            class="btn primary"
            data-action="upstream-pull"
            ${upstream.behind && !upstream.custom && !busy ? '' : 'disabled'}
          >
            Pull latest
          </button>
        </div>`;
    }

    renderOmitted() {
      const omitted = this.status?.maps?.omitted || [];
      if (!omitted.length) return '';
      return html`<h2>Upstream maps not converted</h2>
        <p class="muted">These configurations exist in the checkout but the atlas does not convert them.</p>
        <ul>
          ${omitted
            .map(
              (map) =>
                html`<li>
                  <strong>${escape(map.name)}</strong> <span class="muted">${escape(map.id)}</span><br /><span
                    class="muted"
                    >${escape(map.hint)}</span
                  >
                </li>`,
            )
            .join('')}
        </ul>`;
    }

    renderProgress() {
      const generation = this.status?.generation;
      if (!generation) return html`<div class="muted">No status yet.</div>`;
      const job = generation.job;
      const header = job
        ? html`<div class="notice ${escape(job.phase)}">
            <strong
              >${escape(
                job.phase === 'running'
                  ? 'Running'
                  : job.phase === 'published'
                    ? 'Published'
                    : job.phase === 'error'
                      ? 'Failed'
                      : 'Cancelled',
              )}</strong
            >
            ${job.full ? '(full rebuild)' : ''} · started
            ${escape(clock(job.started))}${job.finished ? `, finished ${escape(clock(job.finished))}` : ''}<br />
            <progress max="100" value="${Math.round(job.percent || 0)}"></progress>
            <div>${escape(job.message)}</div>
          </div>`
        : html`<div class="notice">No generation has run since the server started.</div>`;
      const log = generation.log.length
        ? html`<div class="log">
            ${[...generation.log]
              .reverse()
              .map(
                (entry) => html`<div><time>${escape(clock(entry.time))}</time>${escape(entry.message)}</div>`,
              )
              .join('')}
          </div>`
        : html`<div class="muted">The log fills while a generation runs.</div>`;
      return html`${header}
        <h2>Log</h2>
        ${log}`;
    }

    renderSnapshots() {
      if (!this.snapshots) return html`<div class="muted">Loading snapshots…</div>`;
      if (!this.snapshots.length)
        return html`<div class="muted">No snapshots in <code>public/data/snapshots</code>.</div>`;
      const total = this.snapshots.reduce((sum, snapshot) => sum + snapshot.bytes, 0);
      const stale = this.snapshots.filter((snapshot) => !snapshot.current);
      return html`<p class="muted">
          ${this.snapshots.length} snapshots use ${escape(megabytes(total))}. Every regeneration publishes a
          new snapshot and old ones stay until deleted.
        </p>
        ${this.snapshots
          .map(
            (snapshot) =>
              html`<div class="snapshot">
                <strong>${escape(snapshot.id)}</strong>${snapshot.current
                  ? '<span class="tag">current</span>'
                  : ''}<br />
                <span class="muted"
                  >${escape(megabytes(snapshot.bytes))} · ${snapshot.maps.length} maps ·
                  ${escape(ago(snapshot.modified))}${snapshot.commit
                    ? ` · ${escape(snapshot.commit.slice(0, 8))}`
                    : ''}</span
                ><br />
                <span class="muted">${escape(snapshot.maps.join(', '))}</span>
                ${snapshot.current
                  ? ''
                  : html`<div class="actions">
                      <button
                        class="btn danger"
                        data-action="snapshot-delete"
                        data-id="${escape(snapshot.id)}"
                      >
                        Delete
                      </button>
                    </div>`}
              </div>`,
          )
          .join('')}
        ${stale.length
          ? html`<p class="muted">
              ${stale.length} snapshot${stale.length === 1 ? '' : 's'} could be deleted to free
              ${escape(megabytes(stale.reduce((sum, snapshot) => sum + snapshot.bytes, 0)))}.
            </p>`
          : ''}`;
    }

    renderViewer() {
      const dev = window.__atlasDev;
      const snapshot = dev?.snapshot?.();
      const stats = snapshot
        ? html`<dl>
            <dt>Map</dt>
            <dd>${escape(snapshot.map || 'none')}${snapshot.ready ? '' : ' (loading)'}</dd>
            <dt>Deck</dt>
            <dd>${escape(snapshot.z)}</dd>
            <dt>Camera</dt>
            <dd>
              ${escape(Math.round(snapshot.x))}, ${escape(Math.round(snapshot.y))} px · zoom
              ${escape(snapshot.zoom.toFixed(3))} · detail ${escape(snapshot.detail)}
            </dd>
            <dt>Tile under center</dt>
            <dd>
              ${escape(snapshot.centerTile ? `${snapshot.centerTile.x}, ${snapshot.centerTile.y}` : '-')}
            </dd>
            <dt>Selected</dt>
            <dd>
              ${escape(
                snapshot.selected
                  ? `${snapshot.selected.x}, ${snapshot.selected.y}, Z${snapshot.selected.z}`
                  : 'none',
              )}
            </dd>
            <dt>Textures</dt>
            <dd>
              ${escape(snapshot.images.ready)} ready (${escape(megabytes(snapshot.images.bytes))}),
              ${escape(snapshot.images.pending)} loading, ${escape(snapshot.images.failed)} failed
            </dd>
            <dt>Frame</dt>
            <dd>
              last ${escape(snapshot.frame.last.toFixed(2))} ms · average
              ${escape(snapshot.frame.average.toFixed(2))} ms over ${escape(snapshot.frame.count)} frames
            </dd>
            <dt>Canvas</dt>
            <dd>
              ${escape(snapshot.width)} × ${escape(snapshot.height)} CSS px @ ${escape(snapshot.dpr)}x ·
              ${escape(snapshot.renderer)}
            </dd>
            <dt>Offline storage</dt>
            <dd>${escape(snapshot.storageMode || 'not chosen')}</dd>
          </dl>`
        : html`<div class="muted">The viewer has not exposed its debug hook yet.</div>`;
      return html`<h2>Live viewer state</h2>
        ${stats}
        <h2>Actions</h2>
        <div class="actions">
          <button class="btn" data-action="copy-link">Copy current link</button>
          <button class="btn danger" data-action="clear-storage">Clear offline storage &amp; reload</button>
        </div>
        <p class="muted">
          Clearing removes the IndexedDB map cache and the saved storage choice on this device.
        </p>`;
    }
  }

  new DevTools();
})();
