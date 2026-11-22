const select = (id) => document.getElementById(id);
const editor = select('editor');
const form = select('rule-form');
const confirmDialog = select('confirm');
let state = null;
let editing = null;
let deleting = null;
let busy = false;
let mode = 'rules';

function text(id, value) {
  select(id).textContent = value;
}

function showMessage(message, isError = false) {
  const element = select('notice');
  element.textContent = message;
  element.hidden = !message;
  element.classList.toggle('error', isError);
}

function addText(parent, tag, value, className) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  element.textContent = value;
  parent.append(element);
  return element;
}

function openEditor(rule = {}, id = null) {
  if (busy) return;
  editing = id;
  form.elements.domain.value = rule.domain ?? '';
  form.elements.port.value = rule.port ?? '';
  form.elements.enabled.checked = rule.enabled ?? true;
  text('editor-title', id ? '编辑转发' : '新增转发');
  const error = select('form-error');
  error.hidden = true;
  error.textContent = '';
  editor.showModal();
}

function actionButton(parent, label, handler) {
  const button = addText(parent, 'button', label);
  button.type = 'button';
  button.addEventListener('click', handler);
}

function render() {
  if (!state) return;
  const portField = select('panel-port');
  if (document.activeElement !== portField && portField.value !== String(state.panelPort)) {
    portField.value = state.panelPort;
  }
  select('total').textContent = state.rules.length;
  select('active').textContent = state.rules.filter((rule) => rule.enabled).length;
  const service = select('service');
  service.textContent = state.serviceActive ? '运行中' : '已停止';
  service.classList.toggle('down', !state.serviceActive);
  select('rules-view').hidden = mode !== 'rules';
  select('raw-view').hidden = mode !== 'raw';
  select('tab-rules').setAttribute('aria-selected', mode === 'rules');
  select('tab-raw').setAttribute('aria-selected', mode === 'raw');

  if (mode === 'raw' && document.activeElement !== select('raw') && state.mode === 'raw') {
    select('raw').value = state.raw || '';
  }

  const rows = select('rules');
  rows.replaceChildren();
  for (const rule of state.rules) {
    const row = rows.insertRow();
    addText(row.insertCell(), 'code', rule.domain);
    addText(row.insertCell(), 'code', `127.0.0.1:${rule.port}`);
    const status = row.insertCell();
    addText(status, 'span', rule.enabled ? '已启用' : '已停用', `badge${rule.enabled ? ' on' : ''}`);
    const actions = addText(row.insertCell(), 'div', '', 'actions');
    actionButton(actions, rule.enabled ? '停用' : '启用', () => {
      const next = state.rules.map((item) => (item.id === rule.id ? { ...item, enabled: !rule.enabled } : item));
      send({ action: 'apply', rules: next }, rule.enabled ? '规则已停用并生效' : '规则已启用并生效');
    });
    actionButton(actions, '编辑', () => openEditor(rule, rule.id));
    actionButton(actions, '删除', () => {
      if (busy) return;
      if (state.rules.length <= 1) {
        showMessage('至少保留一条转发规则。', true);
        return;
      }
      deleting = rule.id;
      text('delete-info', `删除「${rule.domain}」后需点击「校验并生效」才会更新 nginx。`);
      confirmDialog.showModal();
    });
  }
}

async function request(payload) {
  const response = await fetch('/api/action', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '操作失败');
  return result;
}

async function send(payload, success = '') {
  if (busy) return;
  busy = true;
  const buttons = [...document.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;
  showMessage('');
  try {
    const result = await request(payload);
    if (result.rules) state = result;
    else state = await (await fetch('/api/state')).json();
    lastSnapshot = snapshotOf(state);
    render();
    if (select('editor').open) select('editor').close();
    if (select('confirm').open) select('confirm').close();
    showMessage(success || result.message || '操作完成');
    if (result.newPort) {
      const target = `http://127.0.0.1:${result.newPort}/`;
      showMessage(`${result.message} 若未跳转请手动打开 ${target}`);
      setTimeout(() => { location.href = target; }, 3000);
    }
  } catch (error) {
    showMessage(error.message, true);
  } finally {
    busy = false;
    for (const button of buttons) button.disabled = false;
  }
}

select('new-rule').addEventListener('click', () => openEditor());
select('cancel').addEventListener('click', () => editor.close());
select('keep').addEventListener('click', () => confirmDialog.close());
select('tab-rules').addEventListener('click', () => {
  if (mode === 'rules') return;
  mode = 'rules';
  render();
});
select('apply-port').addEventListener('click', () => {
  const value = select('panel-port').value;
  send({ action: 'set-port', port: value }, '');
});
select('tab-raw').addEventListener('click', () => {
  if (mode === 'raw') return;
  mode = 'raw';
  if (!select('raw').value.trim() && state.currentFile) select('raw').value = state.currentFile;
  render();
});
select('save-rules').addEventListener('click', () => {
  send({ action: 'save', rules: collectRules() }, '规则已保存（未生效，点击「校验并生效」应用）');
});
select('apply-rules').addEventListener('click', () => {
  send({ action: 'apply', rules: collectRules() }, '');
});
select('save-raw').addEventListener('click', () => {
  send({ action: 'save', mode: 'raw', raw: select('raw').value }, '原文已保存（未生效）');
});
select('apply-raw').addEventListener('click', () => {
  send({ action: 'apply', mode: 'raw', raw: select('raw').value }, '');
});
select('panel-theme').addEventListener('change', (event) => {
  const theme = event.target.value;
  document.documentElement.dataset.theme = theme;
  try { localStorage.setItem('nginx-control.theme', theme); } catch (error) {}
});
for (const dialog of [editor, confirmDialog]) {
  dialog.addEventListener('cancel', (event) => { if (busy) event.preventDefault(); });
}
form.addEventListener('submit', (event) => {
  event.preventDefault();
  const domain = form.elements.domain.value.trim().toLowerCase();
  const port = form.elements.port.value.trim();
  const rule = { domain, port, enabled: form.elements.enabled.checked };
  let next;
  if (editing) {
    next = state.rules.map((item) => (item.id === editing ? { ...item, ...rule, port: Number(port) } : item));
  } else {
    next = [...state.rules, { id: '', ...rule, port: Number(port) }];
  }
  send({ action: 'apply', rules: next }, '规则已应用生效');
});
select('delete-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const rules = state.rules.filter((rule) => rule.id !== deleting);
  send({ action: 'apply', rules }, '规则已删除并生效');
});

function collectRules() {
  return state.rules;
}

function snapshotOf(data) {
  return JSON.stringify({ mode: data.mode, raw: data.raw, rules: data.rules, serviceActive: data.serviceActive });
}

let lastSnapshot = null;

async function pollState() {
  if (busy || editor.open || confirmDialog.open) return;
  if (mode === 'raw' && document.activeElement === select('raw')) return;
  try {
    const fresh = await (await fetch('/api/state')).json();
    const snapshot = snapshotOf(fresh);
    if (snapshot === lastSnapshot) return;
    state = fresh;
    lastSnapshot = snapshot;
    render();
  } catch (error) {
    // 状态轮询失败时不打扰当前操作
  }
}

setInterval(pollState, 5000);

async function init() {
  state = await (await fetch('/api/state')).json();
  mode = state.mode === 'raw' ? 'raw' : 'rules';
  lastSnapshot = snapshotOf(state);
  render();
}

init();
