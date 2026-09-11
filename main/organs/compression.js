// Context engine: estimates the size of the model context and compresses older
// turns into a summary when the threshold is crossed.
const { estimateTokens } = require('./util');

function partTokens(content) {
  if (typeof content === 'string') return estimateTokens(content);
  if (Array.isArray(content)) return content.reduce((n, p) => n + (p.type === 'text' ? estimateTokens(p.text) : 800), 0);
  return 0;
}
function messagesTokens(msgs) { return msgs.reduce((n, m) => n + partTokens(m.content) + 4, 0); }

async function maybeCompress({ history, previousSummary, fixedTokens, contextLength, settings, llm, model, endpoint, apiKey, log }) {
  const { threshold, target } = settings.memory;
  const total = fixedTokens + estimateTokens(previousSummary || '') + messagesTokens(history);
  if (total <= threshold * contextLength) return null;
  const budget = Math.max(512, target * contextLength - fixedTokens - 600);
  let keepFrom = history.length, kept = 0;
  while (keepFrom > 0 && kept + partTokens(history[keepFrom - 1].content) + 4 <= budget) { keepFrom -= 1; kept += partTokens(history[keepFrom].content) + 4; }
  if (keepFrom < 2) keepFrom = Math.min(2, history.length);
  const cut = history.slice(0, keepFrom);
  if (!cut.length) return null;
  const transcript = cut.map((m) => `${m.role.toUpperCase()}: ${typeof m.content === 'string' ? m.content : m.content.map((p) => p.type === 'text' ? p.text : '[image]').join(' ')}`).join('\n\n');
  const prompt = `${previousSummary ? `Earlier summary:\n${previousSummary}\n\n` : ''}Conversation to fold into the summary:\n${transcript}\n\nWrite an updated summary for your own memory of this conversation: facts, decisions, open tasks, files and names mentioned, and the user's preferences. Plain prose, under 300 words.`;
  log && log(`Compressing ${cut.length} older messages (${total} tokens > ${Math.round(threshold * 100)}% of ${contextLength})`);
  const summary = await llm.chatOnce({ endpoint, apiKey, model, messages: [{ role: 'system', content: 'You summarise conversations for later recall.' }, { role: 'user', content: prompt }], temperature: 0.2, maxTokens: 600 });
  return { summary, cut: keepFrom };
}

module.exports = { messagesTokens, partTokens, maybeCompress };
