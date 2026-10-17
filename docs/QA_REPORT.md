# Созвон — отчёт QA

Дата: 2026-10-16 · Окружение: Linux, Node 22.22, @playwright/test 1.56.1, Chromium 141 (headless shell),
фейковые медиа-устройства (`--use-fake-device-for-media-stream`, `--use-fake-ui-for-media-stream`,
`--auto-select-desktop-capture-source=Entire screen`). Сервер в тестах: `node server/index.js` через
`tests/start-server.js`, `HTTPS=1`, `PORT=3200`, `DATA_DIR=$TMPDIR/sozvon-qa-data`. Каталог очищается при каждом прогоне.
Бот запускается из тестов дочерним процессом (`node bot/index.js`, `BOT_SERVER_URL=https://localhost:3200`) и завершается в `afterAll`.

Запуск: `npx playwright test`. Скриншоты пишутся в `tests/screens-qa/`, трейсы упавших тестов в `tests/.results/`.

## Критерии приёмки (SPEC §6)

| # | Критерий | Статус | Чем проверено / пояснение |
|---|----------|:-----:|---------------------------|
| 1 | Регистрация, вход, выход; сессия переживает reload (`sozvon.token`) | ✅ | e2e «Критерий 1» (2 теста): регистрация через UI, reload, `#btn-logout`, повторный вход, `#auth-error` при неверном пароле. API: 8 тестов на register/login/me, включая коды 400/401, регистронезависимую уникальность и длину 2–24. Отдельно руками проверено, что данные (`db.json`) и токен сохраняются после перезапуска сервера. |
| 2 | Сервер с 2 каналами; вход по инвайту; оба онлайн в members | ✅ | e2e «Критерий 2»: каналы `общий`/`Голосовой`, `.member` без `.is-offline`, DJ Бот среди участников, корона у владельца, переход в офлайн после закрытия контекста. API: create/join/leave/delete/rename, права владельца. |
| 3 | Сообщения realtime, история после reload, картинка, удаление | ✅ | e2e «Критерий 3» и «подгрузка истории вверх (60 сообщений) + .file-card». API: лимиты 2000 символов, пустое сообщение, history ≤50 с `before`, права на удаление, `message:deleted`. XSS не проходит: HTML показывается как текст. |
| 4 | Голос: оба в сайдбаре, PC `connected`, входящий аудиотрек, mute виден у второго | ✅ | e2e: 2 `.voice-user`, `data-connected="true"` на удалённых тайлах, у `audio.remote-audio` есть live-трек и `!paused`, иконка `i-mic-off` у второго пользователя (на тайле и в сайдбаре). Дополнительно проверены deafen, камера, `.is-speaking` и reload без «призрачного» тайла. Тест также гоняется в проекте `chromium-real-autoplay`, то есть без флага autoplay. |
| 5 | Стрим экрана: у B `.tile--screen video`, `videoWidth>0`, LIVE | ✅ | e2e: `videoWidth>0`, `.badge--live` в сайдбаре, после остановки тайл и бейдж пропадают. Участник, зашедший после начала стрима, тоже видит экран. |
| 6 | Бот: `!play` → «БОТ» в голосе, `music:state`, плеер, `<audio>` играет; `!skip`/`!stop`; кнопки | ✅ | e2e: бейдж «БОТ», `#music-player` виден, `#music-audio` не на паузе, `src` содержит `/media/music/`, `currentTime>0`, рассинхрон между слушателями <2 с. Проверены кнопки pause/resume/skip/stop, слайдер громкости с записью в `localStorage`, загрузка трека через `#modal-music`, синхронизация позднего слушателя (<1,6 с), deafen и выход из голоса глушат музыку. API: queue/np/remove/shuffle/leave/help, переход к следующему треку по duration, `bot:voice-empty`, `bot:status`, импорт по прямой ссылке. При реальной autoplay-политике звук запускается. |
| 7 | Бот офлайн → `!play` даёт системный ответ | ✅ | e2e: `.message--system` «Музыкальный бот не запущен…». API: `music:command` → `{ok:false,error:'Музыкальный бот не запущен'}`; системное сообщение с `system:true` от DJ Бот. |
| 8 | Нет ошибок в консоли; 375px без горизонтального скролла | ✅ | Каждый e2e/visual тест собирает `console.error` и `pageerror` и падает при их наличии. Исключение одно: ожидаемый сетевой лог `401` в тесте неверного пароля. На 375px `scrollWidth<=clientWidth` на экранах auth, пустого приложения, чата с длинным словом, открытого меню и голоса. `#btn-menu` переключает `.app.is-nav-open`; при ширине <900px `#members` скрыт. |

## Результаты последнего прогона (реальный вывод)

```
Running 62 tests using 1 worker
...
  62 passed (2.9m)
```

Состав: `tests/api.spec.js` 39, `tests/e2e.spec.js` 19, `tests/visual.spec.js` 2. Проект `chromium-real-autoplay` (тесты с тегом `@autoplay`) добавляет ещё 2.
Failed: 0, flaky: 0, skipped: 0.

### История циклов
| Цикл | Результат | Что было |
|------|-----------|----------|
| 1 | 41 passed / 2 failed (api+e2e) | Оба падения оказались ошибками самих тестов: регистр в «зайди в голосовой канал» и повторная загрузка одного и того же mp3 разными тестами. Исправлены в тестах, продукт не менялся. |
| 2 | 52/52 passed | Добавлены расширенные сценарии и visual-проверки. Найдены BUG-D1 и BUG-D2. |
| 3 | 62/62 passed | Проверка исправлений D1/D2 (отдельные soft-проверки в visual.spec). |
| 4 | 62/62 passed | Финальный прогон после правок frontend/designer по замечаниям UI. |

## Баги и замечания

| ID | Владелец | Серьёзность | Описание | Статус |
|----|----------|-------------|----------|--------|
| BUG-D1 | designer | major | При ширине ≥1024px `#music-player` перекрывал текст последних сообщений: у `.chat__messages` не было нижнего отступа на десктопе. | ✅ Закрыт (padding-bottom 176px при ≥1100px), подтверждено visual-тестом |
| BUG-D2 | designer | minor | При ширине <1024px слайдер громкости `#music-volume` был скрыт, хотя SPEC §4 требует локальный слайдер громкости. | ✅ Закрыт, `#music-volume` виден на 375px |
| UI-1 | designer | trivial | На 375px корзина `.message__delete` постоянно видна на каждой строке. | ✅ Закрыт (появляется по hover/focus/тапу) |
| UI-2 | frontend/designer | trivial | У `#btn-menu` была иконка `i-users` вместо бургера. | ✅ Закрыт (`i-menu`) |
| UI-3 | frontend | trivial | Глиф ▶ в подсказке `#modal-music` рендерился эмодзи. | ✅ Закрыт (inline svg `i-play`) |
| UI-4 | frontend/designer | trivial | На домашнем экране был зазор перед заголовком и пустая колонка members. | ✅ Закрыт, проверено по скриншоту `1440-02-empty-app.png` |

Открытых багов нет.

