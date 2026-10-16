# Sozvon — технический контракт (источник истины для всей команды)

Локальный аналог Discord для друзей. Один человек запускает сервер у себя на ПК, друзья заходят
через браузер по LAN или через VPN-оверлей (Radmin VPN / ZeroTier / Tailscale).

Стек: Node.js 20+, ESM (`"type":"module"`), Express 4, Socket.IO 4, без сборщика на фронте
(ванильный JS + ES-модули), WebRTC mesh (P2P) для голоса/видео/стрима экрана.

Зависимости уже установлены: express, socket.io, socket.io-client, bcryptjs, multer@2,
selfsigned, music-metadata@10 (ESM), @playwright/test (dev). Новые — только при реальной нужде,
сообщать тимлиду.

## 0. Владение файлами (СТРОГО — чужие файлы не редактировать, писать владельцу)

| Агент     | Владеет                                                           |
|-----------|-------------------------------------------------------------------|
| backend   | `server/**`, `bot/**`, `package.json` (скрипты/зависимости), `README.md` |
| frontend  | `public/index.html`, `public/js/**`                               |
| designer  | `public/css/**`, `public/assets/**`                               |
| qa        | `tests/**`, `playwright.config.js`, `docs/QA_REPORT.md`           |
| lead      | `docs/SPEC.md` (изменения контракта — только через тимлида)        |

## 1. Запуск и сеть

- `npm start` → `server/index.js`. Порт `PORT` (по умолчанию 3000), хост `0.0.0.0`.
- **HTTPS по умолчанию** (getUserMedia/getDisplayMedia работают только в secure context, а друзья
  заходят по IP). При первом старте сервер генерирует самоподписанный сертификат пакетом
  `selfsigned` в `data/certs/{key,cert}.pem` (SAN: localhost, 127.0.0.1, все локальные IPv4).
  `HTTPS=0` — отключить (тогда голос работает только на localhost).
- При старте печатает все адреса: `https://localhost:3000`, `https://192.168.x.x:3000` …
- `npm run bot` → `bot/index.js`, отдельный процесс. Подключается к `BOT_SERVER_URL`
  (по умолчанию `https://localhost:3000`, `rejectUnauthorized:false`) с токеном из
  `data/bot-token.txt` (генерирует сервер при старте, если нет) или env `BOT_TOKEN`.
- `ICE_SERVERS` (env, JSON) — опционально, по умолчанию `[{"urls":"stun:stun.l.google.com:19302"}]`.
  Отдаётся клиенту в `GET /api/config`.
- Данные: `data/db.json` (атомарная запись через tmp+rename, debounce 300 мс),
  `data/uploads/` (вложения чата), `data/music/` (библиотека бота). `data/` в `.gitignore`.
- `DATA_DIR` (env) — переопределить каталог данных (нужно для тестов).

## 2. Модель данных (как отдаётся клиенту)

```ts
User        { id, username, color /* #hex */, isBot: boolean, online: boolean }
Channel     { id, serverId, name, type: 'text'|'voice', position }
Server      { id, name, ownerId, inviteCode /* 8 символов [a-z0-9] */, icon: null,
              channels: Channel[], members: User[] }
Attachment  { url, name, type /* mime */, size }
Message     { id, channelId, author: User, content, attachments: Attachment[],
              createdAt /* ms epoch */, system?: boolean }
VoiceMember { socketId, userId, username, color, isBot,
              muted, deafened, streaming /* экран */, camera /* вебка */ }
Track       { id, title, artist, duration /* сек, может быть 0 */, url /* /media/music/<file> */, addedBy }
MusicState  { channelId, track: Track|null, queue: Track[], paused: boolean,
              position /* сек на момент updatedAt */, updatedAt /* server ms */, serverNow /* ms */ }
```

