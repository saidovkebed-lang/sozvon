#!/usr/bin/env bash
# Созвон — установка и обновление yt-dlp (скачивание музыки с YouTube/SoundCloud).
#
#   sudo bash /opt/sozvon/deploy/ytdlp.sh install   поставить, если нет (или он устарел/сломан)
#   sudo bash /opt/sozvon/deploy/ytdlp.sh update    обновить до последней версии (это делает таймер раз в сутки)
#   sudo bash /opt/sozvon/deploy/ytdlp.sh status    что установлено
#
# Способ 1 (основной): готовый бинарь yt-dlp_linux / yt-dlp_linux_aarch64 из GitHub releases,
#   sha256 сверяется с SHA2-256SUMS того же релиза. Внутри уже есть всё нужное (в т.ч. yt-dlp-ejs
#   для YouTube); JS-рантайм — Node, который уже стоит для Созвона (сервер передаёт --js-runtimes node:…).
# Способ 2 (если GitHub недоступен): pip в отдельном venv /opt/yt-dlp-venv («yt-dlp[default]»).
# Результат в обоих случаях: /usr/local/bin/yt-dlp.
set -Eeuo pipefail

BIN=/usr/local/bin/yt-dlp
VENV=/opt/yt-dlp-venv
STATE_DIR=/var/lib/sozvon-ytdlp      # способ установки (release|pip), для update
RELEASE_BASE="${YTDLP_RELEASE_BASE:-https://github.com/yt-dlp/yt-dlp/releases/latest/download}"
PIP_INDEX="${YTDLP_PIP_INDEX:-}"     # например https://mirror.yandex.ru/pypi/simple (если pypi.org недоступен)

if [ -t 1 ]; then G=$'\033[32m'; Y=$'\033[33m'; R=$'\033[31m'; Z=$'\033[0m'; else G=""; Y=""; R=""; Z=""; fi
ok()   { printf '    %s✓%s %s\n' "$G" "$Z" "$*"; }
warn() { printf '    %s⚠ %s%s\n' "$Y" "$*" "$Z" >&2; }
fail() { printf '    %s✗ %s%s\n' "$R" "$*" "$Z" >&2; }

have() { command -v "$1" >/dev/null 2>&1; }
# Прокси для музыки из /etc/sozvon.env (YTDLP_PROXY) — запасной путь, если GitHub напрямую недоступен
MUSIC_PROXY=$(sed -n 's/^YTDLP_PROXY=//p' /etc/sozvon.env 2>/dev/null | tail -n 1 || true)
dl() {
  curl -fL --retry 3 --retry-delay 2 --connect-timeout 15 --max-time 300 -sS -o "$2" "$1" && return 0
  [ -n "$MUSIC_PROXY" ] || return 1
  curl -fL --retry 2 --retry-delay 2 --connect-timeout 15 --max-time 300 -sS --proxy "$MUSIC_PROXY" -o "$2" "$1"
}

asset_name() {
  case "$(uname -m)" in
    x86_64|amd64) echo yt-dlp_linux ;;
    aarch64|arm64) echo yt-dlp_linux_aarch64 ;;
    *) echo "" ;;
  esac
}

# yt-dlp работает? (печатает версию)
works() { [ -x "$BIN" ] && timeout 60 "$BIN" --version >/dev/null 2>&1; }
version() { timeout 60 "$BIN" --version 2>/dev/null | head -n 1 || true; }
method() { cat "$STATE_DIR/method" 2>/dev/null || echo unknown; }
set_method() { install -d -m 0755 "$STATE_DIR"; printf '%s\n' "$1" >"$STATE_DIR/method"; }

# Ожидаемый sha256 бинаря из SHA2-256SUMS → stdout
expected_sha() {
  local asset=$1 tmp sum
  tmp=$(mktemp)
  if ! dl "$RELEASE_BASE/SHA2-256SUMS" "$tmp"; then rm -f "$tmp"; return 1; fi
  sum=$(awk -v f="$asset" '$2 == f || $2 == "*"f {print $1}' "$tmp" | head -n 1)
  rm -f "$tmp"
  [[ $sum =~ ^[0-9a-f]{64}$ ]] || return 1
  printf '%s' "$sum"
}

