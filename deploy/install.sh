#!/usr/bin/env bash
# Созвон — установка на VPS (Ubuntu 22.04/24.04, Debian 12) одной командой:
#
#   curl -fsSL https://raw.githubusercontent.com/saidovkebed-lang/sozvon/main/deploy/install.sh | sudo bash
#
# или с параметрами:
#
#   curl -fsSL .../install.sh | sudo bash -s -- --domain chat.example.ru --email me@example.ru
#   sudo bash install.sh --domain chat.example.ru --email me@example.ru
#
# Повторный запуск безопасен: обновляет код и конфиги, сохраняет данные и секреты.
# Подробности для людей: docs/DEPLOY.md

set -Eeuo pipefail

# ---------------------------------------------------------------- настройки --
REPO_URL="${SOZVON_REPO:-https://github.com/saidovkebed-lang/sozvon.git}"
BRANCH="${SOZVON_BRANCH:-main}"

APP_DIR=/opt/sozvon
DATA_DIR=/var/lib/sozvon
ENV_FILE=/etc/sozvon.env
APP_USER=sozvon
APP_PORT=3000
TURN_PORT=3478
TURNS_PORT=5349
RELAY_MIN_PORT=49160
RELAY_MAX_PORT=49999
ACME_ROOT=/var/www/letsencrypt
TURN_CERT_DIR=/etc/coturn/certs
NGINX_SITE=/etc/nginx/sites-available/sozvon.conf
NGINX_LINK=/etc/nginx/sites-enabled/sozvon.conf
CERTBOT_HOOK=/etc/letsencrypt/renewal-hooks/deploy/sozvon-coturn.sh
LOG_DIR=/var/log/sozvon   # используется только без systemd (тестовый режим)

# Node.js: конкретная LTS-версия и её SHA256 (из SHASUMS256.txt на nodejs.org)
NODE_DIR=/opt/node
NODE_VERSION=v22.23.3
NODE_SHA256_X64=df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de
NODE_SHA256_ARM64=a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f
NODE_MIRRORS=(https://nodejs.org/dist https://npmmirror.com/mirrors/node)
NPM_REGISTRY_MAIN=https://registry.npmjs.org/
NPM_REGISTRY_MIRROR=https://registry.npmmirror.com/

# Сервисы, отдающие голый IPv4 (проверены); первые два — российские
IP_SERVICES=(
  https://ip.beget.ru
  https://ipv4-internet.yandex.net/api/v0/ip
  https://ifconfig.me
  https://api.ipify.org
  https://ipv4.icanhazip.com
  https://checkip.amazonaws.com
)

# --------------------------------------------------------------- параметры --
OPT_DOMAIN=""
OPT_EMAIL=""
OPT_IP=""
OPT_SOURCE=""
OPT_RELAY=""          # ""=не менять (по умолчанию 1), 1 или 0
OPT_FIREWALL=1
OPT_YTDLP=""         # ""=как в прошлый раз (по умолчанию 1), 1 или 0
LOCAL_TEST=0
case "${SOZVON_TEST:-0}" in 1|true|yes) LOCAL_TEST=1 ;; esac

usage() {
  cat <<'EOF'
Установка «Созвона» на сервер.

Использование: sudo bash install.sh [параметры]

  --domain ДОМЕН    свой домен (A-запись должна указывать на IP сервера).
                    Без него используется <ip>.sslip.io
  --email ПОЧТА     почта для Let's Encrypt (напоминания о сертификате). Необязательно
  --ip IPv4         публичный IP сервера, если автоопределение ошибается
  --no-relay        не гнать весь голос через свой TURN (FORCE_RELAY=0)
  --relay           весь голос и видео через свой TURN (FORCE_RELAY=1, по умолчанию)
  --no-firewall     не настраивать ufw
  --no-ytdlp        не ставить yt-dlp и ffmpeg (музыка по ссылкам YouTube/Spotify/SoundCloud
                    будет недоступна; по умолчанию ставятся, с ежедневным автообновлением)
  --branch ВЕТКА    ветка git (по умолчанию main)
  --source КАТАЛОГ  взять код из локального каталога вместо git clone
  --local-test      тестовый режим (Docker): без certbot/ufw/определения IP,
                    самоподписанный сертификат, код из /src (или из SOZVON_REPO)
  -h, --help        эта справка
EOF
}

parse_args() {
  while [ $# -gt 0 ]; do
    case "$1" in
      --domain) OPT_DOMAIN="${2:-}"; shift ;;
      --domain=*) OPT_DOMAIN="${1#*=}" ;;
      --email) OPT_EMAIL="${2:-}"; shift ;;
      --email=*) OPT_EMAIL="${1#*=}" ;;
      --ip) OPT_IP="${2:-}"; shift ;;
      --ip=*) OPT_IP="${1#*=}" ;;
      --branch) BRANCH="${2:-}"; shift ;;
      --branch=*) BRANCH="${1#*=}" ;;
      --source) OPT_SOURCE="${2:-}"; shift ;;
      --source=*) OPT_SOURCE="${1#*=}" ;;
      --relay) OPT_RELAY=1 ;;
      --no-relay) OPT_RELAY=0 ;;
      --no-firewall) OPT_FIREWALL=0 ;;
      --with-ytdlp|--ytdlp) OPT_YTDLP=1 ;;
      --no-ytdlp) OPT_YTDLP=0 ;;
      --local-test) LOCAL_TEST=1 ;;
      -h|--help) usage; exit 0 ;;
      *) die "Неизвестный параметр: $1 (см. --help)" ;;
    esac
    shift
  done
  if [ -z "$OPT_YTDLP" ]; then
    OPT_YTDLP=$(env_get SOZVON_YTDLP)
    [ "$OPT_YTDLP" = 0 ] || OPT_YTDLP=1
  fi
  if [ "$LOCAL_TEST" = 1 ]; then
    # код из смонтированного /src, если явно не задан SOZVON_REPO (тогда — git clone)
    if [ -z "$OPT_SOURCE" ] && [ -z "${SOZVON_REPO:-}" ]; then OPT_SOURCE=/src; fi
    OPT_FIREWALL=0
  fi
}

