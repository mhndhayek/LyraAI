// AI goals: only the model writes them. After a session it reflects and plans;
// with autonomy on it works on open goals while the user is away.
const llm = require('./llm');
const { clampText } = require('./util');

class Goals {
  constructor(ctx) { this.ctx = ctx; this.timer = null; this.busy = false; } // settings, store, agent, emit, notify
  start() { this.timer = setInterval(() => this.tick().catch((e) => console.error('goals tick', e)), 5 * 60 * 1000); setTimeout(() => this.tick().catch(() => {}), 90 * 1000); }
  stop() { clearInterval(this.timer); }
  async tick() { await this.reflectPending(); await this.workOnce(); }

  async reflectPending() {
    const { store } = this.ctx; const cutoff = Date.now() - 10 * 60 * 1000;
    for (const c of store.listChats()) {
      const full = store.getChat(c.id);
      if (full.kind !== 'chat' || full.reflected || full.updated_at > cutoff || store.countMessages(c.id) < 4) continue;
      await this.reflect(c.id).catch((e) => console.error('reflect failed', e.message));
    }
  }

  async reflect(chatId) {
    const { store, settings, agent, emit, notify } = this.ctx; const s = settings.get();
    const msgs = store.listMessages(chatId).slice(-30);
    const transcript = msgs.map((m) => `${m.role === 'user' ? 'USER' : 'YOU'}: ${clampText((m.content.text || m.content.transcript || ''), 600)}`).join('\n');
    const existing = store.listGoals(true).map((g) => g.title);
    const model = await agent.pickModel(false);
    const prompt = `You are ${s.persona.name}. Reflect on this session with the user and write goals for yourself for next time.
Two kinds: "improve" (something you could do better, based on what happened) and "explore"/"surprise" (an idea to bring up, or a small creative thing you could make on your own in the workspace, like a gallery page of their photos or a helpful script).
Existing goals (do not repeat): ${existing.join(' | ') || 'none'}.
Reply with JSON only: {"goals":[{"type":"improve|explore|surprise","title":"short imperative title","why":"one sentence grounded in the session"}]} with 0-2 goals. Return {"goals":[]} if nothing is worth it. /no_think

Session:\n${transcript}`;
    const out = await llm.chatOnce({ endpoint: model.endpoint, apiKey: model.apiKey, model: model.id, temperature: 0.4, maxTokens: 500, messages: [{ role: 'user', content: prompt }] });
    store.updateChat(chatId, { reflected: 1 });
    const m = out.replace(/<think>[\s\S]*?<\/think>/g, '').match(/\{[\s\S]*\}/); if (!m) return [];
    let j; try { j = JSON.parse(m[0]); } catch { return []; }
    const added = [];
    for (const g of (j.goals || []).slice(0, 2)) {
      if (!g.title || existing.some((t) => t.toLowerCase() === String(g.title).toLowerCase())) continue;
      const type = ['improve', 'explore', 'surprise'].includes(g.type) ? g.type : 'improve';
      added.push(store.addGoal({ type, title: String(g.title).slice(0, 120), why: String(g.why || '').slice(0, 300), status: 'proposed', log: `From session “${store.getChat(chatId).title}”` }));
    }
    if (added.length) { emit(null, 'goals', {}); notify('goals', `${s.persona.name} set a goal`, added[0].title); }
    return added;
  }

  usage() { const { store } = this.ctx; const today = new Date().toISOString().slice(0, 10); const u = store.kvGet('goals:usage', { date: today, minutes: 0 }); return u.date === today ? u : { date: today, minutes: 0 }; }

  async workOnce(goalId = null, force = false) {
    const { store, settings, agent, emit, notify } = this.ctx; const s = settings.get();
    if (this.busy || agent.isBusy()) return { ok: false, why: 'busy' };
    if (!force && !s.goals.autonomous) return { ok: false, why: 'autonomy off' };
    const u = this.usage();
    if (!force && u.minutes >= s.goals.dailyMinutes) return { ok: false, why: 'daily budget used' };
    const goal = goalId ? store.listGoals(true).find((g) => g.id === goalId) : store.listGoals().filter((g) => ['proposed', 'in_progress'].includes(g.status)).sort((a, b) => a.created_at - b.created_at)[0];
    if (!goal) return { ok: false, why: 'no open goals' };
    this.busy = true; const started = Date.now();
    try {
      let chat = store.listChats().map((c) => store.getChat(c.id)).find((c) => c.kind === 'goal' && c.title === `Goal: ${goal.title}`);
      if (!chat) chat = store.createChat({ title: `Goal: ${goal.title}`, kind: 'goal' });
      store.updateGoal(goal.id, { status: 'in_progress' }); emit(null, 'goals', {}); emit(null, 'chats', {});
      const minutes = Math.max(5, Math.min(s.goals.dailyMinutes - (force ? 0 : u.minutes), 30));
      const prompt = `This is autonomous time: the user is away. Work on your own goal for at most ${minutes} minutes, within your usual safety rules (approvals may be denied or time out; respect that).
Goal (${goal.type}): ${goal.title}
Why: ${goal.why}
${goal.log ? `Previous notes: ${clampText(goal.log, 800)}` : ''}
Do real work in the workspace if the goal calls for it. Finish with a short report for the user (what you did, what to look at), then a last line exactly like: STATUS: done or STATUS: in_progress or STATUS: blocked`;
      const r = await agent.run({ chatId: chat.id, text: prompt, internal: true });
      const last = store.listMessages(chat.id).pop(); const text = last && last.role === 'assistant' ? last.content.text || '' : '';
      const st = (text.match(/STATUS:\s*(done|in_progress|blocked)/i) || [])[1]; const status = st ? st.toLowerCase() : (r.ok ? 'in_progress' : 'blocked');
      store.updateGoal(goal.id, { status, log: clampText(`${goal.log ? goal.log + '\n---\n' : ''}${text}`, 4000) });
      const used = Math.ceil((Date.now() - started) / 60000); store.kvSet('goals:usage', { date: u.date, minutes: u.minutes + used });
      emit(null, 'goals', {}); notify('goals', `${s.persona.name} worked on a goal`, `${goal.title} — ${status.replace('_', ' ')}`);
      return { ok: true, status };
    } finally { this.busy = false; }
  }
}
module.exports = { Goals };
