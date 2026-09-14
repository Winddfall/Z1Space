import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Conversation, HumanChatData, HumanMessage, HumanUser, Invitation } from './types.ts';

export class HumanChatError extends Error {
  code: string;
  status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; }
}

const pairKey = (a: string, b: string) => [a, b].sort().join(':');
function publicInvitation(invite: Invitation, viewerId: string) {
  const { claimToken: _claimToken, ...safe } = invite;
  return { ...safe, shareToken: viewerId === invite.sender.id && invite.status === 'pending' ? invite.claimToken : undefined };
}

export class HumanChatStore {
  private data: HumanChatData = { invitations: [], conversations: [] };
  private saveChain = Promise.resolve();
  private readonly file: string;
  private readonly inviteTtlMs: number;
  constructor(file: string, inviteTtlMs = 7 * 24 * 60 * 60 * 1000) { this.file = file; this.inviteTtlMs = inviteTtlMs; }

  async load() {
    try {
      const saved = JSON.parse(await readFile(this.file, 'utf8')) as Partial<HumanChatData>;
      this.data = { invitations: saved.invitations || [], conversations: saved.conversations || [] };
    } catch { /* first run or corrupt local demo data */ }
  }

  private persist() {
    const snapshot = JSON.stringify(this.data, null, 2);
    this.saveChain = this.saveChain.then(async () => {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(this.file, snapshot);
    });
    return this.saveChain;
  }

  private expire() {
    const now = Date.now(); let changed = false;
    for (const invite of this.data.invitations) {
      if (invite.status === 'pending' && invite.expiresAt <= now) { invite.status = 'expired'; invite.updatedAt = now; changed = true; }
    }
    if (changed) void this.persist();
  }

  async deleteForUsers(userIds: readonly string[]) {
    const ids = new Set(userIds);
    const invitations = this.data.invitations.filter(invite => !ids.has(invite.sender.id) && !ids.has(invite.recipient?.id || ''));
    const conversations = this.data.conversations.filter(conversation => !conversation.memberIds.some(id => ids.has(id)));
    if (invitations.length === this.data.invitations.length && conversations.length === this.data.conversations.length) return;
    this.data.invitations = invitations;
    this.data.conversations = conversations;
    await this.persist();
  }

  overview(viewer: HumanUser) {
    this.expire();
    const invitations = this.data.invitations.filter(i => i.sender.id === viewer.id || i.recipient?.id === viewer.id).map(i => publicInvitation(i, viewer.id));
    const conversations = this.data.conversations.filter(c => c.memberIds.includes(viewer.id)).map(c => {
      const last = c.messages.at(-1); const otherId = c.memberIds.find(id => id !== viewer.id)!;
      return { id: c.id, topic: c.topic, other: c.members[otherId], lastMessage: last || null, unread: c.messages.filter(m => m.seq > (c.lastReadSeq[viewer.id] || 0) && m.senderId !== viewer.id).length, updatedAt: c.updatedAt };
    }).sort((a, b) => b.updatedAt - a.updatedAt);
    return { me: viewer, invitations, conversations };
  }

  async createInvitation(sender: HumanUser, input: { recipientPersonId?: string; recipientName?: string; topic?: string; draft?: string; contentId?: string }) {
    this.expire();
    const recipientPersonId = String(input.recipientPersonId || '').trim(); const recipientName = String(input.recipientName || '').trim(); const topic = String(input.topic || '').trim(); const draft = String(input.draft || '').trim();
    if (!recipientPersonId || !recipientName) throw new HumanChatError('INVALID_RECIPIENT');
    if (!draft || draft.length > 500) throw new HumanChatError('INVALID_DRAFT');
    if (!topic) throw new HumanChatError('INVALID_TOPIC');
    const existing = this.data.invitations.find(i => i.sender.id === sender.id && i.recipientPersonId === recipientPersonId && i.status === 'pending');
    if (existing) return publicInvitation(existing, sender.id);
    const now = Date.now();
    const invite: Invitation = { id: randomUUID(), sender, recipientPersonId, recipientName, topic, draft, contentId: input.contentId, status: 'pending', claimToken: randomBytes(24).toString('hex'), createdAt: now, expiresAt: now + this.inviteTtlMs, updatedAt: now };
    this.data.invitations.push(invite); await this.persist(); return publicInvitation(invite, sender.id);
  }

