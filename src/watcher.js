(function () {
  function debugLog(msg) {
    try {
      window.postMessage({ type: 'cut-debug', detail: msg }, window.location.origin);
    } catch (e) { }
  }

  debugLog('WATCHER INIT: script loaded into MAIN world');

  var orig = window.fetch;
  window.fetch = async function (i, init) {
    var url = typeof i === 'string' ? i : i instanceof URL ? i.href : i.url;
    var isClaudeApi = url && /\/api\//.test(url);

    if (isClaudeApi) {
      debugLog('fetch wrapper called for URL: ' + url);
      if (init && init.headers) {
        try {
          var h = new Headers(init.headers);
          var extracted = {};
          h.forEach(function (val, key) {
            var lower = key.toLowerCase();
            if (lower.indexOf('anthropic') !== -1 || lower === 'baggage') {
              extracted[key] = val;
            }
          });
          if (Object.keys(extracted).length > 0) {
            window.postMessage({ type: 'cut-api-headers', detail: extracted }, window.location.origin);
          }
        } catch (e) { }
      }
    }

    var resp = await orig.apply(this, arguments);

    if (isClaudeApi) {
      try {
        var orgMatch = url.match(/\/api\/organizations\/([^/]+)/);
        var orgId = orgMatch && orgMatch[1];
        if (orgId) {
          window.postMessage({ type: 'cut-org-id', detail: orgId }, window.location.origin);
        }

        var ct = resp.headers.get('content-type') || '';
        if (ct.indexOf('text/event-stream') !== -1) {
          debugLog('Intercepted SSE stream for orgId=' + orgId);
          readSSE(resp.clone(), orgId);
        } else if (ct.indexOf('application/json') !== -1) {
          readJSON(resp.clone(), orgId, url);
        }
      } catch (e) {
        debugLog('Error processing response: ' + e.toString());
      }
    }

    return resp;
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
      window.postMessage({ type: 'cut-completion-done', detail: orgId }, window.location.origin);
    }
  }

  function emitConversationSynced(orgId, url) {
    if (orgId) {
      window.__cutLastCompletionOrgId = orgId;
      window.__cutCompletionTimestamp = Date.now();
      window.postMessage({ type: 'cut-conversation-synced', detail: { orgId: orgId, url: url } }, window.location.origin);
    }
  }

  function emitMessageStats(usage) {
    // Emit token/cost stats from message_start so the widget can display them
    if (!usage || typeof usage !== 'object') return;
    var inputTokens = typeof usage.input_tokens === 'number' ? usage.input_tokens : 0;
    var outputTokens = typeof usage.output_tokens === 'number' ? usage.output_tokens : 0;
    var cacheCreation = typeof usage.cache_creation_input_tokens === 'number' ? usage.cache_creation_input_tokens : 0;
    var cacheRead = typeof usage.cache_read_input_tokens === 'number' ? usage.cache_read_input_tokens : 0;
    window.postMessage({
      type: 'cut-message-stats', detail: {
        inputTokens: inputTokens,
        outputTokens: outputTokens,
        cacheCreationTokens: cacheCreation,
        cacheReadTokens: cacheRead,
        totalTokens: inputTokens + outputTokens,
        timestamp: Date.now()
      }
    }, window.location.origin);
  }

  function readSSE(r, orgId) {
    debugLog('readSSE called for orgId=' + orgId);
    var reader = r.body && r.body.getReader();
    if (!reader) {
      debugLog('readSSE failed: no reader');
      return;
    }
    var dec = new TextDecoder();
    var buf = '';
    var doneEmitted = false;

    function markDone() {
      if (doneEmitted) return;
      doneEmitted = true;
      emitCompletionDone(orgId);
    }

    function pump() {
      return reader.read().then(function (_a) {
        var done = _a.done, value = _a.value;
        if (done) {
          markDone();
          return;
        }
        buf += dec.decode(value, { stream: true });
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
            debugLog('watcher parsed event: type=' + obj.type + ' keys=' + Object.keys(obj).join(','));

            // Fire cut-quota if:
            // 1. The old nested message_limit object is present (original format)
            // 2. OR the event type is "message_limit" — catches new format where the
            //    nested field is null but windows/utilization data is at the top level
            // 3. OR usage_metadata is present (another legacy path)
            var isMessageLimit = !!(obj.message_limit) || obj.type === 'message_limit';
            if (isMessageLimit || obj.usage_metadata) {
              debugLog('watcher: firing cut-quota. type=' + obj.type + ' has_nested_ml=' + !!obj.message_limit + ' has_windows=' + !!obj.windows);
              window.postMessage({ type: 'cut-quota', detail: obj }, window.location.origin);
            }
            // Capture token usage from message_start event
            if (obj.type === 'message_start' && obj.message && obj.message.usage) {
              emitMessageStats(obj.message.usage);
            }
          } catch (e) { }
        }
        return pump();
      }).catch(function () { markDone(); });
    }
    return pump();
  }

  function readJSON(r, orgId, url) {
    r.json().then(function (obj) {
      if (obj && (obj.message_limit || obj.usage_metadata)) {
        window.postMessage({ type: 'cut-quota', detail: obj }, window.location.origin);
      }
      if (isConversationSyncUrl(url)) {
        emitConversationSynced(orgId, url);
      }
    }).catch(function () { });
  }
})();