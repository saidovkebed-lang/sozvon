# Созвон v3 — контракт (дополняет SPEC.md и SPEC-v2.md)

Задачи владельца: (1) аватарки — обычные и анимированные; (2) счётчик пинга (мс);
(3) профиль с баннером и описанием — «функции Нитро бесплатно для всех»; (4) отдельное
приложение для ПК; (5) роли и права участников, которые раздаёт владелец сервера.

**Прод уже работает** (VPS в Москве, данные в /var/lib/sozvon/db.json, обновление —
`deploy/update.sh`). Обязательна миграция существующих данных при старте без потерь:
у старых серверов появляется роль @everyone с правами по умолчанию, владелец остаётся
владельцем, старые пользователи без аватарок/баннеров работают как раньше.
Все 89 существующих тестов должны остаться зелёными (тесты меняет только qa).

## 0. Команда и владение файлами (строго)

| Агент    | Владеет |
|----------|---------|
| backend  | `server/**`, `bot/**`, `deploy/**`, `package.json` (кроме `desktop/`), `README.md`, `docs/DEPLOY.md`, `docs/MUSIC.md` |
| frontend | `public/**` (весь клиент: html, js, css, assets, sw.js) |
| desktop  | `desktop/**` (новое Electron-приложение), `docs/DESKTOP.md` |
| qa       | `tests/**`, `playwright.config.js`, `docs/QA_REPORT.md` |
| lead     | `docs/SPEC*.md`, `public/js/prefs.js` — изменения через тимлида |

Связь — SendMessage (ToolSearch "select:SendMessage"), имена: backend, frontend, desktop, qa.
Серверы для отладки — каждый на своих портах, останавливать ТОЛЬКО по PID. Общий порт 3200
и общий tests/.results не трогать (qa использует `QA_PORT`).

## 1. Права и роли

### 1.1 Биты прав (`server/permissions.js` экспортирует `PERMS`, клиент — `public/js/perms.js`, значения одинаковые)
Права — целое число (битовая маска, ≤ 2^30, хранить как number).
```
ADMINISTRATOR     1<<0   всё, кроме передачи владения и удаления сервера
MANAGE_SERVER     1<<1   название, иконка, баннер сервера, регенерация инвайта
MANAGE_ROLES      1<<2   создавать/менять/удалять роли НИЖЕ своей высшей; выдавать их
MANAGE_CHANNELS   1<<3   создавать/удалять/переименовывать каналы, права каналов
KICK_MEMBERS      1<<4
BAN_MEMBERS       1<<5
CREATE_INVITE     1<<6   видеть/копировать инвайт-код
VIEW_CHANNEL      1<<7   видеть канал (текст: читать; голос: видеть)
SEND_MESSAGES     1<<8
ATTACH_FILES      1<<9
MANAGE_MESSAGES   1<<10  удалять чужие сообщения
MENTION_EVERYONE  1<<11  @everyone подсвечивает всем
CONNECT           1<<12  заходить в голосовой канал
SPEAK             1<<13  говорить (иначе — вход с принудительным mute)
STREAM            1<<14  демонстрация экрана и камера
MUTE_MEMBERS      1<<15  серверный mute другим
DEAFEN_MEMBERS    1<<16  серверный deafen другим
MOVE_MEMBERS      1<<17  перемещать/отключать из голосовых каналов
USE_MUSIC_BOT     1<<18  управлять музыкальным ботом (!play и кнопки)
```
`DEFAULT_EVERYONE = CREATE_INVITE|VIEW_CHANNEL|SEND_MESSAGES|ATTACH_FILES|CONNECT|SPEAK|STREAM|USE_MUSIC_BOT`.

### 1.2 Модель
```ts
Role { id, name (1–32), color: '#rrggbb'|null, permissions: number, position: number /* 0 = @everyone, больше = выше */,
       hoist: boolean /* показывать отдельной группой в списке участников */, mentionable: boolean }
Server  += { roles: Role[], memberRoles: { [userId]: roleId[] }, bans: { [userId]: {by, reason, at} },
             channelOverwrites: { [channelId]: { [roleId]: { allow:number, deny:number } } },
             description: string (≤ 300), banner: string|null /* url */ }
Channel += { overwrites?: … } — НЕ используем, всё в server.channelOverwrites
```
- Роль @everyone: `id === server.id`, position 0, нельзя удалить/переименовать, только права.
- Владелец (`ownerId`) — все права всегда, выше любой роли.
- Эффективные права участника на сервере = OR прав @everyone и его ролей; ADMINISTRATOR → все.
- Права в канале (Discord-алгоритм): base → применить overwrite @everyone (deny, затем allow) →
  OR всех allow / deny по ролям участника (сначала deny ролей, затем allow ролей). ADMINISTRATOR
  и владелец игнорируют overwrites.