### Наблюдения (не баги, к сведению тимлида)
- Сервер ограничивает отправку: 25 сообщений за 10 с на сокет. В SPEC этого нет. Ограничение разумное, но его стоит внести в контракт. Тест истории на 60 сообщений поэтому шлёт их через 3 сокета.
- `POST /api/music/import` скачивает любой URL, включая `127.0.0.1` и адреса LAN (потенциальный SSRF). Для локального приложения «для друзей» риск низкий, но стоит иметь в виду.
- Бот после перезапуска сервера переподключается сам: проверено вручную, `botOnline` снова `true`.
- Ответ бота «зайди в голосовой канал» начинается со строчной буквы и с префиксом «🎧 <имя>,». Смысл совпадает со SPEC, тест сравнивает без учёта регистра.

## Визуальная проверка

Скриншоты лежат в `tests/screens-qa/` (`1440-*` и `375-*`): auth, пустое приложение, модалка сервера, чат с картинкой, мобильное меню, голос со стримом экрана, плеер, библиотека.
Оценка: тёмная тема цельная и аккуратная, бренд «Созвон» свой. Бейджи LIVE/БОТ, корона и бот-иконка читаются. Модалки и auth-карточка хорошо центрированы. На мобиле тайлы идут в одну колонку, плеер компактный. Все замечания по визуалу исправлены (см. таблицу).

## Что не удалось проверить в headless
- Реальный звук через динамики и микрофон: проверено только наличие live-трека, `!paused` у `<audio>` и сигнал от фейкового «бипа» (через `.is-speaking`). Качество звука, эхо и громкость на слух не проверялись.
- Реальный диалог выбора экрана и захват звука системы/вкладки: источник выбирается автоматически флагом.
- NAT/VPN-сценарии (Radmin, ZeroTier, Tailscale), разные подсети, TURN: все пиры были на localhost, ICE через host-кандидаты.
- Предупреждение браузера о самоподписанном сертификате для друзей по IP: в тестах включён `ignoreHTTPSErrors`.
- Firefox и Safari: прогон только в Chromium.
- Импорт с YouTube: `yt-dlp` в окружении не установлен, проверена только прямая ссылка.
- Выход бота через 2 минуты простоя не проверялся, чтобы не растягивать прогон.
- Mesh с большим числом участников (5+): максимум в тестах — 3 браузера.

---

# v2: громкость собеседника, шумоподавление, настройки, музыка по ссылкам (SPEC-v2)

Окружение то же (Node 22.22, @playwright/test 1.56.1, Chromium headless, фейковые медиа). Новые файлы:
`tests/v2-api.spec.js`, `tests/v2-voice.spec.js`, `tests/v2-settings.spec.js`, `tests/v2-music.spec.js`,
`tests/v2-visual.spec.js`, хелперы `tests/fixtures/v2.js`.

**Музыкальный стенд.** Это второй `webServer` в `playwright.config.js`: `tests/start-server-music.js`, порт `QA_PORT+10`, свой `DATA_DIR`. Стенд использует два фейка:
- `tests/fixtures/fake-yt-dlp.mjs` подставляется через `YTDLP_PATH`. Он разбирает реальные аргументы сервера: `-J --flat-playlist`, `ytsearch3:`/`scsearch3:`, `--print after_move:%(.{…})j` и `-o`. Вывод повторяет формат yt-dlp 2026.08.19 (образцы лежат в `tests/fixtures/music/ytdlp-*.json`). Скачивание создаёт ffmpeg-синус по пути из `-o`. Каждый вызов пишется в лог `<MUSIC_DATA_DIR>-ytdlp-calls.log`, и по этому логу тесты проверяют кэш.
- `tests/fixtures/fake-spotify.js` — HTTP-сервер на `QA_PORT+91` (`SPOTIFY_EMBED_BASE=http://127.0.0.1:<port>/embed`). Он отдаёт реальные embed-страницы `open.spotify.com/embed/...`: плейлист на 50 треков, альбом на 18 треков и один трек. Кроме того, есть два производных коротких плейлиста: из 3 треков и с «ненаходимым» треком.

**Параллельные прогоны.** Порт задаётся через `QA_PORT` (по умолчанию 3200). `DATA_DIR` и стенды смещаются вместе с ним, поэтому прогоны разных агентов больше не стирают данные друг друга.

## Матрица проверок v2

