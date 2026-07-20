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
            readJSON(resp.clone(), orgId, url);
          }
        }).catch(function(){});
      }
    } catch(e) {}
    return respPromise;
  };

  function isConversationSyncUrl(url) {
    if (!url) return false;
    return /\/api\/organizations\/[^/]+\/chat_conversations\/[^/?]+/.test(url) &&
      (url.indexOf('tree=True') !== -1 || url.indexOf('tree=true') !== -1) &&
      (url.indexOf('render_all_tools=true') !== -1 || url.indexOf('render_all_tools=True') !== -1);
  }

  function emitCompletionDone(orgId) {
    if (orgId) {
      window.__cutLastCompletionOrgId = orgId;
      window.__cutCompletionTimestamp = Date.now();
      window.dispatchEvent(new CustomEvent('cut-completion-done', {detail: orgId}));
    }
  }

  function emitConversationSynced(orgId, url) {
    if (orgId) {
      window.__cutLastCompletionOrgId = orgId;
      window.__cutCompletionTimestamp = Date.now();
      window.dispatchEvent(new CustomEvent('cut-conversation-synced', {detail: {orgId: orgId, url: url}}));
    }
  }

  function emitMessageStats(usage) {
    // Emit token/cost stats from message_start so the widget can display them
    if (!usage || typeof usage !== 'object') return;
    var inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    var outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    var cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
    var cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
    window.dispatchEvent(new CustomEvent('cut-message-stats', {
      detail: {
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        totalTokens: inputTokens + outputTokens,
        timestamp: Date.now()
      }
    }));
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
            // Capture token usage from message_start event
            if (obj.type === 'message_start' && obj.message && obj.message.usage) {
              emitMessageStats(obj.message.usage);
            }
          } catch(e) {}
        }
        return pump();
      }).catch(function(){ markDone(); });
    }
    return pump();
  }

  function readJSON(r, orgId, url) {
    r.json().then(function(obj) {
      if (obj && (obj.message_limit || obj.usage_metadata)) {
        window.dispatchEvent(new CustomEvent('cut-quota', {detail: obj}));
      }
      if (isConversationSyncUrl(url)) {
        emitConversationSynced(orgId, url);
      }
    }).catch(function(){});
  }
})();