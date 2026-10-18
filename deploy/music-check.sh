#!/usr/bin/env bash
# Созвон — проверка музыки С САМОГО СЕРВЕРА: доступны ли YouTube, SoundCloud, Spotify (embed и API),
# работает ли yt-dlp (с теми же cookies/прокси, что у бота). Ничего не меняет.
#   sudo bash /opt/sozvon/deploy/music-check.sh
set -uo pipefail

ENV_FILE=${SOZVON_ENV_FILE:-/etc/sozvon.env}
APP_USER=sozvon
DATA_DIR=/var/lib/sozvon
YT_VIDEO="https://www.youtube.com/watch?v=jNQXAC9IVRw"       # «Me at the zoo», 19 с
SC_TRACK="https://soundcloud.com/forss/flickermood"           # тестовый трек из документации yt-dlp
SPOTIFY_TRACK_ID=4cOdK2wGLETKBW3PvgPWqT                      # Rick Astley — Never Gonna Give You Up

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; B=$'\033[1m'; Z=$'\033[0m'; else G=""; Y=""; R=""; B=""; Z=""; fi
PASS=() FAIL=() TIPS=()
pass() { printf '  %s✓%s %s\n' "$G" "$Z" "$1"; PASS+=("$1"); }
fail() { printf '  %s✗%s %s\n' "$R" "$Z" "$1"; FAIL+=("$1"); [ -n "${2:-}" ] && TIPS+=("$2"); }
note() { printf '  %s○%s %s\n' "$Y" "$Z" "$1"; [ -n "${2:-}" ] && TIPS+=("$2"); }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" -eq 0 ] || { echo "Запустите от root: sudo bash $0" >&2; exit 1; }

# Настройки как у служб
if [ -r "$ENV_FILE" ]; then
  set -a
  # shellcheck disable=SC1090
  . "$ENV_FILE"
  set +a
fi
YTDLP=${YTDLP_PATH:-$(command -v yt-dlp || echo /usr/local/bin/yt-dlp)}
NODE=$(sed -n 's|^ExecStart=\([^ ]*\) server/index.js$|\1|p' /etc/systemd/system/sozvon.service 2>/dev/null | head -n 1)
[ -x "${NODE:-}" ] || NODE=$(command -v node || true)

# yt-dlp запускаем от пользователя sozvon с тем же кэшем, что у сервера
TMP=$(mktemp -d)
chmod 755 "$TMP"
trap 'rm -rf "$TMP"' EXIT
run_ytdlp() {
  local args=(--ignore-config --no-warnings --socket-timeout 20 --no-playlist)
  local cache="$DATA_DIR/.cache/yt-dlp"
  [ -n "$NODE" ] && args+=(--js-runtimes "node:$NODE")
  if [ -n "${YTDLP_COOKIES:-}" ]; then
    if [ -r "$YTDLP_COOKIES" ]; then cp "$YTDLP_COOKIES" "$TMP/cookies.txt"; chmod 644 "$TMP/cookies.txt"; args+=(--cookies "$TMP/cookies.txt"); fi
  fi
  [ -n "${YTDLP_PROXY:-}" ] && args+=(--proxy "$YTDLP_PROXY")
  if id "$APP_USER" >/dev/null 2>&1 && [ -d "$DATA_DIR" ]; then
    install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR/.cache" "$cache" 2>/dev/null || true
    timeout 120 runuser -u "$APP_USER" -- env HOME="$DATA_DIR" XDG_CACHE_HOME="$DATA_DIR/.cache" \
      ${SSL_CERT_FILE:+SSL_CERT_FILE="$SSL_CERT_FILE"} "$YTDLP" "${args[@]}" --cache-dir "$cache" "$@"
  else
    timeout 120 "$YTDLP" "${args[@]}" --cache-dir "$TMP/cache" "$@"
  fi
}
# Последняя строка ERROR из вывода yt-dlp
why() { grep -m1 -o 'ERROR:.*' "$1" | cut -c1-220 || tail -n 1 "$1" | cut -c1-220; }
http_code() { curl -sS -o "${2:-/dev/null}" -w '%{http_code}' --connect-timeout 10 --max-time 20 -A 'Mozilla/5.0 (X11; Linux x86_64) Chrome/130.0' "$1" 2>/dev/null || echo 000; }

printf '\n%sПроверка музыки Astra с этого сервера%s (%s)\n\n' "$B" "$Z" "$(hostname)"