| # | Требование SPEC-v2 | Статус | Чем проверено |
|---|--------------------|:-----:|---------------|
| 1 | `PATCH /api/me {color}` → `{user}`, валидация, рассылка | ✅ | v2-api: цвет сохраняется; `GET /api/me` и bootstrap у другого участника отдают новый цвет; `user:updated` приходит участнику общего сервера и не приходит постороннему. 10 видов мусора (`red`, `#12345`, `url(...)`, `null`…) дают 400 с текстом по-русски; без токена 401. Через PATCH нельзя сменить username или isBot. Через UI: палитра → сервер; у B без перезагрузки обновляются аватары A в участниках, в голосе, в сообщениях и в user-panel. |
| 2 | `POST /api/me/password` | ✅ | Неверный старый пароль → 400 «Неверный текущий пароль», текущая сессия остаётся жива. Короткий новый → 400, без авторизации → 401. При успехе вторая сессия получает 401 на REST, её новый сокет — `connect_error`, уже открытый сокет отключается; текущий токен жив. Старый пароль после смены не подходит, вход с новым работает. Через UI: `#form-password` показывает ошибку, успешная смена не разлогинивает, после reload сессия жива, вход через форму в новом контексте проходит. |
| 3 | Громкость собеседника 0–200 % через GainNode | ✅ | v2-voice: правый клик по `.voice-user` открывает `.context-menu` со слайдером 0..200. Значения 0/50/200 дают `getUserGain` 0/0.5/2. При 0 % `getUserLevel`=0, при 200 % больше 0. Двойной клик сбрасывает в 100. Значение сохраняется в `sozvon.prefs` и переживает reload с перезаходом в голос. «Заглушить локально» → 0 (`userMuted`). Deafen → 0. `outputVolume` 50 % × 200 % → 1. Меню открывается и с тайла, и кнопкой «⋯». Индикатор `.vol-badge` показан при ≠100 % и скрыт при 100 %. Для себя пунктов громкости и заглушения нет. |
| 4 | Шумоподавление на лету | ✅ | Режимы rnnoise → standard → off → rnnoise в голосе. `getNoiseMode()` совпадает с выбранным; pc остаётся `connected` и не пересоздаётся (перехват `RTCPeerConnection`); `bytesReceived` у B растёт; звук A доходит до выхода B (`getUserLevel` > 0) в каждом режиме; у sender живой аудиотрек; ошибок консоли нет. RNNoise реально подгружен: worklet и `.wasm` из `/vendor/web-noise-suppressor/` отдают 200, `isRnnoiseLoaded()`=true, wasm идёт с MIME `application/wasm`. Без AudioWorklet вариант rnnoise `disabled` с пояснением, голос работает на фолбэке. |
| 5 | Модалка настроек | ✅ | `#btn-user-settings` открывает модалку; 6 разделов `[data-section]`/`[data-panel]` рендерятся, видна только одна панель; ключевые контролы `data-pref` на месте; Esc и крестик закрывают. На 375 px навигация «список → раздел → назад» работает. |
| 6 | Тема dark/light/amoled | ✅ | `data-theme` на `<html>`. Яркость фона: светлая заметно светлее тёмной, у AMOLED фон почти чёрный. После reload тема уже стоит **к моменту вставки `<body>`** (MutationObserver в init-script) и на DOMContentLoaded, то есть мигания нет. Кнопка «Сбросить» в разделе «О приложении» возвращает тёмную тему. |
| 7 | Масштаб шрифта, компактный режим | ✅ | 130 % и 80 % дают `font-size` `<html>` ×1.3 и ×0.8; `data-compact="true"`; оба значения сохраняются после reload. |
| 8 | Горячие клавиши mute/deafen | ✅ | Ctrl+Shift+M и Ctrl+Shift+D переключают `#btn-mute`/`#btn-deafen`. Сочетание переназначается захватом на одиночную M: набор текста с «m»/«M» в композере mute не переключает, M вне поля переключает, старое сочетание больше не действует. |
| 9 | Push-to-talk | ✅ | Режим «Рация» включается через UI. 5 с без клавиши: у B нет `.is-speaking`, а `getUserLevel(A)` у B меньше 0.001, то есть звук не уходит. С зажатой V A говорит у B (тайл и сайдбар), звук приходит. После отпускания A замолкает. V при фокусе в композере PTT не включает. |
| 10 | Spotify-плейлист → ленивая очередь | ✅ | `!play <playlist>` → «Добавил в очередь 3 трек…». Элементы очереди `pending:true` без `url`, с title/artist/duration/source='spotify'. Играет первый трек; из кандидатов поиска выбран тот, что укладывается в ±15 с, а не «1 hour loop» (+60 с). `!skip` включает второй. Реальная embed-страница даёт 50 треков (49 в очереди, >40 pending), альбом — 18. Запросов поиска не больше 4: ищутся текущий трек и следующий, а не весь плейлист. После `!stop` yt-dlp больше не вызывается. Трек по `spotify:track:` URI работает; повторный запрос того же трека не вызывает yt-dlp. |
| 11 | YouTube-плейлист, видео, кэш | ✅ | `!play <playlist?list=>` разбирается через `-J --flat-playlist`, 3 трека с pending, `!skip` работает. Одно видео качается один раз. Повтор по `watch?v=`, `youtu.be`, `shorts/` и `music.youtube.com` даёт 0 вызовов yt-dlp, в библиотеке один экземпляр. |
| 12 | Ошибка трека → сообщение и следующий | ✅ | YouTube (Video unavailable) и Spotify (трек не находится ни на YouTube, ни на SoundCloud) дают «⚠️ Не получилось включить «…» — …: причина» и включение следующего. Несуществующий Spotify-плейлист даёт понятный ответ, бот продолжает работать. |
| 13 | `!play <текст>` → поиск по `MUSIC_SEARCH_SOURCES` | ✅ | Без совпадения в библиотеке вызываются `ytsearch3:`, затем `scsearch3:`; если пусто, бот отвечает «Ничего не нашёл…». На основном сервере без yt-dlp поведение прежнее (старый тест зелёный). |
| 14 | Громкость бота `audio.musicVolume` | ✅ | Контекстное меню бота показывает `[data-action=music-volume]` (без громкости пользователя): значение пишется в prefs, `#music-volume` синхронизирован, громкость `#music-audio` меняется. Старый ключ `sozvon.musicVolume` поддерживается (старый e2e зелёный). Плеер корректно показывает трек из очереди с pending. |
| 15 | deploy / PWA | ✅ | Все `deploy/*.sh` проходят `bash -n` и `shellcheck -S error`; `update.sh` ставит yt-dlp; есть `music-check.sh` и `docs/MUSIC.md`. Все файлы из `SHELL` в `sw.js` отдаются 200 (иначе `cache.addAll` упадёт и обновление PWA не установится); `VERSION` поднят. |
| 16 | Регрессия: старый набор | ✅ | Старые 62 теста зелёные (60 chromium и 2 chromium-real-autoplay). |
| 17 | Визуал настроек 1440/375 × 3 темы | ✅ | Скриншоты в `tests/screens-qa/v2/`: 6 разделов × 3 темы × 2 ширины, экран приложения в каждой теме, контекстное меню на 1440 и 375. Горизонтального скролла нет ни в одном разделе и ни в одной теме; на 375 меню не выходит за экран. Замечания — в таблице ниже. |

## v2: результат последнего прогона (реальный вывод)

`npx playwright test` (порт по умолчанию 3200, дерево с правками voice/ui/music на 16.10 ~22:15 UTC):