- Пароли — bcryptjs. Сессии — случайный токен (`crypto.randomBytes(24).toString('hex')`).
- username: 2–24 символа, уникален без учёта регистра.
- Новый сервер создаётся с каналами `# общий` (text) и `🔊 Голосовой` (voice) — имена `общий`, `Голосовой`.
- Бот-пользователь `DJ Бот` (isBot: true) создаётся сервером при старте и **автоматически
  состоит во всех серверах** (добавляется в members при создании сервера).
- Сообщений храним до 2000 на канал.

## 3. REST API (JSON; авторизация `Authorization: Bearer <token>`)

| Метод | Путь | Тело / ответ |
|---|---|---|
| POST | `/api/register` | `{username,password}` → `{token,user}`; 400 `{error}` |
| POST | `/api/login` | `{username,password}` → `{token,user}`; 401 `{error}` |
| GET  | `/api/me` | → `{user}` |
| GET  | `/api/config` | (без авторизации) → `{iceServers, botOnline}` |
| POST | `/api/attachments` | multipart, поле `file`, ≤ 25 МБ → `Attachment` |
| GET  | `/api/music` | → `{tracks: Track[]}` |
| POST | `/api/music/upload` | multipart, поле `file` (audio/*, ≤ 50 МБ) → `{track}` |
| POST | `/api/music/import` | `{url}` → `{track}` (прямая ссылка на аудио; YouTube/др. — если в системе есть `yt-dlp`) |

Бот авторизуется в REST заголовком `Authorization: Bot <botToken>`.
Статика: `/` → `public/`, `/media/uploads/*`, `/media/music/*` (поддержка Range — express.static это умеет).
Ошибки всегда `{error: "текст по-русски"}`.

## 4. Socket.IO

Подключение: `io({ auth: { token } })` (бот: `auth: { botToken }`). Неверный токен → `connect_error`
с `message: 'unauthorized'`. Все запросы клиента — с ack-колбэком; ответ `{ok:true, ...}` или
`{ok:false, error}`.

### Клиент → сервер (с ack)
| Событие | Payload | Ack |
|---|---|---|
| `bootstrap` | – | `{ok,user,servers:Server[],voice:{[channelId]:VoiceMember[]}, music:{[channelId]:MusicState}}` |
| `server:create` | `{name}` | `{ok,server}` |
| `server:join` | `{inviteCode}` | `{ok,server}` |
| `server:leave` | `{serverId}` | `{ok}` (владелец не может выйти — только удалить) |
| `server:delete` | `{serverId}` | `{ok}` (только владелец) |
| `server:rename` | `{serverId,name}` | `{ok}` (только владелец) |
| `channel:create` | `{serverId,name,type}` | `{ok,channel}` (только владелец) |
| `channel:delete` | `{channelId}` | `{ok}` (только владелец; последний текстовый канал удалить нельзя) |
| `message:history` | `{channelId,before?:ms}` | `{ok,messages}` — до 50 шт., по возрастанию времени |
| `message:send` | `{channelId,content,attachments?:Attachment[]}` | `{ok,message}` (content ≤ 2000, не пустой без вложений) |
| `message:delete` | `{messageId}` | `{ok}` (автор или владелец сервера) |
| `typing` | `{channelId}` | без ack |
| `voice:join` | `{channelId}` | `{ok,peers:VoiceMember[] /* без себя */, music:MusicState|null}` |
| `voice:leave` | – | `{ok}` |
| `voice:state` | `{muted?,deafened?,streaming?,camera?}` | без ack |
| `voice:signal` | `{to:socketId,data}` | без ack, relay |
| `voice:speaking` | `{speaking:boolean}` | без ack |
| `music:command` | `{command,args}` | `{ok}` или `{ok:false,error:'Музыкальный бот не запущен'}` |

Антиспам: не более 25 `message:send` за 10 с на соединение.
Пользователь может быть только в одном голосовом канале (повторный join — сначала leave).
Отключение сокета = выход из голоса.

### Сервер → клиент
| Событие | Payload | Кому |
|---|---|---|
| `server:updated` | `{server}` | всем участникам сервера |
| `server:removed` | `{serverId}` | вышедшему/всем при удалении |
| `presence` | `{userId,online}` | всем, кто делит сервер с пользователем |
| `message:new` | `{message}` | участникам сервера |
| `message:deleted` | `{channelId,messageId}` | участникам сервера |
| `typing` | `{channelId,user}` | участникам сервера, кроме отправителя |
| `voice:members` | `{channelId,members:VoiceMember[]}` | всем участникам сервера (для сайдбара) при любом изменении |
| `voice:peer-joined` | `{peer:VoiceMember}` | остальным в этом голосовом канале (не боту) |
| `voice:peer-left` | `{socketId}` | остальным в канале |
| `voice:signal` | `{from:socketId,data}` | адресату |
| `voice:speaking` | `{socketId,speaking}` | остальным в канале |
| `music:state` | `MusicState` | всем участникам сервера (плеер играет только у тех, кто в этом голосовом канале) |
| `bot:status` | `{online}` | всем |

### WebRTC (mesh)
- Новичок получает `peers` в ack `voice:join` и **сам** создаёт RTCPeerConnection к каждому
  (он инициатор/impolite). Существующие участники создают PC по первому входящему signal
  от неизвестного socketId (polite). Используем паттерн *perfect negotiation*
  (`onnegotiationneeded` → setLocalDescription(); при коллизии polite откатывается).
- `data` в `voice:signal`: `{description}` или `{candidate}`.
- Микрофон — всегда audio-трансивер. Экран и камера добавляются/убираются через
  `addTrack/removeTrack` (renegotiation). Видео-трек экрана помечаем: отправляем
  `voice:state {streaming:true}`; приёмник различает экран/камеру по `stream.id`, переданному
  в сигнале `{trackInfo:{streamId,kind:'screen'|'camera'}}` перед добавлением трека.
- Звук экрана (если браузер дал) идёт отдельным audio-треком в том же stream, что и видео экрана.

### Бот (отдельный процесс `bot/index.js`)
Сокет с `auth:{botToken}`. Сервер помечает его `isBot`, шлёт всем `bot:status {online:true}`.

Бот → сервер:
| Событие | Payload |
|---|---|
| `bot:say` | `{channelId,content}` — сообщение от имени DJ Бот в текстовый канал |
| `bot:voice-join` | `{channelId}` — бот появляется в списке участников голосового канала (без WebRTC) |
| `bot:voice-leave` | `{channelId}` |
| `bot:music-state` | `MusicState` (без serverNow — его ставит сервер) → сервер хранит последнее состояние на канал и рассылает `music:state` |

Сервер → бот:
| Событие | Payload |
|---|---|
| `bot:command` | `{command,args:string,userId,username,serverId,textChannelId:string|null,voiceChannelId:string|null}` |
| `bot:voice-empty` | `{channelId}` — в голосовом канале не осталось людей (бот должен выйти и остановиться) |

Команды приходят двумя путями:
1. Сообщение в чате, начинающееся с `!` (`!play lofi`): сервер сохраняет/рассылает сообщение как
   обычно И пересылает боту `bot:command` (textChannelId = канал сообщения).
2. Кнопки плеера в UI → `music:command` (textChannelId = null, бот отвечает только состоянием).

Если бот офлайн и пришла `!`-команда — сервер отвечает системным сообщением
`«Музыкальный бот не запущен. Запустите: npm run bot»` (system: true, автор — DJ Бот).

Команды бота: `play <запрос|url>` (поиск по библиотеке по названию/исполнителю/имени файла,
без учёта регистра; url → `/api/music/import`), `skip`, `stop` (очистить очередь и выйти из канала),
`pause`, `resume`, `queue`, `np`, `remove <n>`, `shuffle`, `help`, `leave`.
`play` без аргументов при паузе = resume. Если пользователь не в голосовом канале —
бот отвечает «Зайди в голосовой канал». Бот обслуживает по одному голосовому каналу на сервер.
Конец трека бот вычисляет по duration (таймер), затем следующий из очереди; пустая очередь →
track:null и через 2 минуты простоя бот выходит.

Синхронизация у клиента: `elapsed = position + (paused ? 0 : (Date.now() + skew - updatedAt)/1000)`,
где `skew = serverNow - Date.now()` (на момент получения). Клиент ставит `<audio>.src = track.url`,
`currentTime = elapsed`, play(); корректирует, если расхождение > 1.5 с. Громкость бота —
локальный слайдер (localStorage `sozvon.musicVolume`). Музыка не играет у deafened.

## 5. Фронтенд: структура DOM и классы (контракт designer ↔ frontend)

Тема — тёмная, вдохновлена Discord, но собственный бренд «Созвон» (не копировать логотип/имя Discord).
Шрифт: системный стек + `Inter` с Google Fonts (опционально, офлайн-фолбэк обязателен).
Иконки — inline SVG-спрайт `public/assets/icons.svg` (symbol id: `i-hash, i-volume, i-mic, i-mic-off,
i-headphones, i-headphones-off, i-phone-off, i-screen, i-camera, i-camera-off, i-plus, i-settings, i-logout,
i-music, i-play, i-pause, i-skip, i-stop, i-upload, i-trash, i-copy, i-users, i-live, i-expand, i-close,
i-attach, i-send, i-crown, i-bot`), использование: `<svg class="icon"><use href="/assets/icons.svg#i-mic"/></svg>`.
`public/assets/logo.svg`, `public/assets/favicon.svg`.

CSS-файлы: `public/css/tokens.css` (переменные), `public/css/app.css` (всё остальное). index.html подключает оба.

Корневые экраны (переключаются атрибутом `hidden`):
```
#auth-screen.auth                         экран входа/регистрации
  .auth__card > .auth__logo, h1.auth__title, p.auth__subtitle,
  form#auth-form.form  (.field > label.field__label + input.input) ×2,
  button.btn.btn--primary.btn--block, p.auth__switch > a#auth-toggle, p.form__error#auth-error
