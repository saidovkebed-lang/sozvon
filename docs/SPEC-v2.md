# Созвон v2 — контракт доработок (дополняет docs/SPEC.md)

Задачи: (1) ползунок громкости каждого собеседника, (2) шумоподавление, (3) настройки
приложения «как в Discord», (4) музыка по ссылке на плейлист Spotify и на YouTube.
Прод уже развёрнут на VPS в Москве (deploy/install.sh) — ничего не должно сломать
обновление через `deploy/update.sh`. Все 62+ существующих теста должны остаться зелёными.

## 0. Владение файлами (строго)

| Агент  | Владеет |
|--------|---------|
| voice  | `public/js/voice/**`, `public/js/audio/**` (новое), `public/vendor/**` (новое) |
| ui     | `public/index.html`, `public/js/ui/**`, `public/js/main.js`, `public/js/state.js`, `public/js/music.js`, `public/css/**`, `public/assets/**`, `public/sw.js`, `public/manifest.webmanifest` |
| music  | `server/**`, `bot/**`, `deploy/**`, `docs/MUSIC.md`, `README.md`, `package.json` |
| qa     | `tests/**`, `playwright.config.js`, `docs/QA_REPORT.md` |
| lead   | `public/js/prefs.js`, `docs/SPEC*.md` — менять только через тимлида |

Общение — SendMessage (загрузить через ToolSearch "select:SendMessage"). Имена: voice, ui, music, qa.

## 1. Настройки — `public/js/prefs.js` (уже написан тимлидом)
Все ключи и значения по умолчанию — в `DEFAULTS` этого файла. API: `get/set/subscribe/all/reset`,
`getUserVolume/setUserVolume/isUserMuted/setUserMuted`. UI только пишет prefs, движок только
читает и подписывается. Прямых вызовов UI→движок для настроек звука нет, КРОМЕ функций из §2.

## 2. Звуковой движок (агент voice) — публичный API
Экспортировать из `public/js/audio/engine.js`:
```js
export const audioEngine = {
  // Тест микрофона в настройках: вызывает cb(levelDb, gateOpen) ~20 раз/с с уровнем ПОСЛЕ обработки.
  // loopback=true — слышать себя (через выбранное устройство вывода). Возвращает stop().
  startMicTest({ loopback = false, onLevel }) → Promise<() => void>,
  listDevices() → Promise<{ inputs: {deviceId,label}[], outputs: {deviceId,label}[], canSelectOutput: boolean }>,
  rnnoiseSupported() → boolean,     // AudioWorklet + WebAssembly
  setPttPressed(pressed: boolean),  // для экранной кнопки «рация» (клавишу движок слушает сам)
};
```
Поведение:
- **Громкость собеседника** 0–200 % через WebAudio GainNode (не `<audio>.volume`, он ≤100 %):
  итог = userVolume × outputVolume. `userMuted` — локально 0. Применяется на лету по
  подписке на prefs. Касается голоса (mic). Звук демонстрации экрана — отдельная громкость не
  нужна, использовать ту же громкость пользователя. Музыка бота — `audio.musicVolume` (music.js у ui).
  Устройство вывода: `AudioContext.setSinkId` если есть, иначе `HTMLMediaElement.setSinkId`, иначе
  `canSelectOutput:false`. Для QA оставить `.remote-audio[data-socket-id][data-kind]` и добавить
  отладку: `window.__sozvon.audio.getUserGain(userId)` → текущее значение gain.
- **Шумоподавление**: `rnnoise` — RNNoise в AudioWorklet (вендорить готовый WASM-пакет в
  `public/vendor/`, например `@sapphi-red/web-noise-suppressor` (MIT) или аналог; без сборщика,
  без CDN — сервер в РФ, всё отдаём сами; проверить лицензию), при этом браузерный
  noiseSuppression выключен; `standard` — браузерный noiseSuppression; `off` — ничего.
  echoCancellation/autoGain — констрейнты getUserMedia. Смена режима/устройства на лету —
  пересобрать граф и `RTCRtpSender.replaceTrack` у всех пиров, БЕЗ перезахода в канал.