```
Running 89 tests using 1 worker
  ✓  59 [chromium] › tests/v2-api.spec.js:18:3 › v2 REST: PATCH /api/me (цвет аватара) › валидный цвет → {user} с новым цветом; GET /api/me отдаёт его; другой участник получает обновление (808ms)
  ✓  60 [chromium] › tests/v2-api.spec.js:56:3 › v2 REST: PATCH /api/me (цвет аватара) › валидация цвета: мусор → 400 {error} по-русски, цвет не меняется; без токена → 401 (142ms)
  ✓  61 [chromium] › tests/v2-api.spec.js:78:3 › v2 REST: POST /api/me/password › неверный старый → 401/400; короткий новый → 400; успех → другие сессии разлогинены, текущая жива (728ms)
  ✓  62 [chromium] › tests/v2-api.spec.js:125:3 › v2 deploy: статическая проверка скриптов › deploy/*.sh: bash -n и shellcheck -S error; update.sh доустанавливает yt-dlp; есть music-check.sh и docs/MUSIC.md (1.4s)
  ✓  63 [chromium] › tests/v2-api.spec.js:145:3 › v2 PWA: service worker › все файлы из SHELL в sw.js отдаются 200 (иначе cache.addAll падает и обновление не ставится); vendor RNNoise отдаётся (68ms)
  ✓  64 [chromium] › tests/v2-music.spec.js:66:3 › v2 музыка: Spotify › !play <spotify playlist> → очередь с pending → играет первый → !skip → второй (3.0s)
  ✓  65 [chromium] › tests/v2-music.spec.js:111:3 › v2 музыка: Spotify › реальная embed-страница: плейлист 50 треков, альбом, трек по spotify: URI (7.8s)
  ✓  66 [chromium] › tests/v2-music.spec.js:155:3 › v2 музыка: Spotify › ошибка одного трека Spotify-плейлиста → сообщение и следующий (270ms)
  ✓  67 [chromium] › tests/v2-music.spec.js:168:3 › v2 музыка: Spotify › несуществующий плейлист Spotify → понятная ошибка, бот не падает (155ms)
  ✓  68 [chromium] › tests/v2-music.spec.js:178:3 › v2 музыка: YouTube › !play <youtube playlist> → 3 трека, pending, играет первый, !skip → второй (616ms)
  ✓  69 [chromium] › tests/v2-music.spec.js:197:3 › v2 музыка: YouTube › повтор того же видео не вызывает yt-dlp; youtu.be и shorts — тот же кэш (1.6s)
  ✓  70 [chromium] › tests/v2-music.spec.js:224:3 › v2 музыка: YouTube › ошибка одного видео плейлиста → «Не получилось включить» и следующий (232ms)
  ✓  71 [chromium] › tests/v2-music.spec.js:238:3 › v2 музыка: YouTube › текстовый поиск без совпадения в библиотеке → yt-dlp ytsearch; ничего не нашёл → понятный ответ (247ms)
  ✓  72 [chromium] › tests/v2-music.spec.js:255:3 › v2 музыка: UI с ожидающими элементами › плеер показывает трек из Spotify-плейлиста, очередь с pending не ломает UI (2.4s)
  ✓  73 [chromium] › tests/v2-settings.spec.js:19:3 › v2: модалка настроек › открывается #btn-user-settings, все 6 разделов рендерятся, Esc и крестик закрывают (3.3s)
  ✓  74 [chromium] › tests/v2-settings.spec.js:54:3 › v2: модалка настроек › тема light/amoled: data-theme на <html>, сохраняется после reload и стоит ДО рендера body (4.1s)
  ✓  75 [chromium] › tests/v2-settings.spec.js:97:3 › v2: модалка настроек › масштаб шрифта и компактный режим применяются и сохраняются (2.0s)
  ✓  76 [chromium] › tests/v2-settings.spec.js:118:3 › v2: горячие клавиши › Ctrl+Shift+M переключает mute; при вводе в композер буквы не переключают; переназначение работает (3.5s)
  ✓  77 [chromium] › tests/v2-settings.spec.js:161:3 › v2: учётная запись через UI › цвет из палитры сохраняется на сервере; смена пароля через форму (3.4s)
  ✓  78 [chromium] › tests/v2-settings.spec.js:198:3 › v2: цвет аватара у других участников › A меняет цвет → у B в участниках, в голосе и у сообщений A новый цвет без перезагрузки (4.8s)
  ✓  79 [chromium] › tests/v2-visual.spec.js:10:3 › скриншоты настроек 1440: все разделы × темы dark/light/amoled (12.9s)
  ✓  80 [chromium] › tests/v2-visual.spec.js:10:3 › скриншоты настроек 375: все разделы × темы dark/light/amoled (27.9s)
  ✓  81 [chromium] › tests/v2-visual.spec.js:39:1 › скриншот контекстного меню громкости собеседника 1440/375 (7.9s)
  ✓  82 [chromium] › tests/v2-voice.spec.js:43:3 › v2: громкость собеседника › контекстное меню: 0/50/200 % → getUserGain ≈ 0/0.5/2; сохраняется после reload; «Заглушить» → 0; для себя без громкости (10.2s)
  ✓  83 [chromium] › tests/v2-voice.spec.js:136:3 › v2: шумоподавление на лету › rnnoise → standard → off → rnnoise: соединение живо, звук идёт, RNNoise из /vendor/ подгружен (21.9s)
  ✓  84 [chromium] › tests/v2-voice.spec.js:187:3 › v2: push-to-talk › режим рации: без клавиши A не говорит; с зажатой V — говорит у B; ввод в композер не включает (15.2s)
  ✓  85 [chromium] › tests/v2-voice.spec.js:231:3 › v2: браузер без AudioWorklet › RNNoise недоступен → вариант disabled с пояснением, голос работает на фолбэке без ошибок (2.8s)
  …(строки 1–58 и 86–89 — старый набор api/e2e/visual + 2 @autoplay, все ✓)
  89 passed (5.2m)
```

Состав: старый набор 62 (api 39, e2e 19, visual 2, @autoplay 2) и новые 27 (v2-api 5, v2-music 9, v2-settings 6, v2-visual 3, v2-voice 4). Failed: 0, flaky: 0, skipped: 0.

### История циклов v2
| Цикл | Результат | Что было |
|------|-----------|----------|
| 0 | сервер не стартовал | music был в процессе правок: `importFromUrl` не экспортировался. Подождал. |
| 1 | api 3/3; music 3/9; settings+voice 4/8 | Музыка: после `ytsearch` для Spotify-трека скачивание не начиналось, очередь висела. У music это была взаимоблокировка дедупликации загрузок (поиск и скачивание делили один ключ) — **BUG-M1**, исправлено. Падения UI-тестов оказались ошибками самих тестов: радио, оформленное карточкой (клик по label), гонка в `joinVoiceUI`, ожидаемый 400 в консоли, проверка `inbound audioLevel`, который Chromium считает после громкости muted-элемента (переведено на `getUserLevel` по контракту voice). |
| 2 | 85/85 | Первый полный прогон. Параллельные прогоны других агентов на том же 3200/DATA_DIR ломали друг друга; введён `QA_PORT`. |
| 3 | 88/89 | Добавлены проверки ленивой очереди, кэша и UI-цвета, без AudioWorklet, PWA и deploy. Падение — гонка в моём фейке yt-dlp: параллельные поиски перетирали общий файл результатов. Исправлено в фейке (файл на id, атомарная запись), продукт ни при чём. Два повторных прогона music: 9/9. |
| 4 | 89/89 (QA_PORT=3300) | Проверка исправлений замечаний UI-v2-1..3. |
| 5 | **89/89** (порт 3200) | Финальный прогон, вывод выше. Скриншоты пересняты, исправления UI-v2-1..3 видны. |

## v2: баги и замечания

| ID | Владелец | Серьёзность | Описание | Статус |
|----|----------|-------------|----------|--------|
| BUG-M1 | music | major | Spotify-плейлист: после `ytsearch3:` скачивание не начиналось, очередь висела больше минуты, следующие `!play` Spotify тоже не работали. Причина — взаимоблокировка в дедупликации загрузок. | ✅ Закрыт, 3 полных прогона без повторения |
| BUG-T1 | qa | — | Мой фейк yt-dlp: гонка записи кэша поиска при параллельных вызовах давала ложное «Video unavailable». | ✅ Исправлен в tests/ |
| UI-v2-1 | ui | minor | 1440: индикатор громкости «🔊150» и кнопка «⋯» на `.voice-user` съедали ник. | ✅ Закрыт: «⋯» показывается по hover, индикатор — иконка с title |
| UI-v2-2 | ui | trivial | 375: у панелей настроек не было верхнего отступа (горячие клавиши, «О приложении»). | ✅ Закрыт (20px), сверено по скриншоту |
| UI-v2-3 | ui | trivial | После закрытия настроек по Esc на шестерёнке оставалось кольцо фокуса. | ✅ Закрыт (`focus({focusVisible:false})`) |
| (voice) | voice/ui | minor | `.choice__dot` перехватывал клик по самому `input[type=radio]`. Для пользователя это не мешает (кликается карточка), voice передал ui. | ✅ Закрыт ui |

**Открытых багов нет.**

### Наблюдения v2 (не баги, к сведению)
- `!play <текст>`: если длительность ожидаемого трека неизвестна, берётся первый результат `ytsearch3`, даже если это «(1 hour loop)». Это соответствует контракту. Можно отбрасывать кандидатов длиннее ~15 минут.
- `POST /api/me/password` при неверном старом пароле отвечает 400, а не 401: так задумано, чтобы клиент не принял ответ за протухшую сессию. Браузер логирует 400 как ошибку ресурса, и тест это допускает.
- Inbound `audioLevel` в WebRTC-статистике после перехода на WebAudio всегда 0, потому что `.remote-audio` теперь muted. Для диагностики используйте `window.__sozvon.audio.getUserLevel(userId)`.
- Для параллельных прогонов: `QA_PORT=<порт> npx playwright test`. Артефакты в этом случае пишутся в `tests/.results/p<порт>/`.