#app.app                                   основной интерфейс (CSS grid)
  nav.servers#servers                      колонка серверов 72px
    .servers__item.servers__item--home?  > button.server-icon (текст-инициалы)  [.is-active]
    .servers__sep
    button.server-icon.server-icon--add#btn-add-server
  aside.sidebar#sidebar                    240px
    header.sidebar__header > .sidebar__title#server-name + button.icon-btn#btn-server-menu
    .sidebar__invite#invite-box > code#invite-code + button.icon-btn#btn-copy-invite
    .sidebar__scroll
      .channel-group > .channel-group__header (span + button.icon-btn[data-add-channel="text|voice"])
        a.channel[data-channel-id][data-type="text|voice"] [.is-active] > svg.icon + span.channel__name + (button.icon-btn.channel__delete)
        .voice-users  (под голосовым каналом)
          .voice-user[data-socket-id] [.is-speaking] > .avatar.avatar--sm + span.voice-user__name + .voice-user__badges (svg.icon / span.badge.badge--live "LIVE" / span.badge.badge--bot "БОТ")
    .voice-panel#voice-panel [hidden]       статус подключения к голосу (над user-панелью)
      .voice-panel__status (span.dot.dot--ok + "Голос подключён") + .voice-panel__channel
      .voice-panel__actions > button.icon-btn#btn-screen, #btn-camera, #btn-disconnect.icon-btn--danger
    footer.user-panel > .avatar + .user-panel__info(.user-panel__name, .user-panel__tag)
                       + button.icon-btn#btn-mute, #btn-deafen, #btn-logout   ([.is-on] = выключено/красное)
  main.main#main
    header.main__header > svg.icon + h2.main__title#channel-title + .main__topic + .main__actions
    -- текстовый вид --
    section.chat#chat-view
      .chat__messages#messages
        .message[data-message-id] [.message--grouped] [.message--system]
          > .avatar + .message__body > .message__meta(span.message__author[style=color], time.message__time)
                                     + .message__content + .message__attachments(img.message__image / a.file-card)
          + button.icon-btn.message__delete
        .chat__empty
      .chat__typing#typing
      form.composer#composer > button.icon-btn#btn-attach + input[type=file]#file-input[hidden]
                             + .composer__attachments#pending-attachments (.chip)
                             + textarea.composer__input#composer-input + button.icon-btn#btn-send
    -- голосовой вид --
    section.stage#voice-view
      .stage__grid#stage-grid
        .tile[data-socket-id] [.is-speaking] [.tile--video] [.tile--screen] [.tile--focused]
          > video.tile__video | (.avatar.avatar--xl) + .tile__label(span + svg.icon mic-off) + span.badge.badge--live + button.icon-btn.tile__expand
      .stage__join#voice-join  (кнопка «Подключиться», когда смотришь голосовой канал, но не в нём)
      .stage__controls > button.ctrl#ctrl-mute, #ctrl-deafen, #ctrl-camera, #ctrl-screen, .ctrl--danger#ctrl-leave  ([.is-on])
  aside.members#members                    240px, список участников сервера
    h3.members__title + .member [.is-offline] > .avatar(.avatar__status) + span.member__name + svg.icon(i-crown|i-bot)
  .music-player#music-player [hidden]      плавающая карточка бота (правый нижний угол main)
    .music-player__art(svg i-music) + .music-player__info(.music-player__title, .music-player__artist)
    + .music-player__progress > .progress > .progress__bar(style width) + .music-player__times
    + .music-player__controls > button.icon-btn[data-music="pause|resume|skip|stop"] + input[type=range].slider#music-volume
    + button.btn.btn--ghost#btn-music-library
