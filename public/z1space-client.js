(() => {
  const SESSION_KEY = 'z1space-session';
  const session = localStorage.getItem(SESSION_KEY) || (crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`);
  localStorage.setItem(SESSION_KEY, session);
  const headers = { 'content-type': 'application/json', 'x-z1-session': session };
  const getState = () => fetch('/api/state', { headers }).then(r => r.json());
  const saveState = value => fetch('/api/state', { method: 'PUT', headers, body: JSON.stringify(value) }).catch(() => null);
  const originalPersist = persist;
  persist = function () { originalPersist(); saveState(state); };
  const profileText = skill => skill.profileDescription || (skill.goal ? `正在通过 Agent：${skill.goal.replace(/[。.!！?？]+$/, '')}，并把这轮探索中形成的连接沉淀为个人画像。` : `正在使用「${skill.name}」探索值得认识的人与信息。`);
  const originalSaveSkill = saveSkill;
  saveSkill = function (form) { originalSaveSkill(form); const last = state.skills[state.skills.length - 1]; if (last) { last.profileTitle = last.name; last.profileDescription = profileText(last); persist(); } };
  const originalProfileView = profileView;
  profileView = function () { let html = originalProfileView(); const entries = state.skills.map(s => `<div class="profile-impression"><span>${skillIcon(s)}</span><div><h3>${esc(s.profileTitle || s.name)}</h3><p>${esc(profileText(s))}</p></div></div>`).join(''); if (entries) html = html.replace('</section><div class="demo-settings">', `<div class="profile-section"><h2>${icon('spark')} 由任务形成的画像</h2>${entries}</div></section><div class="demo-settings">`); return html; };

  let activeAgentPersonId = null;
  let agentChatData = null;
  function latestAgentRun() { return state.agentRuns?.[state.agentRuns.length - 1] || null; }
  function agentMessagesPanel() {
    const run = latestAgentRun();
    if (activeAgentPersonId && agentChatData?.person) {
      const p = agentChatData.person;
      return `<section class="agent-message-panel agent-chat-panel"><div class="agent-panel-head"><button class="text-button" data-action="agent-chat-back">← 返回任务结果</button><span class="agent-live-dot">Agent 在线</span></div><div class="agent-person-head"><div class="agent-person-avatar">${esc(p.name.slice(0, 1))}</div><div><h2>${esc(p.name)} 的 Agent</h2><p>${esc(p.role)}</p></div></div><div class="agent-context"><span>共同话题</span><b>${esc(p.topic)}</b></div><div class="agent-message-list">${agentChatData.messages.map(m => `<div class="agent-bubble ${m.from === 'me' ? 'mine' : ''}"><small>${m.from === 'me' ? '你' : `${esc(p.name)} 的 Agent`}</small><p>${esc(m.text)}</p></div>`).join('')}</div><form class="agent-compose" id="messages-agent-chat-form" data-person="${p.id}"><textarea id="messages-agent-chat-input" maxlength="500" placeholder="继续问问 TA 的 Agent…" required></textarea><button class="button small" type="submit">发送 ${icon('send')}</button></form></section>`;
    }
    if (!run) return '';
    const candidates = run.matches?.map(id => run.people?.[id]).filter(Boolean) || [];
    const stages = ['理解你的兴趣与任务', '匹配人物与共同话题', '整理推荐理由与交流线索'];
    return `<section class="agent-message-panel"><div class="agent-panel-head"><div><span class="eyebrow">AGENT TASK</span><h2>${esc(run.skill?.name || '最近一次探索')}</h2></div><span class="agent-status-pill ${run.status === 'completed' ? 'done' : ''}">${run.status === 'completed' ? '已完成' : '进行中'}</span></div><div class="agent-timeline">${stages.map((text, i) => `<div class="agent-stage ${i < (run.stage || 0) ? 'done' : i === (run.stage || 0) ? 'current' : ''}"><span>${i < (run.stage || 0) ? '✓' : i + 1}</span><p>${text}</p></div>`).join('')}</div>${run.timeline?.length ? `<div class="agent-summary">${esc(run.timeline[run.timeline.length - 1].text)}</div>` : ''}${candidates.length ? `<div class="agent-results-head"><div><span class="eyebrow">MATCHED PEOPLE</span><h3>这些人，值得先聊聊</h3></div><span class="muted">${candidates.length} 位候选人</span></div><div class="agent-person-grid">${candidates.map(p => `<article class="agent-person-card"><div class="agent-card-top"><div class="agent-person-avatar">${esc(p.name.slice(0, 1))}</div><div><h3>${esc(p.name)}</h3><p>${esc(p.role)}</p></div></div><div class="agent-tags">${p.tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</div><p class="agent-reason">${esc(p.reason)}</p><button class="button small wide" data-action="agent-chat" data-person="${p.id}">与 TA 的 Agent 交流</button></article>`).join('')}</div>` : '<div class="agent-empty">Agent 正在寻找合适的连接，请稍候…</div>'}</section>`;
  }
  const originalMessagesView = messagesView;
  messagesView = function () { const html = originalMessagesView(); return html.replace('<div class="chat-layout">', `${agentMessagesPanel()}<div class="chat-layout">`); };

  async function runFromServer(id) {
    const skill = state.skills.find(s => s.id === id);
    if (!skill) return;
    if (!skill.enabled) return toast('请先启用这个 Skill。');
    const response = await fetch('/api/runs', { method: 'POST', headers, body: JSON.stringify({ skill }) });
    const run = await response.json();
    state.agentRuns = [...(state.agentRuns || []), { ...run, skillId: id }];
    persist();
    go('messages');
    renderWorkspace();
    const poll = async () => {
      const current = await fetch(`/api/runs/${run.id}`, { headers }).then(r => r.json());
      state.agentRuns[state.agentRuns.length - 1] = { ...current, skillId: id };
      state.discoverIds = current.matches || state.discoverIds;
      persist();
      if (currentView === 'messages' && !activeAgentPersonId) renderWorkspace();
      if (current.status !== 'completed') setTimeout(poll, 650);
    };
    poll();
  }
  runSkill = runFromServer;

  function openAgentChat(personId) {
    fetch(`/api/agent-chats/${personId}/messages`, { method: 'POST', headers, body: JSON.stringify({}) })
      .then(r => r.json())
      .then(data => { activeAgentPersonId = personId; agentChatData = data; go('messages'); renderWorkspace(); setTimeout(() => { const list = document.querySelector('.agent-message-list'); if (list) list.scrollTop = list.scrollHeight; document.getElementById('messages-agent-chat-input')?.focus(); }, 0); });
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action="agent-chat"]');
    if (b) openAgentChat(b.dataset.person);
    if (e.target.closest('[data-action="agent-chat-back"]')) { activeAgentPersonId = null; agentChatData = null; renderWorkspace(); }
  });
  document.addEventListener('submit', async e => {
    if (e.target.id !== 'messages-agent-chat-form') return;
    e.preventDefault();
    const form = e.target;
    const input = form.querySelector('textarea');
    const text = input.value.trim();
    if (!text || !agentChatData) return;
    input.disabled = true;
    agentChatData = await fetch(`/api/agent-chats/${form.dataset.person}/messages`, { method: 'POST', headers, body: JSON.stringify({ text }) }).then(r => r.json());
    renderWorkspace();
    setTimeout(() => document.getElementById('messages-agent-chat-input')?.focus(), 0);
  });

  const style = document.createElement('style');
  style.textContent = `.agent-message-panel{margin:0 0 28px;padding:24px;background:linear-gradient(145deg,#fff,#f8faff);border:1px solid #e6ebf5;border-radius:22px;box-shadow:0 12px 30px rgba(35,68,132,.06)}.agent-panel-head{display:flex;align-items:flex-start;justify-content:space-between;gap:18px}.agent-panel-head h2{margin:5px 0 0;font-size:22px}.agent-status-pill,.agent-live-dot{display:inline-flex;align-items:center;gap:7px;padding:7px 11px;border-radius:999px;background:#eef2f8;color:#77849a;font-size:12px;font-weight:700}.agent-status-pill.done{background:#e9f8f1;color:#1b9b68}.agent-live-dot{background:#eaf8f1;color:#14855a}.agent-live-dot:before{content:'';width:7px;height:7px;border-radius:50%;background:#25b977;box-shadow:0 0 0 4px #d9f3e7}.agent-timeline{display:grid;grid-template-columns:repeat(3,1fr);gap:10px;margin:22px 0 16px}.agent-stage{display:flex;align-items:center;gap:9px;color:#a1acbd;font-size:13px}.agent-stage span{display:grid;place-items:center;width:23px;height:23px;border-radius:50%;background:#eef1f6;font-size:11px;font-weight:700}.agent-stage.current{color:#2459ec}.agent-stage.current span{background:#e8efff;color:#2459ec}.agent-stage.done{color:#27976a}.agent-stage.done span{background:#e5f7ee;color:#27976a}.agent-stage p{margin:0;color:inherit}.agent-summary{padding:13px 15px;border-radius:13px;background:#f2f5fb;color:#5c6d87;font-size:13px;line-height:1.7}.agent-results-head{display:flex;align-items:end;justify-content:space-between;margin:24px 0 12px}.agent-results-head h3{margin:4px 0 0;font-size:17px}.agent-person-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:13px}.agent-person-card{padding:17px;border:1px solid #e5eaf3;border-radius:16px;background:#fff;transition:transform .16s,box-shadow .16s}.agent-person-card:hover{transform:translateY(-2px);box-shadow:0 10px 24px rgba(35,68,132,.1)}.agent-card-top,.agent-person-head{display:flex;align-items:center;gap:11px}.agent-person-avatar{width:40px;height:40px;display:grid;place-items:center;border-radius:13px;background:linear-gradient(135deg,#dfe8ff,#f5dfe8);color:#3c5cbb;font-weight:800}.agent-person-card h3,.agent-person-head h2{margin:0;font-size:16px}.agent-person-card p,.agent-person-head p{margin:2px 0 0;color:#8793a7;font-size:12px}.agent-tags{display:flex;gap:6px;flex-wrap:wrap;margin:14px 0 10px}.agent-tags span{padding:4px 8px;border-radius:6px;background:#f1f4f9;color:#708099;font-size:11px}.agent-reason{min-height:44px!important;color:#60718b!important;line-height:1.7}.agent-person-card .button{margin-top:7px}.agent-empty{padding:28px;text-align:center;color:#8c98aa}.agent-chat-panel{padding-bottom:17px}.agent-chat-panel .agent-panel-head{align-items:center}.agent-chat-panel .text-button{padding:0}.agent-context{margin:20px 0 15px;padding:13px 15px;border-radius:13px;background:#f2f5fb;display:flex;flex-direction:column;gap:4px}.agent-context span{font-size:11px;color:#8b98ac}.agent-context b{font-size:14px;color:#455975}.agent-message-list{max-height:390px;overflow:auto;padding:3px 3px 10px}.agent-bubble{max-width:78%;margin:10px 0;padding:11px 14px;border-radius:14px 14px 14px 4px;background:#f0f3f8;color:#43546f}.agent-bubble.mine{margin-left:auto;border-radius:14px 14px 4px 14px;background:#2459ec;color:#fff}.agent-bubble small{display:block;margin-bottom:4px;font-size:10px;opacity:.68}.agent-bubble p{margin:0;color:inherit;font-size:13px;line-height:1.7}.agent-compose{display:flex;align-items:end;gap:10px;padding-top:13px;border-top:1px solid #edf0f5}.agent-compose textarea{flex:1;min-height:48px;max-height:110px;padding:11px 13px;border:1px solid #dfe5ef;border-radius:12px;resize:vertical;font-size:13px;background:#fff}.agent-compose textarea:focus{border-color:#8daaf6;outline:3px solid #e8efff}.agent-compose .button{flex:0 0 auto}.muted{font-size:12px;color:#8c98aa}@media(max-width:720px){.agent-message-panel{padding:17px;border-radius:17px}.agent-timeline{grid-template-columns:1fr;gap:7px}.agent-person-grid{grid-template-columns:1fr}.agent-results-head{align-items:start}.agent-bubble{max-width:90%}.agent-compose{align-items:stretch;flex-direction:column}.agent-compose .button{width:100%}}`;
  document.head.appendChild(style);

  getState().then(remote => { if (!remote || !remote.version) return; const localHasProgress = state.step !== 'auth' || state.skills?.length || state.impressions?.length || state.following?.length || Object.keys(state.chats || {}).length; const remoteHasProgress = remote.step !== 'auth' || remote.skills?.length || remote.impressions?.length || remote.following?.length || Object.keys(remote.chats || {}).length || remote.agentRuns?.length; if (remoteHasProgress || !localHasProgress) { state = { ...state, ...remote }; try { render(); } catch {} } else { saveState(state); } }).catch(() => {});
})();
