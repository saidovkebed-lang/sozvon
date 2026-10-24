#!/usr/bin/env bash
# Созвон — быстрое обновление: свежий код из git, зависимости, доустановка нового
# (yt-dlp и его ежедневное автообновление, обновлённые службы systemd), перезапуск.
#   sudo bash /opt/sozvon/deploy/update.sh
# Данные и настройки (/var/lib/sozvon, /etc/sozvon.env) не трогаются.
# Конфиг nginx перерисовывается из шаблона (сертификат и домен — прежние); если менялся
# шаблон coturn или нужен новый домен — запустите полную установку ещё раз:
#   sudo bash /opt/sozvon/deploy/install.sh
# Также скачивает свежее приложение для ПК (GitHub Releases, тег desktop-v*) в $DATA_DIR/downloads.
#
# Устройство: этап 1 скачивает код и запускает УЖЕ НОВУЮ версию этого скрипта (этап 2),
# так что новые шаги обновления применяются за один запуск.
set -Eeuo pipefail

APP_DIR=/opt/sozvon
DATA_DIR=/var/lib/sozvon
ENV_FILE=/etc/sozvon.env
APP_USER=sozvon
NGINX_SITE=/etc/nginx/sites-available/sozvon.conf
ACME_ROOT=/var/www/letsencrypt
BRANCH="${SOZVON_BRANCH:-main}"
NPM_REGISTRY_MAIN=https://registry.npmjs.org/
NPM_REGISTRY_MIRROR=https://registry.npmmirror.com/
MODE="${1:-}"   # пусто — полное обновление; --after-fetch — этап 2; --post-npm — вызов из npm (мост со старым update.sh)