# ------------------------------------------------------------------ вывод --
if [ -t 1 ]; then
  C_B=$'\033[1m'; C_G=$'\033[32m'; C_Y=$'\033[33m'; C_R=$'\033[31m'; C_C=$'\033[36m'; C_0=$'\033[0m'
else
  C_B=""; C_G=""; C_Y=""; C_R=""; C_C=""; C_0=""
fi
STEP_N=0
step() { STEP_N=$((STEP_N + 1)); printf '\n%s==> [%d] %s%s\n' "$C_B$C_C" "$STEP_N" "$*" "$C_0"; }
info() { printf '    %s\n' "$*"; }
ok()   { printf '    %s✓%s %s\n' "$C_G" "$C_0" "$*"; }
warn() { printf '    %s⚠ %s%s\n' "$C_Y" "$*" "$C_0" >&2; }
die()  { printf '\n%s✗ ОШИБКА: %s%s\n' "$C_R$C_B" "$*" "$C_0" >&2; exit 1; }

on_error() {
  local code=$? line=${1:-?}
  printf '\n%s✗ Установка прервана (строка %s, код %s).%s\n' "$C_R$C_B" "$line" "$code" "$C_0" >&2
  printf '  Исправьте причину выше и запустите команду установки ещё раз — это безопасно.\n' >&2
  exit "$code"
}

have() { command -v "$1" >/dev/null 2>&1; }
have_systemd() { [ -d /run/systemd/system ] && have systemctl; }

# ----------------------------------------------------------------- утилиты --
valid_ipv4() {
  local ip=$1 o
  [[ $ip =~ ^([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})\.([0-9]{1,3})$ ]] || return 1
  for o in "${BASH_REMATCH[@]:1}"; do [ "$o" -le 255 ] || return 1; done
}

private_ipv4() {
  [[ $1 =~ ^(10\.|127\.|169\.254\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])\.) ]]
}

# IPv4 исходящего интерфейса (на облаках с NAT — внутренний адрес)
local_ipv4() {
  ip -4 route get 1.1.1.1 2>/dev/null | awk '{for (i = 1; i < NF; i++) if ($i == "src") { print $(i + 1); exit }}'
}

env_get() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1
}

env_set() {
  local key=$1 val=$2 esc
  if grep -q "^$key=" "$ENV_FILE"; then
    esc=$(printf '%s' "$val" | sed 's/[\\|&]/\\&/g')
    sed -i "s|^$key=.*|$key=$esc|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >>"$ENV_FILE"
  fi
}

# render ШАБЛОН ЦЕЛЬ РЕЖИМ ВЛАДЕЛЕЦ КЛЮЧ=ЗНАЧЕНИЕ... — подставляет @КЛЮЧ@
render() {
  local tpl=$1 dest=$2 mode=$3 owner=$4 kv k v tmp
  shift 4
  [ -f "$tpl" ] || die "Нет шаблона $tpl"
  local expr=()
  for kv in "$@"; do
    k=${kv%%=*}
    v=$(printf '%s' "${kv#*=}" | sed 's/[\\|&]/\\&/g')
    expr+=(-e "s|@${k}@|${v}|g")
  done
  tmp=$(mktemp "$(dirname "$dest")/.sozvon.XXXXXX")
  sed "${expr[@]}" "$tpl" >"$tmp"
  if grep -qE '@[A-Z][A-Z0-9_]*@' "$tmp"; then
    rm -f "$tmp"
    die "В шаблоне $tpl остались неподставленные значения"
  fi
  chmod "$mode" "$tmp"
  chown "$owner" "$tmp"
  mv -f "$tmp" "$dest"
}

apt_install() {
  DEBIAN_FRONTEND=noninteractive apt-get install -y -qq \
    -o DPkg::Lock::Timeout=600 \
    -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold \
    --no-install-recommends "$@" </dev/null >/dev/null
}

download() { # URL ФАЙЛ
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 600 -sS -o "$2" "$1"
}

# ------------------------------------------------------------------- шаги --
check_system() {
  step "Проверка системы"
  [ "$(id -u)" -eq 0 ] || die "Запустите от root: curl -fsSL … | sudo bash"
  have apt-get || die "Нужна Ubuntu 22.04/24.04 или Debian 12 (apt-get не найден)"
  local id="" ver="" name="?"
  if [ -r /etc/os-release ]; then
    # shellcheck disable=SC1091
    . /etc/os-release
    id=${ID:-}; ver=${VERSION_ID:-}; name=${PRETTY_NAME:-$id}
  fi
  case "$id:$ver" in
    ubuntu:22.04|ubuntu:24.04|debian:12|debian:13) ok "Система: $name" ;;
    *) warn "Система $name не проверялась (рекомендуется Ubuntu 24.04). Продолжаю." ;;
  esac
  case "$(uname -m)" in
    x86_64|amd64) NODE_ARCH=x64; NODE_SHA256=$NODE_SHA256_X64 ;;
    aarch64|arm64) NODE_ARCH=arm64; NODE_SHA256=$NODE_SHA256_ARM64 ;;
    *) die "Архитектура $(uname -m) не поддерживается (нужна x86_64 или arm64)" ;;
  esac
  if ! have_systemd && [ "$LOCAL_TEST" != 1 ]; then
    die "Не найден systemd. Нужен обычный VPS (KVM), а не контейнер без systemd."
  fi
  local mem_mb
  mem_mb=$(awk '/MemTotal/ {print int($2 / 1024)}' /proc/meminfo 2>/dev/null || echo 0)
  if [ "${mem_mb:-0}" -gt 0 ] && [ "$mem_mb" -lt 700 ]; then
    warn "Мало памяти: ${mem_mb} МБ. Рекомендуется от 1 ГБ."
  fi
  [ "$LOCAL_TEST" = 1 ] && warn "ТЕСТОВЫЙ РЕЖИМ (--local-test): без Let's Encrypt, ufw и определения IP"
  return 0
}

