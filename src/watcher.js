(function(){
  var orig = window.fetch.bind(window);
  window.fetch = function(i, init) {
    var respPromise = orig(i, init);
    try {
      var url = typeof i === 'string' ? i : i instanceof URL ? i.href : i.url;
      if (url && /claude\.ai\/api\//.test(url)) {
        var orgMatch = url.match(/\/api\/organizations\/([^/]+)/);
        var orgId = orgMatch && orgMatch[1];
        if (orgId) {
          window.dispatchEvent(new CustomEvent('cut-org-id', {detail: orgId}));
        }
        respPromise.then(function(resp) {
          var ct = resp.headers.get('content-type') || '';
          if (ct.indexOf('text/event-stream') !== -1) {
            readSSE(resp.clone(), orgId);
          } else if (ct.indexOf('application/json') !== -1) {
            readJSON(resp.clone());
          }
        }).catch(function(){});
      }
    } catch(e) {}
    return respPromise;
  };

  function emitCompletionDone(orgId) {
    if (orgId) {
      // Persist so a newly-loaded content script can recover this event
      // even if it missed the live CustomEvent dispatch.
      window.__cutLastCompletionOrgId = orgId;
      window.__cutCompletionTimestamp = Date.now();
      window.dispatchEvent(new CustomEvent('cut-completion-done', {detail: orgId}));
    }
  }

  function readSSE(r, orgId) {
    var reader = r.body && r.body.getReader();
    if (!reader) return;
    var dec = new TextDecoder();
    var buf = '';
    var doneEmitted = false;

    function markDone() {
      if (doneEmitted) return;
      doneEmitted = true;
      emitCompletionDone(orgId);
    }

    function pump() {
      return reader.read().then(function(_a) {
        var done = _a.done, value = _a.value;
        if (done) {
          markDone();
          return;
        }
        buf += dec.decode(value, {stream: true});
        var lines = buf.split('\n');
        buf = lines.pop() || '';
        for (var i = 0; i < lines.length; i++) {
          var line = lines[i];
          if (line.indexOf('data: ') !== 0) continue;
          var raw = line.slice(6).trim();
          if (raw === '[DONE]') {
            markDone();
            continue;
          }
          if (!raw) continue;
          try {
            var obj = JSON.parse(raw);
            if (obj.message_limit || obj.usage_metadata) {
              window.dispatchEvent(new CustomEvent('cut-quota', {detail: obj}));
            }
          } catch(e) {}
        }
        return pump();
      }).catch(function(){ markDone(); });
    }
    return pump();
  }

  function readJSON(r) {
    r.json().then(function(obj) {
      if (obj && (obj.message_limit || obj.usage_metadata)) {
        window.dispatchEvent(new CustomEvent('cut-quota', {detail: obj}));
      }
    }).catch(function(){});
  }
})();