die() { printf '\n✗ ОШИБКА: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
have_systemd() { [ -d /run/systemd/system ] && have systemctl; }
env_get() { [ -f "$ENV_FILE" ] || return 0; sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
env_set() {
  local key=$1 val=$2 esc
  if grep -q "^$key=" "$ENV_FILE"; then
    esc=$(printf '%s' "$val" | sed 's/[\\|&]/\\&/g')
    sed -i "s|^$key=.*|$key=$esc|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0"
export PATH="/opt/node/bin:/usr/local/bin:$PATH"

# ------------------------------------------------------------ этап 1: код --
if [ -z "$MODE" ]; then
  [ -d "$APP_DIR/.git" ] || die "$APP_DIR не git-репозиторий. Запустите deploy/install.sh"
  old=$(git -C "$APP_DIR" rev-parse --short HEAD)
  git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" || die "git fetch не удался (доступ к github.com?)"
  git -C "$APP_DIR" reset --hard -q FETCH_HEAD
  new=$(git -C "$APP_DIR" rev-parse --short HEAD)
  chown -R root:root "$APP_DIR"
  chmod -R u+rwX,go+rX,go-w "$APP_DIR"
  if [ "$old" = "$new" ]; then ok "Код уже свежий ($new)"; else ok "Код: $old → $new"; fi
  exec bash "$APP_DIR/deploy/update.sh" --after-fetch
fi

# --------------------------------------------------- этап 2: зависимости --
if [ "$MODE" = --after-fetch ]; then
  have npm || die "npm не найден. Запустите deploy/install.sh"
  export SOZVON_DEPLOY=1   # deploy/npm-postinstall.mjs: ничего не делать, всё делаем здесь
  sub=ci
  [ -f "$APP_DIR/package-lock.json" ] || sub=install
  reg=$NPM_REGISTRY_MAIN
  curl -fsS --connect-timeout 5 --max-time 10 -o /dev/null "${reg}express" || reg=$NPM_REGISTRY_MIRROR
  args=("$sub" --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)
  (cd "$APP_DIR" && npm "${args[@]}" --registry "$reg") \
    || (cd "$APP_DIR" && npm "${args[@]}" --registry "$NPM_REGISTRY_MIRROR") \
    || die "npm $sub не удался"
  chmod -R go+rX,go-w "$APP_DIR/node_modules"
  ok "Зависимости обновлены"
fi

# ------------------------------------------- этап 2: новое в установке --
# render ШАБЛОН ЦЕЛЬ КЛЮЧ=ЗНАЧЕНИЕ... (как в install.sh); 0 — файл изменился
render_unit() {
  local tpl=$1 dest=$2 kv k v tmp expr=()
  shift 2
  [ -f "$tpl" ] || die "Нет шаблона $tpl"
  for kv in "$@"; do
    k=${kv%%=*}
    v=$(printf '%s' "${kv#*=}" | sed 's/[\\|&]/\\&/g')
    expr+=(-e "s|@${k}@|${v}|g")
  done
  tmp=$(mktemp "$(dirname "$dest")/.sozvon.XXXXXX")
  sed "${expr[@]}" "$tpl" >"$tmp"
  if grep -qE '@[A-Z][A-Z0-9_]*@' "$tmp"; then rm -f "$tmp"; die "В шаблоне $tpl остались неподставленные значения"; fi
  chmod 0644 "$tmp"
  if [ -f "$dest" ] && cmp -s "$tmp" "$dest"; then rm -f "$tmp"; return 1; fi
  mv -f "$tmp" "$dest"
  return 0
}

ytdlp_on=1
[ "$(env_get SOZVON_YTDLP)" = 0 ] && ytdlp_on=0

if [ -f "$ENV_FILE" ]; then
  [ -n "$(env_get SOZVON_YTDLP)" ] || env_set SOZVON_YTDLP "$ytdlp_on"
  if ! grep -q '^# --- Музыка' "$ENV_FILE" && [ -f "$APP_DIR/deploy/templates/env-music.conf" ]; then
    cat "$APP_DIR/deploy/templates/env-music.conf" >>"$ENV_FILE"
    ok "В $ENV_FILE добавлены подсказки по музыкальным настройкам (закомментированы)"
  fi
fi

# SFU трансляций экрана (mediasoup): порт для старых установок и правило ufw (SFU=0 — выключен, порт не нужен)
if [ -f "$ENV_FILE" ] && [ "$(env_get SFU)" != 0 ]; then
  if [ -z "$(env_get SFU_PORT)" ]; then
    env_set SFU_PORT 40000
    ok "Трансляции через сервер (SFU): порт 40000 udp+tcp — SFU_PORT в $ENV_FILE"
  fi
  sfu_port=$(env_get SFU_PORT)
  if have ufw && ufw status 2>/dev/null | grep -q 'Status: active' && ! ufw status 2>/dev/null | grep -q "^$sfu_port/udp"; then
    ufw allow "$sfu_port/udp" comment 'sozvon sfu' >/dev/null && ufw allow "$sfu_port/tcp" comment 'sozvon sfu' >/dev/null \
      && ok "ufw: открыт порт SFU $sfu_port/udp+tcp (и в облачном файрволе провайдера, если он есть)"
  fi
fi

# ffmpeg: аватары/баннеры (кадрирование, анимация) и часть треков yt-dlp
if ! have ffmpeg && have apt-get; then
  printf '  … ставлю ffmpeg (аватары, баннеры, музыка)\n'
  if DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o DPkg::Lock::Timeout=600 --no-install-recommends ffmpeg </dev/null >/dev/null 2>&1 \
    || { DEBIAN_FRONTEND=noninteractive apt-get update -qq -o DPkg::Lock::Timeout=600 </dev/null >/dev/null 2>&1 \
         && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o DPkg::Lock::Timeout=600 --no-install-recommends ffmpeg </dev/null >/dev/null 2>&1; }; then
    ok "ffmpeg установлен"
  else
    warn "ffmpeg не установился — аватары будут сохраняться без обрезки (apt-get install ffmpeg)"
  fi
fi

if [ "$ytdlp_on" = 1 ]; then
  bash "$APP_DIR/deploy/ytdlp.sh" install || warn "yt-dlp не установлен — музыка по ссылкам недоступна (повторить: sudo bash $APP_DIR/deploy/ytdlp.sh install)"
  if [ -f "$ENV_FILE" ] && [ -z "$(env_get YTDLP_PATH)" ] && [ -x /usr/local/bin/yt-dlp ]; then
    env_set YTDLP_PATH /usr/local/bin/yt-dlp
  fi
fi

if have_systemd; then
  node_bin=$(sed -n 's|^ExecStart=\([^ ]*\) server/index.js$|\1|p' /etc/systemd/system/sozvon.service 2>/dev/null | head -n 1)
  [ -x "${node_bin:-}" ] || node_bin=$(command -v node || true)
  [ -x "${node_bin:-}" ] || die "node не найден. Запустите deploy/install.sh"
  for u in sozvon sozvon-bot; do
    if render_unit "$APP_DIR/deploy/templates/$u.service" "/etc/systemd/system/$u.service" \
        "APP_DIR=$APP_DIR" "ENV_FILE=$ENV_FILE" "DATA_DIR=$DATA_DIR" "NODE_BIN=$node_bin"; then
      ok "Обновлена служба $u.service"
    fi
  done
  if [ "$ytdlp_on" = 1 ]; then
    for u in sozvon-ytdlp-update.service sozvon-ytdlp-update.timer; do
      render_unit "$APP_DIR/deploy/templates/$u" "/etc/systemd/system/$u" "APP_DIR=$APP_DIR" || true
    done
    systemctl daemon-reload
    systemctl enable -q --now sozvon-ytdlp-update.timer
    ok "Автообновление yt-dlp: таймер sozvon-ytdlp-update.timer активен"
  else
    systemctl daemon-reload
  fi
  install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR/.cache"
  # Ежечасная загрузка нового релиза приложения для ПК (приложения у друзей обновляются сами)
  if [ -f "$APP_DIR/deploy/templates/sozvon-app-release.timer" ]; then
    for u in sozvon-app-release.service sozvon-app-release.timer; do
      render_unit "$APP_DIR/deploy/templates/$u" "/etc/systemd/system/$u" \
        "APP_DIR=$APP_DIR" "DATA_DIR=$DATA_DIR" "APP_USER=$APP_USER" || true
    done
    systemctl daemon-reload
    systemctl enable -q --now sozvon-app-release.timer
    ok "Автообновление приложения для ПК: таймер sozvon-app-release.timer активен"
  fi
fi

# nginx: перерисовать конфиг из шаблона (новый лимит загрузки и т.п.), домен и сертификат — прежние
nginx_rerender() {
  [ -f "$NGINX_SITE" ] && have nginx || return 0
  local cert key domain port l80="" l443="" backup
  cert=$(sed -n 's/^[[:space:]]*ssl_certificate[[:space:]]\{1,\}\([^;]*\);.*/\1/p' "$NGINX_SITE" | head -n 1)
  key=$(sed -n 's/^[[:space:]]*ssl_certificate_key[[:space:]]\{1,\}\([^;]*\);.*/\1/p' "$NGINX_SITE" | head -n 1)
  if [ -z "$cert" ] || [ -z "$key" ]; then
    warn "nginx: в $NGINX_SITE нет HTTPS (сертификат ещё не получен) — пропускаю; запустите deploy/install.sh"
    return 0
  fi
  domain=$(env_get SOZVON_DOMAIN)
  [ -n "$domain" ] || domain=$(sed -n 's/^[[:space:]]*server_name[[:space:]]\{1,\}\([^;]*\);.*/\1/p' "$NGINX_SITE" | head -n 1)
  port=$(env_get PORT)
  if [ -f /proc/net/if_inet6 ]; then
    l80="    listen [::]:80;"
    l443="    listen [::]:443 ssl http2;"
  fi
  backup=$(mktemp /tmp/sozvon-nginx.XXXXXX)
  cp -p "$NGINX_SITE" "$backup"
  if render_unit "$APP_DIR/deploy/templates/nginx.conf" "$NGINX_SITE" \
      "DOMAIN=$domain" "ACME_ROOT=$ACME_ROOT" "APP_PORT=${port:-3000}" \
      "SSL_CERT=$cert" "SSL_KEY=$key" "LISTEN6_80=$l80" "LISTEN6_443=$l443"; then
    if nginx -t -q 2>/dev/null; then
      if have_systemd; then systemctl reload-or-restart nginx; else nginx -s reload 2>/dev/null || true; fi
      ok "nginx: конфиг обновлён из шаблона ($(grep -o 'client_max_body_size [^;]*' "$NGINX_SITE"))"
    else
      cp -p "$backup" "$NGINX_SITE"
      warn "nginx -t: новый конфиг с ошибкой — вернул прежний ($(nginx -t 2>&1 | tail -n 1))"
    fi
  else
    ok "nginx: конфиг уже актуален"
  fi
  rm -f "$backup"
}
nginx_rerender

# Приложение для ПК: свежий релиз с GitHub → $DATA_DIR/downloads (ошибки сети не мешают обновлению)
if [ -f "$APP_DIR/deploy/app-release.sh" ]; then
  DATA_DIR=$DATA_DIR APP_USER=$APP_USER timeout 1800 bash "$APP_DIR/deploy/app-release.sh" \
    || warn "Приложение для ПК не обновлено (GitHub недоступен?). Повторить: sudo bash $APP_DIR/deploy/app-release.sh"
fi

# мост из npm: старый update.sh сам перезапустит службы следующим шагом
[ "$MODE" = --post-npm ] && exit 0

# ------------------------------------------------------- перезапуск --
have_systemd || die "systemd не найден — перезапустите процессы вручную"
systemctl restart sozvon
systemctl restart sozvon-bot
port=$(env_get PORT)
for _ in $(seq 1 30); do
  if curl -fsS --noproxy "*" --max-time 3 -o /dev/null "http://127.0.0.1:${port:-3000}/api/config" 2>/dev/null; then
    ok "Astra перезапущена и отвечает"
    if [ "$ytdlp_on" = 1 ]; then
      if [ -x /usr/local/bin/yt-dlp ]; then
        ok "yt-dlp $(/usr/local/bin/yt-dlp --version 2>/dev/null || echo '?'). Проверить YouTube/SoundCloud/Spotify: sudo bash $APP_DIR/deploy/music-check.sh"
      fi
    fi
    exit 0
  fi
  sleep 1
done
die "Сервер не отвечает после обновления. Журнал: journalctl -u sozvon -n 100"