- **Цепочка микрофона**: getUserMedia → [RNNoise] → GainNode(inputVolume) → шумовой гейт
  (auto: текущая логика speaking-detection; manual: порог sensitivityDb) → MediaStreamDestination
  → отправляемый трек. Индикатор «говорит» = гейт открыт и не muted.
- **Push-to-talk**: inputMode='ptt' → микрофон открыт только пока зажата `pttKey`
  (keydown/keyup на window, игнорировать ввод в полях, отпускание с задержкой pttReleaseDelay).
  Работает только когда вкладка в фокусе — это ограничение браузера, ui пишет об этом в настройках.
- Горячие клавиши mute/deafen (`keybinds.*`) — слушает ui (js/ui/keybinds.js), вызывает
  существующие toggleMute/toggleDeafen.

## 3. Интерфейс (агент ui)
- **Модалка «Настройки пользователя»** `#modal-user-settings` (полноэкранная, как в Discord: слева
  список разделов, справа содержимое, Esc/крестик закрывают). Открывается шестерёнкой в
  `.user-panel` (`#btn-user-settings`). Разделы:
  1. **Моя учётная запись** — ник (только чтение), цвет аватара (палитра + свой), смена пароля
     (REST из §4), выход.
  2. **Голос и видео** — устройство ввода/вывода, громкость ввода/вывода (0–200 %), тест
     микрофона с индикатором уровня и порогом гейта, режим ввода (голос/рация + назначение
     клавиши), чувствительность (авто/ползунок dB), шумоподавление (ИИ RNNoise / стандартное /
     выкл; RNNoise недоступен → disabled с пояснением), эхоподавление, автоусиление.
  3. **Внешний вид** — тема (тёмная / светлая / AMOLED), масштаб шрифта, компактный режим,
     анимации. Тема через `data-theme` на `<html>` и переопределение токенов в tokens.css.
  4. **Уведомления** — звуки (вход/выход, сообщения, mute), системные уведомления (запрос
     разрешения Notification), «только упоминания». Звуки генерировать WebAudio (без файлов),
     `js/ui/sounds.js`.
  5. **Горячие клавиши** — mute/deafen (захват сочетания), PTT-клавиша (дублирует раздел 2).
  6. **О приложении** — версия, ссылка на GitHub, кнопка «Сбросить настройки».
- **Громкость собеседника**: правый клик (и долгий тап на мобильном, и пункт «⋯») по
  `.voice-user` в сайдбаре и по `.tile` → контекстное меню `.context-menu` со слайдером
  «Громкость пользователя» 0–200 % (подписи 0/100/200, двойной клик — сброс в 100),
  «Заглушить локально», «Профиль» (необязательно). Для себя — пункты не показывать.
  Индикатор на `.voice-user`, если громкость ≠100 % или заглушён.
- Музыка бота: music.js берёт громкость из `prefs 'audio.musicVolume'` (0..100), слайдер
  `#music-volume` пишет туда же. Сохранить совместимость с `audio#music-audio`.
- Применение внешнего вида и звуков уведомлений — подписки на prefs.

## 4. Сервер и музыка (агент music)
REST (авторизация как раньше):
- `PATCH /api/me` `{color:'#rrggbb'}` → `{user}`; рассылает обновлённого пользователя всем
  делящим с ним серверы (`server:updated` для каждого общего сервера или новое событие
  `user:updated {user}` — выбрать одно, описать в docs/SPEC-v2.md §4 через тимлида; рекомендую
  `user:updated`, ui его обрабатывает).
- `POST /api/me/password` `{oldPassword,newPassword}` → `{ok:true}`; 400/401 по-русски.
  Остальные сессии пользователя — инвалидировать, текущий токен оставить.

Музыка:
- **YouTube**: видео, плейлист, Shorts, youtu.be, music.youtube.com. Через yt-dlp
  (путь из env `YTDLP_PATH`, по умолчанию `yt-dlp` в PATH). Плейлист → в очередь до
  `MUSIC_PLAYLIST_LIMIT` (по умолчанию 100) треков.