install_packages() {
  step "Установка пакетов (nginx, coturn, certbot, git…)"
  info "Это займёт 1–3 минуты…"
  DEBIAN_FRONTEND=noninteractive apt-get update -qq -o DPkg::Lock::Timeout=600 </dev/null
  local pkgs=(ca-certificates curl git openssl xz-utils iproute2 procps nginx coturn certbot python3)
  # ffmpeg: yt-dlp собирает из него аудио (HLS SoundCloud, opus → mp3 для всех браузеров)
  [ "$OPT_FIREWALL" = 1 ] && pkgs+=(ufw)
  [ "$OPT_YTDLP" = 1 ] && pkgs+=(ffmpeg)
  apt_install "${pkgs[@]}"
  ok "Пакеты установлены"
}

detect_ip() {
  step "Определение публичного IP"
  LOCAL_IP=$(local_ipv4 || true)
  if [ -n "$OPT_IP" ]; then
    valid_ipv4 "$OPT_IP" || die "--ip: «$OPT_IP» не похож на IPv4"
    PUBLIC_IP=$OPT_IP
    ok "IP задан вручную: $PUBLIC_IP"
  elif [ "$LOCAL_TEST" = 1 ]; then
    PUBLIC_IP=${LOCAL_IP:-127.0.0.1}
    ok "Тестовый режим: использую локальный IP $PUBLIC_IP"
  else
    PUBLIC_IP=""
    local s ip
    for s in "${IP_SERVICES[@]}"; do
      ip=$(curl -4 -fsS --connect-timeout 5 --max-time 8 "$s" 2>/dev/null | tr -d ' \t\r\n"') || continue
      if valid_ipv4 "$ip" && ! private_ipv4 "$ip"; then
        PUBLIC_IP=$ip
        ok "Публичный IP: $PUBLIC_IP (по $s)"
        break
      fi
    done
    if [ -z "$PUBLIC_IP" ]; then
      if [ -n "$LOCAL_IP" ] && ! private_ipv4 "$LOCAL_IP"; then
        PUBLIC_IP=$LOCAL_IP
        ok "Публичный IP (по маршруту): $PUBLIC_IP"
      else
        die "Не удалось определить публичный IPv4. Укажите его вручную: --ip 1.2.3.4 (есть в панели провайдера)"
      fi
    fi
  fi
  [ -n "$LOCAL_IP" ] || LOCAL_IP=$PUBLIC_IP
  if [ "$LOCAL_IP" != "$PUBLIC_IP" ] && [ "$LOCAL_TEST" != 1 ]; then
    info "Сервер за NAT провайдера: внутренний IP $LOCAL_IP → внешний $PUBLIC_IP (учтём в TURN)"
  fi
}

to_ascii_domain() {
  local d=$1
  if [[ $d =~ [^a-zA-Z0-9.-] ]]; then
    d=$(python3 -c 'import sys; print(sys.argv[1].encode("idna").decode())' "$d" 2>/dev/null) \
      || die "Не удалось преобразовать домен «$1» (кириллический домен укажите в punycode, xn--…)"
  fi
  printf '%s' "${d,,}" | sed 's/\.$//'
}

choose_domain() {
  step "Выбор адреса сайта"
  local prev prev_auto
  prev=$(env_get SOZVON_DOMAIN)
  prev_auto=$(env_get SOZVON_DOMAIN_AUTO)
  DOMAIN_AUTO=0
  if [ -n "$OPT_DOMAIN" ]; then
    DOMAIN=$(to_ascii_domain "$OPT_DOMAIN")
  elif [ -n "$prev" ] && [ "$prev_auto" != 1 ]; then
    DOMAIN=$prev
    info "Использую домен из прошлой установки"
  elif [ "$LOCAL_TEST" = 1 ]; then
    DOMAIN=sozvon.test
  else
    DOMAIN="${PUBLIC_IP//./-}.sslip.io"
    DOMAIN_AUTO=1
  fi
  [[ $DOMAIN =~ ^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9-]{2,63}$ ]] || die "Некорректный домен: $DOMAIN"
  ok "Адрес: https://$DOMAIN"
  if [ "$DOMAIN_AUTO" = 1 ]; then
    warn "Используется бесплатный адрес $DOMAIN (сервис sslip.io)."
    warn "Свой домен (.ru/.рф) надёжнее: sslip.io — зарубежный DNS и может работать с перебоями."
    warn "Потом можно перейти: sudo bash $APP_DIR/deploy/install.sh --domain ваш-домен.ru"
  elif [ "$LOCAL_TEST" != 1 ]; then
    local resolved
    resolved=$(getent ahostsv4 "$DOMAIN" 2>/dev/null | awk '{print $1}' | sort -u | tr '\n' ' ' || true)
    if [ -z "$resolved" ]; then
      warn "Домен $DOMAIN пока не находится в DNS. Создайте A-запись → $PUBLIC_IP и подождите 5–30 минут."
    elif [[ " $resolved " != *" $PUBLIC_IP "* ]]; then
      warn "Домен $DOMAIN указывает на ${resolved% }, а IP сервера $PUBLIC_IP. Исправьте A-запись."
    else
      ok "DNS: $DOMAIN → $PUBLIC_IP"
    fi
  fi
}