- Иерархия: участник с MANAGE_ROLES/KICK/BAN/MUTE/MOVE может действовать только на тех, чья
  высшая роль НИЖЕ его высшей роли (владелец — на всех; на владельца — никто).
- Миграция при старте: каждому серверу без `roles` создать @everyone с DEFAULT_EVERYONE,
  `memberRoles={}`, `bans={}`, `channelOverwrites={}`, `description=''`, `banner=null`.
- Бот (DJ Бот) — не подчиняется правам (служебный), в списке ролей не участвует.

### 1.3 Отдача клиенту
`publicServer(s)` дополнительно: `roles`, `memberRoles`, `channelOverwrites`, `description`, `banner`,
`bans` — только тем, у кого BAN_MEMBERS (остальным — `null`). `inviteCode` — только при
CREATE_INVITE (иначе `null`). Каналы без VIEW_CHANNEL у получателя — не отдаются ему вовсе
(значит `server:updated` теперь персонализирован по получателю). Сообщения/история/typing/
голосовые участники каналов без VIEW_CHANNEL — не отдаются.

### 1.4 Проверки на сервере (везде, где сейчас `requireOwner`, плюс новые)
| Действие | Право |
|---|---|
| server:rename, иконка/баннер/описание сервера, новый инвайт | MANAGE_SERVER |
| channel:create/delete/rename, права канала | MANAGE_CHANNELS |
| message:send | VIEW_CHANNEL+SEND_MESSAGES (вложения — ATTACH_FILES) |
| message:delete чужого | MANAGE_MESSAGES |
| message:history / typing | VIEW_CHANNEL |
| voice:join | VIEW_CHANNEL+CONNECT (без SPEAK → server-mute) |
| voice:state streaming/camera=true | STREAM |
| !-команды бота и music:command | USE_MUSIC_BOT (ответ «Нет права управлять музыкой») |
| server:delete, передача владения | только владелец |

### 1.5 Новые сокет-события (клиент → сервер, все с ack `{ok}`/`{ok:false,error}`)
```
role:create   {serverId, name?, color?, permissions?}          → {ok, role}
role:update   {serverId, roleId, name?, color?, permissions?, hoist?, mentionable?}
role:delete   {serverId, roleId}
role:reorder  {serverId, roleIds: string[] /* сверху вниз, без @everyone */}
member:roles  {serverId, userId, roleIds: string[]}           (MANAGE_ROLES + иерархия)
member:kick   {serverId, userId, reason?}
member:ban    {serverId, userId, reason?, deleteMessages?: boolean}
member:unban  {serverId, userId}
member:voice  {serverId, userId, serverMute?, serverDeafen?, moveTo?: channelId|null /* null = отключить */}
channel:update {channelId, name?, overwrites?: { [roleId]: {allow, deny} }}
server:update {serverId, name?, description?, icon?: url|null, banner?: url|null, regenerateInvite?: true}
server:transfer {serverId, userId}                            (только владелец)
```
Сервер → клиент: `server:updated {server}` (персонально), `server:removed {serverId, reason?:'kick'|'ban'}`
при кике/бане, `voice:members` с полями `serverMute`, `serverDeafen` у VoiceMember,
`voice:moved {channelId}` перемещённому (клиент переподключается к новому каналу).
Бан: забаненный не может зайти по инвайту (`Вы заблокированы на этом сервере`).

## 2. Профили — «Нитро для всех»

### 2.1 Модель пользователя
```ts
User += {
  displayName: string|null (1–32),   // показывается вместо username, где есть
  avatar: string|null,               // url статичной версии (png/webp 256×256)
  avatarAnimated: string|null,       // url анимированной (gif/webp, 256×256) — если исходник анимирован
  banner: string|null, bannerAnimated: string|null,   // 960×340 (≈ 2.8:1)
  bannerColor: '#rrggbb'|null,       // если баннера нет
  about: string (≤ 190),             // «Обо мне», markdown-лайт как в чате
  pronouns: string (≤ 40),
  status: 'online'|'idle'|'dnd'|'invisible',   // invisible → для других offline
  customStatus: { emoji: string|null (≤ 8), text: string (≤ 128), expiresAt: number|null } | null,
  profileTheme: { primary:'#rrggbb', accent:'#rrggbb' } | null,
  createdAt
}
```
`publicUser` отдаёт всё перечисленное (кроме приватного). Старые пользователи — null/'' по умолчанию.

