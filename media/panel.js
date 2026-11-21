// @ts-check
(function () {
  // @ts-ignore
  const vscode = acquireVsCodeApi();

  // State
  let state = {
    model: 'gemini-3-1-flash-lite',
    status: 'idle',
    budget: { usedTokens: 0, maxTokens: 8000 },
    messages: [],
    streamingChunk: '',
    activeApproval: null,
    error: null
  };

  // DOM Elements
  const modelNameEl = document.getElementById('model-name');
  const stopBtn = document.getElementById('stop-btn');
  const newChatBtn = document.getElementById('new-chat-btn');
  const budgetText = document.getElementById('budget-text');
  const budgetFill = document.getElementById('budget-bar-fill');
  const transcriptEl = document.getElementById('transcript');
  const approvalBanner = document.getElementById('approval-banner');
  const approvalDesc = document.getElementById('approval-desc');
  const btnReviewChanges = document.getElementById('btn-review-changes');
  const btnAllow = document.getElementById('btn-allow');
  const btnDeny = document.getElementById('btn-deny');
  const chatInput = document.getElementById('chat-input');
  const sendBtn = document.getElementById('send-btn');
  const autocompletePopup = document.getElementById('autocomplete-popup');

  // Stream Batching
  let streamBuffer = '';
  let streamBatchTimer = null;
  let activeStreamingBubble = null;

  // Simple Markdown Parser
  function renderMarkdown(text) {
    if (!text) return '';
    let html = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');

    // Fenced code blocks
    html = html.replace(/```([a-zA-Z0-9_-]*)\n([\s\S]*?)```/g, (match, lang, code) => {
      return `<pre><code class="language-${lang}">${code.trim()}</code></pre>`;
    });

    // Inline code
    html = html.replace(/`([^`]+)`/g, '<code>$1</code>');

    // Bold
    html = html.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

    // Italic
    html = html.replace(/\*([^*]+)\*/g, '<em>$1</em>');

    // Headers
    html = html.replace(/^### (.*$)/gim, '<h3>$1</h3>');
    html = html.replace(/^## (.*$)/gim, '<h2>$1</h2>');
    html = html.replace(/^# (.*$)/gim, '<h1>$1</h1>');

    // Line breaks to paragraphs
    const paragraphs = html.split(/\n\n+/);
    return paragraphs.map(p => {
      if (p.startsWith('<pre>') || p.startsWith('<h1>') || p.startsWith('<h2>') || p.startsWith('<h3>')) {
        return p;
      }
      return `<p>${p.replace(/\n/g, '<br>')}</p>`;
    }).join('');
  }

  // Render Context Chosen Card
  function renderContextCard(items) {
    if (!items || items.length === 0) return '';
    const rows = items.map(item => `
      <tr>
        <td class="cell-file">${item.file || item.path}</td>
        <td class="cell-lines">${item.lines ? `${item.lines[0]}-${item.lines[1]}` : ''}</td>
        <td class="cell-score"><span class="score-badge">${typeof item.score === 'number' ? item.score.toFixed(2) : item.score}</span></td>
        <td>${item.why || ''}</td>
        <td>${item.tokens || ''}</td>
      </tr>
    `).join('');

    return `
      <div class="context-card">
        <div class="context-card-header">
          <span>Context Chosen (${items.length} items)</span>
        </div>
        <table class="context-table">
          <thead>
            <tr>
              <th>File</th>
              <th>Lines</th>
              <th>Score</th>
              <th>Why</th>
              <th>Tokens</th>
            </tr>
          </thead>
          <tbody>
            ${rows}
          </tbody>
        </table>
      </div>
    `;
  }

  // Update UI Elements
  function updateHeader() {
    let displayName = state.model;
    if (displayName.includes('/')) {
      const parts = displayName.split('/');
      displayName = parts[parts.length - 1];
    }
    if (displayName.includes('gemini')) displayName = 'gemini-3-1-flash-lite';
    if (displayName.includes('groq')) displayName = 'Groq Fast';
    if (modelNameEl) modelNameEl.textContent = displayName;

    if (stopBtn) {
      stopBtn.disabled = state.status !== 'streaming';
    }
  }

  function updateBudget() {
    const used = state.budget.usedTokens;
    const max = state.budget.maxTokens || 8000;
    const pct = Math.min(100, Math.round((used / max) * 100));

    if (budgetText) {
      budgetText.textContent = `${used.toLocaleString()} / ${max.toLocaleString()} tokens (${pct}%)`;
    }

    if (budgetFill) {
      budgetFill.style.width = `${pct}%`;
      budgetFill.classList.remove('warning', 'danger');
      if (pct >= 90) {
        budgetFill.classList.add('danger');
      } else if (pct >= 70) {
        budgetFill.classList.add('warning');
      }
    }
  }

  function updateApproval() {
    if (!approvalBanner) return;
    if (state.activeApproval) {
      approvalBanner.style.display = 'flex';
      const tc = state.activeApproval.toolCalls && state.activeApproval.toolCalls[0];
      const desc = tc ? `${tc.name || 'apply_changes'} (${state.activeApproval.summary || 'pending approval'})` : 'Changes pending approval';
      if (approvalDesc) approvalDesc.textContent = desc;
    } else {
      approvalBanner.style.display = 'none';
    }
  }

  function renderMessages() {
    if (!transcriptEl) return;
    transcriptEl.innerHTML = '';

    for (const msg of state.messages) {
      const bubble = document.createElement('div');
      bubble.className = `message ${msg.role}`;

      const sender = document.createElement('div');
      sender.className = 'message-sender';
      sender.textContent = msg.role === 'user' ? 'You' : 'Forge Agent';
      bubble.appendChild(sender);

      if (msg.chosenContext && msg.chosenContext.length > 0) {
        const ctxContainer = document.createElement('div');
        ctxContainer.innerHTML = renderContextCard(msg.chosenContext);
        bubble.appendChild(ctxContainer);
      }

      if (msg.content) {
        const content = document.createElement('div');
        content.className = 'message-content';
        content.innerHTML = renderMarkdown(msg.content);
        bubble.appendChild(content);
      }

      transcriptEl.appendChild(bubble);
    }

    // If currently streaming
    if (state.status === 'streaming') {
      activeStreamingBubble = document.createElement('div');
      activeStreamingBubble.className = 'message assistant';

      const sender = document.createElement('div');
      sender.className = 'message-sender';
      sender.textContent = 'Forge Agent';
      activeStreamingBubble.appendChild(sender);

      const content = document.createElement('div');
      content.className = 'message-content';
      content.innerHTML = renderMarkdown(state.streamingChunk) + '<span class="streaming-cursor"></span>';
      activeStreamingBubble.appendChild(content);

      transcriptEl.appendChild(activeStreamingBubble);
    } else {
      activeStreamingBubble = null;
    }

    transcriptEl.scrollTop = transcriptEl.scrollHeight;
  }

  function flushStreamBatch() {
    if (!streamBuffer) return;
    state.streamingChunk += streamBuffer;
    streamBuffer = '';

    if (activeStreamingBubble) {
      const content = activeStreamingBubble.querySelector('.message-content');
      if (content) {
        content.innerHTML = renderMarkdown(state.streamingChunk) + '<span class="streaming-cursor"></span>';
      }
      if (transcriptEl) transcriptEl.scrollTop = transcriptEl.scrollHeight;
    } else {
      renderMessages();
    }
  }

  // Autocomplete
  let autocompleteItems = [];
  let selectedAutocompleteIndex = 0;

  function renderAutocomplete(items) {
    autocompleteItems = items || [];
    selectedAutocompleteIndex = 0;
    if (!autocompletePopup) return;

    if (autocompleteItems.length === 0) {
      autocompletePopup.style.display = 'none';
      return;
    }

    autocompletePopup.innerHTML = '';
    autocompleteItems.forEach((item, idx) => {
      const div = document.createElement('div');
      div.className = `autocomplete-item ${idx === 0 ? 'selected' : ''}`;
      div.innerHTML = `
        <span>${item.kind === 'file' ? 'ðŸ“„' : 'ðŸ”·'}</span>
        <strong>${item.name || item.path}</strong>
        <span class="autocomplete-item-path">${item.path || ''}</span>
      `;
      div.addEventListener('click', () => {
        applyAutocomplete(item);
      });
      autocompletePopup.appendChild(div);
    });

    autocompletePopup.style.display = 'block';
  }

  function applyAutocomplete(item) {
    if (!chatInput) return;
    const val = chatInput.value;
    const cursorPos = chatInput.selectionStart;
    const atIdx = val.lastIndexOf('@', cursorPos - 1);
    if (atIdx !== -1) {
      const insertText = `@${item.path || item.name} `;
      const newVal = val.slice(0, atIdx) + insertText + val.slice(cursorPos);
      chatInput.value = newVal;
      chatInput.selectionStart = atIdx + insertText.length;
      chatInput.selectionEnd = atIdx + insertText.length;
    }
    if (autocompletePopup) autocompletePopup.style.display = 'none';
    chatInput.focus();
  }

  // Event Listeners
  if (chatInput) {
    chatInput.addEventListener('input', () => {
      // Auto expand
      chatInput.style.height = 'auto';
      chatInput.style.height = `${Math.min(chatInput.scrollHeight, 120)}px`;

      // Check for @ mentions
      const val = chatInput.value;
      const cursorPos = chatInput.selectionStart;
      const atIdx = val.lastIndexOf('@', cursorPos - 1);
      if (atIdx !== -1 && !val.slice(atIdx, cursorPos).includes(' ')) {
        const query = val.slice(atIdx + 1, cursorPos);
        vscode.postMessage({ command: 'searchMentions', data: { query } });
      } else {
        if (autocompletePopup) autocompletePopup.style.display = 'none';
      }
    });

    chatInput.addEventListener('keydown', (e) => {
      if (autocompletePopup && autocompletePopup.style.display === 'block' && autocompleteItems.length > 0) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          selectedAutocompleteIndex = (selectedAutocompleteIndex + 1) % autocompleteItems.length;
          updateAutocompleteSelection();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          selectedAutocompleteIndex = (selectedAutocompleteIndex - 1 + autocompleteItems.length) % autocompleteItems.length;
          updateAutocompleteSelection();
          return;
        }
        if (e.key === 'Enter' || e.key === 'Tab') {
          e.preventDefault();
          applyAutocomplete(autocompleteItems[selectedAutocompleteIndex]);
          return;
        }
        if (e.key === 'Escape') {
          autocompletePopup.style.display = 'none';
          return;
        }
      }

      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });
  }

  function updateAutocompleteSelection() {
    if (!autocompletePopup) return;
    const items = autocompletePopup.querySelectorAll('.autocomplete-item');
    items.forEach((item, idx) => {
      if (idx === selectedAutocompleteIndex) {
        item.classList.add('selected');
      } else {
        item.classList.remove('selected');
      }
    });
  }

  function sendMessage() {
    if (!chatInput) return;
    const text = chatInput.value.trim();
    if (!text || state.status === 'streaming') return;

    chatInput.value = '';
    chatInput.style.height = '38px';
    if (autocompletePopup) autocompletePopup.style.display = 'none';

    // Optimistic local add
    const userMsg = {
      id: `user-${Date.now()}`,
      role: 'user',
      content: text,
      timestamp: Date.now()
    };
    state.messages.push(userMsg);
    renderMessages();

    vscode.postMessage({ command: 'sendMessage', data: { text } });
  }

  if (sendBtn) {
    sendBtn.addEventListener('click', sendMessage);
  }

  if (stopBtn) {
    stopBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'cancel' });
    });
  }

  if (newChatBtn) {
    newChatBtn.addEventListener('click', () => {
      vscode.postMessage({ command: 'newChat' });
    });
  }

  if (btnReviewChanges) {
    btnReviewChanges.addEventListener('click', () => {
      vscode.postMessage({ command: 'reviewChanges' });
    });
  }

  if (btnAllow) {
    btnAllow.addEventListener('click', () => {
      if (state.activeApproval) {
        vscode.postMessage({
          command: 'approveTool',
          data: {
            id: state.activeApproval.id,
            threadId: state.activeApproval.threadId,
            decision: 'allow'
          }
        });
      }
    });
  }

  if (btnDeny) {
    btnDeny.addEventListener('click', () => {
      if (state.activeApproval) {
        vscode.postMessage({
          command: 'approveTool',
          data: {
            id: state.activeApproval.id,
            threadId: state.activeApproval.threadId,
            decision: 'deny'
          }
        });
      }
    });
  }

  // Handle messages dispatched from the extension host
  window.addEventListener('message', (event) => {
    const msg = event.data;
    if (!msg || !msg.type) return;

    switch (msg.type) {
      case 'SET_MODEL':
        state.model = msg.payload;
        updateHeader();
        break;

      case 'START_STREAMING':
        state.status = 'streaming';
        state.streamingChunk = '';
        streamBuffer = '';
        updateHeader();
        renderMessages();
        break;

      case 'APPEND_STREAM_CHUNK':
        streamBuffer += msg.payload;
        if (!streamBatchTimer) {
          streamBatchTimer = setTimeout(() => {
            streamBatchTimer = null;
            flushStreamBatch();
          }, 50);
        }
        break;

      case 'FINISH_STREAMING':
        if (streamBatchTimer) {
          clearTimeout(streamBatchTimer);
          streamBatchTimer = null;
        }
        flushStreamBatch();
        if (state.streamingChunk) {
          const last = state.messages[state.messages.length - 1];
          if (last && last.role === 'assistant') {
            last.content += state.streamingChunk;
          } else {
            state.messages.push({
              id: `msg-${Date.now()}`,
              role: 'assistant',
              content: state.streamingChunk,
              timestamp: Date.now()
            });
          }
          state.streamingChunk = '';
        }
        state.status = state.activeApproval ? 'awaiting_approval' : 'idle';
        updateHeader();
        renderMessages();
        break;

      case 'ADD_MESSAGE':
        state.messages.push(msg.payload);
        renderMessages();
        break;

      case 'UPDATE_BUDGET':
        state.budget = {
          usedTokens: msg.payload.usedTokens,
          maxTokens: msg.payload.maxTokens ?? state.budget.maxTokens
        };
        updateBudget();
        break;

      case 'SET_CHOSEN_CONTEXT': {
        const items = msg.payload;
        const last = state.messages[state.messages.length - 1];
        if (last && last.role === 'assistant') {
          last.chosenContext = items;
        } else {
          state.messages.push({
            id: `msg-${Date.now()}-ctx`,
            role: 'assistant',
            content: '',
            timestamp: Date.now(),
            chosenContext: items
          });
        }
        renderMessages();
        break;
      }

      case 'SET_APPROVAL_REQUEST':
        state.activeApproval = msg.payload;
        state.status = msg.payload ? 'awaiting_approval' : 'idle';
        updateHeader();
        updateApproval();
        break;

      case 'RESOLVE_APPROVAL':
        state.activeApproval = null;
        state.status = 'idle';
        updateHeader();
        updateApproval();
        break;

      case 'CLEAR_CHAT':
        state.messages = [];
        state.streamingChunk = '';
        state.activeApproval = null;
        state.status = 'idle';
        state.budget.usedTokens = 0;
        updateHeader();
        updateBudget();
        updateApproval();
        renderMessages();
        break;

      case 'SET_AUTOCOMPLETE_RESULTS':
        renderAutocomplete(msg.payload);
        break;
    }
  });

  // Initial render
  updateHeader();
  updateBudget();
  updateApproval();
})();