# ------------------------------------------------------------------ yt-dlp --
printf '%sИнструменты%s\n' "$B" "$Z"
YTDLP_OK=0
if [ -x "$YTDLP" ] || have "$YTDLP"; then
  ver=$("$YTDLP" --version 2>/dev/null | head -n 1)
  if [ -n "$ver" ]; then
    YTDLP_OK=1
    age=""
    if [[ $ver =~ ^([0-9]{4})\.([0-9]{2})\.([0-9]{2}) ]]; then
      days=$(( ($(date +%s) - $(date -d "${BASH_REMATCH[1]}-${BASH_REMATCH[2]}-${BASH_REMATCH[3]}" +%s)) / 86400 ))
      age=" (выпущен $days дн. назад)"
      if [ "$days" -gt 60 ]; then
        note "yt-dlp $ver устарел$age" "Обновите yt-dlp: sudo systemctl start sozvon-ytdlp-update (или sudo bash /opt/sozvon/deploy/ytdlp.sh update)"
      else
        pass "yt-dlp $ver$age"
      fi
    else
      pass "yt-dlp $ver"
    fi
  else
    fail "yt-dlp есть ($YTDLP), но не запускается" "Переустановите: sudo bash /opt/sozvon/deploy/ytdlp.sh install force"
  fi
else
  fail "yt-dlp не установлен" "Установите: sudo bash /opt/sozvon/deploy/ytdlp.sh install (или обновитесь: sudo bash /opt/sozvon/deploy/update.sh)"
fi
if systemctl is-active -q sozvon-ytdlp-update.timer 2>/dev/null; then
  pass "Автообновление yt-dlp включено (sozvon-ytdlp-update.timer)"
elif have systemctl; then
  note "Таймер автообновления yt-dlp не активен" "Включите: sudo bash /opt/sozvon/deploy/update.sh"
fi
if [ -n "$NODE" ]; then pass "JS-рантайм для YouTube: Node $("$NODE" -v 2>/dev/null) ($NODE)"; else fail "Node.js не найден (нужен yt-dlp для YouTube)"; fi
if have ffmpeg; then pass "ffmpeg есть"; else note "ffmpeg не установлен — часть треков SoundCloud (HLS) не скачается" "Поставьте ffmpeg: sudo apt-get install -y ffmpeg"; fi
[ -n "${YTDLP_PROXY:-}" ] && note "Для скачивания используется прокси YTDLP_PROXY=${YTDLP_PROXY%%@*}…"
if [ -n "${YTDLP_COOKIES:-}" ]; then
  if [ -r "$YTDLP_COOKIES" ]; then pass "Файл cookies: $YTDLP_COOKIES"; else fail "YTDLP_COOKIES=$YTDLP_COOKIES — файл не найден/не читается"; fi
fi

