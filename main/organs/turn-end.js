// How an agent turn ends when the model wrote no reply text.
//
// Before: any empty reply said "I used all N tool steps", even when the model
// had called 3 tools and simply stopped. Small models often put the whole
// answer in their thinking (an unclosed <think>, or everything in
// reasoning_content), so the reply came back blank and the message lied.
function finishTurn({ text, ranOut, stopped, maxSteps, steps, lastReasoning, finish, model }) {
  const out = { text: (text || '').trim(), notice: null, log: null };
  if (out.text) return out;
  if (stopped) { out.text = '(stopped)'; return out; }
  if (ranOut) {
    out.text = `I used all ${maxSteps} tool steps for this turn without finishing. Say “carry on” and I will pick up where I left off, or raise the limit under Settings › Model.`;
    return out;
  }
  const thought = (lastReasoning || '').trim();
  const where = `model ${model || '?'}, ${steps} step${steps === 1 ? '' : 's'}, finish ${finish || 'none'}`;
  if (thought) {
    out.text = thought;
    out.fromReasoning = true;
    out.notice = 'The model wrote its answer inside its thinking, so it is shown here as the reply.';
    out.log = { level: 'warn', message: `Empty reply: the answer was only in the model's thinking (${where})` };
    return out;
  }
  out.text = 'The model ended its turn without writing a reply. Try asking again, or pick another model under Settings › Model.';
  out.log = { level: 'warn', message: `Empty reply: the model returned no text and no tool calls (${where})` };
  return out;
}

module.exports = { finishTurn };