node_major() { local v; v=$("$1" -v 2>/dev/null) || return 1; v=${v#v}; printf '%s' "${v%%.*}"; }

install_node() {
  step "Node.js"
  local cur=""
  [ -x "$NODE_DIR/bin/node" ] && cur=$("$NODE_DIR/bin/node" -v 2>/dev/null || true)
  if [ "$cur" = "$NODE_VERSION" ]; then
    ok "Node.js $cur уже установлен в $NODE_DIR"
  else
    local sys_node="" major=0
    sys_node=$(command -v node 2>/dev/null || true)
    [ -n "$sys_node" ] && major=$(node_major "$sys_node" || echo 0)
    if [ -z "$cur" ] && [ -n "$sys_node" ] && [ "${major:-0}" -ge 20 ] && have npm; then
      NODE_BIN=$sys_node
      NPM_BIN=$(command -v npm)
      ok "Использую системный Node.js $("$NODE_BIN" -v) ($NODE_BIN)"
      return 0
    fi
    local file="node-$NODE_VERSION-linux-$NODE_ARCH.tar.xz" tmp m got=0
    tmp=$(mktemp -d)
    for m in "${NODE_MIRRORS[@]}"; do
      info "Скачиваю $m/$NODE_VERSION/$file"
      if download "$m/$NODE_VERSION/$file" "$tmp/$file"; then
        if echo "$NODE_SHA256  $tmp/$file" | sha256sum -c --status; then
          got=1
          break
        fi
        warn "Контрольная сумма не совпала — пробую другое зеркало"
      else
        warn "Не скачалось с $m — пробую другое зеркало"
      fi
      rm -f "$tmp/$file"
    done
    [ "$got" = 1 ] || { rm -rf "$tmp"; die "Не удалось скачать Node.js ни с одного зеркала"; }
    mkdir -p "$tmp/x"
    tar -xJf "$tmp/$file" -C "$tmp/x" --strip-components=1
    rm -rf "$NODE_DIR.old"
    [ -d "$NODE_DIR" ] && mv "$NODE_DIR" "$NODE_DIR.old"
    mv "$tmp/x" "$NODE_DIR"
    chown -R root:root "$NODE_DIR"
    chmod 755 "$NODE_DIR"
    rm -rf "$NODE_DIR.old" "$tmp"
    ok "Node.js $NODE_VERSION установлен в $NODE_DIR (sha256 проверен)"
  fi
  local b
  for b in node npm npx; do ln -sfn "$NODE_DIR/bin/$b" "/usr/local/bin/$b"; done
  NODE_BIN=$NODE_DIR/bin/node
  NPM_BIN=$NODE_DIR/bin/npm
  export PATH="$NODE_DIR/bin:$PATH"
}

install_ytdlp() {
  step "yt-dlp (музыка с YouTube, SoundCloud, треки Spotify)"
  if [ "$OPT_YTDLP" != 1 ]; then
    info "Пропущено (--no-ytdlp). Включить потом: sudo bash $APP_DIR/deploy/install.sh --ytdlp"
    return 0
  fi
  # бинарь с GitHub (sha256 из SHA2-256SUMS), запасной вариант — pip в venv
  if ! bash "$APP_DIR/deploy/ytdlp.sh" install; then
    warn "Музыка по ссылкам пока недоступна. Повторить: sudo bash $APP_DIR/deploy/ytdlp.sh install"
  fi
  return 0
}

setup_user() {
  step "Пользователь и каталоги"
  if ! id "$APP_USER" >/dev/null 2>&1; then
    useradd --system --user-group --home-dir "$DATA_DIR" --no-create-home \
      --shell /usr/sbin/nologin "$APP_USER"
    ok "Создан системный пользователь $APP_USER"
  else
    ok "Пользователь $APP_USER уже есть"
  fi
  install -d -o "$APP_USER" -g "$APP_USER" -m 0750 "$DATA_DIR"
  install -d -m 0755 "$ACME_ROOT"
  ok "Данные: $DATA_DIR"
}

fetch_code() {
  step "Код Созвона → $APP_DIR"
  if [ -n "$OPT_SOURCE" ]; then
    [ -f "$OPT_SOURCE/package.json" ] || die "--source: в $OPT_SOURCE нет package.json"
    mkdir -p "$APP_DIR"
    tar -C "$OPT_SOURCE" --exclude=./node_modules --exclude=./data --exclude=./.git \
      --exclude=./output --exclude=./tests --exclude=./test-results -cf - . | tar -C "$APP_DIR" -xf -
    ok "Скопировано из $OPT_SOURCE"
  elif [ -d "$APP_DIR/.git" ]; then
    git -C "$APP_DIR" remote set-url origin "$REPO_URL"
    git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" \
      || die "git fetch не удался. Проверьте доступ к github.com с сервера: curl -I https://github.com"
    git -C "$APP_DIR" reset --hard -q FETCH_HEAD
    ok "Обновлено до $(git -C "$APP_DIR" log -1 --format='%h %s')"
  else
    if [ -e "$APP_DIR" ] && [ -n "$(ls -A "$APP_DIR" 2>/dev/null)" ]; then
      local bak
      bak="$APP_DIR.bak-$(date +%Y%m%d-%H%M%S)"
      mv "$APP_DIR" "$bak"
      warn "$APP_DIR был не пустой — перенесён в $bak"
    fi
    git clone -q --depth 1 --branch "$BRANCH" "$REPO_URL" "$APP_DIR" \
      || die "git clone не удался. Проверьте доступ к github.com с сервера: curl -I https://github.com"
    ok "Склонировано: $(git -C "$APP_DIR" log -1 --format='%h %s')"
  fi
  [ -f "$APP_DIR/deploy/templates/nginx.conf" ] || die "В коде нет deploy/templates — проверьте ветку ($BRANCH)"
  chown -R root:root "$APP_DIR"
  chmod -R u+rwX,go+rX,go-w "$APP_DIR"
}

npm_deps() {
  step "Зависимости npm"
  local sub=ci reg
  [ -f "$APP_DIR/package-lock.json" ] || sub=install
  if curl -fsS --connect-timeout 5 --max-time 10 -o /dev/null "${NPM_REGISTRY_MAIN}express"; then
    reg=$NPM_REGISTRY_MAIN
  else
    reg=$NPM_REGISTRY_MIRROR
    warn "registry.npmjs.org недоступен — использую зеркало $reg"
  fi
  export SOZVON_DEPLOY=1   # deploy/npm-postinstall.mjs: шаги обновления делаем сами, не из npm
  local npm_args=("$sub" --omit=dev --no-audit --no-fund --no-update-notifier --loglevel=error)
  if ! (cd "$APP_DIR" && "$NPM_BIN" "${npm_args[@]}" --registry "$reg"); then
    [ "$reg" = "$NPM_REGISTRY_MIRROR" ] && die "npm $sub не удался"
    warn "npm $sub не удался с $reg — пробую зеркало $NPM_REGISTRY_MIRROR"
    (cd "$APP_DIR" && "$NPM_BIN" "${npm_args[@]}" --registry "$NPM_REGISTRY_MIRROR") || die "npm $sub не удался"
  fi
  chmod -R go+rX,go-w "$APP_DIR/node_modules"
  ok "npm $sub --omit=dev: готово"
}

write_env() {
  step "Настройки ($ENV_FILE)"
  if [ ! -f "$ENV_FILE" ]; then
    install -m 0600 -o root -g root /dev/null "$ENV_FILE"
    printf '# Созвон: переменные окружения (создано deploy/install.sh).\n# Свои переменные можно дописывать — установщик их не трогает.\n' >"$ENV_FILE"
  fi
  chmod 600 "$ENV_FILE"
  chown root:root "$ENV_FILE"

  TURN_SECRET=$(env_get TURN_SECRET)
  if [ -z "$TURN_SECRET" ]; then
    TURN_SECRET=$(openssl rand -hex 32)
    env_set TURN_SECRET "$TURN_SECRET"
    ok "Сгенерирован TURN_SECRET"
  else
    ok "TURN_SECRET сохранён с прошлой установки"
  fi
  env_set HTTPS 0
  env_set HOST 127.0.0.1
  env_set PORT "$APP_PORT"
  env_set TRUST_PROXY 1
  env_set PUBLIC_URL "https://$DOMAIN"
  env_set DATA_DIR "$DATA_DIR"
  env_set TURN_HOST "$DOMAIN"
  env_set TURN_PORT "$TURN_PORT"
  env_set TURNS_PORT "$TURNS_PORT"
  if [ -n "$OPT_RELAY" ]; then
    env_set FORCE_RELAY "$OPT_RELAY"
  elif [ -z "$(env_get FORCE_RELAY)" ]; then
    env_set FORCE_RELAY 1
  fi
  env_set BOT_SERVER_URL "http://127.0.0.1:$APP_PORT"
  env_set SOZVON_DOMAIN "$DOMAIN"
  env_set SOZVON_DOMAIN_AUTO "$DOMAIN_AUTO"
  [ -n "$OPT_EMAIL" ] && env_set SOZVON_EMAIL "$OPT_EMAIL"
  env_set SOZVON_YTDLP "$OPT_YTDLP"
  if [ "$OPT_YTDLP" = 1 ] && [ -z "$(env_get YTDLP_PATH)" ]; then env_set YTDLP_PATH /usr/local/bin/yt-dlp; fi
  # подсказки по музыкальным настройкам (закомментированы) — один раз
  if ! grep -q '^# --- Музыка' "$ENV_FILE"; then
    cat "$APP_DIR/deploy/templates/env-music.conf" >>"$ENV_FILE"
  fi
  ok "FORCE_RELAY=$(env_get FORCE_RELAY) (1 = весь голос через свой TURN)"
}

# ---------------------------------------------------------------- службы --
svc_restart() { # имя
  if have_systemd; then
    systemctl daemon-reload
    systemctl enable -q "$1"
    systemctl restart "$1"
  else
    direct_restart "$1"
  fi
}

# Без systemd (только --local-test в Docker): запускаем процессы напрямую.
# 9>&- — не отдаём дочерним процессам дескриптор блокировки установщика.
direct_restart() {
  mkdir -p "$LOG_DIR"
  case "$1" in
    nginx)
      nginx -s reload 2>/dev/null || nginx 9>&- ;;
    coturn)
      pkill -x turnserver 2>/dev/null && sleep 1 || true
      turnserver -c /etc/turnserver.conf -o --pidfile=/run/turnserver.pid \
        --proc-user turnserver --proc-group turnserver --log-file="$LOG_DIR/coturn.log" >/dev/null 9>&- ;;
    sozvon|sozvon-bot)
      local script=server/index.js pidf="/run/$1.pid"
      [ "$1" = sozvon-bot ] && script=bot/index.js
      if [ -f "$pidf" ]; then kill "$(cat "$pidf")" 2>/dev/null || true; sleep 1; fi
      (
        set -a
        # shellcheck disable=SC1090
        . "$ENV_FILE"
        set +a
        export HOME=$DATA_DIR NODE_ENV=production
        umask 027
        cd "$APP_DIR"
        exec setsid runuser -u "$APP_USER" -- "$NODE_BIN" "$script" </dev/null >>"$LOG_DIR/$1.log" 2>&1
      ) 9>&- &
      echo $! >"$pidf" ;;
  esac
}

