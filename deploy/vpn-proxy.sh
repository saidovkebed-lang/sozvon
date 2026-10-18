#!/usr/bin/env bash
# Свой VPN как прокси для Spotify (и по желанию YouTube) на сервере Astra.
# Spotify не обслуживает российские адреса (API: «unavailable in this country», страницы: 451). Скрипт ставит
# Xray-клиент с вашей ссылкой из v2RayNG (vless/vmess/trojan/ss или ссылка на подписку). Xray слушает только
# внутри сервера (127.0.0.1:10808 SOCKS, 127.0.0.1:10809 HTTP); через него идут ТОЛЬКО запросы к Spotify
# (SPOTIFY_PROXY) и, если согласитесь, скачивание музыки (YTDLP_PROXY). Голос, чат и всё остальное — напрямую.
#
#   sudo bash /opt/sozvon/deploy/vpn-proxy.sh            — установить / сменить ссылку
#   sudo bash /opt/sozvon/deploy/vpn-proxy.sh --check    — проверить, что Spotify открывается через VPN
#   sudo bash /opt/sozvon/deploy/vpn-proxy.sh --off      — выключить (вернуть как было)
set -euo pipefail

APP_DIR=${APP_DIR:-/opt/sozvon}
ENV_FILE=${ENV_FILE:-/etc/sozvon.env}
XRAY_BIN=/usr/local/bin/xray
XRAY_CONF=/etc/sozvon-vpn.json
UNIT=/etc/systemd/system/sozvon-vpn.service
HTTP_PROXY_URL=http://127.0.0.1:10809
TEST_URL=https://open.spotify.com/embed/track/6fPan2saHdFaIHuTSatORv

B=$'\e[1m'; G=$'\e[32m'; R=$'\e[31m'; Y=$'\e[33m'; Z=$'\e[0m'
ok() { printf '%s✓%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '%s!%s %s\n' "$Y" "$Z" "$*"; }
die() { printf '%s✗ %s%s\n' "$R" "$*" "$Z" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Запустите от root: sudo bash $0"

env_set() { # env_set KEY VALUE — заменить/раскомментировать строку или дописать
  local k=$1 v=$2
  touch "$ENV_FILE"
  if grep -qE "^#?\s*${k}=" "$ENV_FILE"; then
    sed -i -E "s|^#?\s*${k}=.*|${k}=${v//|/\\|}|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}
env_off() { sed -i -E "s|^(${1}=.*)|#\1|" "$ENV_FILE" 2>/dev/null || true; }

restart_app() {
  systemctl restart sozvon 2>/dev/null || true
  systemctl restart sozvon-bot 2>/dev/null || true
}

check() {
  local body code
  body=$(curl -s -m 25 -x "$HTTP_PROXY_URL" -A 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/140.0' -w '\n%{http_code}' "$TEST_URL" || true)
  code=${body##*$'\n'}
  if [ "$code" = 200 ] && grep -q '"entity":{"type":"track"' <<<"$body"; then
    ok "Spotify открывается через VPN (трек получен)"; return 0
  fi
  if grep -q '"status":451' <<<"$body"; then
    warn "VPN работает, но его сервер тоже в стране, где Spotify недоступен (451). Выберите в подписке другую страну."
  else
    warn "Через VPN Spotify не открылся (HTTP ${code:-нет ответа}). Журнал: journalctl -u sozvon-vpn -n 30"
  fi
  return 1
}

case "${1:-}" in
  --check)
    systemctl is-active --quiet sozvon-vpn && ok "Служба sozvon-vpn работает" || die "Служба sozvon-vpn не запущена"
    check; exit $? ;;
  --off)
    systemctl disable --now sozvon-vpn 2>/dev/null || true
    env_off SPOTIFY_PROXY; env_off YTDLP_PROXY
    restart_app
    ok "VPN-прокси выключен, Spotify и музыка снова идут напрямую"; exit 0 ;;
  ''|--setup) ;;
  *) die "Неизвестный параметр: $1 (есть --check и --off)" ;;
esac

printf '\n%sVPN-прокси для Spotify%s\n' "$B" "$Z"
echo "Нужна ссылка из v2RayNG: «⋮» у сервера → «Поделиться» → «Копировать в буфер» (vless://…, vmess://…, trojan://…, ss://…)"
echo "или ссылка на подписку (https://…). Ссылка — это ваш ключ к VPN: вводите её только здесь, никому не пересылайте."
echo

# 1) Xray
if [ ! -x "$XRAY_BIN" ]; then
  arch=$(uname -m)
  case "$arch" in
    x86_64|amd64) asset=Xray-linux-64.zip ;;
    aarch64|arm64) asset=Xray-linux-arm64-v8a.zip ;;
    *) die "Архитектура $arch не поддерживается" ;;
  esac
  if ! command -v unzip >/dev/null; then
    apt-get install -y -q unzip >/dev/null 2>&1 || { apt-get update -q >/dev/null; apt-get install -y -q unzip >/dev/null; }
  fi
  tmp=$(mktemp -d)
  echo "Скачиваю Xray ($asset)…"
  curl -fsSL -m 300 -o "$tmp/x.zip" "https://github.com/XTLS/Xray-core/releases/latest/download/$asset" || die "Не удалось скачать Xray с GitHub"
  unzip -o -q "$tmp/x.zip" -d "$tmp/x"
  install -m 755 "$tmp/x/xray" "$XRAY_BIN"
  rm -rf "$tmp"
