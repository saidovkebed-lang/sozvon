#!/usr/bin/env bash
# Созвон — резервная копия данных (пользователи, сообщения, файлы, музыка) и настроек.
#   sudo bash /opt/sozvon/deploy/backup.sh              → /var/backups/sozvon/sozvon-ДАТА.tar.gz
#   sudo bash /opt/sozvon/deploy/backup.sh --keep 7     хранить только 7 последних копий
#   sudo bash /opt/sozvon/deploy/backup.sh --restore ФАЙЛ.tar.gz   восстановить из копии
set -Eeuo pipefail

DATA_DIR=/var/lib/sozvon
ENV_FILE=/etc/sozvon.env
OUT_DIR=/var/backups/sozvon
KEEP=0
RESTORE=""

die() { printf '\n✗ ОШИБКА: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }

while [ $# -gt 0 ]; do
  case "$1" in
    --keep) KEEP="${2:-0}"; shift ;;
    --out) OUT_DIR="${2:-}"; shift ;;
    --restore) RESTORE="${2:-}"; shift ;;
    -h|--help) sed -n '2,6p' "$0"; exit 0 ;;
    *) die "Неизвестный параметр: $1" ;;
  esac
  shift
done
[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0"
have_systemd() { [ -d /run/systemd/system ] && command -v systemctl >/dev/null; }

if [ -n "$RESTORE" ]; then
  [ -f "$RESTORE" ] || die "Файл не найден: $RESTORE"
  tar -tzf "$RESTORE" | grep -q '^sozvon/' || die "Это не бэкап Созвона (нет каталога sozvon/)"
  have_systemd && systemctl stop sozvon-bot sozvon
  if [ -d "$DATA_DIR" ]; then
    mv "$DATA_DIR" "$DATA_DIR.before-restore-$(date +%Y%m%d-%H%M%S)"
    ok "Текущие данные сохранены рядом: $DATA_DIR.before-restore-*"
  fi
  tar -xzf "$RESTORE" -C "$(dirname "$DATA_DIR")" sozvon
  chown -R sozvon:sozvon "$DATA_DIR"
  chmod 750 "$DATA_DIR"
  if tar -tzf "$RESTORE" | grep -qx 'sozvon.env' && [ ! -f "$ENV_FILE" ]; then
    tar -xzf "$RESTORE" -O sozvon.env >"$ENV_FILE"
    chmod 600 "$ENV_FILE"
    ok "Восстановлен $ENV_FILE"
  fi
  have_systemd && systemctl start sozvon sozvon-bot
  ok "Данные восстановлены из $RESTORE"
  exit 0
fi

[ -d "$DATA_DIR" ] || die "Нет каталога данных $DATA_DIR"
install -d -m 0700 "$OUT_DIR"
file="$OUT_DIR/sozvon-$(date +%Y%m%d-%H%M%S).tar.gz"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
# db.json пишется атомарно (tmp + rename), поэтому копировать можно на ходу
args=(-C "$(dirname "$DATA_DIR")" sozvon)
if [ -f "$ENV_FILE" ]; then
  cp "$ENV_FILE" "$tmp/sozvon.env"
  args+=(-C "$tmp" sozvon.env)
fi
(umask 077 && tar -czf "$file" --warning=no-file-changed "${args[@]}") || [ $? -eq 1 ]
chmod 600 "$file"
ok "Бэкап: $file ($(du -h "$file" | cut -f1))"
printf '  Скачать к себе на компьютер:  scp root@IP-СЕРВЕРА:%s .\n' "$file"
printf '  В файле есть TURN_SECRET и токен бота — храните его как пароль.\n'

if [ "$KEEP" -gt 0 ] 2>/dev/null; then
  shopt -s nullglob
  all=("$OUT_DIR"/sozvon-*.tar.gz)   # имена с датой: сортировка по имени = по времени
  mapfile -t old < <(printf '%s\n' "${all[@]}" | sort -r | tail -n +"$((KEEP + 1))")
  if [ "${#old[@]}" -gt 0 ]; then
    rm -f "${old[@]}"
    ok "Удалено старых копий: ${#old[@]}"
  fi
fi