nginx_apply() {
  nginx -t -q 2>&1 || die "nginx -t: конфигурация с ошибкой"
  if have_systemd; then
    systemctl enable -q nginx
    systemctl reload-or-restart nginx
  else
    direct_restart nginx
  fi
}

setup_coturn() {
  step "TURN-сервер (coturn)"
  # relay-ip — адрес основного интерфейса: иначе coturn может выбрать loopback/docker0
  # и анонсировать external-ip, на котором реально не слушает
  local ext_ip=$PUBLIC_IP relay_line="relay-ip=$LOCAL_IP"
  if [ "$LOCAL_IP" != "$PUBLIC_IP" ]; then
    ext_ip="$PUBLIC_IP/$LOCAL_IP"
  fi
  render "$APP_DIR/deploy/templates/turnserver.conf" /etc/turnserver.conf 0640 root:turnserver \
    "TURN_PORT=$TURN_PORT" "TURNS_PORT=$TURNS_PORT" "EXTERNAL_IP=$ext_ip" "RELAY_IP_LINE=$relay_line" \
    "RELAY_MIN_PORT=$RELAY_MIN_PORT" "RELAY_MAX_PORT=$RELAY_MAX_PORT" "DOMAIN=$DOMAIN" \
    "TURN_SECRET=$TURN_SECRET" "TURN_CERT=$TURN_CERT_DIR/fullchain.pem" "TURN_PKEY=$TURN_CERT_DIR/privkey.pem"
  if [ -f /etc/default/coturn ]; then
    if grep -qE '^#?\s*TURNSERVER_ENABLED=' /etc/default/coturn; then
      sed -i -E 's/^#?\s*TURNSERVER_ENABLED=.*/TURNSERVER_ENABLED=1/' /etc/default/coturn
    else
      echo 'TURNSERVER_ENABLED=1' >>/etc/default/coturn
    fi
  fi
  install -d -o turnserver -g turnserver -m 0750 "$TURN_CERT_DIR"
  ok "/etc/turnserver.conf: порты $TURN_PORT (udp/tcp), $TURNS_PORT (tls), relay $RELAY_MIN_PORT-$RELAY_MAX_PORT/udp"
}

