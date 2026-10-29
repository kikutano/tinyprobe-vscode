// The run view: renders the NDJSON events of `tinyprobe run` / `tinyprobe call` (docs/protocol.md).
// Plain browser JavaScript with no VS Code API except the bootstrap at the end, so the same
// file can serve a browser UI. Every value from the run is set with textContent, never as HTML.
(function () {
  'use strict';

  function element(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function formatDuration(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1) return `${Math.round(ms * 1000)}µs`;
    if (ms < 1000) return `${Math.round(ms * 100) / 100}ms`;
    return `${Math.round(ms / 10) / 100}s`;
  }

  function formatBytes(bytes) {
    if (bytes < 1000) return `${bytes} B`;
    if (bytes < 1000000) return `${(bytes / 1000).toFixed(1)} kB`;
    return `${(bytes / 1000000).toFixed(1)} MB`;
  }

  /** A JSON body indented; anything else as it is. */
  function prettyBody(body) {
    if (body === null || body === undefined || body === '') return '';
    try {
      return JSON.stringify(JSON.parse(body), null, 2);
    } catch {
      return body;
    }
  }

  /** A `for_each` step reports each item as `Name [2/3]`: the step itself keeps the plain name. */
  function baseName(name) {
    return String(name ?? '').replace(/ \[\d+\/\d+\]$/, '');
  }

  /** What is selected: a step, or one item of a `for_each` step. */
  function key(index, iteration) {
    return iteration === null || iteration === undefined ? `${index}` : `${index}.${iteration}`;
  }

  function statusClass(code) {
    if (code === null || code === undefined) return 'status-none';
    if (code < 300) return 'status-ok';
    if (code < 400) return 'status-redirect';
    if (code < 500) return 'status-client';
    return 'status-server';
  }

  function createRunView(root) {
    let state;
    let selected = null;

    function reset(title, environment) {
      state = { title, environment, steps: [], started: false, finished: null, invalid: null, error: null, to: null };
      selected = null;
      render();
    }

    function step(index) {
      let found = state.steps.find(s => s.index === index);
      if (!found) {
        found = { index, name: `step ${index + 1}`, type: 'call', status: 'pending', attempt: 1, result: null };
        state.steps.push(found);
        state.steps.sort((a, b) => a.index - b.index);
      }
      return found;
    }

    function apply(event) {
      switch (event.event) {
        case 'run_started':
          state.started = true;
          // Run to here (`run --to`): the step to show when it completes, unless an earlier one failed.
          state.to = event.to ?? null;
          for (const s of event.steps) Object.assign(step(s.index), { name: s.name, type: s.type });
          break;
        case 'step_started': {
          // A step that starts ends the previous sleep, which has no step_completed.
          for (const s of state.steps) if (s.type === 'sleep' && s.status === 'running') s.status = 'passed';
          Object.assign(step(event.index), {
            name: event.iteration ? baseName(event.name) : event.name,
            type: event.type,
            status: 'running',
            attempt: event.attempt,
            iteration: event.iteration ?? null,
            total: event.iterations ?? null
          });
          break;
        }
        case 'step_completed': {
          const s = Object.assign(step(event.index), { status: event.success ? 'passed' : 'failed', result: event, iteration: null });
          const failedBefore = state.steps.some(x => x.index < s.index && x.status === 'failed');
          // A failed for_each step opens on its first failed item.
          const failedItem = (event.iterations ?? []).find(i => !i.success);
          if (selected === null || !event.success || state.steps.length === 1 || (s.index === state.to && !failedBefore)) {
            selected = key(s.index, failedItem?.iteration);
          }
          break;
        }
        case 'run_finished':
          state.finished = event;
          for (const s of state.steps) {
            if (s.status === 'running' && s.type === 'sleep') s.status = 'passed';
            else if (s.status === 'pending' || s.status === 'running') s.status = 'skipped';
          }
          break;
        case 'invalid':
          state.invalid = event;
          break;
      }
      render();
    }

    function error(message) {
      state.error = message;
      render();
    }

    // --- Rendering ---------------------------------------------------------

    function render() {
      root.replaceChildren(header(), body());
    }

    function header() {
      const node = element('header', 'header');
      const title = element('div', 'title');
      title.append(element('span', 'logo', '⚡'), element('span', 'name', state.title || 'tinyprobe'));
      node.append(title);

      const meta = element('div', 'meta');
      if (state.environment) meta.append(element('span', 'chip', `env ${state.environment}`));
      meta.append(outcome());
      node.append(meta);

      if (state.finished) {
        const s = state.finished.summary;
        const parts = [
          `${s.passed_steps}/${s.total_steps} steps passed`,
          s.failed_steps ? `${s.failed_steps} failed` : null,
          s.not_run_steps ? `${s.not_run_steps} not run` : null,
          `${s.checks_passed + s.checks_failed} checks`,
          `${s.http_requests} requests`,
          formatDuration(s.duration_ms)
        ].filter(Boolean);
        node.append(element('div', 'summary', parts.join(' · ')));
      }
      return node;
    }

    function outcome() {
      if (state.error) return element('span', 'badge badge-failed', 'ERROR');
      if (state.invalid) return element('span', 'badge badge-failed', 'INVALID');
      if (state.finished) {
        return state.finished.success
          ? element('span', 'badge badge-passed', 'PASSED')
          : element('span', 'badge badge-failed', 'FAILED');
      }
      return element('span', 'badge badge-running', state.started ? 'RUNNING' : 'STARTING');
    }

    function body() {
      if (state.error) return message('error', state.error);
      if (state.invalid) return problems(state.invalid.errors);
      if (state.steps.length === 0) return message('muted', 'Waiting for tinyprobe…');

      const node = element('main', 'layout');
      node.append(stepList(), details());
      return node;
    }

    function message(kind, text) {
      return element('pre', `message message-${kind}`, text);
    }

    function problems(errors) {
      const node = element('section', 'problems');
      node.append(element('h2', null, `The workflow is not valid (${errors.length} ${errors.length === 1 ? 'problem' : 'problems'})`));
      const list = element('ul');
      for (const e of errors) list.append(element('li', null, e.text));
      node.append(list);
      return node;
    }

    function stepList() {
      const list = element('ol', 'steps');
      for (const s of state.steps) {
        const items = Array.isArray(s.result?.iterations) ? s.result.iterations : null;
        const item = row(`step step-${s.status}`, key(s.index, null), s.result !== null);
        item.append(element('span', 'icon', { passed: '✓', failed: '✗', running: '●', skipped: '–', pending: '○' }[s.status]));
        item.append(element('span', 'step-name', runningName(s)));
        if (s.result && items) {
          const passed = items.filter(i => i.success).length;
          item.append(element('span', `code ${passed === items.length ? 'status-ok' : 'status-server'}`, `${passed}/${items.length}`));
          item.append(element('span', 'duration', formatDuration(items.reduce((sum, i) => sum + (i.duration_ms ?? 0), 0))));
        } else if (s.result) {
          item.append(element('span', `code ${statusClass(s.result.status)}`, s.result.status ?? '---'));
          item.append(element('span', 'duration', formatDuration(s.result.duration_ms)));
        }
        list.append(item);

        for (const i of items ?? []) {
          const sub = row(`step step-item step-${i.success ? 'passed' : 'failed'}`, key(s.index, i.iteration), true);
          sub.append(element('span', 'icon', i.success ? '✓' : '✗'));
          sub.append(element('span', 'step-name', `item ${i.iteration} of ${items.length}`));
          sub.append(element('span', `code ${statusClass(i.status)}`, i.status ?? '---'));
          sub.append(element('span', 'duration', formatDuration(i.duration_ms)));
          list.append(sub);
        }
      }
      return list;
    }

    function runningName(s) {
      if (s.status !== 'running') return s.name;
      if (s.total) return `${s.name} (item ${s.iteration} of ${s.total})`;
      return s.attempt > 1 ? `${s.name} (attempt ${s.attempt})` : s.name;
    }

    /** A row of the step list; one with a result can be selected with a click or the keyboard. */
    function row(className, id, selectable) {
      const item = element('li', `${className}${id === selected ? ' selected' : ''}`);
      item.tabIndex = 0;
      if (selectable) {
        const choose = () => { selected = id; render(); };
        item.addEventListener('click', choose);
        item.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });
      }
      return item;
    }

    function details() {
      const node = element('section', 'details');
      const [index, iteration] = String(selected).split('.').map(Number);
      const s = state.steps.find(x => x.index === index);
      if (!s || !s.result) {
        node.append(message('muted', 'Select a completed step to see its request and response.'));
        return node;
      }

      // An item of a for_each step has the same fields as a step.
      const r = (Number.isInteger(iteration) && s.result.iterations?.find(i => i.iteration === iteration)) || s.result;
      node.append(element('h2', null, r.name));
      const line = element('div', 'request-line');
      line.append(element('span', 'method', r.method ?? ''), element('span', 'url', r.url ?? ''));
      node.append(line);

      const facts = [
        r.status !== null ? `status ${r.status}` : 'no response',
        formatDuration(r.duration_ms),
        r.attempts > 1 ? `${r.attempts} attempts` : null,
        typeof r.bytes_sent === 'number' ? `sent ${formatBytes(r.bytes_sent)}` : null,
        typeof r.bytes_received === 'number' ? `received ${formatBytes(r.bytes_received)}` : null
      ].filter(Boolean);
      node.append(element('div', 'facts', facts.join(' · ')));

      if (r.failure) node.append(element('div', 'failure', `✗ ${r.failure}`));
      if ((r.assertions ?? []).length > 0) node.append(checks(r.assertions));

      const saved = Object.entries(r.saved ?? {});
      if (saved.length > 0) {
        node.append(element('h3', null, 'Saved'));
        node.append(table(saved.map(([name, value]) => [name, JSON.stringify(value)])));
      }

      if (r.response) {
        node.append(section(`Response  ${r.response.status} ${r.response.reason ?? ''}`, r.response.headers,
          prettyBody(r.response.body), r.response.body_truncated ? 'The body was cut at 1 MiB.' : null));
      }
      if (r.request) {
        node.append(section(`Request  ${r.request.method} ${r.request.url}`, r.request.headers, prettyBody(r.request.body), null));
      }
      return node;
    }

    function checks(assertions) {
      const list = element('ul', 'checks');
      for (const a of assertions) {
        const item = element('li', a.passed ? 'check-passed' : 'check-failed');
        item.append(element('span', 'icon', a.passed ? '✓' : '✗'), element('span', null, `${a.subject} ${a.condition}`));
        if (!a.passed) item.append(element('span', 'actual', `actual ${a.actual}`));
        list.append(item);
      }
      return list;
    }

    function section(title, headers, bodyText, note) {
      const node = element('details', 'exchange');
      node.open = true;
      node.append(element('summary', null, title));
      if (headers.length > 0) node.append(table(headers.map(h => [h.name, h.value])));
      if (bodyText) node.append(element('pre', 'body', bodyText));
      else node.append(element('div', 'muted', 'No body'));
      if (note) node.append(element('div', 'note', note));
      return node;
    }

    function table(rows) {
      const node = element('table', 'pairs');
      for (const [name, value] of rows) {
        const row = element('tr');
        row.append(element('th', null, name), element('td', null, value));
        node.append(row);
      }
      return node;
    }

    reset('', null);
    return { reset, apply, error };
  }

  // --- Bootstrap -----------------------------------------------------------

  const view = createRunView(document.getElementById('app'));
  window.tinyprobeRunView = view;

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'reset') view.reset(data.title, data.environment);
    else if (data.type === 'event') view.apply(data.event);
    else if (data.type === 'error') view.error(data.message);
  });

  if (typeof acquireVsCodeApi === 'function') acquireVsCodeApi().postMessage({ type: 'ready' });
})();
