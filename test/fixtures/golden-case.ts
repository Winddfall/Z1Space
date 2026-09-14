export const goldenSessionId = 'golden-demo-session';

export const goldenProfileState = Object.freeze({
  version: 1,
  profileVersion: 3,
  profileConfirmedAt: '2026-09-14T00:00:00.000Z',
  step: 'done',
  name: '小林',
  impressions: [
    '我关注 AI 产品入口与任务流程的真实取舍，希望从具体案例而不是概念出发。',
    '我会亲自验证交互方案，也愿意分享用户访谈和独立产品实践。',
    '我想认识能够提供不同设计视角、并愿意围绕证据认真交流的人。'
  ],
  profileSourceReferences: [
    ['知乎回答：AI 产品入口复盘'],
    ['项目记录：用户访谈与原型验证'],
    ['公开介绍：交流偏好']
  ],
  profilePublicBoundaries: ['public', 'public', 'public'],
  skills: [{
    id: 'golden-people-skill',
    name: '寻找 AI 产品同路人',
    kind: 'people',
    goal: '寻找关注 AI 产品入口和交互取舍、愿意分享实践经验的人。',
    keywords: 'AI 产品 交互',
    enabled: true
  }],
  following: [],
  liked: [],
  saved: [],
  chats: {},
  runs: [],
  discoverIds: [],
  contentIds: [],
  lastView: 'discover',
  agentChats: {}
});