# Самоподписанный сертификат для --local-test (вместо Let's Encrypt)
test_cert() {
  local dir=$1
  install -d -m 0755 "$dir"
  if [ ! -s "$dir/fullchain.pem" ]; then
    openssl req -x509 -newkey rsa:2048 -nodes -days 365 -subj "/CN=$DOMAIN" \
      -addext "subjectAltName=DNS:$DOMAIN" -keyout "$dir/privkey.pem" -out "$dir/fullchain.pem" 2>/dev/null
    chmod 600 "$dir/privkey.pem"
  fi
}

cert_valid() { # каталог: есть и действует ещё ≥ 30 дней
  [ -s "$1/fullchain.pem" ] && [ -s "$1/privkey.pem" ] \
    && openssl x509 -checkend 2592000 -noout -in "$1/fullchain.pem" >/dev/null 2>&1
}

certbot_hints() {
  cat >&2 <<EOF

${C_Y}${C_B}Не удалось получить сертификат HTTPS для $DOMAIN.${C_0}
Без HTTPS браузеры не дают доступ к микрофону, поэтому сайт пока не запущен наружу.
Что проверить:
  1. Порт 80 (TCP) открыт для всего интернета. У многих провайдеров VPS есть
     «облачный файрвол» / «группы безопасности» в панели — разрешите там 80 и 443.
  2. Домен указывает на этот сервер: A-запись $DOMAIN → $PUBLIC_IP
     (проверка: getent hosts $DOMAIN). После изменения DNS подождите 5–30 минут.
  3. Если ошибка «too many certificates» / rate limit — подождите или используйте свой домен:
       sudo bash $APP_DIR/deploy/install.sh --domain ваш-домен.ru
Подробный журнал: /var/log/letsencrypt/letsencrypt.log
После исправления просто запустите установку ещё раз.
EOF
}