## v2: что не проверить в headless
- **Реальный звук.** Громкость 0–200 % проверена по значению GainNode и пиковому уровню после него, но не на слух. Клиппинг при 200 % и громкой речи не оценивался.
- **Реальная работа RNNoise на шуме.** Проверено, что worklet и wasm загружаются, режим переключается на лету и звук проходит. Качество подавления (клавиатура, вентилятор, улица) и задержка не измерялись: фейковый микрофон Chromium даёт только бип.
- **YouTube и Spotify из РФ.** Все сценарии музыки идут на фейковых yt-dlp и embed-страницах (структуры взяты из реального вывода yt-dlp 2026.08.19 и реальных страниц `open.spotify.com/embed`). Доступность YouTube и SoundCloud с VPS, капча «подтвердите, что вы не бот», `YTDLP_COOKIES`/`YTDLP_PROXY`, Spotify Web API с ключами и `deploy/music-check.sh` нужно проверить на самом сервере.
- **Выбор устройства вывода (`setSinkId`)** и реальные устройства ввода: в headless есть только фейковые «Fake Default Audio Input/Output».
- **PTT вне фокуса вкладки**: это ограничение браузера, оно указано в настройках и не тестируется.
- **Системные уведомления (Notification)**: в headless разрешение `denied`. Проверено только то, что раздел рендерится и показывает пояснение.
- **Долгий тап на мобильном** для контекстного меню: проверены правый клик и кнопка «⋯», touch-жесты — нет.
- Firefox и Safari (AudioWorklet и `setSinkId` там ведут себя иначе): прогон только в Chromium.

---

# v3: роли и права, профили «Нитро для всех», пинг, приложение для ПК (SPEC-v3)

Окружение: Node 22.22, @playwright/test 1.56.1, Chromium headless, ffmpeg/ffprobe из системы, Xvfb.
Прогон: `QA_PORT=3900 npx playwright test` (основной сервер :3900, музыкальный :3910, фейковый Spotify :3991,
отдельные серверы из тестов: миграция :3920, лимит вложений :3921). Все серверы останавливаются по PID.

Новые файлы: `tests/v3-roles.spec.js` (21), `tests/v3-migration.spec.js` (3), `tests/v3-profile.spec.js` (13),
`tests/v3-ui.spec.js` (10), `tests/v3-visual.spec.js` (2), `tests/v3-desktop.spec.js` (1); хелперы `tests/fixtures/v3.js`;
фикстура старой базы `tests/fixtures/v3-legacy/` (+ генератор `make-legacy.mjs`).

**Фикстура миграции.** `db.json` и `uploads/` созданы **старым кодом** (коммит 28bc738, git worktree): скрипт поднимает
старый сервер и наполняет его через настоящие REST/Socket.IO (3 пользователя, 2 сервера, лишний канал, сообщения,
PNG-вложение, цвет аватара). Перед стартом тест проверяет, что у серверов нет `roles/memberRoles`, а у пользователей
нет `avatar/displayName`.

**Значения прав** продублированы в `tests/fixtures/v3.js` прямо из SPEC §1.1, а не импортированы из `server/`. Тест
сверяет их с `server/permissions.js` и `public/js/perms.js`.

## Матрица проверок v3