- **Spotify**: `open.spotify.com/(intl-xx/)?(playlist|album|track)/ID` (+ `spotify:` URI).
  Звук Spotify НЕ качаем (DRM). Берём метаданные (название, исполнитель, длительность):
  1) если заданы `SPOTIFY_CLIENT_ID`/`SPOTIFY_CLIENT_SECRET` — Web API (client credentials,
  с пагинацией); 2) иначе — публичная embed-страница `open.spotify.com/embed/<type>/<id>`
  (разбор встроенного JSON; устойчиво к изменениям: несколько стратегий, понятная ошибка).
  Каждый трек ищется в источниках из `MUSIC_SEARCH_SOURCES` (по умолчанию `youtube,soundcloud`:
  `ytsearch1:` / `scsearch1:` «исполнитель — название»), с проверкой длительности (±15 с от
  Spotify, если известна).
- **Ленивая очередь**: ссылки на плейлист добавляют в очередь «ожидающие» элементы
  (`{pending:true,title,artist,duration?,source}`), скачивание — непосредственно перед
  воспроизведением + предзагрузка следующего. Скачанное кэшируется в библиотеке
  (повторный запрос того же видео/трека не качает заново). MusicState.queue отдаёт ожидающие
  элементы с `pending:true` и без `url`. Ошибка трека → сообщение в чат и следующий.
- `!play <текст>` без совпадения в библиотеке → поиск по `MUSIC_SEARCH_SOURCES`.
- Устойчивость в РФ: `YTDLP_COOKIES` (путь к cookies.txt для обхода «подтвердите, что вы не
  бот»), `YTDLP_PROXY` (необязательный прокси только для скачивания музыки), таймауты,
  понятные ответы бота («YouTube не отвечает с этого сервера — попробуйте SoundCloud-ссылку…»).
- deploy: yt-dlp ставится ПО УМОЛЧАНИЮ (бинарь из GitHub releases с фолбэком на pip/pipx),
  ежедневное автообновление (systemd timer), JS-рантайм для YouTube — использовать уже
  установленный Node (`--js-runtimes node`, проверить актуальный флаг yt-dlp), `--no-ytdlp` для
  отключения. `deploy/music-check.sh` — проверка с самого VPS: доступен ли YouTube (yt-dlp
  -j на тестовое видео), SoundCloud, open.spotify.com embed, Spotify API; печатает итог
  ✓/✗ и советы. Ничего не ломать в уже установленной системе: update.sh должен доустановить
  yt-dlp и таймер.
- `docs/MUSIC.md` — для пользователя по-русски: как ставить музыку (`!play` + ссылка на
  YouTube видео/плейлист, Spotify плейлист/альбом/трек, текстовый поиск, загрузка mp3),
  как получить ключи Spotify API (необязательно), что делать если YouTube не качает
  (music-check.sh, cookies, SoundCloud), ограничения и что это для личного некоммерческого
  использования.

### §4 — зафиксировано по итогам реализации (agent music)
- Событие `user:updated {user}` — всем, кто делит сервер с пользователем (смена цвета).
- `PATCH /api/me {color}` → `{user}`; `POST /api/me/password {oldPassword,newPassword}` → `{ok:true}`;
  неверный старый пароль — **400**; прочие сессии пользователя инвалидируются (сокеты отключаются).
- `GET /api/music` → `{tracks, internet}` (`internet` — доступен ли импорт по ссылкам/поиск).
- Служебные REST для бота (`Authorization: Bot …`): `POST /api/music/resolve` (ссылка/запрос →
  список элементов очереди) и `POST /api/music/fetch` (скачать элемент → `Track`).
- Элемент очереди в ожидании: `{id, title, artist, duration, addedBy, pending:true, source, loading?}`
  (без `url`; `loading:true` — идёт загрузка).
- yt-dlp: `YTDLP_PATH`, `YTDLP_COOKIES`, `YTDLP_PROXY`, `--js-runtimes node:<execPath>` (yt-dlp ≥ 2025.11.12);
  `MUSIC_SEARCH_SOURCES` (по умолчанию `youtube,soundcloud`), `MUSIC_PLAYLIST_LIMIT` (100);
  Spotify: `SPOTIFY_CLIENT_ID/SECRET`, `SPOTIFY_EMBED_BASE`, `SPOTIFY_API_BASE`, `SPOTIFY_ACCOUNTS_BASE`.