### 2.2 REST (авторизация как раньше)
- `POST /api/me/avatar` multipart `file` (png/jpg/webp/gif/apng ≤ 10 МБ) → `{user}`.
  Сервер через ffmpeg (есть на проде): квадратная обрезка по центру, 256×256; если исходник
  анимирован (gif/apng/animated webp) — сохранить анимированную версию (gif или animated webp,
  ≤ 256×256, ≤ 60 кадров/с, ≤ 15 с, итог ≤ 4 МБ, иначе понизить fps/цвета) + статичный первый кадр.
  Без ffmpeg (dev/тесты без него) — сохранять как есть, без обрезки, честно. Запрос можно
  дополнить полями `x,y,size` (кадрирование, выбранное в UI, в пикселях исходника).
- `DELETE /api/me/avatar`, `POST /api/me/banner` (то же, 960×340, ≤ 15 МБ), `DELETE /api/me/banner`.
- `PATCH /api/me` расширить: `displayName, bannerColor, about, pronouns, status, customStatus, profileTheme, color`.
- `POST /api/servers/:id/icon`, `POST /api/servers/:id/banner` (MANAGE_SERVER), то же через ffmpeg.
- Файлы в `DATA_DIR/media/avatars|banners|icons`, отдаются `/media/...` с кэшем (имя файла с хэшем).
Событие `user:updated {user}` (уже есть) — при любом изменении профиля/статуса.
Лимит вложений в чате поднять до 100 МБ (env `UPLOAD_LIMIT_MB`, по умолчанию 100) — проверить
`client_max_body_size` в nginx-шаблоне deploy (сейчас 60m → поднять, update.sh перерендерит).

### 2.3 Клиент (frontend)
- Аватар везде, где сейчас буква: `<img>` статичный; анимированный — играет при наведении на
  сообщение/участника (как в Discord) и всегда в попапе профиля; уважать reduced-motion.
- Попап профиля по клику на ник/аватар (сообщение, участники, голосовой список): баннер
  (картинка/гиф/цвет), аватар с кольцом статуса, displayName, @username, местоимения, кастомный
  статус, «Обо мне», роли на этом сервере (цветные «таблетки»; с MANAGE_ROLES — «+» добавить
  роль), «Участник с …», тема профиля (градиент primary→accent). Для модераторов — кнопки
  кик/бан/mute/переместить по правам.
- Настройки → «Профиль» (новый раздел): загрузка аватара/баннера с кадрированием (canvas:
  перетаскивание+зум, предпросмотр; анимированные — без кадрирования на клиенте, но с
  передачей x,y,size), цвет баннера, «Обо мне» с счётчиком 190, местоимения, displayName, тема
  профиля, живой предпросмотр карточки. Статус: в user-panel клик по аватару → меню
  «В сети / Не активен / Не беспокоить / Невидимый / Задать статус…».
- Имена в чате и участниках — цвет высшей роли с цветом (иначе обычный). Участники
  сгруппированы по hoist-ролям («Админы — 2», …, «В сети», «Не в сети»).
- «Не беспокоить» — без звуков и системных уведомлений.

### 2.4 Качество стрима (Нитро-функция)
При запуске демонстрации экрана — выбор «720p 30 / 1080p 60 / Исходное» (и звук экрана вкл/выкл).
Применять констрейнты getDisplayMedia и `RTCRtpSender.setParameters` (maxBitrate: 2.5 / 6 / 8 Мбит/с,
maxFramerate). Помнить выбор в prefs (`'stream.quality'`, `'stream.audio'` — тимлид добавит в prefs.js).

## 3. Счётчик пинга (мс)
- Сервер: `ping` событие с ack (клиент шлёт `{t}`, сервер сразу отвечает `{t}`) — уже можно
  через socket.io ack; отдельный `socket.on('ping:rtt', (_, ack) => ack({now: Date.now()}))`.
- Клиент: каждые 5 с измерять RTT до сервера; в голосе — дополнительно WebRTC RTT
  (`candidate-pair.currentRoundTripTime` выбранной пары, при FORCE_RELAY это путь через TURN),
  потери пакетов (`inbound-rtp packetsLost/packetsReceived`), джиттер, битрейт.
  Показ: в `.voice-panel` и в `.user-panel` — значок-«антенна» с цветом (зелёный < 100 мс,
  жёлтый < 250, красный ≥ 250) и числом «42 мс»; по клику/наведению — попап «Подключение» со
  средним/последним пингом, мини-графиком последних 30 замеров (svg), потерями, джиттером,
  кодеком, транспортом (relay/direct), сервером TURN. Вне голоса — только пинг до сервера.