| # | Требование | Статус | Чем проверено |
|---|------------|:-----:|---------------|
| 1 | Миграция старого db.json | ✅ | v3-migration: на старой базе стартует отдельный сервер. Вход старыми паролями работает. Сервер, владелец, инвайт, участники, каналы, история и вложение (200, image/png) на месте. `roles=[@everyone{id=server.id, pos 0, DEFAULT_EVERYONE}]`, `memberRoles/bans/channelOverwrites={}`, `description=''`, `banner=null`; новые поля пользователя null/''. Владелец может всё (роли, server:update, каналы, кик), участник действует с правами по умолчанию (пишет, голос, видит инвайт; не управляет). Перезапуск идемпотентен: @everyone не дублируется, роли и изменения сохраняются, db.json на диске уже в новом формате. |
| 2 | PERMS сервер = клиент = SPEC | ✅ | Все 19 битов и DEFAULT_EVERYONE совпадают (server/permissions.js, public/js/perms.js). |
| 3 | Роли: create/update/reorder/delete, валидация, выдача | ✅ | Имя 1–32, цвет `#rrggbb`, @everyone нельзя удалить или переименовать, `role:reorder` меняет position (сверху вниз), удаление роли чистит `memberRoles`, несуществующую роль не выдать. |
| 4 | MANAGE_ROLES и иерархия | ✅ | Без права — отказ. С правом можно выдавать и менять только роли ниже своей высшей; свою и выше — нельзя; снять роли владельцу нельзя; созданная модератором роль встаёт ниже его роли; ADMINISTRATOR через роль ниже не выдаётся. |
| 5 | SEND_MESSAGES / ATTACH_FILES / MANAGE_MESSAGES | ✅ | Ошибки на сервере. Роль возвращает право. Своё сообщение удалить можно всегда. Overwrite канала: deny @everyone в одном канале, allow роли перекрывает. В UI без SEND композер `disabled`, сообщение не уходит. |
| 6 | Приватный канал (overwrite VIEW_CHANNEL) | ✅ | У участника без роли канала нет в персональном `server:updated` и в bootstrap, нет его `channelOverwrites`. history/send/voice:join → отказ. `message:new`, `typing`, `voice:members` и `bootstrap.voice` приватного канала ему не приходят. После выдачи роли канал появляется, история доступна. В UI канал не виден в сайдбаре и появляется без перезагрузки. |
| 7 | ADMINISTRATOR / владелец | ✅ | Игнорируют overwrites, могут server:update, каналы, видят bans. Не могут server:delete, server:transfer и кик владельца. |
| 8 | inviteCode / bans по правам | ✅ | Без CREATE_INVITE `inviteCode:null` (приходит в server:updated). Без BAN_MEMBERS `bans:null`. |
| 9 | server:update (MANAGE_SERVER) | ✅ | name, description ≤300 (301 → ошибка), regenerateInvite (старый код перестаёт работать). Старый `server:rename` тоже требует права. |
| 10 | Кик / бан / разбан / иерархия | ✅ | `server:removed {reason:'kick'|'ban'}`. После кика можно вернуться по инвайту. Бан: `bans[userId]={by,reason,at}`, `deleteMessages` удаляет сообщения, повторный вход → «Вы заблокированы на этом сервере», после разбана вход работает. Модератор не может тронуть админа выше, равного по роли и владельца. Бота кикнуть нельзя. |
| 11 | Голос: CONNECT, SPEAK→serverMute, STREAM, member:voice | ✅ | Без CONNECT — отказ. Без SPEAK вход с `serverMute:true`, клиент его не снимет. Без STREAM `streaming/camera=true` не применяются, с правом применяются. member:voice: serverMute/serverDeafen в `voice:members`, `voice:moved {channelId}` перемещённому, `moveTo:null` отключает, без права или против владельца — отказ, перенос в текстовый канал — отказ. |
| 12 | USE_MUSIC_BOT | ✅ | С запущенным ботом: `music:command` и `!queue` в чате → «Нет права управлять музыкой»; владелец может. |
| 13 | Передача владения | ✅ | Может только владелец и только участнику сервера. Новый владелец получает всё, бывший теряет права и может выйти с сервера. |
| 14 | UI: настройки сервера → Роли | ✅ | `#btn-role-create` создаёт роль. Имя (`#role-name-input`) и право (`data-perm=KICK_MEMBERS`, вкладка «Права») доходят до сервера. |
| 15 | UI: цвет ника и hoist-группы | ✅ | `.members__group[data-group=<roleId>]` «Админы — 1» у обоих пользователей, плюс группы online/offline. `.member__name` и `.message__author` окрашены в цвет роли. |
| 16 | UI: контекстное меню участника | ✅ | Рядовой участник видит только «Профиль». Владелец видит profile/roles/kick/ban. Кик через меню и `#modal-reason`: у кикнутого сервер пропадает. |
| 17 | Аватар PNG/GIF (ffmpeg) | ✅ | PNG 640×360 → 256×256 (ffprobe), `avatarAnimated=null`. GIF 20 кадров → animated WebP ≤256, квадрат, >5 кадров (кадры считаются по RIFF/ANMF: ffmpeg не декодирует animated WebP), ≤4 МБ, плюс статичный первый кадр 256×256. Кадрирование x,y,size учитывается. Кэш `/media/...` long max-age. DELETE работает. Не картинка → 400, >10 МБ → 413, без токена → 401. |
| 18 | Баннер 960×340, иконка/баннер сервера | ✅ | Баннер 960×340, анимированный — `bannerAnimated`. Иконка сервера 256×256, только с MANAGE_SERVER (403 без права), приходит `server:updated`. |
| 19 | Профиль: displayName/about 190/pronouns/bannerColor/theme/customStatus | ✅ | Валидация всех полей (7 видов мусора → 400). `user:updated` уходит другому участнику. `color` из v2 работает. |
| 20 | Статус invisible / кастомный статус с истечением | ✅ | Другим invisible видно как `online:false`, `status:'offline'` (сам `invisible` не утекает). Себе — `invisible`. dnd виден другим. После `expiresAt` статус не отдаётся (lazy). В UI: меню `#me-avatar` → Невидимый → у B `.is-offline` и группа «Не в сети»; «Задать статус…» → текст у B. |
| 21 | UI: аватар и попап профиля | ✅ | `.avatar.has-img > img.avatar__img`: статичный src, при hover на сообщении анимированный, после ухода курсора снова статичный. При reduced-motion hover анимацию не включает. Без аватара — буква. Попап: displayName, @username, местоимения, кастомный статус, «Обо мне» с markdown (**жирный**), роли-таблетки, «Участник с», баннер `/media/banners/`, анимированный аватар, градиент темы primary→accent; целиком во вьюпорте; Esc закрывает. |
| 22 | UI: Настройки → Профиль | ✅ | about обрезается до 190, есть счётчик, живой предпросмотр, сохранение доходит до сервера. Аватар через `#profile-avatar-input` → `#modal-crop` → `#crop-ok` сохраняется и появляется у другого участника. |
| 23 | Лимит вложений 100 МБ | ✅ | 30 МБ на основном сервере принимается. Отдельный сервер с `UPLOAD_LIMIT_MB=2`: 1,5 МБ → 200, 3 МБ → 413 «…2 МБ» (так поведение лимита проверяется без 100 МБ в памяти). Старый тест «>25 МБ» адаптирован: >100 МБ → 4xx. Код ссылается на `UPLOAD_LIMIT_MB`, nginx `client_max_body_size` ≥ 100m (было 60m, BUG-B1). |
| 24 | Пинг | ✅ | `ping:rtt` → `{now}`. `__sozvon.ping.last > 0`, есть `history`. `#ping-user` «N мс» с `data-level`. В голосе `#ping-voice`, `ping.voice.rtt` — число ≥0, есть loss/jitter, попап с `svg.ping-chart`. |
| 25 | Стрим 1080p60 | ✅ | `#modal-stream`, 1080p60 → у sender'а экрана `getParameters().encodings[0]`: `maxBitrate === 6_000_000`, `maxFramerate === 60` (через перехват RTCPeerConnection и через `__sozvon.rtc.screenEncodings()`). Выбор запоминается в prefs `stream.quality` и предвыбирается. 720p30 → 2 500 000 / 30. |
| 26 | Desktop smoke (Electron, xvfb) | ✅ | `_electron.launch` на `desktop/dist/linux-unpacked/sozvon` (`--server=`, `--user-data-dir`, `SOZVON_ALLOW_INSECURE_LOCALHOST=1`). Открывается окно со страницей сервера (`#auth-screen`). `sozvonDesktop.isDesktop===true`, `version` — строка, все 6 функций моста на месте. `window.require/process` нет. У главного окна `contextIsolation:true`, `sandbox:true`, `nodeIntegration:false`. `html.is-desktop`. Если сборки нет — тест пропускается (skip) с причиной. Скриншот `tests/screens-qa/v3/desktop-linux.png`. |
| 27 | Регрессия: прежние 89 | ✅ | Все зелёные (с адаптациями ниже). |
| 28 | Визуал v3 1440/375 × 3 темы | ✅ | `tests/screens-qa/v3/`: app, profile-popup, members, settings-profile, status-menu, ping-popup, server-roles, member-menu, stream-modal. Горизонтального скролла нет ни в одной теме. |

### Адаптации старых тестов (законное изменение контракта)
- `api.spec.js` «вложения: > 25 МБ» → «> 100 МБ» (101 МБ): по SPEC-v3 §2.2 лимит поднят до 100 МБ.
- `e2e.spec.js` (2 места) и `visual.spec.js`: старт демонстрации теперь идёт через `#modal-stream` → `#btn-stream-start` (SPEC-v3 §2.4). Добавлен хелпер `startScreenShare(page, quality)` в `tests/fixtures/ui.js`.
- `inviteCode` в старых тестах не менялся: у @everyone по умолчанию есть CREATE_INVITE.

## v3: результат последнего прогона (реальный вывод)

`QA_PORT=3900 npx playwright test` (дерево 17.10 после правок backend/frontend/desktop; строки v3, обрезаны до 200 символов):

