import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
const source = readFileSync(resolve('web/chat-sidebar.js'), 'utf8');
function chat(request: (...args: any[]) => Promise<any>) {
  const input = { value: 'Hello', style: {}, focus() {} };
  const storage = new Map();
  const window: any = { addEventListener() {}, OpenKanAPI: { api: request } };
  const document = { readyState: 'loading', addEventListener() {} };
  const localStorage = { getItem: (key: string) => storage.get(key), setItem: (key: string, val: string) => storage.set(key, val), removeItem: (key: string) => storage.delete(key) };
  const instrumented = source.replace('  window.OpenKanChatSidebar =', `window.testChat = { state, onSend, onAbort, onNewSession, onInput,
    setup() { state.root = { querySelector: () => input }; renderTranscript = async () => {}; updateAbortButton = () => {}; renderTaskMentionTray = () => {}; autoResize = () => {}; updateLiveStatus = () => {}; removeStreamingIndicator = () => {}; bindChipChips = () => {}; refreshSessions = async () => {}; pollForCompletion = async () => {}; startSessionStream = () => {}; syncHeroState = () => {}; composerFeedback = () => {}; }
  }; window.OpenKanChatSidebar =`);
  new Function('window', 'document', 'localStorage', 'input', instrumented)(window, document, localStorage, input);
  window.testChat.setup();
  return { ...window.testChat, input, storage };
}
test('accepted chat stays busy until completion and blocks duplicate sends', async () => {
  let sends = 0;
  const c = chat(async () => { sends++; return { accepted: true, sessionId: 'session-1', userTurn: { role: 'user', content: 'Hello', ts: 'now' } }; });
  await c.onSend();
  assert.equal(c.state.inFlight, true);
  c.input.value = 'Follow-up'; await c.onSend();
  assert.equal(sends, 1);
  assert.equal(c.input.value, 'Follow-up');
});
test('failed sends preserve message and task references, without a ghost sent turn', async () => {
  const c = chat(async () => { throw new Error('Connection unavailable'); });
  c.state.taskMentions.set('tsk-1', { id: 'tsk-1', title: 'Task' });
  await c.onSend();
  assert.equal(c.input.value, 'Hello');
  assert.equal(c.state.taskMentions.size, 1);
  assert.equal(c.state.inFlight, false);
  assert.equal(c.state.transcript.some((turn: any) => turn.__status === 'sending'), false);
});
test('composer drafts are scoped by project and session', () => {
  const c = chat(async () => ({}));
  c.state.projectScope = 'project-a'; c.state.currentSessionId = 'session-1';
  c.onInput({ target: { id: 'chat-sidebar-input' } });
  assert.ok([...c.storage.keys()].some(key => key.includes('project-a') && key.includes('session-1')));
});