- Отладка для qa: `window.__sozvon.ping = { last, history, voice: {rtt, loss, jitter} }`.

## 4. Отдельное приложение для ПК (desktop)
- `desktop/` — Electron (последний стабильный, закрепить версию), без сборки фронта: окно
  открывает URL сервера (по умолчанию `https://89-108-81-153.sslip.io`, меняется в меню
  «Сервер…» и при первом запуске, хранится в userData). Отдельный `package.json` в desktop/.
- Возможности сверх браузера: **глобальная клавиша рации и mute/deafen** (globalShortcut /
  uiohook — PTT должен работать, когда окно не в фокусе; проверить реализацию нажатия/отпускания —
  globalShortcut не даёт keyup, поэтому использовать uiohook-napi или аналог с prebuilt для win/mac/linux),
  иконка в трее (свернуть в трей, mute/deafen/выход), автозапуск (опция), нативные уведомления,
  бейдж непрочитанных, выбор экрана/окна для демонстрации (desktopCapturer + своё окно выбора,
  т.к. в Electron getDisplayMedia без picker'а не работает), одиночный экземпляр,
  внешние ссылки — в системном браузере, разрешения на микрофон/камеру автоматически только для
  своего сервера.
- Мост в страницу: `window.sozvonDesktop = { isDesktop:true, version, onPttChange(cb),
  onToggleMute(cb), onToggleDeafen(cb), setBadge(n), getScreenSources() , setSettings(...) }`
  через contextBridge (preload, contextIsolation:true, sandbox:true, nodeIntegration:false).
  frontend использует мост, если он есть: PTT из моста, выбор экрана — своё окно с превью
  источников, «Скачать приложение» в UI скрывается внутри приложения.
- Сборка: electron-builder → Windows `Sozvon-Setup-<ver>.exe` (NSIS) + portable `.zip`;
  по возможности Linux AppImage и macOS (macOS собрать на Linux нельзя — честно указать).
  Иконки из public/assets/logo.svg. Подпись кода — нет (Windows SmartScreen предупредит —
  указать в docs/DESKTOP.md, как запустить).
- Раздача: файлы сборки НЕ коммитить в git. Публикация в GitHub Releases (тег `desktop-v<ver>`)
  — делает тимлид после проверки (desktop готовит артефакты в `desktop/dist/` и описание).
  Сервер отдаёт `/download` — страница со ссылками (backend: `GET /api/app/latest` →
  `{version, files:[{name,url,size,platform}]}` из env/файла `DATA_DIR/app-release.json`,
  который `update.sh` скачивает с GitHub Releases в `DATA_DIR/downloads/` и отдаёт сам —
  чтобы из РФ скачивалось с вашего сервера, а не с GitHub). frontend: кнопка «Скачать
  приложение для ПК» в «О приложении» и на экране входа.

## 5. Критерии приёмки (qa)
1. Миграция: db.json старого формата (взять из текущего прод-формата: сервер без roles) → старт → всё работает, @everyone с DEFAULT_EVERYONE, владелец может всё.
2. Роли: создать роль, выдать участнику, права реально применяются на сервере (нет SEND_MESSAGES → ошибка; нет MANAGE_MESSAGES → нельзя удалить чужое; приватный канал через overwrite не виден и не приходит в server:updated/истории); иерархия (модератор не может кикнуть админа выше); кик/бан (забаненный не заходит по инвайту), серверный mute, перемещение в голосе; цвет имени по роли; hoist-группы в участниках.
3. Аватар PNG и GIF: загрузка, обрезка 256×256 (ffmpeg), анимированный играет при наведении, статичный кадр по умолчанию; баннер, «Обо мне», статус, кастомный статус, тема профиля — видны другому пользователю в попапе; user:updated.
4. Пинг: `__sozvon.ping.last` — число > 0, значок с «мс» виден; в голосе есть WebRTC RTT.
5. Качество стрима: выбор 1080p60 → `getParameters().encodings[0].maxBitrate === 6_000_000`.
6. Desktop: приложение собирается; в headless (xvfb) стартует, открывает сервер, мост `window.sozvonDesktop.isDesktop === true`.
7. Регрессия: все прежние 89 тестов зелёные.