dialog.modal#modal-*                       модалки: #modal-server (создать / войти по коду — две вкладки .tabs > .tab[.is-active]),
                                            #modal-channel, #modal-music (библиотека: список .track + upload + import url), #modal-confirm
  .modal__header > h3 + button.icon-btn[data-close]; .modal__body; .modal__footer > .btn.btn--ghost + .btn.btn--primary
.toasts#toasts > .toast [.toast--error|.toast--ok]
```
Аватар: `.avatar` — круг с первой буквой, фон `style="--c: #hex"` (designer использует `background: var(--c)`).
Размеры: `.avatar` 40px, `--sm` 24px, `--xl` 80px. `.is-speaking` — зелёное кольцо (`--speaking`).
Адаптив: < 1024px members скрыт; < 640px — колонка серверов + сайдбар выезжают по кнопке
`button.icon-btn.main__menu#btn-menu` (класс `.app.is-nav-open`).
Состояния кнопок: `.is-on` (активна/выключено-красным для mute/deafen), `:disabled`, `:focus-visible` обязательно.

## 6. Критерии приёмки (проверяет QA)

1. Регистрация/вход/выход, сессия переживает перезагрузку страницы (token в localStorage `sozvon.token`).
2. Создать сервер → появился с двумя каналами; второй пользователь входит по инвайт-коду; оба видят друг друга в members (онлайн).
3. Сообщения в реальном времени, история после перезагрузки, вложение-картинка отображается, удаление.
4. Голос: два браузера в одном голосовом канале → в сайдбаре оба, RTCPeerConnection `connected`,
   у тайла входящий аудиотрек; mute отражается у второго.
5. Стрим экрана: пользователь A включает демонстрацию → у B появляется `.tile--screen` с `<video>`, у которого `videoWidth > 0`; бейдж LIVE в сайдбаре.
6. Бот: `npm run bot` → `!play <трек>` в чате, пока автор в голосовом канале → бот в списке голосового канала с бейджем «БОТ», у слушателей `music:state` с треком, плеер показан, `<audio>` не на паузе; `!skip`/`!stop` работают; кнопки плеера работают.
7. Бот офлайн → `!play` даёт системный ответ.
8. Нет ошибок в консоли браузера при базовых сценариях; адаптив 375px без горизонтального скролла.
