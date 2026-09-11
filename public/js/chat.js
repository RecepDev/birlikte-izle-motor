import { el, toast, errorText } from './ui.js';

const EMOJIS = [
  '😂', '🤣', '😊', '😍', '😘', '😎', '🤔', '😮', '😱', '😢', '😭', '😡', '🥱', '😴', '🤯', '🥳',
  '🤫', '🙈', '💀', '🤡', '👍', '👎', '👏', '🙏', '🙌', '💪', '👀', '🔥', '❤️', '💔', '💯', '✨',
  '🎉', '🍿', '🎬', '📺', '⏸️', '▶️', '⏩', '✅', '❌',
];

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

  // ---- emoji picker ----
  const emojiBtn = form.querySelector('#emoji-btn');
  const emojiPanel = form.querySelector('#emoji-panel');

  function toggleEmoji(open = emojiPanel.hidden) {
    emojiPanel.hidden = !open;
    emojiBtn.setAttribute('aria-expanded', String(open));
  }

  function insertEmoji(emoji) {
    if (input.value.length + emoji.length > input.maxLength) return;
    const start = input.selectionStart ?? input.value.length;
    const end = input.selectionEnd ?? start;
    input.value = input.value.slice(0, start) + emoji + input.value.slice(end);
    const caret = start + emoji.length;
    input.setSelectionRange(caret, caret);
    input.focus();
  }

  emojiPanel.replaceChildren(
    ...EMOJIS.map((emoji) => el('button', { type: 'button', text: emoji, onclick: () => insertEmoji(emoji) })),
  );
  emojiBtn.addEventListener('click', () => toggleEmoji());
  document.addEventListener('click', (e) => {
    if (!emojiPanel.hidden && !form.contains(e.target)) toggleEmoji(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !emojiPanel.hidden) toggleEmoji(false);
  });

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    toggleEmoji(false);
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
