// The picture of a workflow: its steps in order, the values each one saves and the steps that use them, lit up
// as a run goes. Everything comes from `tinyprobe inspect --json` and the ndjson events of `tinyprobe run`.
// Shared by tinyprobe-app and the VS Code extension, which copies this file: the model is plain JavaScript that
// runs in Node too; the drawing needs a document. Every text is set with textContent, never as HTML.
(function (exports) {
  'use strict';

  const SVG = 'http://www.w3.org/2000/svg';

  /** The `${name}` placeholders in a value, deep, without generated values (`${$uuid}`). */
  function placeholders(value, found = new Set()) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/\$\{([A-Za-z_][\w.-]*)\}/g)) found.add(match[1]);
    } else if (Array.isArray(value)) {
      for (const item of value) placeholders(item, found);
    } else if (value && typeof value === 'object') {
      for (const item of Object.values(value)) placeholders(item, found);
    }
    return found;
  }

  function baseName(path) {
    return String(path ?? '').replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? '';
  }

  /**
   * The workflow as a flow: one node per step (in the order `inspect` lists them, the steps of a sequence where
   * its `use` is), one lane per saved value from the step that saves it to the steps that use it, and the values
   * that come from elsewhere. A step uses a value when `${name}` is in its `with`, or when the called endpoint
   * needs it and the `with` does not give it.
   * @param {object} inspect the `inspect --json` document of a workflow
   * @param {string[]} environment the variable names of the selected environment file
   */
  function flowModel(inspect, environment) {
    const fromEnvironment = new Set(environment ?? []);
    const variables = new Set((inspect.variables ?? []).map(v => v.name));
    const endpoints = new Map((inspect.endpoints ?? []).map(e => [e.name, e]));
    const nodes = [];
    const lanes = [];
    const latest = new Map();
    const inputs = { environment: [], variables: [], other: [] };
    const addInput = (kind, name) => { if (!inputs[kind].includes(name)) inputs[kind].push(name); };

    for (const step of inspect.steps ?? []) {
      const node = {
        index: step.index,
        name: step.name,
        type: step.type,
        sequence: step.sequence ? (step.sequence.name || baseName(step.sequence.file)) : null,
        saves: [],
        uses: []
      };
      if (step.type === 'sleep') {
        node.duration = step.duration_ms ?? null;
      } else if (step.type === 'call') {
        const endpoint = endpoints.get(step.call);
        node.call = step.call;
        node.method = endpoint?.method ?? null;
        node.path = endpoint?.path ?? null;
        node.until = step.until ? { every: step.until.every_ms, timeout: step.until.timeout_ms } : null;
        node.forEach = step.for_each
          ? (Array.isArray(step.for_each.items) ? step.for_each.items.length : step.for_each.variable ? `\${${step.for_each.variable}}` : '?')
          : null;

        const given = step.with ?? {};
        const used = placeholders(given);
        // What the endpoint needs and the step does not give: a value of the run, or a param's default.
        const defaults = new Set((endpoint?.params ?? []).filter(p => !p.required).map(p => p.name));
        const optional = new Set([...(endpoint?.query ?? []), ...defaults]);
        for (const argument of endpoint?.arguments ?? []) {
          if (Object.prototype.hasOwnProperty.call(given, argument)) continue;
          if (optional.has(argument) && !latest.has(argument) && !fromEnvironment.has(argument) && !variables.has(argument)) continue;
          used.add(argument);
        }
        // The keys of a for_each's items are the item's own values.
        for (const item of step.for_each?.items ?? []) {
          if (item && typeof item === 'object') for (const key of Object.keys(item)) used.delete(key);
        }
        if (step.for_each?.variable) used.add(step.for_each.variable);

        for (const name of used) {
          if (latest.has(name)) {
            const lane = latest.get(name);
            lane.to.push(nodes.length);
            node.uses.push({ name, lane: lane.id });
          } else if (fromEnvironment.has(name)) addInput('environment', name);
          else if (variables.has(name)) addInput('variables', name);
          // In a sequence, the params come from the `with` of its `use`; in a for_each, from each item.
          else if (!node.sequence && !step.for_each) addInput('other', name);
        }
        for (const name of Object.keys(step.save ?? {})) {
          const lane = { id: lanes.length, name, from: nodes.length, to: [] };
          lanes.push(lane);
          latest.set(name, lane);
          node.saves.push({ name, lane: lane.id });
        }
      }
      nodes.push(node);
    }
    // A value saved and never used afterwards gets no line: it would start and lead nowhere.
    for (const node of nodes) {
      for (const save of node.saves) save.unused = lanes[save.lane].to.length === 0;
    }
    return { nodes, lanes, inputs };
  }

  /**
   * The lines of values in a node: "uses ● a, ● b" and "saves ● c", each wrapped at `maxChars` so that a step
   * with many values grows down instead of running out of its box.
   */
  function valueLines(node, maxChars) {
    const lines = [];
    for (const [label, values] of [['uses', node.uses], ['saves', node.saves]]) {
      if (values.length === 0) continue;
      let line = { label, items: [], length: label.length };
      values.forEach((value, n) => {
        const text = ` ● ${value.name}${value.unused ? ' (not used)' : ''}${n < values.length - 1 ? ',' : ''}`;
        if (line.items.length > 0 && line.length + text.length > maxChars) {
          lines.push(line);
          line = { label: '', items: [], length: label.length };
        }
        line.items.push({ text, lane: value.lane, unused: Boolean(value.unused) });
        line.length += text.length;
      });
      lines.push(line);
    }
    return lines;
  }

  /**
   * A column for each lane that is used, from the left; a column is used again once the lane in it has ended,
   * so a long workflow with many values stays narrow. Lanes come in the order of their first step.
   */
  function laneColumns(lanes) {
    const ends = [];
    const columns = new Map();
    for (const lane of lanes) {
      if (lane.to.length === 0) continue;
      let column = ends.findIndex(end => end < lane.from);
      if (column < 0) column = ends.length;
      ends[column] = lane.to[lane.to.length - 1];
      columns.set(lane.id, column);
    }
    return columns;
  }

  /**
   * A color for each drawn lane, different from the colors of the lanes that are drawn at the same time, so
   * that two values side by side are never the same color. Eight colors, used again once a lane has ended.
   */
  function laneColors(lanes, columns, count = LANE_COLORS) {
    const drawn = lanes.filter(l => columns.has(l.id));
    const colors = new Map();
    for (const lane of drawn) {
      const end = lane.to[lane.to.length - 1];
      const taken = new Set(drawn
        .filter(other => colors.has(other.id) && other.from <= end && other.to[other.to.length - 1] >= lane.from)
        .map(other => colors.get(other.id)));
      let color = 0;
      while (taken.has(color) && color < count) color++;
      colors.set(lane.id, color < count ? color : lane.id % count);
    }
    return colors;
  }

  // --- Drawing -------------------------------------------------------------------------------------------------

  const NODE_X = 8;
  // The steps are as wide as the place the flow is drawn in, at the page's own text size: a picture scaled to
  // fit made its text bigger than the page's, and left it narrower than what is around it.
  const DEFAULT_W = 600;
  // Narrow enough for a phone (a 390 px screen leaves about 358 px), below that the flow scrolls.
  const MIN_W = 280;
  const LINE = 20;
  /** The width of a character of the 13.5px text, to wrap values and shorten names inside a node. */
  const CHAR = 7.9;
  const GAP = 16;
  const GROUP_LABEL = 26;
  const LANE_COLORS = 8;

  function svg(tag, attributes, text) {
    const node = document.createElementNS(SVG, tag);
    for (const [name, value] of Object.entries(attributes ?? {})) {
      if (value !== null && value !== undefined) node.setAttribute(name, String(value));
    }
    if (text !== undefined && text !== null) node.textContent = String(text);
    return node;
  }

  function duration(ms) {
    if (ms === null || ms === undefined) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    return `${Math.round(ms / 100) / 10}s`;
  }

  function shorten(text, max) {
    const value = String(text ?? '');
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
  }

  /**
   * Draws the flow in `root` and returns { apply(event), reset(), select(position) }. `onSelect(position)` is
   * called when a step is clicked or chosen with the keyboard.
   */
  function createFlow(root, model, { onSelect, onRunTo = null, selected = null } = {}) {
    let states = [];
    let current = selected;
    let NODE_W = DEFAULT_W;
    // The width of `root`, from the resize observer. Reading clientWidth while drawing forced a layout of the whole
    // page on every event of a run, and made a run of 500 steps take minutes.
    let room = 0;

    /** The width of a step box for the width of `root`, or the default when it is not laid out yet. */
    function fit() {
      return room > 0 ? Math.max(MIN_W, room - NODE_X - 8) : DEFAULT_W;
    }

    if (typeof ResizeObserver !== 'undefined') {
      const watch = new ResizeObserver(entries => {
        if (!root.isConnected) return watch.disconnect();
        room = Math.floor(entries[entries.length - 1].contentRect.width);
        if (fit() !== NODE_W) draw();
      });
      watch.observe(root);
    }

    // The events of a run arrive faster than a screen refreshes: they update the states, and the picture is drawn
    // once with all of them, at the next frame. A hidden page gets no frames (a tab in the background, a webview
    // that is not shown), so a timer draws it too, whichever comes first.
    let pending = null;
    function drawSoon() {
      if (pending) return;
      const now = () => {
        if (!pending) return;
        clearTimeout(pending.timer);
        if (pending.frame) cancelAnimationFrame(pending.frame);
        pending = null;
        draw();
      };
      pending = { timer: setTimeout(now, 100), frame: typeof requestAnimationFrame === 'function' ? requestAnimationFrame(now) : null };
    }

    function drawNow() {
      if (pending) {
        clearTimeout(pending.timer);
        if (pending.frame) cancelAnimationFrame(pending.frame);
        pending = null;
      }
      draw();
    }

    function reset() {
      states = model.nodes.map(() => ({ status: 'pending', attempt: 1, item: null, items: null, result: null }));
      draw();
    }

    function position(index) {
      return model.nodes.findIndex(n => n.index === index);
    }

    /** One ndjson event of a run of this workflow. */
    function apply(event) {
      if (event.event === 'run_started') {
        reset();
        return;
      }
      const at = position(event.index);
      if (event.event === 'step_started' && at >= 0) {
        // A step that starts ends the sleep before it, which has no step_completed.
        states.forEach((s, i) => { if (i < at && s.status === 'running') s.status = 'passed'; });
        Object.assign(states[at], { status: 'running', attempt: event.attempt ?? 1, item: event.iteration ?? null, items: event.iterations ?? null });
      } else if (event.event === 'step_completed' && at >= 0) {
        Object.assign(states[at], { status: event.success ? 'passed' : 'failed', result: event });
      } else if (event.event === 'run_finished') {
        for (const s of states) {
          if (s.status === 'running') s.status = 'passed';
          else if (s.status === 'pending') s.status = 'skipped';
        }
      }
      // The end of a run is drawn at once: it is the picture that stays.
      if (event.event === 'run_finished') drawNow();
      else drawSoon();
    }

    function select(at) {
      current = at;
      draw();
      onSelect?.(at);
    }

    function draw() {
      const nodes = model.nodes;
      NODE_W = fit();
      // Values are colored, the same color where a value is saved and where it is used: no lines between steps,
      // "uses" and "saves" say it, and the color matches them at a glance.
      const colors = laneColors(model.lanes, laneColumns(model.lanes));
      const maxChars = Math.floor((NODE_W - 40 - 16) / CHAR);
      const lines = nodes.map(n => (n.type === 'call' ? valueLines(n, maxChars) : []));
      const heights = lines.map(l => (l.length > 0 ? 54 + LINE * l.length + 8 : 62));
      const tops = [];
      let y = 6;
      nodes.forEach((node, i) => {
        if (node.sequence && (i === 0 || nodes[i - 1].sequence !== node.sequence)) y += GROUP_LABEL;
        tops.push(y);
        y += heights[i] + GAP;
      });
      const width = NODE_X + NODE_W + 8;
      const height = Math.max(y, 40);

      const picture = svg('svg', { viewBox: `0 0 ${width} ${height}`, width, height, class: 'flow-svg', role: 'list', 'aria-label': 'The steps of the workflow and the values they pass on' });

      // The groups of a sequence's steps, behind them.
      let start = null;
      nodes.forEach((node, i) => {
        if (node.sequence && start === null) start = i;
        const ends = node.sequence && (i === nodes.length - 1 || nodes[i + 1].sequence !== node.sequence);
        if (ends) {
          const top = tops[start] - GROUP_LABEL + 2;
          picture.append(svg('rect', { x: 1, y: top, width: NODE_W + 14, height: tops[i] + heights[i] - top + 7, rx: 10, class: 'flow-group' }));
          picture.append(svg('text', { x: 12, y: top + 17, class: 'flow-group-label' }, `use ${node.sequence}`));
          start = null;
        }
      });

      nodes.forEach((node, i) => picture.append(drawNode(node, i, tops[i], heights[i], lines[i], colors)));
      root.replaceChildren(picture);
    }

    function drawNode(node, i, top, height, valueLines_, colors) {
      const state = states[i] ?? { status: 'pending' };
      const group = svg('g', {
        class: `flow-node flow-${state.status}${current === i ? ' flow-selected' : ''}`,
        tabindex: 0, role: 'listitem', 'aria-label': `Step ${i + 1}: ${node.name}, ${state.status}`
      });
      const choose = () => select(i);
      group.addEventListener('click', choose);
      group.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); choose(); } });

      group.append(svg('rect', { x: NODE_X, y: top, width: NODE_W, height, rx: 8, class: 'flow-box' }));
      const icon = { pending: '○', running: '●', passed: '✓', failed: '✗', skipped: '–' }[state.status] ?? '○';
      group.append(svg('text', { x: NODE_X + 14, y: top + 25, class: 'flow-icon' }, icon));

      // With onRunTo, "▶ Up to here" at the right of the first line runs the workflow up to this step. It is a
      // button of its own: a click on it does not select the step.
      let right = NODE_X + NODE_W - 14;
      if (onRunTo) {
        const RUN_W = 96;
        const runTo = () => onRunTo(i);
        const button = svg('g', { class: 'flow-run-to', tabindex: 0, role: 'button', 'aria-label': `Run the workflow up to step ${i + 1}` });
        button.addEventListener('click', e => { e.stopPropagation(); runTo(); });
        button.addEventListener('keydown', e => {
          if (e.key !== 'Enter' && e.key !== ' ') return;
          e.preventDefault();
          e.stopPropagation();
          runTo();
        });
        const x = NODE_X + NODE_W - 10 - RUN_W;
        button.append(svg('rect', { x, y: top + 10, width: RUN_W, height: 22, rx: 11 }));
        button.append(svg('text', { x: x + RUN_W / 2, y: top + 25, 'text-anchor': 'middle' }, '▶ Up to here'));
        button.append(svg('title', null, 'Runs the steps before this one again, stops here and shows its response'));
        group.append(button);
        right = x - 10;
      }

      // Badges at the right of the first line: polling, items, progress, duration. The name takes what is left.
      const badges = [];
      if (node.until) badges.push(state.status === 'running' && state.attempt > 1 ? `↻ attempt ${state.attempt}` : `↻ until, every ${duration(node.until.every)}`);
      if (node.forEach !== null && node.forEach !== undefined) {
        badges.push(state.status === 'running' && state.items ? `item ${state.item}/${state.items}` : typeof node.forEach === 'number' ? `× ${node.forEach} items` : `× each of ${node.forEach}`);
      }
      if (state.result) badges.push(`${state.result.status ?? '---'} · ${duration(state.result.duration_ms)}`);
      const badgeText = badges.join('   ');
      if (badges.length > 0) group.append(svg('text', { x: right, y: top + 25, 'text-anchor': 'end', class: 'flow-badge' }, badgeText));
      const nameChars = Math.max(12, Math.floor((right - NODE_X - 40 - 14 - badgeText.length * 7.2) / 8.8));
      group.append(svg('text', { x: NODE_X + 40, y: top + 25, class: 'flow-name' }, shorten(`${i + 1}. ${node.name}`, nameChars)));

      const detail = node.type === 'sleep' ? `wait ${duration(node.duration)}`
        : node.type === 'call' ? `${node.method ?? ''} ${node.path ?? ''}  ·  ${node.call}`
        : node.type;
      group.append(svg('text', { x: NODE_X + 40, y: top + 47, class: 'flow-detail' }, shorten(detail, Math.floor((NODE_W - 56) / 7.9))));

      // One text per line: SVG does not wrap. A continued line is indented under the first value.
      valueLines_.forEach((line, n) => {
        const text = svg('text', { x: NODE_X + 40 + (line.label ? 0 : (line.length - line.items.reduce((sum, item) => sum + item.text.length, 0)) * CHAR), y: top + 69 + n * LINE, class: 'flow-values' });
        if (line.label) text.append(svg('tspan', { class: 'flow-values-label' }, line.label));
        for (const item of line.items) {
          text.append(svg('tspan', { class: item.unused ? 'flow-values-unused' : `flow-lane-text lane-${colors.get(item.lane) ?? 0}` }, item.text));
        }
        group.append(text);
      });
      group.append(svg('title', null, `${node.name}${state.result?.failure ? `: ${state.result.failure}` : ''}`));
      return group;
    }

    reset();
    return { apply, reset, select, get selected() { return current; }, state: i => states[i] };
  }

  Object.assign(exports, { flowModel, createFlow, placeholders, valueLines, laneColumns, laneColors });
})(typeof module === 'object' && module.exports ? module.exports : (globalThis.tinyprobeFlow = {}));
