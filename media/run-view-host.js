// The run view's bootstrap in VS Code: the extension posts the NDJSON events of a run, and the shared view
// (media/shared/run-view.js, copied from tinyprobe-app) renders them. A workflow's run also has its diagram
// (media/shared/flow.js), drawn from its inspection and lit up by the same events.
(function () {
  'use strict';

  const view = globalThis.tinyprobeRunView.create(document.getElementById('app'));
  const flows = globalThis.tinyprobeFlow;
  const flowBox = document.getElementById('flow-box');
  const flowRoot = document.getElementById('flow');
  let diagram = null;

  function drawFlow(inspection) {
    diagram = null;
    flowRoot.replaceChildren();
    flowBox.hidden = !inspection;
    if (!inspection) return;
    const model = flows.flowModel(inspection, []);
    // A click on a step shows its request and response below, as a click on its row does.
    diagram = flows.createFlow(flowRoot, model, {
      onSelect: at => {
        view.select(model.nodes[at].index);
        requestAnimationFrame(() => document.querySelector('#app .details')?.scrollIntoView({ behavior: 'smooth', block: 'start' }));
      }
    });
  }

  window.addEventListener('message', ({ data }) => {
    if (data.type === 'reset') {
      view.reset(data.title, data.environment, { call: Boolean(data.call) });
      drawFlow(data.flow);
    } else if (data.type === 'event') {
      view.apply(data.event);
      diagram?.apply(data.event);
    } else if (data.type === 'error') view.error(data.message);
  });

  acquireVsCodeApi().postMessage({ type: 'ready' });
})();
