#!/usr/bin/env bash
# Astra — обновление по кнопке «Обновить Astra» в админ-панели.
# Запускает systemd от root: sozvon-self-update.path следит за файлом $DATA_DIR/update-request, который
# создаёт приложение (пользователь sozvon), и стартует sozvon-self-update.service → этот скрипт.
#   sudo bash /opt/sozvon/deploy/self-update.sh check     вручную: проверить, есть ли новая версия
#   sudo bash /opt/sozvon/deploy/self-update.sh update    вручную: то же, что кнопка (обычно — просто update.sh)
#   sudo bash /opt/sozvon/deploy/self-update.sh backup    вручную: то же, что «💾 Бэкап сейчас» в Telegram-боте
#
# Безопасность (граница root ↔ sozvon):
#  • единственный вход — файл-запрос. Из него читаются максимум 32 байта (с тайм-аутом, ссылки и не-файлы
#    игнорируются), оставляются только буквы a-z и сравниваются с тремя словами: check | update | backup. Содержимое
#    никогда не выполняется и не подставляется в команды; сам файл удаляется (rm не идёт по ссылкам).
#  • результат пишется НЕ в каталог данных (его владелец — sozvon, там возможны подменённые ссылки), а в
#    $STATE_DIR=/var/lib/sozvon-state (root:root 755, файлы 644): приложение может только читать.
#  • выполняется только код из $APP_DIR (root:root) — тот же deploy/update.sh, что и при ручном обновлении.
#  • одновременные запуски исключены flock (/run/sozvon-self-update.lock), update.sh держит свой замок.
#
#  • backup запускает только $APP_DIR/deploy/backup.sh now (тот же, что ночной таймер): итог пишет сам backup.sh
#    в $STATE_DIR/backup-status.json, а здесь — $STATE_DIR/backup-run.json (состояние и код выхода) и backup-run.log.
#
# Переопределения (тесты): DATA_DIR, APP_DIR, STATE_DIR, SOZVON_BRANCH, SELF_UPDATE_LOCK, SELF_UPDATE_CMD,
# SELF_UPDATE_BACKUP_CMD, SELF_UPDATE_ALLOW_NONROOT=1.
set -Eeuo pipefail
umask 022

DATA_DIR=${DATA_DIR:-/var/lib/sozvon}
APP_DIR=${APP_DIR:-/opt/sozvon}
STATE_DIR=${STATE_DIR:-/var/lib/sozvon-state}
BRANCH=${SOZVON_BRANCH:-main}
LOCK=${SELF_UPDATE_LOCK:-/run/sozvon-self-update.lock}
UPDATE_CMD=${SELF_UPDATE_CMD:-$APP_DIR/deploy/update.sh}
BACKUP_CMD=${SELF_UPDATE_BACKUP_CMD:-$APP_DIR/deploy/backup.sh}
REQ=$DATA_DIR/update-request
export PATH="/opt/node/bin:/usr/local/bin:$PATH"

say() { printf '[self-update] %s\n' "$*"; }
[ "$(id -u)" -eq 0 ] || [ "${SELF_UPDATE_ALLOW_NONROOT:-0}" = 1 ] || { say "Запустите от root" >&2; exit 1; }
command -v node >/dev/null 2>&1 || { say "node не найден" >&2; exit 1; }

# --------------------------------------------------------------- запрос
kind=""
if [ -L "$REQ" ]; then
  say "update-request — символическая ссылка, игнорирую"
elif [ -f "$REQ" ]; then
  kind=$(timeout 5 head -c 32 -- "$REQ" 2>/dev/null | tr -dc 'a-z' || true)
fi
[ -e "$REQ" ] || [ -L "$REQ" ] && rm -rf -- "$REQ"
[ -n "${1:-}" ] && kind=$1

exec 9>"$LOCK"
if ! flock -n 9; then say "Обновление уже выполняется — запрос пропущен"; exit 0; fi

install -d -o root -g root -m 0755 "$STATE_DIR" 2>/dev/null || install -d -m 0755 "$STATE_DIR"

# JSON из пар КЛЮЧ=ЗНАЧЕНИЕ (КЛЮЧ:n — число, КЛЮЧ:l — список строк через перевод строки)
json() {
  node -e '
    const o = {};
    for (const a of process.argv.slice(1)) {
      const i = a.indexOf("="); const k = a.slice(0, i); const v = a.slice(i + 1);
      if (k.endsWith(":n")) o[k.slice(0, -2)] = v === "" ? null : Number(v);
      else if (k.endsWith(":l")) o[k.slice(0, -2)] = v ? v.split("\n").filter(Boolean) : [];
      else o[k] = v === "" ? null : v;
    }
    process.stdout.write(JSON.stringify(o) + "\n");' -- "$@"
}
# write_state ИМЯ — stdin атомарно в $STATE_DIR/ИМЯ (mktemp + mv)
write_state() {
  local tmp
  tmp=$(mktemp "$STATE_DIR/.state.XXXXXX")
  cat >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATE_DIR/$1"
}
now_ms() { date +%s%3N; }

