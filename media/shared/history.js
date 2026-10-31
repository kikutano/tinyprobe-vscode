// The request history: an entry from the events of a `tinyprobe call`, and the list it goes into. Shared by
// tinyprobe-app and the VS Code extension, which copies this file: plain JavaScript that runs in a page and in Node.
(function (exports) {
  'use strict';

  const HISTORY_BODY_LIMIT = 64 * 1024;

  /**
   * An entry of the request history from the events of a `tinyprobe call`, or undefined when nothing
   * was sent (the file or the arguments were invalid). Bodies over `limit` are cut, as the binary
   * cuts those over 1 MiB, with `body_truncated: true`.
   */
  function historyEntry({ file, endpoint, args, environment, events, time }, limit = HISTORY_BODY_LIMIT) {
    const step = events.find(e => e.event === 'step_completed');
    if (!step) return undefined;
    const cut = part => part && typeof part.body === 'string' && part.body.length > limit
      ? { ...part, body: part.body.slice(0, limit), body_truncated: true }
      : part;
    return {
      time,
      file,
      endpoint,
      args,
      environment: environment ?? null,
      method: step.method ?? step.request?.method ?? null,
      url: step.url ?? step.request?.url ?? null,
      status: step.status ?? null,
      success: !!step.success,
      duration_ms: step.duration_ms ?? null,
      failure: step.failure ?? null,
      events: events.map(e => e.event === 'step_completed' ? { ...e, request: cut(e.request), response: cut(e.response) } : e)
    };
  }

  /** The history with a new entry first, at most `max` entries. */
  function addToHistory(entries, entry, max) {
    return [entry, ...entries].slice(0, max);
  }

  Object.assign(exports, { HISTORY_BODY_LIMIT, historyEntry, addToHistory });
})(typeof module === 'object' && module.exports ? module.exports : (globalThis.tinyprobeHistory = {}));