  async claim(viewer: HumanUser, inviteId: string, token: string) {
    this.expire(); const invite = this.data.invitations.find(i => i.id === inviteId);
    if (!invite || invite.claimToken !== token) throw new HumanChatError('INVITATION_NOT_FOUND', 404);
    if (invite.sender.id === viewer.id) throw new HumanChatError('CANNOT_INVITE_SELF');
    if (invite.status !== 'pending') throw new HumanChatError('INVITATION_NOT_PENDING', 409);
    if (invite.recipient && invite.recipient.id !== viewer.id) throw new HumanChatError('INVITATION_ALREADY_CLAIMED', 409);
    invite.recipient = { ...viewer, personId: invite.recipientPersonId }; invite.updatedAt = Date.now(); await this.persist(); return publicInvitation(invite, viewer.id);
  }

  async act(viewer: HumanUser, inviteId: string, action: 'accept' | 'reject' | 'withdraw') {
    this.expire(); const invite = this.data.invitations.find(i => i.id === inviteId);
    if (!invite) throw new HumanChatError('INVITATION_NOT_FOUND', 404);
    if (invite.status !== 'pending') return publicInvitation(invite, viewer.id);
    if (action === 'withdraw' && invite.sender.id !== viewer.id) throw new HumanChatError('FORBIDDEN', 403);
    if (action !== 'withdraw' && invite.recipient?.id !== viewer.id) throw new HumanChatError('FORBIDDEN', 403);
    if (action === 'accept') {
      if (!invite.recipient) throw new HumanChatError('INVITATION_NOT_CLAIMED', 409);
      const key = pairKey(invite.sender.id, invite.recipient.id);
      let conversation = this.data.conversations.find(c => pairKey(c.memberIds[0], c.memberIds[1]) === key);
      if (!conversation) {
        const now = Date.now();
        conversation = { id: randomUUID(), memberIds: [invite.sender.id, invite.recipient.id], members: { [invite.sender.id]: invite.sender, [invite.recipient.id]: invite.recipient }, topic: invite.topic, invitationId: invite.id, messages: [], lastReadSeq: { [invite.sender.id]: 0, [invite.recipient.id]: 0 }, createdAt: now, updatedAt: now };
        this.data.conversations.push(conversation);
      }
      invite.status = 'accepted'; invite.conversationId = conversation.id;
    } else invite.status = action === 'reject' ? 'rejected' : 'withdrawn';
    invite.updatedAt = Date.now(); await this.persist(); return publicInvitation(invite, viewer.id);
  }

  conversation(viewerId: string, id: string) {
    const c = this.data.conversations.find(x => x.id === id);
    if (!c) throw new HumanChatError('CONVERSATION_NOT_FOUND', 404);
    if (!c.memberIds.includes(viewerId)) throw new HumanChatError('FORBIDDEN', 403);
    const otherId = c.memberIds.find(x => x !== viewerId)!;
    return { ...c, other: c.members[otherId] };
  }

  async send(viewerId: string, conversationId: string, input: { text?: string; clientMessageId?: string }) {
    const c = this.data.conversations.find(x => x.id === conversationId);
    if (!c) throw new HumanChatError('CONVERSATION_NOT_FOUND', 404);
    if (!c.memberIds.includes(viewerId)) throw new HumanChatError('FORBIDDEN', 403);
    const text = String(input.text || '').trim(); const clientMessageId = String(input.clientMessageId || '').trim();
    if (!text || text.length > 1000 || !clientMessageId) throw new HumanChatError('INVALID_MESSAGE');
    const duplicate = c.messages.find(m => m.senderId === viewerId && m.clientMessageId === clientMessageId);
    if (duplicate) return duplicate;
    const message: HumanMessage = { id: randomUUID(), seq: (c.messages.at(-1)?.seq || 0) + 1, senderId: viewerId, text, clientMessageId, createdAt: Date.now() };
    c.messages.push(message); c.updatedAt = message.createdAt; c.lastReadSeq[viewerId] = message.seq; await this.persist(); return message;
  }

  async read(viewerId: string, conversationId: string, seq: number) {
    const c = this.data.conversations.find(x => x.id === conversationId);
    if (!c) throw new HumanChatError('CONVERSATION_NOT_FOUND', 404);
    if (!c.memberIds.includes(viewerId)) throw new HumanChatError('FORBIDDEN', 403);
    c.lastReadSeq[viewerId] = Math.max(c.lastReadSeq[viewerId] || 0, Math.min(seq, c.messages.at(-1)?.seq || 0)); await this.persist(); return { ok: true };
  }
}