# Способ 1: бинарь с GitHub. $1=force (1 — скачать даже если sha совпадает)
install_release() {
  local force=${1:-0} asset sum tmp cur=""
  asset=$(asset_name)
  [ -n "$asset" ] || { warn "Архитектура $(uname -m): готового бинаря нет"; return 1; }
  sum=$(expected_sha "$asset") || { warn "Не скачался SHA2-256SUMS с GitHub ($RELEASE_BASE)"; return 1; }
  [ -f "$BIN" ] && [ ! -L "$BIN" ] && cur=$(sha256sum "$BIN" | awk '{print $1}')
  if [ "$force" != 1 ] && [ "$cur" = "$sum" ] && works; then
    ok "yt-dlp $(version) — уже последняя версия"
    set_method release
    return 0
  fi
  tmp=$(mktemp "$(dirname "$BIN")/.yt-dlp.XXXXXX")
  if ! dl "$RELEASE_BASE/$asset" "$tmp"; then rm -f "$tmp"; warn "Не скачался $asset с GitHub"; return 1; fi
  if [ "$(sha256sum "$tmp" | awk '{print $1}')" != "$sum" ]; then
    rm -f "$tmp"
    warn "sha256 скачанного $asset не совпал с SHA2-256SUMS — файл отброшен"
    return 1
  fi
  chmod 0755 "$tmp"
  if ! timeout 120 "$tmp" --version >/dev/null 2>&1; then
    rm -f "$tmp"
    warn "Скачанный $asset не запускается (старая glibc?)"
    return 1
  fi
  mv -f "$tmp" "$BIN"   # атомарно: работающие загрузки доиграют старым файлом
  set_method release
  ok "yt-dlp $(version) установлен ($asset, sha256 проверен)"
}

# Способ 2: pip в venv
install_pip() {
  local upgrade=${1:-0} pip_args=()
  if ! have python3; then warn "python3 не найден"; return 1; fi
  if ! python3 -c 'import venv, ensurepip' >/dev/null 2>&1; then
    if have apt-get; then
      DEBIAN_FRONTEND=noninteractive apt-get install -y -qq -o DPkg::Lock::Timeout=600 python3-venv </dev/null >/dev/null 2>&1 \
        || { DEBIAN_FRONTEND=noninteractive apt-get update -qq </dev/null >/dev/null 2>&1 && \
             DEBIAN_FRONTEND=noninteractive apt-get install -y -qq python3-venv </dev/null >/dev/null 2>&1; } \
        || { warn "Не удалось поставить python3-venv"; return 1; }
    else
      warn "Нет модуля venv (python3-venv)"; return 1
    fi
  fi
  [ -x "$VENV/bin/pip" ] || python3 -m venv "$VENV" || { warn "python3 -m venv не удался"; return 1; }
  [ -n "$PIP_INDEX" ] && pip_args+=(--index-url "$PIP_INDEX")
  [ "$upgrade" = 1 ] && pip_args+=(--upgrade)
  if ! "$VENV/bin/pip" install -q --disable-pip-version-check "${pip_args[@]}" 'yt-dlp[default]'; then
    warn "pip install yt-dlp не удался (pypi.org недоступен? можно задать YTDLP_PIP_INDEX)"
    return 1
  fi
  chmod -R go+rX "$VENV"
  ln -sfn "$VENV/bin/yt-dlp" "$BIN"
  set_method pip
  ok "yt-dlp $(version) установлен через pip ($VENV)"
}

cmd_install() {
  if works && [ "${1:-}" != force ]; then
    ok "yt-dlp $(version) уже установлен ($(method))"
    return 0
  fi
  install_release 1 && return 0
  warn "Пробую запасной способ: pip"
  install_pip 0 && return 0
  fail "yt-dlp не установлен. Музыка по ссылкам будет недоступна (загрузка mp3 через «Библиотеку» работает)."
  fail "Повторить: sudo bash $(readlink -f "$0") install"
  return 1
}

cmd_update() {
  local before
  before=$(version)
  case "$(method)" in
    pip) install_pip 1 || return 1 ;;
    *)
      if ! install_release 0; then
        # GitHub недоступен: если стоит pip-вариант — обновим его
        if [ -x "$VENV/bin/pip" ]; then install_pip 1 || return 1; else return 1; fi
      fi ;;
  esac
  local after
  after=$(version)
  [ "$before" != "$after" ] && ok "yt-dlp обновлён: ${before:-нет} → $after"
  return 0
}

cmd_status() {
  if works; then ok "yt-dlp $(version) ($BIN, способ: $(method))"; else fail "yt-dlp не установлен или не запускается ($BIN)"; return 1; fi
}

[ "$(id -u)" -eq 0 ] || [ "${1:-status}" = status ] || { fail "Запустите от root: sudo bash $0 ${1:-}"; exit 1; }
case "${1:-status}" in
  install) cmd_install "${2:-}" ;;
  update) cmd_update ;;
  status) cmd_status ;;
  -h|--help) sed -n '2,13p' "$0" ;;
  *) fail "Неизвестная команда: $1 (install | update | status)"; exit 1 ;;
esac
