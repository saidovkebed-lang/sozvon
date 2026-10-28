#!/usr/bin/env bash
# Astra — администраторы экземпляра (админ-панель, docs/ADMIN.md).
#
#   sudo bash /opt/sozvon/deploy/admin.sh grant ИМЯ           сделать пользователя администратором
#   sudo bash /opt/sozvon/deploy/admin.sh revoke ИМЯ          снять права администратора
#   sudo bash /opt/sozvon/deploy/admin.sh list                список администраторов
#   sudo bash /opt/sozvon/deploy/admin.sh require-2fa on|off|default
#                                                             требовать ли 2FA для админ-панели (default — по ADMIN_REQUIRE_2FA, иначе да)
#
# Как это работает: работающий сервер слушает локальный unix-сокет $DATA_DIR/admin.sock (права 600, владелец
# sozvon) и принимает команды с токеном из $DATA_DIR/admin-control.token (тоже 600). Прочитать токен и
# подключиться к сокету может только root (и сам сервис) — по сети этот канал недоступен. Изменения вносит
# сам сервер, поэтому db.json не портится. Если сервер остановлен, grant/revoke/list правят db.json напрямую.
#
# Переопределения (тесты, нестандартные установки): DATA_DIR, ADMIN_CONTROL_SOCKET, ADMIN_SERVICE.
set -Eeuo pipefail

DATA_DIR=${DATA_DIR:-/var/lib/sozvon}
SERVICE=${ADMIN_SERVICE:-sozvon}
SOCK=${ADMIN_CONTROL_SOCKET:-$DATA_DIR/admin.sock}
TOKEN_FILE=$DATA_DIR/admin-control.token
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLI="$HERE/admin-cli.mjs"
export PATH="/opt/node/bin:/usr/local/bin:$PATH"

die() { printf '✗ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
usage() { sed -n '3,9p' "$0" | sed 's/^# \{0,1\}//'; exit "${1:-0}"; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0 ${*:-list}"
have node || die "node не найден (/opt/node/bin/node)"

cmd=${1:-}
arg=${2:-}
case "$cmd" in
  grant|revoke) [ -n "$arg" ] || die "Укажите имя пользователя: sudo bash $0 $cmd ИМЯ" ;;
  list) ;;
  require-2fa) case "$arg" in on|off|default) ;; *) die "require-2fa: on | off | default" ;; esac ;;
  -h|--help|help|'') usage 0 ;;
  *) printf 'Неизвестная команда: %s\n\n' "$cmd" >&2; usage 1 ;;
esac

service_active() { have systemctl && systemctl is-active --quiet "$SERVICE" 2>/dev/null; }

if [ -S "$SOCK" ] && [ -r "$TOKEN_FILE" ]; then
  have curl || die "curl не найден"
  token=$(tr -d '\r\n' <"$TOKEN_FILE")
  body=$(node "$CLI" json "$cmd" "$arg")
  # токен — через stdin (-K -), в списке процессов его не видно
  if resp=$(printf 'header = "x-admin-token: %s"\n' "$token" \
      | curl -sS --max-time 15 --unix-socket "$SOCK" -K - -H 'content-type: application/json' --data-binary "$body" http://localhost/admin); then
    printf '%s' "$resp" | node "$CLI" print
    exit $?
  fi
  service_active && die "Сервер работает, но не отвечает на $SOCK. Перезапустите: systemctl restart $SERVICE"
fi

# Сервер не запущен (или старая версия без admin.sock)
if service_active; then
  die "Служба $SERVICE работает, но канала $SOCK нет (старая версия?). Обновите Astra: sudo bash /opt/sozvon/deploy/update.sh"
fi
[ -f "$DATA_DIR/db.json" ] || die "Нет базы $DATA_DIR/db.json"
[ "$cmd" = require-2fa ] && die "require-2fa работает только при запущенном сервере: systemctl start $SERVICE"
node "$CLI" offline "$DATA_DIR/db.json" "$cmd" "$arg"