```
Running 139 tests using 1 worker
  ✓   86 [chromium] › tests/v3-desktop.spec.js:38:1 › desktop: окно открывается, грузит страницу сервера, мост window.sozvonDesktop.isDesktop === true (1.1s)
  ✓   87 [chromium] › tests/v3-migration.spec.js:38:1 › старт на старом db.json: вход, серверы, история, вложение — всё на месте; @everyone = DEFAULT_EVERYONE (165ms)
  ✓   88 [chromium] › tests/v3-migration.spec.js:77:1 › после миграции: владелец может всё, участник — права @everyone по умолчанию, инвайт работает (411ms)
  ✓   89 [chromium] › tests/v3-migration.spec.js:110:1 › миграция идемпотентна: перезапуск сохраняет роли/изменения, @everyone не дублируется; db.json на диске в новом формате (713ms)
  ✓   90 [chromium] › tests/v3-profile.spec.js:17:3 › v3 аватар и баннер (ffmpeg) › PNG 640×360 → avatar 256×256 (центр-кроп), avatarAnimated=null; user:updated другому; кэш-заголовки; DELETE (395ms)
  ✓   91 [chromium] › tests/v3-profile.spec.js:37:3 › v3 аватар и баннер (ffmpeg) › GIF (анимированный, 20 кадров) → avatarAnimated ≤256×256 с анимацией + статичный первый кадр 256×256 (591ms)
  ✓   92 [chromium] › tests/v3-profile.spec.js:57:3 › v3 аватар и баннер (ffmpeg) › кадрирование x,y,size из UI учитывается (PNG) (420ms)
  ✓   93 [chromium] › tests/v3-profile.spec.js:71:3 › v3 аватар и баннер (ffmpeg) › баннер PNG → 960×340; анимированный баннер → bannerAnimated; DELETE; мусор → 400 (1.1s)
  ✓   94 [chromium] › tests/v3-profile.spec.js:96:3 › v3 аватар и баннер (ffmpeg) › аватар > 10 МБ → 413/400 с {error} (261ms)
  ✓   95 [chromium] › tests/v3-profile.spec.js:104:3 › v3 аватар и баннер (ffmpeg) › иконка/баннер сервера: MANAGE_SERVER; иконка 256×256 (629ms)
  ✓   96 [chromium] › tests/v3-profile.spec.js:121:3 › v3 PATCH /api/me: профиль и статус › displayName/about(190)/pronouns(40)/bannerColor/profileTheme/customStatus — валидация и рассылка (225ms)
  ✓   97 [chromium] › tests/v3-profile.spec.js:148:3 › v3 PATCH /api/me: профиль и статус › статус invisible → для других offline (presence/members), себе — invisible; dnd/idle видны (217ms)
  ✓   98 [chromium] › tests/v3-profile.spec.js:171:3 › v3 PATCH /api/me: профиль и статус › кастомный статус с истечением: после expiresAt не отдаётся (2.4s)
  ✓   99 [chromium] › tests/v3-profile.spec.js:187:3 › v3 лимит вложений 100 МБ › конфиг: multer = UPLOAD_LIMIT_MB (100 по умолчанию), nginx client_max_body_size ≥ 100m (4ms)
  ✓  100 [chromium] › tests/v3-profile.spec.js:203:3 › v3 лимит вложений 100 МБ › отдельный сервер с UPLOAD_LIMIT_MB=2: 1.5 МБ проходит, 3 МБ → 413 с текстом лимита (поток, без 100 МБ в памяти) (786ms
  ✓  101 [chromium] › tests/v3-profile.spec.js:222:3 › v3 лимит вложений 100 МБ › основной сервер: 30 МБ (больше старого лимита 25) принимается (419ms)
  ✓  102 [chromium] › tests/v3-profile.spec.js:233:3 › v3 пинг (сервер) › ping:rtt → ack {now} (90ms)
  ✓  103 [chromium] › tests/v3-roles.spec.js:26:3 › v3 права: модель и отдача клиенту › PERMS сервера и клиента совпадают с контрактом; DEFAULT_EVERYONE (36ms)
  ✓  104 [chromium] › tests/v3-roles.spec.js:41:3 › v3 права: модель и отдача клиенту › новый сервер: @everyone (id=server.id, position 0, DEFAULT_EVERYONE), пустые memberRoles/bans/overwrites, descri
  ✓  105 [chromium] › tests/v3-roles.spec.js:59:3 › v3 права: модель и отдача клиенту › inviteCode только при CREATE_INVITE (иначе null) (217ms)
  ✓  106 [chromium] › tests/v3-roles.spec.js:71:3 › v3 роли: CRUD, порядок, выдача › role:create/update/reorder/delete; валидация; @everyone нельзя удалить/переименовать (264ms)
  ✓  107 [chromium] › tests/v3-roles.spec.js:111:3 › v3 роли: CRUD, порядок, выдача › без MANAGE_ROLES нельзя создавать/менять роли; с MANAGE_ROLES — только ниже своей высшей (300ms)
  ✓  108 [chromium] › tests/v3-roles.spec.js:146:3 › v3 права: сообщения › SEND_MESSAGES: снять у @everyone → ошибка; роль с правом → можно; владелец всегда может (190ms)
  ✓  109 [chromium] › tests/v3-roles.spec.js:160:3 › v3 права: сообщения › ATTACH_FILES: без права вложение отклоняется, текст проходит (205ms)
  ✓  110 [chromium] › tests/v3-roles.spec.js:170:3 › v3 права: сообщения › MANAGE_MESSAGES: без права чужое не удалить; своё — можно; с правом — чужое удаляется (194ms)
  ✓  111 [chromium] › tests/v3-roles.spec.js:184:3 › v3 права: сообщения › overwrite канала: deny SEND для @everyone в одном канале, allow для роли перекрывает (337ms)
  ✓  112 [chromium] › tests/v3-roles.spec.js:205:3 › v3 права: приватный канал › deny VIEW_CHANNEL у @everyone + allow роли: канал не виден, история/typing/сообщения не приходят; роль открывает (1.3s)
  ✓  113 [chromium] › tests/v3-roles.spec.js:253:3 › v3 права: приватный канал › ADMINISTRATOR и владелец игнорируют overwrites; ADMINISTRATOR может всё, кроме удаления/передачи (319ms)
  ✓  114 [chromium] › tests/v3-roles.spec.js:278:3 › v3 server:update › MANAGE_SERVER: name/description(≤300)/regenerateInvite; без права — отказ (296ms)
  ✓  115 [chromium] › tests/v3-roles.spec.js:304:3 › v3 модерация: кик, бан, иерархия › кик: server:removed {reason:"kick"}, можно вернуться по инвайту; без KICK_MEMBERS — отказ (300ms)
  ✓  116 [chromium] › tests/v3-roles.spec.js:316:3 › v3 модерация: кик, бан, иерархия › иерархия: модератор кикает рядового, но не админа выше и не владельца (501ms)
  ✓  117 [chromium] › tests/v3-roles.spec.js:340:3 › v3 модерация: кик, бан, иерархия › бан: server:removed {reason:"ban"}, «Вы заблокированы на этом сервере» по инвайту, bans видны только BAN_MEMBERS
  ✓  118 [chromium] › tests/v3-roles.spec.js:365:3 › v3 модерация: кик, бан, иерархия › передача владения: только владелец; новый владелец может всё, бывший — нет (380ms)
  ✓  119 [chromium] › tests/v3-roles.spec.js:383:3 › v3 права: голос › CONNECT: без права voice:join отклоняется (189ms)
  ✓  120 [chromium] › tests/v3-roles.spec.js:390:3 › v3 права: голос › SPEAK: без права вход с серверным mute, клиент сам его не снимет (704ms)
  ✓  121 [chromium] › tests/v3-roles.spec.js:404:3 › v3 права: голос › STREAM: без права streaming/camera=true не применяются; с правом — применяются (2.3s)
  ✓  122 [chromium] › tests/v3-roles.spec.js:422:3 › v3 права: голос › member:voice: серверный mute/deafen, перемещение (voice:moved), отключение; без прав и против старших — отказ (285ms)
  ✓  123 [chromium] › tests/v3-roles.spec.js:462:3 › v3 права: музыкальный бот › USE_MUSIC_BOT: без права music:command и !-команда → «Нет права управлять музыкой» (254ms)
  ✓  124 [chromium] › tests/v3-ui.spec.js:24:3 › v3 UI: роли › настройки сервера → Роли: создать роль через UI, она есть на сервере; цвет ника по роли и hoist-группа у обоих (5.1s)
  ✓  125 [chromium] › tests/v3-ui.spec.js:70:3 › v3 UI: роли › контекстное меню участника: владелец видит kick/ban/роли, рядовой — нет; кик через меню + причина (7.2s)
  ✓  126 [chromium] › tests/v3-ui.spec.js:95:3 › v3 UI: роли › приватный канал не виден в сайдбаре у участника без роли; появляется при выдаче роли (3.2s)
  ✓  127 [chromium] › tests/v3-ui.spec.js:106:3 › v3 UI: роли › без SEND_MESSAGES композер у участника заблокирован/понятная ошибка, а не тихая потеря (3.5s)
  ✓  128 [chromium] › tests/v3-ui.spec.js:122:3 › v3 UI: профиль › аватар (GIF): img вместо буквы, статичный src, анимированный при hover; попап профиля у другого — баннер, about, статус, тема, роли (
  ✓  129 [chromium] › tests/v3-ui.spec.js:191:3 › v3 UI: профиль › без аватара — буква как раньше; reduced-motion — hover не включает анимацию (6.1s)
  ✓  130 [chromium] › tests/v3-ui.spec.js:205:3 › v3 UI: профиль › настройки → Профиль: about со счётчиком 190, displayName, сохранение; загрузка аватара через кадрирование (5.7s)
  ✓  131 [chromium] › tests/v3-ui.spec.js:228:3 › v3 UI: профиль › статус: меню у аватара → Невидимый → у другого offline; Задать статус… → виден другому (5.5s)
  ✓  132 [chromium] › tests/v3-ui.spec.js:249:3 › v3 UI: пинг и стрим › пинг: __sozvon.ping.last > 0, значок «мс»; в голосе — WebRTC RTT (5.9s)
  ✓  133 [chromium] › tests/v3-ui.spec.js:268:3 › v3 UI: пинг и стрим › стрим 1080p60: getParameters().encodings[0].maxBitrate === 6_000_000, maxFramerate 60; 720p30 → 2.5 Мбит/с; выбор запоминается (
  ✓  134 [chromium] › tests/v3-visual.spec.js:37:3 › скриншоты v3 1440: участники с ролями, попап профиля, роли, профиль, стрим, пинг × 3 темы (21.2s)
  ✓  135 [chromium] › tests/v3-visual.spec.js:37:3 › скриншоты v3 375: участники с ролями, попап профиля, роли, профиль, стрим, пинг × 3 темы (31.7s)
  …(строки 1–85 и 136–139 — старые api/e2e/v2/visual + 2 @autoplay, все ✓)
  139 passed (7.6m)
```

