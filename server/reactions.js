// Реакции на сообщения (как в Discord/Telegram): у сообщения m.reactions = [{ emoji, userIds }] —
// порядок — в каком поставили первую реакцию этим эмодзи. Хранятся прямо в сообщении (db.data.messages),
// поэтому уходят вместе с ним при удалении сообщения/канала/сервера. Права и рассылка — server/realtime.js.

export const MAX_REACTIONS = 20;   // разных эмодзи на одно сообщение
const MAX_EMOJI_LEN = 32;          // UTF-16: хватает на семью/флаг с модификаторами (ZWJ-последовательности)

const PICTO = /\p{Extended_Pictographic}|\p{Regional_Indicator}|⃣/u;
const EMOJI_ONLY = /^[\p{Extended_Pictographic}\p{Emoji_Component}\p{Emoji_Modifier}‍️⃣]+$/u;
const segmenter = new Intl.Segmenter('ru', { granularity: 'grapheme' });

/** Один эмодзи (одна графема) или null. Буквы, цифры без «⃣», пробелы и HTML — нет. */
export function cleanEmoji(raw) {
  if (typeof raw !== 'string') return null;
  const e = raw.trim();
  if (!e || e.length > MAX_EMOJI_LEN || !EMOJI_ONLY.test(e) || !PICTO.test(e)) return null;
  let n = 0;
  for (const _ of segmenter.segment(e)) if (++n > 1) return null;
  return e;
}

/**
 * Поставить (on=true) или снять реакцию. Возвращает { changed } либо { error } (лимит разных эмодзи).
 * Пустые записи удаляются, пустой список — убирает поле целиком.
 */
export function setReaction(msg, emoji, userId, on) {
  const list = Array.isArray(msg.reactions) ? msg.reactions : [];
  let r = list.find((x) => x.emoji === emoji);
  if (on) {
    if (r?.userIds.includes(userId)) return { changed: false };
    if (!r) {
      if (list.length >= MAX_REACTIONS) return { error: `Не больше ${MAX_REACTIONS} разных реакций на сообщение` };
      r = { emoji, userIds: [] };
      list.push(r);
    }
    r.userIds.push(userId);
  } else {
    if (!r || !r.userIds.includes(userId)) return { changed: false };
    r.userIds = r.userIds.filter((id) => id !== userId);
    if (!r.userIds.length) list.splice(list.indexOf(r), 1);
  }
  if (list.length) msg.reactions = list; else delete msg.reactions;
  return { changed: true };
}

/** Для клиента: только живые пользователи (exists), пустые реакции не отдаём. */
export function publicReactions(msg, exists = () => true) {
  if (!Array.isArray(msg.reactions)) return [];
  return msg.reactions
    .map((r) => ({ emoji: r.emoji, userIds: r.userIds.filter(exists) }))
    .filter((r) => r.userIds.length);
}