setup_nginx_and_cert() {
  step "nginx и сертификат HTTPS"
  # IPv6 слушаем, только если он есть в ядре (на части VPS выключен — nginx тогда не стартует)
  local l80="" l443=""
  if [ -f /proc/net/if_inet6 ]; then
    l80="    listen [::]:80;"
    l443="    listen [::]:443 ssl http2;"
  fi
  rm -f /etc/nginx/sites-enabled/default
  ln -sfn "$NGINX_SITE" "$NGINX_LINK"
  CERT_OK=0
  if [ "$LOCAL_TEST" = 1 ]; then
    CERT_LINEAGE=/etc/ssl/sozvon-test/$DOMAIN
    test_cert "$CERT_LINEAGE"
    ok "Тестовый режим: самоподписанный сертификат $CERT_LINEAGE"
  else
    CERT_LINEAGE=/etc/letsencrypt/live/$DOMAIN
  fi

  install -d -m 0755 "$(dirname "$CERTBOT_HOOK")"
  render "$APP_DIR/deploy/templates/certbot-deploy-hook.sh" "$CERTBOT_HOOK" 0755 root:root \
    "CERT_LINEAGE=$CERT_LINEAGE" "TURN_CERT_DIR=$TURN_CERT_DIR"

  if [ "$LOCAL_TEST" = 1 ]; then
    CERT_OK=1   # в тестовом режиме certbot не вызываем никогда
  elif cert_valid "$CERT_LINEAGE"; then
    CERT_OK=1
    ok "Сертификат уже есть и действителен: $CERT_LINEAGE"
  else
    # Этап 1: только HTTP, чтобы Let's Encrypt проверил домен
    render "$APP_DIR/deploy/templates/nginx-http.conf" "$NGINX_SITE" 0644 root:root \
      "DOMAIN=$DOMAIN" "ACME_ROOT=$ACME_ROOT" "LISTEN6_80=$l80"
    nginx_apply
    local email_args=(--register-unsafely-without-email)
    local email=${OPT_EMAIL:-$(env_get SOZVON_EMAIL)}
    [ -n "$email" ] && email_args=(--email "$email" --no-eff-email)
    info "Запрашиваю сертификат Let's Encrypt для $DOMAIN…"
    if certbot certonly --webroot -w "$ACME_ROOT" --cert-name "$DOMAIN" -d "$DOMAIN" \
        --non-interactive --agree-tos "${email_args[@]}" --keep-until-expiring </dev/null; then
      CERT_OK=1
      ok "Сертификат получен, продление автоматическое (certbot.timer)"
    else
      certbot_hints
    fi
  fi

  if [ "$CERT_OK" = 1 ]; then
    render "$APP_DIR/deploy/templates/nginx.conf" "$NGINX_SITE" 0644 root:root \
      "DOMAIN=$DOMAIN" "ACME_ROOT=$ACME_ROOT" "APP_PORT=$APP_PORT" \
      "SSL_CERT=$CERT_LINEAGE/fullchain.pem" "SSL_KEY=$CERT_LINEAGE/privkey.pem" \
      "LISTEN6_80=$l80" "LISTEN6_443=$l443"
    nginx_apply
    RENEWED_LINEAGE=$CERT_LINEAGE "$CERTBOT_HOOK"
    ok "nginx: https://$DOMAIN → 127.0.0.1:$APP_PORT"
  fi
}

# Ежедневное обновление yt-dlp (systemd timer)
setup_ytdlp_timer() {
  local u
  if [ "$OPT_YTDLP" = 1 ]; then
    for u in sozvon-ytdlp-update.service sozvon-ytdlp-update.timer; do
      render "$APP_DIR/deploy/templates/$u" "/etc/systemd/system/$u" 0644 root:root "APP_DIR=$APP_DIR"
    done
    systemctl daemon-reload
    systemctl enable -q --now sozvon-ytdlp-update.timer
    ok "Автообновление yt-dlp: sozvon-ytdlp-update.timer (раз в сутки)"
  elif [ -f /etc/systemd/system/sozvon-ytdlp-update.timer ]; then
    systemctl disable -q --now sozvon-ytdlp-update.timer 2>/dev/null || true
    info "Автообновление yt-dlp выключено (--no-ytdlp)"
  fi
}

setup_services() {
  step "Службы (systemd)"
  if have_systemd; then
    local u
    for u in sozvon sozvon-bot; do
      render "$APP_DIR/deploy/templates/$u.service" "/etc/systemd/system/$u.service" 0644 root:root \
        "APP_DIR=$APP_DIR" "ENV_FILE=$ENV_FILE" "DATA_DIR=$DATA_DIR" "NODE_BIN=$NODE_BIN"
    done
    setup_ytdlp_timer
    systemctl daemon-reload
    systemctl enable -q coturn sozvon sozvon-bot
  else
    warn "systemd нет (тестовый режим) — запускаю процессы напрямую, логи в $LOG_DIR"
  fi
  svc_restart coturn
  svc_restart sozvon
  svc_restart sozvon-bot
  ok "Запущены: coturn, sozvon, sozvon-bot"
}

ssh_ports() {
  local p
  p=$(ss -Htlnp 2>/dev/null | awk '/"sshd"/ {n = split($4, a, ":"); print a[n]}' | sort -u)
  [ -n "$p" ] || p=22
  printf '%s\n' "$p"
}

setup_firewall() {
  [ "$OPT_FIREWALL" = 1 ] || return 0
  step "Файрвол (ufw)"
  have ufw || { warn "ufw не найден — пропускаю"; return 0; }
  local p
  for p in $(ssh_ports) 22; do ufw allow "$p/tcp" comment 'ssh' >/dev/null; done
  ufw allow 80/tcp comment 'sozvon http' >/dev/null
  ufw allow 443/tcp comment 'sozvon https' >/dev/null
  ufw allow "$TURN_PORT/udp" comment 'sozvon turn' >/dev/null
  ufw allow "$TURN_PORT/tcp" comment 'sozvon turn' >/dev/null
  ufw allow "$TURNS_PORT/tcp" comment 'sozvon turns' >/dev/null
  ufw allow "$RELAY_MIN_PORT:$RELAY_MAX_PORT/udp" comment 'sozvon turn relay' >/dev/null
  if ufw status | grep -q 'Status: active'; then
    ufw reload >/dev/null
  else
    ufw --force enable >/dev/null
  fi
  ok "Открыты: SSH, 80, 443/tcp, $TURN_PORT/udp+tcp, $TURNS_PORT/tcp, $RELAY_MIN_PORT-$RELAY_MAX_PORT/udp"
  warn "Если у провайдера есть «облачный файрвол» в панели — откройте там те же порты."
}

