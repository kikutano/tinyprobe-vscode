// The run view's bootstrap in VS Code: the extension posts the NDJSON events of a run, and the shared view
// (media/shared/run-view.js, copied from tinyprobe-app) renders them.
(function () {
  'use strict';

  const view = globalThis.tinyprobeRunView.create(document.getElementById('app'));

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'reset') view.reset(data.title, data.environment);
    else if (data.type === 'event') view.apply(data.event);
    else if (data.type === 'error') view.error(data.message);
  });

  acquireVsCodeApi().postMessage({ type: 'ready' });
})();