fi
ok "Xray: $("$XRAY_BIN" version | head -1 | cut -d' ' -f1-2)"

# 2) ссылка → конфиг (ввод скрыт и не попадает в историю команд)
read -rsp "Вставьте ссылку и нажмите Enter: " LINK; echo
[ -n "$LINK" ] || die "Пустая ссылка"
idx=0
if [[ "$LINK" =~ ^https?:// ]]; then
  echo "Серверы в подписке:"
  printf '%s' "$LINK" | node "$APP_DIR/deploy/vpn-link.mjs" --list || die "Подписка не читается"
  read -rp "Номер сервера (лучше страна, где работает Spotify; Enter — 0): " idx; idx=${idx:-0}
fi
tmpconf=$(mktemp --suffix=.json)
printf '%s' "$LINK" | node "$APP_DIR/deploy/vpn-link.mjs" --index "$idx" > "$tmpconf" || { rm -f "$tmpconf"; die "Ссылка не распознана"; }
unset LINK
if ! xout=$("$XRAY_BIN" run -test -c "$tmpconf" 2>&1); then
  rm -f "$tmpconf"
  printf '%s\n' "$xout" | grep -iE 'fail|error' | tail -n 3 >&2
  die "Xray не принял конфиг для этого сервера — запустите скрипт ещё раз и выберите другой номер (и пришлите строку выше разработчику)"
fi
install -m 600 "$tmpconf" "$XRAY_CONF"; rm -f "$tmpconf"
ok "Конфиг сохранён в $XRAY_CONF (доступ только root)"

# 3) служба
cat > "$UNIT" <<EOF
[Unit]
Description=Astra: VPN-прокси для Spotify (Xray, только 127.0.0.1)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=$XRAY_BIN run -c $XRAY_CONF
Restart=on-failure
RestartSec=5
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
PrivateTmp=true

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload
systemctl enable --now sozvon-vpn >/dev/null 2>&1
systemctl restart sozvon-vpn
sleep 2
systemctl is-active --quiet sozvon-vpn || die "Служба не запустилась: journalctl -u sozvon-vpn -n 30"
ok "Служба sozvon-vpn запущена (127.0.0.1:10808 SOCKS, 127.0.0.1:10809 HTTP)"

# 4) проверка и включение
if check; then
  env_set SPOTIFY_PROXY "$HTTP_PROXY_URL"
  read -rp "Пустить через VPN и скачивание музыки (YouTube станет доступен)? [y/N] " yt
  if [[ "$yt" =~ ^[YyДд] ]]; then
    env_set YTDLP_PROXY "$HTTP_PROXY_URL"
    env_set MUSIC_SEARCH_SOURCES "youtube,soundcloud"
    ok "Музыка тоже идёт через VPN; поиск: YouTube, затем SoundCloud"
  fi
  restart_app
  ok "Готово. Попробуйте в голосовом канале: !play <ссылка Spotify>"
else
  warn "Spotify через этот сервер VPN недоступен — настройки Astra не менял. Запустите скрипт ещё раз и выберите другой сервер."
  exit 1
fi