# ------------------------------------------------------------- проверки --
health_check() {
  step "Проверка"
  local cfg="" failed=0
  for _ in $(seq 1 30); do
    cfg=$(curl -fsS --noproxy "*" --max-time 3 "http://127.0.0.1:$APP_PORT/api/config" 2>/dev/null) && break
    sleep 1
  done
  if [ -z "$cfg" ]; then
    warn "Сервер не отвечает на 127.0.0.1:$APP_PORT"
    if have_systemd; then journalctl -u sozvon -n 30 --no-pager >&2 || true; fi
    die "Сервер не запустился. Журнал: journalctl -u sozvon -n 100"
  fi
  ok "Сервер отвечает: /api/config"
  if [[ $cfg == *"turn:$DOMAIN:$TURN_PORT"* ]]; then ok "TURN-учётки выдаются (turn:$DOMAIN:$TURN_PORT)"; else warn "В /api/config нет своего TURN"; failed=1; fi

  local bot=0
  for _ in $(seq 1 20); do
    if curl -fsS --noproxy "*" --max-time 3 "http://127.0.0.1:$APP_PORT/api/config" 2>/dev/null | grep -q '"botOnline":true'; then bot=1; break; fi
    sleep 1
  done
  if [ "$bot" = 1 ]; then ok "Музыкальный бот подключён"; else warn "Бот пока не подключился (journalctl -u sozvon-bot)"; fi

  if [ "$OPT_YTDLP" = 1 ]; then
    if [ -x /usr/local/bin/yt-dlp ] && runuser -u "$APP_USER" -- env HOME="$DATA_DIR" XDG_CACHE_HOME="$DATA_DIR/.cache" /usr/local/bin/yt-dlp --version >/dev/null 2>&1; then
      ok "yt-dlp $(/usr/local/bin/yt-dlp --version 2>/dev/null) (проверка YouTube/SoundCloud/Spotify: sudo bash $APP_DIR/deploy/music-check.sh)"
    else
      warn "yt-dlp не работает — музыка по ссылкам недоступна (sudo bash $APP_DIR/deploy/ytdlp.sh install)"
    fi
  fi

  if pgrep -x turnserver >/dev/null; then ok "coturn запущен"; else warn "coturn не запущен (journalctl -u coturn)"; failed=1; fi

  if [ "$CERT_OK" = 1 ]; then
    local k=()
    [ "$LOCAL_TEST" = 1 ] && k=(-k)
    if curl -fsS --noproxy "*" "${k[@]}" --max-time 10 --resolve "$DOMAIN:443:127.0.0.1" -o /dev/null "https://$DOMAIN/api/config"; then
      ok "HTTPS через nginx: https://$DOMAIN/api/config"
    else
      warn "nginx не проксирует https://$DOMAIN (проверьте: nginx -t; journalctl -u nginx)"
      failed=1
    fi
  fi
  HEALTH_FAILED=$failed
}

banner() {
  if [ "$CERT_OK" != 1 ]; then
    printf '\n%sУстановка почти готова: сервер работает, но нет HTTPS-сертификата.%s\n' "$C_Y$C_B" "$C_0"
    printf 'Исправьте причину (см. выше) и запустите установку ещё раз.\n\n'
    exit 1
  fi
  local url="https://$DOMAIN" line
  line=$(printf '%*s' $((${#url} + 8)) '' | tr ' ' '=')
  printf '\n%s%s\n' "$C_G$C_B" "$line"
  printf '    %s\n' "$url"
  printf '%s%s\n\n' "$line" "$C_0"
  printf '%sСозвон установлен!%s Откройте ссылку выше в браузере:\n' "$C_B" "$C_0"
  printf '  1. Зарегистрируйтесь (первым — это вы).\n'
  printf '  2. Создайте сервер и голосовой канал.\n'
  printf '  3. Скопируйте инвайт-код сервера и отправьте друзьям вместе со ссылкой — им нужен только браузер.\n\n'
  printf 'Полезное:\n'
  printf '  обновить:     sudo bash %s/deploy/update.sh\n' "$APP_DIR"
  printf '  бэкап:        sudo bash %s/deploy/backup.sh\n' "$APP_DIR"
  printf '  журнал:       journalctl -u sozvon -f\n'
  printf '  музыка:       sudo bash %s/deploy/music-check.sh  (доступны ли YouTube/SoundCloud/Spotify)\n' "$APP_DIR"
  printf '  настройки:    %s (после правки: systemctl restart sozvon)\n' "$ENV_FILE"
  if [ "$DOMAIN_AUTO" = 1 ]; then
    printf '  свой домен:   sudo bash %s/deploy/install.sh --domain ваш-домен.ru\n' "$APP_DIR"
  fi
  printf '\nЕсли сайт не открывается снаружи — откройте порты 80, 443, %s, %s и %s-%s/udp\n' \
    "$TURN_PORT" "$TURNS_PORT" "$RELAY_MIN_PORT" "$RELAY_MAX_PORT"
  printf 'в облачном файрволе в панели провайдера (если он там есть).\n\n'
  [ "${HEALTH_FAILED:-0}" = 0 ] || exit 1
}

main() {
  umask 022
  parse_args "$@"
  trap 'on_error $LINENO' ERR
  check_system
  exec 9>/run/sozvon-install.lock
  flock -n 9 || die "Установка уже запущена в другом окне"
  install_packages
  detect_ip
  choose_domain
  install_node
  setup_user
  fetch_code
  install_ytdlp
  npm_deps
  write_env
  setup_coturn
  setup_nginx_and_cert
  setup_services
  setup_firewall
  health_check
  banner
}

main "$@"
