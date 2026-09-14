(() => {
  const SESSION_KEY = 'z1space-session';
  const session = localStorage.getItem(SESSION_KEY) || (crypto.randomUUID ? crypto.randomUUID() : `session-${Date.now()}`);
  localStorage.setItem(SESSION_KEY, session);
  const headers = { 'content-type': 'application/json', 'x-z1-session': session };
  const getState = () => fetch('/api/state', { headers }).then(r => r.json());
  const saveState = value => fetch('/api/state', { method: 'PUT', headers, body: JSON.stringify(value) }).catch(() => null);
  const originalRenderAuth = renderAuth;
  let authSession = null;
  let stayOnAuth = false;
  const sameZhihuUser = (snapshot, user) => Boolean(snapshot?.zhihuUser?.id && user?.id && snapshot.zhihuUser.id === user.id);
  const uniqueIds = values => [...new Set((values || []).filter(value => typeof value === 'string' && value))];
  function mergeCollection(target, incoming) {
    const positions = new Map(target.map((item, index) => [item.id, index]));
    for (const item of incoming) {
      const index = positions.get(item.id);
      if (index === undefined) { positions.set(item.id, target.length); target.push(item); }
      else target[index] = { ...target[index], ...item };
    }
  }
  function mergeServerRunData(run) {
    if (!run || typeof run !== 'object') return;
    const incomingPeople = Object.values(run.people || {}).filter(person => person && typeof person.id === 'string' && typeof person.name === 'string').map(person => ({
      ...person,
      initial: person.initial || String(person.name).slice(0, 1),
      color: person.color || 'violet',
      contentCount: Number.isFinite(Number(person.contentCount)) ? Number(person.contentCount) : 0,
      source: person.source || (person.url ? 'zhihu' : 'demo')
    }));
    const incomingPosts = Object.values(run.posts || {}).filter(post => post && typeof post.id === 'string' && typeof post.person === 'string' && typeof post.title === 'string').map(post => ({
      ...post,
      text: post.text || post.title,
      full: post.full || post.text || post.title,
      author: post.author || '',
      source: post.source || (post.url ? 'zhihu' : 'demo')
    }));
    mergeCollection(people, incomingPeople);
    mergeCollection(posts, incomingPosts);
    state.people = { ...(state.people || {}), ...Object.fromEntries(incomingPeople.map(person => [person.id, person])) };
    state.posts = { ...(state.posts || {}), ...Object.fromEntries(incomingPosts.map(post => [post.id, post])) };
    state.discoverIds = uniqueIds([...(state.discoverIds || []), ...(run.matches || [])]);
    state.contentIds = uniqueIds([...(state.contentIds || []), ...(run.contentMatches || [])]);
    state.feedIds = uniqueIds([...(state.feedIds || []), ...(run.feedIds || run.matches || [])]);
  }
  async function loadAuthSession() {
    try { const response = await fetch('/api/auth/session', { credentials: 'same-origin' }); authSession = await response.json(); return authSession; } catch { authSession = { mode: 'demo', authenticated: false, oauthConfigured: false }; return authSession; }
  }
  async function restoreExistingSpace(user) {
    const remote = await getState().catch(() => null);
    if (!remote || remote.step === 'auth' || !sameZhihuUser(remote, user)) return false;
    const userData = authSession?.userData || remote.zhihuUserData;
    const changed = state.name !== (user.fullname || state.name) || state.zhihuUser?.id !== user.id || state.zhihuUserData !== userData;
    state = { ...state, ...remote, name: user.fullname || remote.name, zhihuUser: user, zhihuUserData: userData };
    mergeServerRunData({ people: remote.people, posts: remote.posts, matches: remote.discoverIds, contentMatches: remote.contentIds, feedIds: remote.feedIds });
    if (migrateZhihuProfile() || changed) persist();
    render();
    return true;
  }
  function isRealZhihuProfile() { return state.profileSource === 'zhihu' && Boolean(state.zhihuUser); }
  function impressionSources() {
    if (state.interview?.complete) {
      const source = state.interview.usedPublicFacts ? '已读取的公开资料与本次回答' : '本次回答';
      return [`${source} 01`, `${source} 02`, `${source} 03`];
    }
    return ['本次回答 01', '本次回答 02', '本次回答 03'];
  }
  window.z1spaceImpressionSources = impressionSources;
  function zhihuImpressions(user, userData = {}) {
    const headline = String(user.headline || '').trim();
    const description = String(user.description || '').trim();
    const titles = Array.isArray(userData.contentItems) ? userData.contentItems.map(item => String(item.title || '').trim()).filter(Boolean).slice(0, 3) : [];
    return [
      headline ? `知乎公开介绍：${headline}` : '',
      description && description !== headline ? `知乎公开简介：${description}` : '',
      titles.length ? `公开表达：${titles.join('；')}` : ''
    ].filter(Boolean);
  }
  function applyZhihuUser(user) {
    if (!user) return;
    state.name = user.fullname || state.name;
    state.zhihuUser = user;
    if (authSession?.userData) state.zhihuUserData = authSession.userData;
    if (state.profileSource !== 'manual' && !state.interview?.complete) state.impressions = zhihuImpressions(user, state.zhihuUserData);
    state.profileSource = 'zhihu';
    if (state.step === 'auth') state.step = 'impressions';
    persist();
  }
  function migrateZhihuProfile() {
    if (!state.zhihuUser || state.profileSource === 'manual') return false;
    const changed = state.profileSource !== 'zhihu' || state.name !== state.zhihuUser.fullname;
    state.profileSource = 'zhihu';
    state.name = state.zhihuUser.fullname || state.name;
    if (!Array.isArray(state.impressions) || !state.impressions.length || state.impressions.join('') === initialImpressions.join('')) state.impressions = zhihuImpressions(state.zhihuUser, state.zhihuUserData);
    return changed;
  }
  renderAuth = function () {
    originalRenderAuth();
    const note = document.querySelector('.auth-card .demo-note');
    const button = document.getElementById('authorize');
    if (!button) return;
    button.disabled = true;
    button.onclick = () => {};
    loadAuthSession().then(async auth => {
      if (auth.authenticated && auth.user) {
        if (!stayOnAuth && await restoreExistingSpace(auth.user)) return;
        if (stayOnAuth) {
          if (note) note.textContent = '知乎账号已连接。确认资料无误后，可以继续创建你的画像。';
          button.innerHTML = '继续创建画像 ' + icon('arrow');
          button.disabled = false;
          button.onclick = () => { stayOnAuth = false; applyZhihuUser(auth.user); render(); };
          return;
        }
        applyZhihuUser(auth.user);
        render();
        return;
      }
      if (auth.oauthConfigured) {
        if (note) note.textContent = '知乎 OAuth 真实接入模式 · 只读取你授权的公开资料，OAuth Token 仅保存在服务端。';
        button.innerHTML = '同意授权，连接知乎 ' + icon('arrow');
        const consent = document.getElementById('consent');
        button.disabled = !consent?.checked;
        if (consent) consent.onchange = () => { button.disabled = !consent.checked; };
        button.onclick = () => { if (!consent?.checked) return; button.disabled = true; button.innerHTML = '<span class="loading"></span> 正在跳转知乎授权'; window.location.assign('/auth/zhihu/start'); };
      } else {
        if (note) note.textContent = '当前未配置知乎 OAuth 应用，暂时无法读取真实账号资料。';
        button.innerHTML = '暂时无法连接知乎';
        button.disabled = true;
      }
      const params = new URLSearchParams(location.search);
      if (params.get('auth') === 'error') toast(params.get('reason') || '知乎授权未完成，请重试。');
      if (params.get('auth') === 'success' && auth.user) { applyZhihuUser(auth.user); render(); }
      if (params.has('auth')) history.replaceState(null, '', location.pathname + location.hash);
    });
  };

  const originalPersist = persist;
  let stateSaveQueue = Promise.resolve();
  persist = function () {
    originalPersist();
    const snapshot = JSON.parse(JSON.stringify(state));
    // The API uses this server-side confirmation marker to authorize Skill runs.
    // Older local sessions only had step='done', so backfill the marker when the
    // profile is complete instead of making an already confirmed user redo onboarding.
    if (snapshot.step === 'done' && Array.isArray(snapshot.impressions) && snapshot.impressions.length === 3) {
      snapshot.profileVersion = Number.isInteger(snapshot.profileVersion) && snapshot.profileVersion > 0 ? snapshot.profileVersion : 1;
      snapshot.profileConfirmedAt = snapshot.profileConfirmedAt || new Date().toISOString();
    }
    stateSaveQueue = stateSaveQueue.then(() => saveState(snapshot));
  };
  const profileText = skill => skill.profileDescription || (skill.goal ? `正在通过 Agent：${skill.goal.replace(/[。.!！?？]+$/, '')}，并把这轮探索中形成的连接沉淀为个人画像。` : `正在使用「${skill.name}」探索值得认识的人与信息。`);
  const originalSaveSkill = saveSkill;
  saveSkill = function (form) {
    const existingIds = new Set(state.skills.map(skill => skill.id));
    originalSaveSkill(form);
    const last = state.skills[state.skills.length - 1];
    if (!last) return;
    last.profileTitle = last.name;
    last.profileDescription = profileText(last);
    persist();
    if (!existingIds.has(last.id)) void stateSaveQueue.then(() => runFromServer(last.id));
  };
  function profileContentCount(type) {
    const items = state.zhihuUserData?.contentItems || [];
    return items.filter(item => item.contentType === type).length;
  }
  const randomPick = items => items[Math.floor(Math.random() * items.length)];
  const shorten = (value, max = 128) => { const text = String(value || '').replace(/\s+/g, ' ').trim(); return text.length > max ? `${text.slice(0, max).trim()}…` : text; };
  const sentence = value => shorten(value, 156).replace(/[。！？!?]+$/, '');
  let interviewTransitionDirection = 'forward';

  function interviewQuestions() {
    const user = state.zhihuUser || {};
    const headline = String(user.headline || '').trim();
    const description = String(user.description || '').trim();
    const titles = Array.isArray(state.zhihuUserData?.contentItems) ? state.zhihuUserData.contentItems.map(item => String(item.title || '').trim()).filter(Boolean) : [];
    const hasPublicProfile = isRealZhihuProfile() && Boolean(headline || description || titles.length);
    const currentFocus = headline || description;
    return [
      {
        context: hasPublicProfile && currentFocus ? `从你的知乎公开介绍「${shorten(currentFocus, 38)}」出发` : '从一个开放的问题开始',
        question: hasPublicProfile && currentFocus
          ? `除了公开资料里的这句话，最近最值得你投入时间解决的问题是什么？`
          : randomPick(['最近让你反复琢磨、愿意投入时间的一件事是什么？', '如果接下来三个月只能专注一件事，你最想把什么事情做得更好？', '最近有什么具体问题，让你忍不住想继续追下去？']),
        hint: '可以从一个真实场景、正在推进的事，或你在意的变化说起。',
        placeholder: '比如：我正在尝试……因为我发现……'
      },
      {
        context: titles.length ? `你最近的公开表达里有「${shorten(titles[0], 34)}」` : (hasPublicProfile ? '结合你的公开资料脉络' : '继续了解你的思考方式'),
        question: titles.length
          ? '当你判断一个想法值不值得继续做时，通常最看重什么？'
          : randomPick(['遇到一个新想法时，你通常怎样判断它值得继续做？', '面对不确定的问题，你会先寻找证据、先动手尝试，还是先找人讨论？为什么？', '什么样的过程会让你觉得“这件事值得认真做下去”？']),
        hint: '没有标准答案。讲讲你的判断方式、一次经历或你常坚持的取舍。',
        placeholder: '我通常会先……因为……'
      },
      {
        context: hasPublicProfile ? '用最后一个问题，补全你期待的连接' : '最后，聊聊你想遇见怎样的人',
        question: randomPick(['在 Z1Space 里，你希望遇到怎样的人，展开什么样的对话？', '如果有人能带给你一种新的视角，你最希望 TA 擅长或经历过什么？', '什么样的交流会让你觉得“这次认识很值得”？']),
        hint: '可以说说你愿意分享什么，也可以说说你期待别人带来什么。',
        placeholder: '我希望认识愿意……的人，一起聊聊……'
      }
    ];
  }

  function ensureInterview() {
    const interview = state.interview;
    const validQuestions = Array.isArray(interview?.questions) && interview.questions.length === 3 && interview.questions.every(question => question && ['context', 'question', 'hint', 'placeholder'].every(key => typeof question[key] === 'string'));
    if (validQuestions && Array.isArray(interview.answers)) {
      const missingTitles = !Array.isArray(state.profileTitles) || state.profileTitles.length !== 3;
      const legacyUnknownText = /暂无一句话介绍|暂未提供足够信息|暂未读取到你的公开回答|不会据此臆测|公开资料也呈现出相近的线索/.test((state.impressions || []).join(''));
      if (interview.complete && (missingTitles || legacyUnknownText)) {
        const fallback = fallbackInterviewSynthesis(interview);
        if (missingTitles) state.profileTitles = fallback.titles;
        if (legacyUnknownText) state.impressions = fallback.impressions;
        interview.usedPublicFacts = false;
        if (!interview.synthesisRequested) {
          interview.synthesisRequested = true;
          void synthesizeInterviewProfile(interview).then(synthesis => {
            if (state.interview !== interview || !interview.complete) return;
            state.impressions = synthesis.impressions;
            state.profileTitles = synthesis.titles;
            interview.usedPublicFacts = synthesis.usedPublicFacts;
            interview.provider = synthesis.provider;
            persist();
            render();
          });
        }
        persist();
      }
      return interview;
    }
    const next = {
      questions: interviewQuestions(),
      answers: ['', '', ''],
      index: 0,
      complete: false,
      usedPublicFacts: false
    };
    state.interview = next;
    persist();
    return next;
  }

  function interviewIdentityCard() {
    const user = state.zhihuUser || {};
    const data = state.zhihuUserData || {};
    const headline = String(user.headline || user.description || '').trim();
    const connected = isRealZhihuProfile();
    const publicCounts = connected ? [
      data.answerCount === undefined ? '' : `<div class="source-line"><span>公开回答</span><b>${data.answerCount} 篇</b></div>`,
      data.articleCount === undefined ? '' : `<div class="source-line"><span>公开文章</span><b>${data.articleCount} 篇</b></div>`,
      Number.isFinite(Number(data.followeeCount)) ? `<div class="source-line"><span>关注用户</span><b>${Number(data.followeeCount)} 个</b></div>` : ''
    ].filter(Boolean).join('') : '';
    return `<aside class="identity-card interview-identity">${ownAvatar('big')}<div><h3>${esc(state.name || '知乎用户')}</h3><p>${esc(headline || (connected ? '知乎账号已连接' : '准备开始创建你的 Space'))}</p></div>${publicCounts ? `<div class="divider"></div>${publicCounts}` : ''}<div class="divider"></div><p class="demo-label">Agent 只会结合你授权的公开资料与本次主动回答生成画像，不展示技术标识或私密信息。</p></aside>`;
  }

  function interviewAnswerCore(answer) {
    const original = sentence(answer);
    let text = original;
    const prefix = /^(我想|我正在|我希望|我更看重|我通常会|我会|是否有|如果|关于|对于|在)/;
    while (prefix.test(text)) text = text.replace(prefix, '').trim();
    return text || original;
  }
  function fallbackInterviewTitle(answer, index) {
    return shorten(interviewAnswerCore(answer) || `回答 ${index + 1}`, 18);
  }
  function interviewImpressions(interview) {
    const answers = interview.answers.map(interviewAnswerCore);
    return [
      `你正在投入：${answers[0]}。`,
      `面对想法与行动，${answers[1]}是你在意的判断。`,
      `在新的连接中，你期待：${answers[2]}。`
    ].map(value => shorten(value, 400));
  }
  function fallbackInterviewSynthesis(interview) {
    return {
      titles: interview.answers.map(fallbackInterviewTitle),
      impressions: interviewImpressions(interview),
      usedPublicFacts: false,
      provider: 'fallback'
    };
  }
  function validInterviewSynthesis(value) {
    return value && Array.isArray(value.titles) && value.titles.length === 3 && value.titles.every(item => typeof item === 'string' && item.trim())
      && Array.isArray(value.impressions) && value.impressions.length === 3 && value.impressions.every(item => typeof item === 'string' && item.trim());
  }
  async function synthesizeInterviewProfile(interview) {
    const fallback = fallbackInterviewSynthesis(interview);
    try {
      const response = await fetch('/api/profile/synthesis', {
        method: 'POST',
        headers,
        credentials: 'same-origin',
        body: JSON.stringify({ answers: interview.answers })
      });
      const result = await response.json();
      if (!response.ok || !validInterviewSynthesis(result)) return fallback;
      return {
        titles: result.titles.map(item => shorten(item, 24)),
        impressions: result.impressions.map(item => shorten(item, 400)),
        usedPublicFacts: Boolean(result.usedPublicFacts),
        provider: result.provider === 'deepseek' ? 'deepseek' : 'fallback'
      };
    } catch {
      return fallback;
    }
  }

  function renderInterviewResult(interview) {
    document.title = 'Z1Space · 你的画像';
    app.innerHTML = header(1) + `<main class="onboard-container interview-onboarding"><div class="onboard-title"><div><span class="eyebrow">STEP 02 / YOUR AGENT</span><h1>这是你的 Z1Space 画像。</h1><p>Agent 已结合你的三次回答${interview.usedPublicFacts ? '与已读取的知乎公开资料' : ''}，整理成可编辑的第一版画像。</p></div><span class="pill">${icon('spark')} 已生成画像</span></div><div class="onboard-grid">${interviewIdentityCard()}<div class="interview-result interview-card interview-card-enter"><div class="interview-result-head"><div><span class="interview-kicker">YOUR Z1SPACE PROFILE</span><h2>先看看，哪里最像你。</h2></div><button class="text-button interview-restart" data-action="interview-restart">重新回答</button></div>${impressionFields(state.impressions)}<div class="form-actions">${button('interview-back', '上一步', 'button ghost')}<div>${button('save-impressions', '保存并确认画像', 'button secondary')}${button('continue-impressions', '保存并继续 ' + icon('arrow'))}</div></div></div></div></main>`;
    bindImpressionCounters();
  }

  function renderInterviewQuestion(interview) {
    const index = Math.max(0, Math.min(2, Number(interview.index) || 0));
    interview.index = index;
    const question = interview.questions[index];
    const answered = String(interview.answers[index] || '');
    const progress = ((index + 1) / 3) * 100;
    const connected = isRealZhihuProfile();
    const transitionClass = interviewTransitionDirection === 'back' ? 'interview-card-back-enter' : 'interview-card-enter';
    interviewTransitionDirection = 'forward';
    document.title = 'Z1Space · 创建分身';
    app.innerHTML = header(1) + `<main class="onboard-container interview-onboarding"><div class="onboard-title"><div><span class="eyebrow">STEP 02 / YOUR AGENT</span><h1>让 Agent 先认识你。</h1><p>用三个问题补全你希望 Agent 认识的部分，再生成属于你的 Z1Space 画像。</p></div><span class="pill">${icon('check')} ${connected ? '知乎公开资料已连接' : '开始创建画像'}</span></div><div class="onboard-grid">${interviewIdentityCard()}<section class="interview-card ${transitionClass}" data-interview-card><div class="interview-card-top"><div><span class="interview-kicker">AGENT INTERVIEW</span><span class="interview-question-number">问题 0${index + 1} / 03</span></div><span class="interview-status">正在倾听</span></div><div class="interview-progress" aria-label="访谈进度：第 ${index + 1} 题，共 3 题"><span style="width:${progress}%"></span></div><div class="interview-progress-labels"><span class="done">认识方向</span><span class="${index > 0 ? 'done' : ''}">了解方法</span><span class="${index > 1 ? 'done' : ''}">期待连接</span></div><div class="interview-question"><span>${esc(question.context)}</span><h2>${esc(question.question)}</h2><p>${esc(question.hint)}</p></div><label class="interview-answer-label" for="interview-answer">你的回答</label><textarea id="interview-answer" class="interview-answer" maxlength="420" placeholder="${esc(question.placeholder)}" aria-describedby="interview-answer-note">${esc(answered)}</textarea><div class="interview-answer-meta" id="interview-answer-note"><span>自然地说就好，写下真实想法即可。</span><span data-interview-counter>${answered.length}/420</span></div><div class="interview-actions">${button('interview-back', '上一步', 'button ghost')}<button type="button" class="button interview-next" data-action="interview-next">${index === 2 ? '生成我的画像 ' + icon('spark') : '回答完毕，下一题 ' + icon('arrow')}</button></div></section></div></main>`;
    const answer = document.getElementById('interview-answer');
    answer?.focus();
  }

  renderImpressions = function () {
    const interview = ensureInterview();
    if (interview.complete) renderInterviewResult(interview);
    else renderInterviewQuestion(interview);
  };

  document.addEventListener('input', event => {
    const input = event.target;
    if (input?.id !== 'interview-answer') return;
    const counter = document.querySelector('[data-interview-counter]');
    if (counter) counter.textContent = `${input.value.length}/420`;
  });

  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    if (!target) return;
    if (target.dataset.action === 'interview-restart') {
      const interview = ensureInterview();
      delete state.profileTitles;
      delete state.interview;
      persist();
      renderImpressions();
      return;
    }
    if (target.dataset.action === 'interview-back') {
      const interview = ensureInterview();
      const answer = document.getElementById('interview-answer');
      const currentAnswer = String(answer?.value || '').trim();
      if (!interview.complete && currentAnswer) interview.answers[Math.max(0, Math.min(2, Number(interview.index) || 0))] = currentAnswer;
      target.disabled = true;
      document.querySelector('.interview-card')?.classList.add('is-leaving-back');
      window.setTimeout(() => {
        if (interview.complete) {
          interview.complete = false;
          interview.index = 2;
        } else if (Number(interview.index) > 0) {
          interview.index = Number(interview.index) - 1;
        } else {
          stayOnAuth = true;
          state.step = 'auth';
        }
        interviewTransitionDirection = state.step === 'auth' ? 'forward' : 'back';
        persist();
        render();
      }, 240);
      return;
    }
    if (target.dataset.action !== 'interview-next') return;
    const interview = ensureInterview();
    const answer = document.getElementById('interview-answer');
    const value = String(answer?.value || '').trim();
    if (!value) {
      toast('写下一点真实想法，让 Agent 更了解你。');
      answer?.focus();
      return;
    }
    const index = Math.max(0, Math.min(2, Number(interview.index) || 0));
    interview.answers[index] = value;
    const card = document.querySelector('[data-interview-card]');
    target.disabled = true;
    card?.classList.add('is-leaving');
    window.setTimeout(async () => {
      if (index !== 2) {
        interview.index = index + 1;
        persist();
        renderImpressions();
        return;
      }
      document.querySelector('.interview-status')?.replaceChildren(document.createTextNode('正在整理画像'));
      try {
        const synthesis = await synthesizeInterviewProfile(interview);
        state.impressions = synthesis.impressions;
        state.profileTitles = synthesis.titles;
        interview.usedPublicFacts = synthesis.usedPublicFacts;
        interview.provider = synthesis.provider;
      } catch {
        const fallback = fallbackInterviewSynthesis(interview);
        state.impressions = fallback.impressions;
        state.profileTitles = fallback.titles;
        interview.usedPublicFacts = false;
        interview.provider = 'fallback';
      }
      interview.complete = true;
      persist();
      renderImpressions();
    }, 240);
  });

  const interviewStyle = document.createElement('style');
  interviewStyle.textContent = `.interview-onboarding{max-width:1110px}.interview-card{min-height:500px;padding:30px;border:1px solid #dfe7f6;border-radius:20px;background:radial-gradient(circle at 100% 0,#eef4ff 0,rgba(238,244,255,0) 34%),#fff;box-shadow:0 18px 42px rgba(30,62,124,.07);overflow:hidden}.interview-card-enter{animation:interview-card-in .42s cubic-bezier(.22,1,.36,1) both}.interview-card-back-enter{animation:interview-card-back-in .42s cubic-bezier(.22,1,.36,1) both}.interview-card.is-leaving,.interview-card.is-leaving-back{pointer-events:none}.interview-card.is-leaving{animation:interview-card-out .24s cubic-bezier(.55,0,1,.45) both}.interview-card.is-leaving-back{animation:interview-card-back-out .24s cubic-bezier(.55,0,1,.45) both}.interview-card-top,.interview-result-head{display:flex;align-items:flex-start;justify-content:space-between;gap:16px}.interview-kicker{display:block;color:#2459ec;font-size:11px;font-weight:800;letter-spacing:.13em}.interview-question-number{display:block;margin-top:5px;color:#8491a5;font-size:13px}.interview-status{padding:6px 10px;border-radius:999px;background:#eef4ff;color:#3864c7;font-size:12px}.interview-progress{height:8px;margin-top:25px;overflow:hidden;border-radius:999px;background:#e8edf6}.interview-progress span{display:block;height:100%;border-radius:inherit;background:linear-gradient(90deg,#2459ec,#6b96ff);box-shadow:0 2px 8px rgba(36,89,236,.28);transition:width .5s cubic-bezier(.22,1,.36,1)}.interview-progress-labels{display:grid;grid-template-columns:repeat(3,1fr);margin-top:9px;color:#9aa6b8;font-size:11px}.interview-progress-labels span:nth-child(2){text-align:center}.interview-progress-labels span:nth-child(3){text-align:right}.interview-progress-labels .done{color:#4d70bd;font-weight:700}.interview-question{padding:46px 0 26px}.interview-question>span{display:inline-flex;padding:6px 10px;border-radius:8px;background:#f4f7fc;color:#7386a4;font-size:12px}.interview-question h2{max-width:720px;margin:16px 0 10px;font-size:clamp(24px,3vw,32px);letter-spacing:-.03em;line-height:1.38}.interview-question p{max-width:650px;margin:0;font-size:14px}.interview-answer-label{display:block;margin-bottom:9px;color:#455570;font-size:14px;font-weight:700}.interview-answer{width:100%;min-height:122px;padding:16px;border:1px solid #dfe6f0;border-radius:14px;resize:vertical;background:#fbfcff;color:#40516b;font-size:15px;line-height:1.8;transition:border-color .18s,box-shadow .18s,background .18s}.interview-answer::placeholder{color:#a2adbd}.interview-answer:focus{border-color:#89a8fa;outline:0;background:#fff;box-shadow:0 0 0 4px #e9efff}.interview-answer-meta{display:flex;justify-content:space-between;gap:16px;margin-top:8px;color:#98a4b6;font-size:12px}.interview-actions{display:flex;align-items:center;justify-content:space-between;gap:14px;margin-top:29px;padding-top:20px;border-top:1px solid #e9edf4}.interview-next{min-width:176px}.interview-result h2{margin:6px 0 0;font-size:24px}.interview-restart{padding:6px 0;color:#6c7d95;font-size:13px}.interview-result .impression-list{margin-top:27px}@keyframes interview-card-in{from{opacity:0;transform:translate3d(20px,8px,0)}to{opacity:1;transform:translate3d(0,0,0)}}@keyframes interview-card-out{to{opacity:0;transform:translate3d(-24px,0,0)}}@keyframes interview-card-back-in{from{opacity:0;transform:translate3d(-20px,8px,0)}to{opacity:1;transform:translate3d(0,0,0)}}@keyframes interview-card-back-out{to{opacity:0;transform:translate3d(24px,0,0)}}@media(max-width:720px){.interview-card{min-height:0;padding:22px;border-radius:17px}.interview-question{padding:32px 0 21px}.interview-question h2{font-size:25px}.interview-actions{align-items:stretch;flex-direction:column-reverse}.interview-next{width:100%}.interview-answer-meta{align-items:flex-start;flex-direction:column;gap:2px}.interview-result-head{align-items:flex-start}.interview-result .form-actions{margin-top:20px}}@media(prefers-reduced-motion:reduce){.interview-card-enter,.interview-card-back-enter,.interview-card.is-leaving,.interview-card.is-leaving-back{animation:none}.interview-progress span{transition:none}}`;
  document.head.appendChild(interviewStyle);

  const originalProfileView = profileView;
  profileView = function () { let html = originalProfileView(); const entries = state.skills.map(s => `<div class="profile-impression"><span>${skillIcon(s)}</span><div><h3>${esc(s.profileTitle || s.name)}</h3><p>${esc(profileText(s))}</p></div></div>`).join(''); if (entries) html = html.replace('</section><div class="demo-settings">', `<div class="profile-section"><h2>${icon('spark')} 由任务形成的画像</h2>${entries}</div></section><div class="demo-settings">`); return html; };

  let activeAgentPersonId = null;
  let a2aSessionData = null;
  let agentChatData = null;
  function latestAgentRun() { return state.agentRuns?.[state.agentRuns.length - 1] || null; }
  function agentMessagesPanel() {
    const run = latestAgentRun();
    if (activeAgentPersonId && agentChatData?.person) {
      const p = agentChatData.person;
      return `<section class="agent-message-panel agent-chat-panel"><div class="agent-panel-head"><button class="text-button" data-action="agent-chat-back">← 返回任务结果</button><span class="agent-live-dot">Agent 在线</span></div><div class="agent-person-head"><div class="agent-person-avatar">${esc(p.name.slice(0, 1))}</div><div><h2>${esc(p.name)} 的 Agent</h2><p>${esc(p.role)}</p></div></div><div class="agent-context"><span>共同话题</span><b>${esc(p.topic)}</b></div><div class="agent-message-list">${agentChatData.messages.map(m => `<div class="agent-bubble ${m.from === 'me' ? 'mine' : ''}"><small>${m.from === 'me' ? '你' : `${esc(p.name)} 的 Agent`}</small><p>${esc(m.text)}</p></div>`).join('')}</div><form class="agent-compose" id="messages-agent-chat-form" data-person="${p.id}"><textarea id="messages-agent-chat-input" maxlength="500" placeholder="继续问问 TA 的 Agent…" required></textarea><button class="button small" type="submit">发送 ${icon('send')}</button></form></section>`;
    }
    if (!run) return '';
    const candidates = run.matches?.map(id => run.people?.[id] || state.people?.[id]).filter(Boolean) || [];
    const stages = ['理解你的兴趣与任务', '匹配人物与共同话题', '整理推荐理由与交流线索'];
    return `<section class="agent-message-panel"><div class="agent-panel-head"><div><span class="eyebrow">AGENT TASK</span><h2>${esc(run.skill?.name || '最近一次探索')}</h2></div><span class="agent-status-pill ${run.status === 'completed' ? 'done' : ''}">${run.status === 'completed' ? '已完成' : '进行中'}</span></div><div class="agent-timeline">${stages.map((text, i) => `<div class="agent-stage ${i < (run.stage || 0) ? 'done' : i === (run.stage || 0) ? 'current' : ''}"><span>${i < (run.stage || 0) ? '✓' : i + 1}</span><p>${text}</p></div>`).join('')}</div>${run.timeline?.length ? `<div class="agent-summary">${esc(run.timeline[run.timeline.length - 1].text)}</div>` : ''}${candidates.length ? `<div class="agent-results-head"><div><span class="eyebrow">MATCHED PEOPLE</span><h3>这些人，值得先聊聊</h3></div><span class="muted">${candidates.length} 位候选人</span></div><div class="agent-person-grid">${candidates.map(p => `<article class="agent-person-card"><div class="agent-card-top"><div class="agent-person-avatar">${esc(p.name.slice(0, 1))}</div><div><h3>${esc(p.name)}</h3><p>${esc(p.role)}</p></div></div><div class="agent-tags">${p.tags.map(tag => `<span>${esc(tag)}</span>`).join('')}</div><p class="agent-reason">${esc(p.reason)}</p><button class="button small wide" data-action="agent-chat" data-person="${p.id}" data-topic="${esc(p.topic || '')}">让双方 Agent 先聊聊</button></article>`).join('')}</div>` : '<div class="agent-empty">Agent 正在寻找合适的连接，请稍候…</div>'}</section>`;
  }
  const originalMessagesView = messagesView;
  messagesView = function () { const html = originalMessagesView(); return html.replace('<div class="chat-layout">', `${agentMessagesPanel()}<div class="chat-layout">`); };

  async function runFromServer(id) {
    const skill = state.skills.find(s => s.id === id);
    if (!skill) return;
    if (!skill.enabled) return toast('请先启用这个 Skill。');
    let response;
    let run;
    try {
      response = await fetch('/api/runs', { method: 'POST', headers, body: JSON.stringify({ skill }) });
      run = await response.json().catch(() => ({}));
    } catch {
      toast('Skill 启动失败，请检查网络后重试。');
      return;
    }
    if (!response.ok || !run.id) {
      const messages = {
        PROFILE_NOT_CONFIRMED: '请先保存并确认你的画像，再运行 Skill。',
        SKILL_DISABLED: '请先启用这个 Skill。',
        SKILL_NOT_FOUND: '这个 Skill 已不存在，请刷新页面后重试。'
      };
      toast(messages[run.error] || 'Skill 启动失败，请刷新页面后重试。');
      return;
    }
    mergeServerRunData(run);
    state.agentRuns = [...(state.agentRuns || []), { ...run, skillId: id }];
    persist();
    go('messages');
    renderWorkspace();
    const poll = async () => {
      let currentResponse;
      let current;
      try {
        currentResponse = await fetch(`/api/runs/${run.id}`, { headers });
        current = await currentResponse.json().catch(() => ({}));
      } catch {
        toast('Skill 状态获取失败，请刷新页面后重试。');
        return;
      }
      if (!currentResponse.ok || !current?.id) {
        toast('Skill 状态获取失败，请刷新页面后重试。');
        return;
      }
      mergeServerRunData(current);
      const runIndex = state.agentRuns.findIndex(item => item.id === run.id);
      const next = { ...current, skillId: id };
      if (runIndex === -1) state.agentRuns = [...(state.agentRuns || []), next];
      else state.agentRuns[runIndex] = next;
      persist();
      if (currentView === 'messages' && !activeAgentPersonId) renderWorkspace();
      if (current.status === 'running') setTimeout(poll, 650);
      else if (current.status === 'failed') toast(current.llmError || current.timeline?.[current.timeline.length - 1]?.text || 'Skill 执行失败，请重试。');
    };
    void poll();
  }
  runSkill = runFromServer;

  async function openAgentChat(personId, topic) {
    try {
      const found = await fetch(`/api/discover/people?q=${encodeURIComponent(topic || personId)}&limit=10`, { headers }).then(r => r.json());
      const recommendation = (found.recommendations || []).find(item => item.targetId === personId && item.a2aEligible);
      if (recommendation) {
        a2aSessionData = await fetch('/api/a2a-sessions', { method: 'POST', headers, body: JSON.stringify({ recommendationId: recommendation.id, idempotencyKey: crypto.randomUUID() }) }).then(r => r.json());
        activeAgentPersonId = null; agentChatData = null; go('messages'); renderWorkspace();
        const poll = async () => { const current = await fetch(`/api/a2a-sessions/${a2aSessionData.id}`, { headers }).then(r => r.json()); a2aSessionData = current; if (currentView === 'messages') renderWorkspace(); if (current.status === 'running' || current.status === 'observing' || current.status === 'created') setTimeout(poll, 500); }; poll();
        return;
      }
      const data = await fetch(`/api/agent-chats/${personId}/messages`, { method: 'POST', headers, body: JSON.stringify({}) }).then(r => r.json());
      activeAgentPersonId = personId; agentChatData = data; go('messages'); renderWorkspace();
    } catch (error) { toast('暂时无法启动 Agent 交流，请稍后重试。'); }
  }

  document.addEventListener('click', e => {
    const b = e.target.closest('[data-action="agent-chat"]');
    if (b) openAgentChat(b.dataset.person, b.dataset.topic);
    if (e.target.closest('[data-action="agent-chat-back"]')) { activeAgentPersonId = null; agentChatData = null; a2aSessionData = null; renderWorkspace(); }
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

  function closeAccountMenu() {
    const trigger = document.querySelector('[data-action="toggle-account-menu"]');
    const panel = document.getElementById('account-menu-panel');
    if (trigger) trigger.setAttribute('aria-expanded', 'false');
    if (panel) panel.hidden = true;
  }
  async function logout() {
    const button = document.querySelector('[data-action="logout"]');
    if (button) button.disabled = true;
    try {
      const response = await fetch('/auth/logout', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('LOGOUT_FAILED');
    } catch {
      if (button) button.disabled = false;
      toast('退出登录失败，请稍后重试。');
      return;
    }
    localStorage.removeItem('z1space-prototype-v1');
    authSession = null;
    stayOnAuth = false;
    state = fresh();
    history.replaceState(null, '', location.pathname);
    render();
  }
  async function deleteAccount() {
    if (!window.confirm('注销账号会清除你在 Z1Space 的画像、Skills、关注、收藏和聊天记录，并从头开始初始化画像。确定继续吗？')) return;
    const button = document.querySelector('[data-action="delete-account"]');
    if (button) button.disabled = true;
    try {
      const response = await fetch('/auth/delete-account', { method: 'POST', credentials: 'same-origin' });
      if (!response.ok) throw new Error('DELETE_ACCOUNT_FAILED');
    } catch {
      if (button) button.disabled = false;
      toast('注销账号失败，请稍后重试。');
      return;
    }
    localStorage.removeItem('z1space-prototype-v1');
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem('z1space-demo-user');
    location.replace(location.pathname);
  }
  document.addEventListener('click', event => {
    const target = event.target.closest('[data-action]');
    const action = target?.dataset.action;
    if (action === 'toggle-account-menu') {
      const panel = document.getElementById('account-menu-panel');
      const open = panel?.hidden;
      closeAccountMenu();
      if (panel && open) {
        panel.hidden = false;
        target.setAttribute('aria-expanded', 'true');
      }
      return;
    }
    if (action === 'logout') {
      logout();
      return;
    }
    if (action === 'delete-account') {
      deleteAccount();
      return;
    }
    if (!event.target.closest('.account-menu')) closeAccountMenu();
  });

  if (state.step === 'auth') {
    renderAuth();
  } else {
    render();
    loadAuthSession().then(auth => {
      if (!auth.authenticated || !auth.user) return;
      if (state.zhihuUser?.id && state.zhihuUser.id !== auth.user.id) {
        state = fresh();
        applyZhihuUser(auth.user);
        render();
        return;
      }
      const previousUserId = state.zhihuUser?.id;
      applyZhihuUser(auth.user);
      if (previousUserId !== auth.user.id || state.profileSource === 'zhihu') render();
    }).catch(() => {});
  }



  /* F05 真人聊天：服务端持久化的邀请、会话和消息。与 Agent 对话保持独立。 */
  const humanDemoUser = new URLSearchParams(location.search).get('demoUser') || localStorage.getItem('z1space-demo-user') || 'a';
  localStorage.setItem('z1space-demo-user', humanDemoUser);
  const humanHeaders = { ...headers, 'x-z1-demo-user': humanDemoUser };
  let humanOverview = null;
  let humanConversation = null;
  let humanPoll = null;
  const humanApi = async (path, options = {}) => {
    const response = await fetch(path, { ...options, headers: { ...humanHeaders, ...(options.headers || {}) } });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '请求失败');
    return data;
  };
  const humanError = error => toast(({ INVITATION_NOT_FOUND: '邀请不存在或链接已失效', INVITATION_ALREADY_CLAIMED: '该邀请已被其他会话认领', FORBIDDEN: '你没有权限访问这段会话', INVITATION_NOT_CLAIMED: '请先打开邀请链接完成认领' }[error.message] || error.message || '操作失败'));
  const humanName = p => p?.name || '对方';
  const humanStatus = { pending: '等待确认', accepted: '已连接', rejected: '已拒绝', withdrawn: '已撤回', expired: '已过期' };
  const humanPanel = () => {
    const overview = humanOverview || { invitations: [], conversations: [], me: { name: '本地演示身份' } };
    const invitations = overview.invitations || [];
    const incoming = invitations.filter(i => i.recipient?.id === overview.me.id && i.sender?.id !== overview.me.id);
    const outgoing = invitations.filter(i => i.sender?.id === overview.me.id);
    const selected = humanConversation;
    const initials = name => esc((name || '对').slice(0, 1));
    const preview = c => c.lastMessage?.text || `围绕「${c.topic}」开始交流`;
    const timeLabel = value => value ? new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '';
    const list = overview.conversations.map(c => `<button class="human-chat-item ${selected?.id === c.id ? 'active' : ''}" data-human-open="${esc(c.id)}"><span class="human-chat-avatar">${initials(humanName(c.other))}</span><span class="human-chat-copy"><b>${esc(humanName(c.other))}</b><small>${esc(preview(c))}</small></span><span class="human-chat-meta"><time>${timeLabel(c.lastMessage?.createdAt || c.updatedAt)}</time>${c.unread ? `<em>${c.unread}</em>` : ''}</span></button>`).join('');
    const inviteRows = [...incoming, ...outgoing].map(i => `<div class="human-invite-row"><div><b>${i.sender?.id === overview.me.id ? '发给' : '来自'} ${esc(i.sender?.id === overview.me.id ? i.recipientName : humanName(i.sender))}</b><small>${esc(i.topic)} · ${humanStatus[i.status] || i.status}</small></div>${i.status === 'pending' && i.recipient?.id === overview.me.id ? `<span><button class="button small" data-human-act="accept" data-id="${i.id}">接受</button> <button class="button secondary small" data-human-act="reject" data-id="${i.id}">拒绝</button></span>` : i.status === 'pending' && i.sender?.id === overview.me.id ? `<span><button class="button secondary small" data-human-act="withdraw" data-id="${i.id}">撤回</button>${i.shareToken ? ` <button class="text-button" data-human-copy="${i.id}" data-token="${i.shareToken}">复制链接</button>` : ''}</span>` : ''}</div>`).join('');
    const detail = selected ? `<section class="human-chat-detail"><header class="human-chat-head"><button class="text-button" data-human-back>← 返回消息列表</button><div class="human-chat-person"><span class="human-chat-avatar">${initials(humanName(selected.other))}</span><div><b>${esc(humanName(selected.other))}</b><small>真人会话 · 本地演示</small></div></div><span class="pill">点对点</span></header><div class="human-topic">共同话题：${esc(selected.topic)}</div><div class="human-message-list">${selected.messages.map(m => `<div class="human-message ${m.senderId === overview.me.id ? 'mine' : ''}"><small>${m.senderId === overview.me.id ? '你' : esc(humanName(selected.members[m.senderId]))}</small><p>${esc(m.text)}</p></div>`).join('') || '<div class="human-empty">会话已建立，发出第一句话吧。</div>'}</div><form id="human-message-form"><textarea id="human-message-input" maxlength="1000" required placeholder="写下你想说的话…"></textarea><button class="button small" type="submit">发送 ${icon('send')}</button></form></section>` : '';
    return `<section class="human-message-panel"><div class="human-panel-title"><div><span class="eyebrow">REAL PEOPLE</span><h2>真人消息</h2></div><span class="human-demo-badge">本地演示身份：${esc(overview.me.name)}</span></div>${inviteRows ? `<div class="human-invites"><h3>邀请</h3>${inviteRows}</div>` : ''}${selected ? detail : `<div class="human-inbox-list">${list || '<div class="human-empty">暂无已连接会话<br><small>从人物卡片发起一条真人邀请吧</small></div>'}</div>`}</section>`;
  };
  const refreshHuman = async (conversationId = humanConversation?.id) => {
    try {
      const nextOverview = await humanApi('/api/human/overview');
      const nextConversation = conversationId ? await humanApi(`/api/human/conversations/${conversationId}`) : null;
      const changed = JSON.stringify(nextOverview) !== JSON.stringify(humanOverview) || JSON.stringify(nextConversation) !== JSON.stringify(humanConversation);
      humanOverview = nextOverview;
      if (nextConversation) {
        humanConversation = nextConversation;
        const seq = nextConversation.messages.at(-1)?.seq || 0;
        if (seq) humanApi(`/api/human/conversations/${conversationId}/read`, { method: 'POST', body: JSON.stringify({ seq }) }).catch(() => null);
      }
      if (changed && currentView === 'messages' && document.activeElement?.id !== 'human-message-input') renderWorkspace();
    } catch (error) { humanError(error); }
  };
  const originalHumanMessagesView = messagesView;
  messagesView = function () { return `${originalHumanMessagesView()}${humanPanel()}`; };
  function inviteHumanDialog(personId, postId) {
    const person = lookup(personId); const post = posts.find(x => x.id === postId); const topic = post?.title || person?.topic || '共同兴趣';
    if (!person) return;
    showDialog(`邀请 ${person.name} 开始真人对话`, `<div class="person-top">${avatar(person)}<div><b>${esc(person.name)}</b><div class="person-subtitle">${esc(person.role)}</div></div></div><div class="summary-box"><span class="eyebrow">共同话题</span><br>${esc(topic)}</div><form id="human-invite-form" data-person="${esc(person.id)}" data-name="${esc(person.name)}" data-topic="${esc(topic)}"><div class="field"><label for="human-invite-text">写一句邀请开场白</label><textarea id="human-invite-text" maxlength="500" required>你好，看到你分享的内容，我也在关注「${esc(topic)}」。想听听你的实践经历，也很愿意交换我的想法。</textarea><small>邀请将生成一个链接，只有对方打开并接受后才会建立会话。</small></div></form><div class="demo-note">本地演示模式 · 当前身份是 ${esc((humanOverview?.me?.name) || '演示用户 A')}，不会向知乎发送消息。</div>`, button('close-dialog','取消','button secondary') + '<button type="submit" form="human-invite-form" class="button">创建真人邀请</button>');
  }
  document.addEventListener('click', async e => {
    const invite = e.target.closest('[data-action="invite"]');
    if (invite) { e.preventDefault(); e.stopImmediatePropagation(); await refreshHuman(); inviteHumanDialog(invite.dataset.id, invite.dataset.post); return; }
    const open = e.target.closest('[data-human-open]');
    if (open) { e.preventDefault(); humanConversation = await humanApi(`/api/human/conversations/${open.dataset.humanOpen}`); go('messages'); renderWorkspace(); return; }
    if (e.target.closest('[data-human-back]')) { humanConversation = null; renderWorkspace(); return; }
    const act = e.target.closest('[data-human-act]');
    if (act) { e.preventDefault(); try { await humanApi(`/api/human/invitations/${act.dataset.id}/${act.dataset.humanAct}`, { method: 'POST', body: '{}' }); await refreshHuman(); closeDialog(); toast(act.dataset.humanAct === 'accept' ? '邀请已接受，可以开始聊天。' : '邀请状态已更新。'); } catch (error) { humanError(error); } return; }
    const copy = e.target.closest('[data-human-copy]');
    if (copy) { const url = `${location.origin}/?invite=${encodeURIComponent(copy.dataset.humanCopy)}&token=${encodeURIComponent(copy.dataset.token)}&demoUser=b`; await navigator.clipboard?.writeText(url); toast('邀请链接已复制，发给对方后等待对方接受。'); return; }
  }, true);
  document.addEventListener('submit', async e => {
    if (e.target.id === 'human-invite-form') { e.preventDefault(); e.stopImmediatePropagation(); const f = e.target; try { const result = await humanApi('/api/human/invitations', { method: 'POST', body: JSON.stringify({ recipientPersonId: f.dataset.person, recipientName: f.dataset.name, topic: f.dataset.topic, draft: f.querySelector('textarea').value }) }); closeDialog(); await refreshHuman(); const share = `${location.origin}/?invite=${encodeURIComponent(result.id)}&token=${encodeURIComponent(result.shareToken)}&demoUser=b`; await navigator.clipboard?.writeText(share); go('messages'); renderWorkspace(); toast('真人邀请已创建，链接已复制。'); } catch (error) { humanError(error); } return; }
    if (e.target.id === 'human-message-form') { e.preventDefault(); e.stopImmediatePropagation(); const input = e.target.querySelector('textarea'); const text = input.value.trim(); if (!text || !humanConversation) return; input.disabled = true; try { await humanApi(`/api/human/conversations/${humanConversation.id}/messages`, { method: 'POST', body: JSON.stringify({ text, clientMessageId: crypto.randomUUID() }) }); input.value = ''; await refreshHuman(humanConversation.id); } catch (error) { humanError(error); } finally { input.disabled = false; } return; }
  }, true);
  const originalGo = go;
  go = function (view, id) { originalGo(view, id); if (view === 'messages') refreshHuman(id); };
  const params = new URLSearchParams(location.search);
  if (params.get('invite') && params.get('token')) (async () => { try { const result = await humanApi(`/api/human/invitations/${encodeURIComponent(params.get('invite'))}/claim`, { method: 'POST', body: JSON.stringify({ token: params.get('token') }) }); showDialog('收到一条真人邀请', `<div class="summary-box"><span class="eyebrow">${esc(result.sender.name)} 邀请你</span><h3>${esc(result.topic)}</h3><p>${esc(result.draft)}</p></div><div class="demo-note">你将以本地演示身份「${esc((await humanApi('/api/human/overview')).me.name)}」接收这条邀请。</div>`, button('close-dialog','稍后处理','button secondary') + `<button class="button" data-human-act="accept" data-id="${result.id}">接受邀请</button>`); history.replaceState(null, '', location.pathname + location.hash); await refreshHuman(); } catch (error) { humanError(error); } })();
  humanPoll = setInterval(() => { if (currentView === 'messages') refreshHuman(); }, 3000);
  refreshHuman();
  const humanStyle = document.createElement('style'); humanStyle.textContent = `.chat-layout{display:none!important}.human-inbox-list{border-top:1px solid #edf0f5}.human-chat-item{display:grid;grid-template-columns:48px 1fr auto;align-items:center;gap:13px;width:100%;padding:15px 8px;border:0;border-bottom:1px solid #edf0f5;background:#fff;text-align:left;color:#42536d;cursor:pointer;transition:background .16s}.human-chat-item:hover,.human-chat-item.active{background:#f6f8ff}.human-chat-avatar{display:grid;place-items:center;width:46px;height:46px;border-radius:50%;background:linear-gradient(135deg,#dce7ff,#f5dff0);color:#3e61be;font-size:18px;font-weight:800}.human-chat-copy{min-width:0}.human-chat-copy b{display:block;color:#243652;font-size:15px}.human-chat-copy small{display:block;overflow:hidden;margin-top:6px;color:#8995a8;font-size:12px;text-overflow:ellipsis;white-space:nowrap}.human-chat-meta{display:flex;min-width:48px;align-self:stretch;flex-direction:column;align-items:flex-end;justify-content:space-between;padding:2px 0}.human-chat-meta time{color:#a1aabd;font-size:11px}.human-chat-meta em{display:grid;place-items:center;min-width:18px;height:18px;border-radius:10px;background:#e64c68;color:#fff;font-size:10px;font-style:normal}.human-chat-detail{padding-top:5px}.human-chat-person{display:flex;align-items:center;gap:10px;margin:auto}.human-chat-person .human-chat-avatar{width:36px;height:36px;font-size:15px}.human-chat-person small,.human-chat-head small{display:block;color:#8a97aa;font-size:11px;margin-top:3px}.human-message-panel{margin:0 0 28px;padding:24px;background:#fff;border:1px solid #e6ebf5;border-radius:22px;box-shadow:0 12px 30px rgba(35,68,132,.06)}.human-panel-title,.human-chat-head{display:flex;align-items:center;justify-content:space-between;gap:14px}.human-panel-title h2{margin:5px 0 18px}.human-demo-badge{padding:7px 11px;border-radius:999px;background:#fff7e8;color:#9b681b;font-size:12px}.human-invites{margin-bottom:16px;padding:13px;border-radius:14px;background:#fafbfe}.human-invites h3{margin:0 0 8px;font-size:13px}.human-invite-row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:10px 0;border-top:1px solid #edf0f5}.human-invite-row small,.human-chat-item small,.human-chat-head small{display:block;color:#8a97aa;font-size:11px;margin-top:4px}.human-chat-main{padding:18px;display:flex;flex-direction:column}.human-topic{margin:16px 0;padding:11px 13px;background:#f2f5fb;border-radius:11px;color:#60718b;font-size:12px}.human-message-list{flex:1;max-height:290px;overflow:auto}.human-message{max-width:78%;margin:9px 0;padding:10px 13px;border-radius:14px 14px 14px 4px;background:#f0f3f8;color:#43546f}.human-message.mine{margin-left:auto;border-radius:14px 14px 4px 14px;background:#2459ec;color:#fff}.human-message small{display:block;font-size:10px;opacity:.68}.human-message p{margin:4px 0 0;font-size:13px;line-height:1.6}.human-chat-main form{display:flex;gap:10px;margin-top:14px}.human-chat-main textarea{flex:1;min-height:45px;padding:10px;border:1px solid #dfe5ef;border-radius:11px;resize:vertical}.human-empty{display:grid;place-items:center;align-content:center;gap:8px;color:#8c98aa;text-align:center}.human-empty h3,.human-empty p{margin:0}@media(max-width:720px){.human-chat-layout{grid-template-columns:1fr}.human-chat-list{border-right:0;border-bottom:1px solid #edf0f5}.human-chat-main form{flex-direction:column}}`; document.head.appendChild(humanStyle);
})();