do_check() {
  local cur latest="" behind="" notes="" err=""
  cur=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "")
  if out=$(git -C "$APP_DIR" fetch -q --depth 50 origin "$BRANCH" 2>&1); then
    latest=$(git -C "$APP_DIR" rev-parse FETCH_HEAD)
    behind=$(git -C "$APP_DIR" rev-list --count "HEAD..FETCH_HEAD" 2>/dev/null || echo "")
    notes=$(git -C "$APP_DIR" log --format='%h %s' -n 30 "HEAD..FETCH_HEAD" 2>/dev/null || true)
    say "Проверка: ${cur:0:7} → ${latest:0:7} (новых коммитов: ${behind:-?})"
  else
    err="git fetch не удался: $(printf '%s' "$out" | tail -n 2 | tr '\n' ' ' | cut -c1-250)"
    say "$err"
  fi
  json "current=$cur" "latest=$latest" "behind:n=$behind" "notes:l=$notes" "checkedAt:n=$(now_ms)" "error=$err" | write_state update-check.json
}

do_update() {
  local from to rc started tmp result
  from=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo "")
  started=$(now_ms)
  # журнал: новый файл в $STATE_DIR (каталог root), затем подменяем атомарно
  tmp=$(mktemp "$STATE_DIR/.log.XXXXXX")
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATE_DIR/update.log"
  exec 3>>"$STATE_DIR/update.log"
  json "state=running" "kind=update" "startedAt:n=$started" "from=$from" | write_state update-status.json
  printf '=== Astra: обновление %s (сейчас %s)\n' "$(date '+%Y-%m-%d %H:%M:%S')" "${from:-?}" >&3
  set +e
  bash "$UPDATE_CMD" >&3 2>&1 </dev/null
  rc=$?
  set -e
  to=$(git -C "$APP_DIR" rev-parse --short HEAD 2>/dev/null || echo "")
  if [ "$rc" -eq 0 ]; then
    printf '\n=== Готово: Astra обновлена до %s\n' "${to:-?}" >&3
    json "current=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "")" "latest=$(git -C "$APP_DIR" rev-parse HEAD 2>/dev/null || echo "")" \
      "behind:n=0" "notes:l=" "checkedAt:n=$(now_ms)" | write_state update-check.json
  else
    printf '\n=== Ошибка: update.sh завершился с кодом %s. Подробности выше; повторить вручную: sudo bash %s/deploy/update.sh\n' "$rc" "$APP_DIR" >&3
  fi
  result=failed
  [ "$rc" -eq 0 ] && result="done"
  json "state=$result" "kind=update" "startedAt:n=$started" "finishedAt:n=$(now_ms)" \
    "from=$from" "to=$to" "exitCode:n=$rc" | write_state update-status.json
  exec 3>&-
  say "Обновление завершено: код $rc (${from:-?} → ${to:-?})"
}

do_backup() {
  local started rc tmp result
  started=$(now_ms)
  tmp=$(mktemp "$STATE_DIR/.log.XXXXXX")
  chmod 0644 "$tmp"
  mv -f "$tmp" "$STATE_DIR/backup-run.log"
  json "state=running" "startedAt:n=$started" | write_state backup-run.json
  set +e
  # backup.sh сам пишет $STATE_DIR/backup-status.json (файл, размер, Telegram, ошибка)
  SOZVON_STATE_DIR=$STATE_DIR bash "$BACKUP_CMD" now >>"$STATE_DIR/backup-run.log" 2>&1 </dev/null
  rc=$?
  set -e
  result=failed
  # 2 — локальная копия готова, но в Telegram отправить не удалось
  { [ "$rc" -eq 0 ] || [ "$rc" -eq 2 ]; } && result="done"
  json "state=$result" "startedAt:n=$started" "finishedAt:n=$(now_ms)" "exitCode:n=$rc" | write_state backup-run.json
  say "Бэкап по запросу завершён: код $rc"
}

case "$kind" in
  check) do_check ;;
  update) do_update ;;
  backup) do_backup ;;
  "") say "Запроса нет — нечего делать" ;;
  *) say "Неизвестный запрос «$kind» — пропущено" ;;
esac
