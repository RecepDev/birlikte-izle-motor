import { el, toast, errorText } from './ui.js';

const timeOf = (ts) => new Date(ts).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });

export function createChat({ list, form, input, request, meId }) {
  function item(m) {
    if (m.system) return el('li', { class: 'system', text: m.text });
    return el(
      'li',
      { class: m.fromId === meId() ? 'mine' : '' },
      el('span', { class: 'from', text: m.from }),
      el('span', { text: m.text }),
      el('span', { class: 'ts', text: timeOf(m.ts) }),
    );
  }

  const nearBottom = () => list.scrollHeight - list.scrollTop - list.clientHeight < 80;
  const toBottom = () => { list.scrollTop = list.scrollHeight; };

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const res = await request('chat', { text });
    if (res?.error) {
      input.value = text;
      toast(errorText(res.error));
    }
  });

  return {
    render(messages) {
      list.replaceChildren(...messages.map(item));
      toBottom();
    },
    add(m) {
      const stick = nearBottom();
      list.append(item(m));
      while (list.children.length > 300) list.firstChild.remove();
      if (stick || m.fromId === meId()) toBottom();
    },
  };
}