Состав: старые 89 (api 39, e2e 19 + 2 @autoplay, visual 2, v2: 27) и новые v3 50 (roles 21, profile 13, ui 10, migration 3, visual 2, desktop 1).
Failed: 0, flaky: 0, skipped: 0 (desktop-сборка была на месте, smoke выполнялся).

### История циклов v3
| Цикл | Результат | Что было |
|------|-----------|----------|
| 0 | 10/37 (API) | Сервер ещё правился. Плюс мои ошибки: `makeUser()` возвращает `{user:{id}}`, а не `id`; `memberIds` не входит в публичный контракт (есть `members`). Исправлено в тестах. |
| 1 | 32/34 API; UI 6/10 | ffprobe не считает кадры animated WebP — подсчёт перенесён в разбор RIFF/ANMF. Старый файл аватара удаляется при замене (тест скачивает его до повторной загрузки). Предикат `server:updated` для приватного канала был неверным (overwrites скрытых каналов честно не отдаются). **BUG-B1** nginx 60m → backend. UI: права роли на вкладке «Права», пункт «Роли» в меню появляется, только когда есть роли, `button[data-status]` (в иконке тоже был data-status), градиент темы смешан с фоном — проверка по оттенкам точек. |
| 2 | **139/139** | Первый полный прогон после исправления BUG-B1 и правок frontend (TDZ в voice-stage.js, закрытие `#modal-settings`). |
| 3 | **139/139** | Повторный полный прогон, вывод выше. Добавлена проверка «попап профиля целиком во вьюпорте». |

## v3: баги и замечания

| ID | Владелец | Серьёзность | Описание | Статус |
|----|----------|-------------|----------|--------|
| BUG-B1 | backend | major | `deploy/templates/nginx.conf`: `client_max_body_size 60m` при лимите вложений 100 МБ. Файлы 60–100 МБ на проде отсекал бы nginx. | ✅ Закрыт: 110m, update.sh перерендеривает конфиг; тест зелёный |
| UI-v3-1 | frontend | minor | 1440: попап профиля, открытый из сообщения внизу чата, прилегал к нижнему краю вьюпорта: размер измерялся во время анимации scale(0.96). | ✅ Закрыт: в тесте ужесточено до отступа ≥8 px, v3-ui + v3-visual 12/12 |
| UI-v3-2 | frontend | trivial | Редактор роли без цвета показывал «nullnull» под заголовком: в replaceChildren попадали null-дети. | ✅ Закрыт (filter(Boolean)) |
| BUG-T2 | qa | — | Мои ошибки в тестах цикла 0–1 (id пользователя, memberIds, ffprobe и WebP, предикат приватного канала, мобильное меню в v3-visual). | ✅ Исправлены в tests/ |

**Открытых багов нет.**

### Наблюдения v3 (к сведению)
- Истёкший кастомный статус отдаётся как `null` лениво, при сериализации. Отдельного `user:updated` в момент истечения нет: клиент должен скрывать статус по `expiresAt` сам.
- `customStatus` с `expiresAt` в прошлом сервер принимает и сразу отдаёт `null` (тест допускает и 400).
- Пункт «Роли» в контекстном меню скрыт, пока на сервере нет ролей, кроме @everyone. Логично, но в контракте этого нет.
- Анимированный аватар сохраняется как animated WebP. ffmpeg/ffprobe его не декодируют, поэтому для проверки и для будущей перекодировки нужен разбор контейнера или libwebp.

## v3: что не проверить в headless
- **Глобальная рация desktop вне фокуса (uiohook)**, трей, автозапуск, нативные уведомления, бейдж: smoke проверяет только окно, мост и безопасность webPreferences. desktop прогонял PTT отдельно своим `scripts/smoke.mjs` через xdotool. Windows NSIS/zip и SmartScreen не проверялись (только linux-unpacked под Xvfb).
- **Реальное качество стрима 1080p60**: проверены параметры энкодера (`maxBitrate`, `maxFramerate`), но не фактический битрейт и fps на фейковом источнике экрана.
- **RTT через TURN (FORCE_RELAY)**: пиры на localhost, `voice.rtt` ≈ 0–2 мс по host-кандидатам.
- **Загрузка 100 МБ через nginx**: конфиг проверен статически, поведение лимита — на отдельном сервере с `UPLOAD_LIMIT_MB=2`. backend отдельно проверял в Docker: 95 МБ через nginx → 200.
- **Кадрирование drag/zoom на canvas**: проверены открытие `#modal-crop` и сохранение, жесты мыши и тача — нет.
- «Не беспокоить» без звуков: системные уведомления в headless запрещены, звуки на слух не проверялись.