# ----------------------------------------------------------------- YouTube --
printf '\n%sYouTube%s\n' "$B" "$Z"
c=$(http_code https://www.youtube.com/)
if [ "$c" = 200 ]; then pass "www.youtube.com открывается (HTTP 200)"; else fail "www.youtube.com не открывается (HTTP $c)" "YouTube недоступен с сервера напрямую. Варианты: YTDLP_PROXY в /etc/sozvon.env, ссылки SoundCloud, MUSIC_SEARCH_SOURCES=soundcloud"; fi
if [ "$YTDLP_OK" = 1 ]; then
  if run_ytdlp --flat-playlist -J "ytsearch1:rick astley never gonna give you up" >"$TMP/yts.json" 2>"$TMP/yts.err" && grep -q '"entries"' "$TMP/yts.json"; then
    pass "Поиск на YouTube работает"
  else
    fail "Поиск на YouTube не работает: $(why "$TMP/yts.err")"
  fi
  if run_ytdlp -J "$YT_VIDEO" >"$TMP/yt.json" 2>"$TMP/yt.err" && grep -q '"acodec"' "$TMP/yt.json"; then
    pass "Звук с YouTube получается (тестовое видео)"
  else
    err=$(why "$TMP/yt.err")
    if grep -qiE 'not a bot|sign in to confirm' "$TMP/yt.err"; then
      fail "YouTube требует подтвердить «не бот» (обычное дело для IP датацентров)" \
        "Добавьте cookies YouTube: экспортируйте cookies.txt из браузера (инструкция — docs/MUSIC.md), положите в /var/lib/sozvon/cookies.txt, chown sozvon: и пропишите YTDLP_COOKIES=/var/lib/sozvon/cookies.txt в /etc/sozvon.env, затем systemctl restart sozvon"
    else
      fail "Звук с YouTube не получается: $err" "Обновите yt-dlp (sudo bash /opt/sozvon/deploy/ytdlp.sh update); если YouTube режется — YTDLP_PROXY или SoundCloud"
    fi
  fi
fi

# -------------------------------------------------------------- SoundCloud --
printf '\n%sSoundCloud%s\n' "$B" "$Z"
c=$(http_code https://soundcloud.com/)
if [ "$c" = 200 ]; then pass "soundcloud.com открывается (HTTP 200)"; else fail "soundcloud.com не открывается (HTTP $c)"; fi
if [ "$YTDLP_OK" = 1 ]; then
  if run_ytdlp -J "$SC_TRACK" >"$TMP/sc.json" 2>"$TMP/sc.err" && grep -q '"formats"' "$TMP/sc.json"; then
    pass "Звук с SoundCloud получается (тестовый трек)"
  else
    fail "SoundCloud не отдаёт трек: $(why "$TMP/sc.err")" "Обновите yt-dlp; проверьте YTDLP_PROXY"
  fi
fi

# ----------------------------------------------------------------- Spotify --
printf '\n%sSpotify (только названия треков; звук ищется на YouTube/SoundCloud)%s\n' "$B" "$Z"
EMBED=${SPOTIFY_EMBED_BASE:-https://open.spotify.com/embed}
c=$(http_code "$EMBED/track/$SPOTIFY_TRACK_ID" "$TMP/embed.html")
if [ "$c" = 200 ] && grep -q '__NEXT_DATA__\|trackList\|"type":"track"' "$TMP/embed.html"; then
  if grep -q 'Never Gonna Give You Up' "$TMP/embed.html"; then pass "Embed-страница Spotify открывается и разбирается"; else note "Embed-страница Spotify открылась, но формат необычный" "Если плейлисты Spotify не добавляются — задайте ключи Spotify API (docs/MUSIC.md)"; fi
else
  fail "Embed-страница Spotify недоступна (HTTP $c)" "Spotify может быть недоступен из РФ. Задайте ключи SPOTIFY_CLIENT_ID/SECRET (docs/MUSIC.md) или используйте ссылки YouTube"
fi
API=${SPOTIFY_API_BASE:-https://api.spotify.com}
ACC=${SPOTIFY_ACCOUNTS_BASE:-https://accounts.spotify.com}
if [ -n "${SPOTIFY_CLIENT_ID:-}" ] && [ -n "${SPOTIFY_CLIENT_SECRET:-}" ]; then
  tok=$(curl -sS --connect-timeout 10 --max-time 20 -u "$SPOTIFY_CLIENT_ID:$SPOTIFY_CLIENT_SECRET" -d grant_type=client_credentials "$ACC/api/token" 2>/dev/null \
    | sed -n 's/.*"access_token" *: *"\([^"]*\)".*/\1/p')
  if [ -n "$tok" ]; then
    c=$(curl -sS -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 20 -H "Authorization: Bearer $tok" "$API/v1/tracks/$SPOTIFY_TRACK_ID" 2>/dev/null || echo 000)
    if [ "$c" = 200 ]; then pass "Spotify Web API работает (ключи приняты)"; else fail "Spotify Web API ответил HTTP $c" "Проверьте приложение на developer.spotify.com (docs/MUSIC.md)"; fi
  else
    fail "Spotify API не выдал токен — ключи неверны или $ACC недоступен" "Проверьте SPOTIFY_CLIENT_ID/SECRET в /etc/sozvon.env"
  fi
else
  c=$(http_code "$ACC/api/token")
  case "$c" in
    000) note "Ключи Spotify API не заданы (необязательно); accounts.spotify.com недоступен" ;;
    *) note "Ключи Spotify API не заданы — это необязательно (без них плейлисты берутся с embed-страницы, ~100 первых треков)" ;;
  esac
fi

# --------------------------------------------------------------- GitHub --
printf '\n%sОбновления%s\n' "$B" "$Z"
c=$(curl -sSL -o /dev/null -w '%{http_code}' --connect-timeout 10 --max-time 30 https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS 2>/dev/null || echo 000)
if [ "$c" = 200 ]; then pass "GitHub доступен — yt-dlp будет обновляться"; else note "GitHub недоступен (HTTP $c) — автообновление yt-dlp пойдёт через pip" ; fi

# -------------------------------------------------------------------- итог --
printf '\n%sИтог:%s ✓ %d   ✗ %d\n' "$B" "$Z" "${#PASS[@]}" "${#FAIL[@]}"
if [ "${#FAIL[@]}" -eq 0 ]; then
  printf '%sВсё в порядке: !play со ссылками YouTube, Spotify и SoundCloud должен работать.%s\n' "$G" "$Z"
else
  printf '%sЕсть проблемы.%s Что работает в любом случае: загрузка mp3 через «Библиотеку».\n' "$Y" "$Z"
fi
if [ "${#TIPS[@]}" -gt 0 ]; then
  printf '\n%sСоветы:%s\n' "$B" "$Z"
  printf '%s\n' "${TIPS[@]}" | awk '!seen[$0]++' | sed 's/^/  • /'
fi
printf '\nПодробно: docs/MUSIC.md (раздел «Если музыка не качается»)\n\n'
[ "${#FAIL[@]}" -eq 0 ]
