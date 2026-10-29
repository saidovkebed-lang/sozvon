#!/usr/bin/env bash
# Astra — резервные копии данных (пользователи, сообщения, вложения, аватары, музыка) и настроек.
#
#   sudo bash /opt/sozvon/deploy/backup.sh now              сделать копию сейчас (+ ротация, + Telegram, если включён)
#   sudo bash /opt/sozvon/deploy/backup.sh list             список копий, размеры, последний запуск таймера
#   sudo bash /opt/sozvon/deploy/backup.sh restore ФАЙЛ     восстановить из копии (.tar.zst / .tar.gz / .enc / .enc.part00)
#   sudo bash /opt/sozvon/deploy/backup.sh setup            включить отправку копий в свой Telegram-бот (зашифрованно)
#   sudo bash /opt/sozvon/deploy/backup.sh telegram-test    проверить связь с ботом (тестовое сообщение)
#
# Копии: /var/backups/sozvon/astra-ГГГГММДД-ЧЧММ.tar.zst (или .tar.gz без zstd), права 600, владелец root.
# Ротация: 7 последних дней + 4 недели (по одной копии в неделю). Подробно: docs/BACKUP.md
#
# Переопределения (для тестов и нестандартных установок):
#   DATA_DIR, SOZVON_ENV_FILE, BACKUP_DIR, APP_USER, BACKUP_KEEP_DAILY, BACKUP_KEEP_WEEKLY,
#   BACKUP_COMPRESS=zstd|gzip, BACKUP_MUSIC=0 (без музыки), BACKUP_TELEGRAM_API, BACKUP_TELEGRAM_PART_SIZE,
#   BACKUP_SERVICES («sozvon-bot sozvon»), BACKUP_ASSUME_YES=1 / BACKUP_RESTORE_ENV=y|n (restore без вопросов).
#   systemctl ищется в PATH (в тестах — подменный).
set -Eeuo pipefail
umask 077

DATA_DIR=${DATA_DIR:-/var/lib/sozvon}
ENV_FILE=${SOZVON_ENV_FILE:-/etc/sozvon.env}
BACKUP_DIR=${BACKUP_DIR:-/var/backups/sozvon}
APP_USER=${APP_USER:-sozvon}
SERVICES=${BACKUP_SERVICES:-sozvon-bot sozvon}
TIMER=sozvon-backup.timer
SELF=$(readlink -f "$0" 2>/dev/null || printf '%s' "$0")
# Итог последнего бэкапа для админ-панели (backup-status.json): каталог root, приложению только для чтения
STATE_DIR=${SOZVON_STATE_DIR:-$(dirname "$DATA_DIR")/sozvon-state}
LAST_ERROR=""
STATUS_DONE=0

die() { LAST_ERROR=$*; printf '\n✗ ОШИБКА: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }
info() { printf '  · %s\n' "$*"; }
warn() { printf '  ! %s\n' "$*" >&2; }
have() { command -v "$1" >/dev/null 2>&1; }
human() { numfmt --to=iec --suffix=B "$1" 2>/dev/null || printf '%s B' "$1"; }
fsize() { stat -c %s "$1"; }

# Значение из окружения, иначе из $ENV_FILE (KEY=value, KEY="value", KEY='value').
env_get() {
  [ -f "$ENV_FILE" ] || return 0
  local v
  v=$(sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1)
  case "$v" in
    \"*\") v=${v#\"}; v=${v%\"} ;;
    \'*\') v=${v#\'}; v=${v%\'} ;;
  esac
  printf '%s' "$v"
}
conf() { local cur=${!1:-}; if [ -n "$cur" ]; then printf '%s' "$cur"; else env_get "$1"; fi; }

# Записать KEY='value' в $ENV_FILE (права 600, root).
env_set() {
  local key=$1 val=$2 line tmp
  line="$key='$val'"
  if [ ! -f "$ENV_FILE" ]; then
    install -m 0600 /dev/null "$ENV_FILE"
  fi
  tmp=$(mktemp "$(dirname "$ENV_FILE")/.sozvon-env.XXXXXX")
  awk -v k="$key" -v l="$line" 'BEGIN{d=0} index($0, k "=")==1 { if (!d) print l; d=1; next } { print } END{ if (!d) print l }' "$ENV_FILE" >"$tmp"
  chmod 600 "$tmp"
  chown root:root "$tmp" 2>/dev/null || true
  mv -f "$tmp" "$ENV_FILE"
}

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $SELF ${1:-now}"

# ---------------------------------------------------------------- systemctl
sysctl_ok() { have systemctl; }
svc() { if sysctl_ok; then systemctl "$@"; else info "systemctl нет — пропускаю: systemctl $*"; fi; }

# ---------------------------------------------------------------- архив
compressor() {
  local want
  want=$(conf BACKUP_COMPRESS)
  if [ "$want" = gzip ]; then echo gzip; return; fi
  if have zstd; then echo zstd; return; fi
  [ "$want" = zstd ] && warn "zstd не установлен — использую gzip (apt-get install zstd)"
  echo gzip
}

# Распаковать архив (по содержимому, а не по имени) в stdout как tar-поток.
decompress_to_tar() {
  local f=$1 magic
  magic=$(head -c 4 "$f" | od -An -tx1 | tr -d ' \n')
  case "$magic" in
    28b52ffd) have zstd || die "Для распаковки нужен zstd: apt-get install zstd"; zstd -dc -q "$f" ;;
    1f8b*) gzip -dc "$f" ;;
    *) die "Неизвестный формат архива: $f" ;;
  esac
}

# ---------------------------------------------------------------- статус для админ-панели
jesc() { printf '%s' "$1" | tr -d '\000-\037' | sed 's/\\/\\\\/g; s/"/\\"/g'; }
# write_backup_status ok|failed ФАЙЛ РАЗМЕР TELEGRAM ОШИБКА → $STATE_DIR/backup-status.json (mktemp + mv)
write_backup_status() {
  local tmp okv=true
  [ "$1" = ok ] || okv=false
  install -d -m 0755 "$STATE_DIR" 2>/dev/null || return 0
  # пишем только в каталог root (не в каталог данных sozvon — там возможна подмена ссылками)
  [ "$(stat -c %u "$STATE_DIR" 2>/dev/null)" = "$(id -u)" ] || { warn "$STATE_DIR не принадлежит root — статус не записан"; return 0; }
  tmp=$(mktemp "$STATE_DIR/.backup-status.XXXXXX") || return 0
  printf '{"time":"%s","result":"%s","ok":%s,"file":"%s","size":%s,"telegram":"%s","error":"%s"}\n' \
    "$(date -Is)" "$1" "$okv" "$(jesc "$2")" "${3:-null}" "$(jesc "$4")" "$(jesc "$5")" >"$tmp"
  chmod 644 "$tmp"
  mv -f "$tmp" "$STATE_DIR/backup-status.json"
  STATUS_DONE=1
}
backup_exit_status() {
  local rc=$?
  [ "$STATUS_DONE" = 1 ] && return 0
  write_backup_status failed "" "" "" "${LAST_ERROR:-код $rc}" || true
}

do_backup() {
  [ -d "$DATA_DIR" ] || die "Нет каталога данных $DATA_DIR"
  install -d -m 0700 "$BACKUP_DIR"
  chmod 700 "$BACKUP_DIR"
  exec 9>"$BACKUP_DIR/.lock"
  flock -n 9 || die "Другой бэкап уже выполняется ($BACKUP_DIR/.lock)"

  local comp ext stamp name file part tmp stage music tar_rc
  comp=$(compressor)
  if [ "$comp" = zstd ]; then ext=tar.zst; else ext=tar.gz; fi
  stamp=$(date +%Y%m%d-%H%M)
  name="astra-$stamp.$ext"
  file="$BACKUP_DIR/$name"
  # вторая копия в ту же минуту: секунды в имени (сортировка по имени остаётся сортировкой по времени)
  if compgen -G "$BACKUP_DIR/astra-$stamp.tar.*" >/dev/null; then
    name="astra-$stamp$(date +%S).$ext"; file="$BACKUP_DIR/$name"
  fi
  part="$BACKUP_DIR/.$name.partial"
  tmp=$(mktemp -d)
  # shellcheck disable=SC2064
  trap "backup_exit_status; rm -rf '$tmp' '$part'" EXIT
  stage="$tmp/stage"
  mkdir -p "$stage/data" "$stage/env"

  echo "Astra: резервная копия $DATA_DIR → $file"
  # db.json пишется атомарно (запись во временный файл + rename), поэтому копия файла всегда целая.
  # Копируем базу ПЕРВОЙ: файлы, на которые она ссылается, к моменту их упаковки уже существуют.
  if [ -f "$DATA_DIR/db.json" ]; then
    cp -p "$DATA_DIR/db.json" "$stage/data/db.json"
  else
    warn "В $DATA_DIR нет db.json — копирую только файлы"
  fi
  if [ -f "$ENV_FILE" ]; then
    cp -p "$ENV_FILE" "$stage/env/sozvon.env"
  else
    warn "Нет $ENV_FILE — настройки в копию не попадут"
  fi
  music=$(conf BACKUP_MUSIC)
  music=${music:-1}
  {
    echo "Astra backup"
    echo "created=$(date -Is)"
    echo "host=$(hostname 2>/dev/null || echo '?')"
    echo "data_dir=$DATA_DIR"
    echo "env_file=$ENV_FILE"
    echo "music=$music"
    echo "format=2"
  } >"$stage/BACKUP-INFO.txt"

  # Верхний уровень каталога данных; не берём то, что сервер/таймеры восстановят сами:
  #   .cache (кэш yt-dlp, node), downloads (приложение для ПК — таймер sozvon-app-release),
  #   bin (cloudflared), временные *.tmp, сломанные копии db.json.broken-* остаются.
  local entries=() e base
  for e in "$DATA_DIR"/* "$DATA_DIR"/.[!.]*; do
    [ -e "$e" ] || [ -L "$e" ] || continue
    base=${e##*/}
    case "$base" in
      db.json|.cache|.npm|node_modules|downloads|bin|*.tmp|.lock|admin.sock|admin-control.token|update-request) continue ;;
      music) [ "$music" = 0 ] && continue ;;
    esac
    entries+=("./$base")
  done

  local tar_args=(--create --file=- --numeric-owner --warning=no-file-changed --warning=no-file-removed
    -C "$stage" BACKUP-INFO.txt env data/db.json)
  [ -f "$stage/data/db.json" ] || tar_args=(--create --file=- --numeric-owner --warning=no-file-changed
    --warning=no-file-removed -C "$stage" BACKUP-INFO.txt env)
  if [ "${#entries[@]}" -gt 0 ]; then
    # Временные файлы загрузок: music/.upload-*, music/.dl-*, music/.import-*, media/.tmp
    tar_args+=(--exclude='./music/.*' --exclude='./media/.tmp'
      --transform='s,^\./,data/,S' -C "$DATA_DIR" "${entries[@]}")
  fi

  set +e
  if [ "$comp" = zstd ]; then
    tar "${tar_args[@]}" | zstd -q -T0 -10 -o "$part" -f
  else
    tar "${tar_args[@]}" | gzip -6 >"$part"
  fi
  local rcs=("${PIPESTATUS[@]}")
  set -e
  tar_rc=${rcs[0]}
  # tar: 1 = «файл изменился во время чтения» — для живого сервера это нормально
  [ "$tar_rc" -le 1 ] || die "tar завершился с ошибкой ($tar_rc)"
  [ "${rcs[1]}" -eq 0 ] || die "Сжатие ($comp) завершилось с ошибкой (${rcs[1]})"
  decompress_to_tar "$part" | tar -t >/dev/null || die "Созданный архив не читается"
  chmod 600 "$part"
  chown root:root "$part" 2>/dev/null || true
  mv -f "$part" "$file"
  ok "Копия: $file ($(human "$(fsize "$file")"))"

  rotate
  local tg="выключено"
  if telegram_enabled; then
    if telegram_send_backup "$file" "$tmp"; then tg="отправлено"; else tg="ОШИБКА"; fi
  elif [ -n "$(conf BACKUP_TELEGRAM_TOKEN)" ]; then
    tg="пропущено (нет BACKUP_TELEGRAM_CHAT_ID или BACKUP_PASSPHRASE)"
    warn "Telegram: $tg — настроить: sudo bash $SELF setup"
  fi
  {
    echo "time=$(date -Is)"
    echo "file=$name"
    echo "size=$(fsize "$file")"
    echo "telegram=$tg"
  } >"$BACKUP_DIR/.last-status"
  write_backup_status ok "$name" "$(fsize "$file")" "$tg" ""

  local total
  total=$(du -cb "$BACKUP_DIR"/astra-*.tar.* 2>/dev/null | tail -n 1 | cut -f1)
  info "Всего копий: $(count_backups), занято: $(human "${total:-0}")"
  info "Скачать к себе: scp root@IP-СЕРВЕРА:$file ."
  info "В копии есть $ENV_FILE (пароли, токены) — храните её как пароль."
  [ "$tg" = "ОШИБКА" ] && { warn "Локальная копия готова, но отправить в Telegram не удалось"; exit 2; }
  return 0
}

backups_sorted() {   # новые первыми; имя содержит дату → сортировка по имени = по времени
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'astra-*.tar.zst' -o -name 'astra-*.tar.gz' \) -printf '%f\n' 2>/dev/null | sort -r
}
count_backups() { backups_sorted | grep -c . || true; }

# Ротация: самая свежая копия каждого из последних N дней + самая свежая копия каждой из M предыдущих недель.
rotate() {
  local keep_d keep_w
  keep_d=$(conf BACKUP_KEEP_DAILY); keep_d=${keep_d:-7}
  keep_w=$(conf BACKUP_KEEP_WEEKLY); keep_w=${keep_w:-4}
  local f day week days=" " weeks=" " nd=0 nw=0 removed=0
  [[ "$keep_d" =~ ^[0-9]+$ ]] || keep_d=7
  [[ "$keep_w" =~ ^[0-9]+$ ]] || keep_w=4
  [ "$keep_d" -ge 1 ] || keep_d=1
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    day=$(printf '%s' "$f" | sed -n 's/^astra-\([0-9]\{8\}\)-.*/\1/p')
    if [ -z "$day" ]; then continue; fi
    week=$(date -d "$day" +%G-%V 2>/dev/null || echo "$day")
    if [[ "$days" != *" $day "* ]] && [ "$nd" -lt "$keep_d" ]; then
      days+="$day "; weeks+="$week "; nd=$((nd + 1)); continue
    fi
    if [[ "$days" != *" $day "* ]] && [[ "$weeks" != *" $week "* ]] && [ "$nw" -lt "$keep_w" ]; then
      weeks+="$week "; days+="$day "; nw=$((nw + 1)); continue
    fi
    rm -f "$BACKUP_DIR/$f"
    removed=$((removed + 1))
  done < <(backups_sorted)
  [ "$removed" -gt 0 ] && ok "Ротация: удалено старых копий: $removed (храню $keep_d дн. + $keep_w нед.)"
  return 0
}

# ---------------------------------------------------------------- Telegram (по желанию владельца)
TG_API() { local a; a=$(conf BACKUP_TELEGRAM_API); printf '%s' "${a:-https://api.telegram.org}"; }
telegram_enabled() {
  [ -n "$(conf BACKUP_TELEGRAM_TOKEN)" ] && [ -n "$(conf BACKUP_TELEGRAM_CHAT_ID)" ] && [ -n "$(conf BACKUP_PASSPHRASE)" ]
}

# tg_call МЕТОД [curl -F/-d аргументы…] — токен передаётся через stdin (-K -), в списке процессов его не видно.
# Telegram из РФ бывает недоступен напрямую — тогда через VPN-прокси (тот же, что для Spotify, deploy/vpn-proxy.sh).
# TELEGRAM_PROXY=http://… — всегда через него; TELEGRAM_PROXY=off — только напрямую;
# иначе: сначала напрямую (быстрый отказ), при сетевой ошибке — через SPOTIFY_PROXY, если он задан.
tg_call() {
  local method=$1 token proxy fixed rc out
  shift
  token=$(conf BACKUP_TELEGRAM_TOKEN)
  [ -n "$token" ] || { warn "Не задан BACKUP_TELEGRAM_TOKEN"; return 1; }
  fixed=$(conf TELEGRAM_PROXY)
  proxy=$fixed
  [ -n "$proxy" ] || proxy=$(conf SPOTIFY_PROXY)
  [ "$fixed" = off ] && proxy=""
  _tg() { # _tg [proxy] args…
    local px=$1; shift
    printf 'url = "%s/bot%s/%s"\n' "$(TG_API)" "$token" "$method" \
      | curl -sS --connect-timeout 10 --max-time "$maxt" --speed-limit 512 --speed-time 25 --retry 1 ${px:+-x "$px"} -K - "$@"
  }
  # «зависшее» соединение (Telegram замедлен) обрываем: сообщения — за 30 с, файлы — по низкой скорости
  local maxt=30
  [ "$method" = sendDocument ] && maxt=${BACKUP_TELEGRAM_TIMEOUT:-600}
  if [ -n "$fixed" ] && [ "$fixed" != off ]; then _tg "$fixed" "$@"; return; fi
  rc=0
  out=$(_tg "" "$@" 2>/dev/null) || rc=$?
  if [ "$rc" -eq 0 ]; then printf '%s' "$out"; return 0; fi
  if [ -n "$proxy" ]; then
    warn "Telegram напрямую недоступен (curl $rc) — пробую через VPN-прокси ${proxy%%@*}"
    _tg "$proxy" "$@"
    return
  fi
  warn "Telegram недоступен с этого сервера (curl $rc). Настройте VPN-прокси: sudo bash /opt/sozvon/deploy/vpn-proxy.sh"
  return "$rc"
}
tg_ok() { grep -q '"ok"[[:space:]]*:[[:space:]]*true'; }

tg_message() {
  local resp
  resp=$(tg_call sendMessage --data-urlencode "chat_id=$(conf BACKUP_TELEGRAM_CHAT_ID)" --data-urlencode "text=$1") || return 1
  printf '%s' "$resp" | tg_ok || { warn "Telegram ответил: $(printf '%s' "$resp" | head -c 300)"; return 1; }
}

tg_document() {
  local f=$1 caption=$2 resp
  resp=$(tg_call sendDocument -F "chat_id=$(conf BACKUP_TELEGRAM_CHAT_ID)" -F "caption=$caption" -F "document=@$f") || return 1
  printf '%s' "$resp" | tg_ok || { warn "Telegram ответил: $(printf '%s' "$resp" | head -c 300)"; return 1; }
}

encrypt_file() {   # encrypt_file ВХОД ВЫХОД — AES-256-CBC, ключ из пароля (PBKDF2, 200000 итераций)
  local pp
  pp=$(conf BACKUP_PASSPHRASE)
  openssl enc -aes-256-cbc -pbkdf2 -iter 200000 -salt -in "$1" -out "$2" -pass fd:3 3<<<"$pp"
}
decrypt_file() {
  local pp
  pp=$(conf BACKUP_PASSPHRASE)
  if [ -z "$pp" ]; then
    [ -t 0 ] || die "Копия зашифрована: задайте BACKUP_PASSPHRASE или запустите в терминале"
    read -rsp "Пароль шифрования копии: " pp; echo
  fi
  openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in "$1" -out "$2" -pass fd:3 3<<<"$pp" \
    || die "Не удалось расшифровать (неверный пароль?)"
}

telegram_send_backup() {
  local file=$1 tmp=$2 name enc size limit maxparts n i p host
  name=$(basename "$file")
  enc="$tmp/$name.enc"
  host=$(hostname 2>/dev/null || echo server)
  info "Telegram: шифрую копию (AES-256, пароль BACKUP_PASSPHRASE)…"
  encrypt_file "$file" "$enc" || { warn "Не удалось зашифровать копию"; return 1; }
  size=$(fsize "$enc")
  limit=$(conf BACKUP_TELEGRAM_PART_SIZE)
  limit=$(numfmt --from=iec "${limit:-45M}" 2>/dev/null || echo 47185920)
  [ "$limit" -le 47185920 ] || limit=47185920   # лимит Bot API — 50 МБ
  maxparts=$(conf BACKUP_TELEGRAM_MAX_PARTS)
  [[ "${maxparts:-}" =~ ^[0-9]+$ ]] || maxparts=20
  if [ "$size" -le "$limit" ]; then
    tg_document "$enc" "Astra · $host · $name.enc ($(human "$size"))" || return 1
    ok "Telegram: отправлено $name.enc ($(human "$size"))"
    return 0
  fi
  n=$(( (size + limit - 1) / limit ))
  if [ "$n" -gt "$maxparts" ]; then
    warn "Telegram: копия $(human "$size") — это $n частей (> $maxparts), не отправляю. Скачайте её через scp."
    return 1
  fi
  split -b "$limit" -d -a 2 "$enc" "$enc.part"
  i=0
  for p in "$enc".part*; do
    i=$((i + 1))
    tg_document "$p" "Astra · $host · $(basename "$p") ($i/$n). Склеить: cat $name.enc.part* > $name.enc" || return 1
  done
  ok "Telegram: отправлено $n частей по ≤$(human "$limit") ($name.enc.part00…)"
}

telegram_test() {
  [ -n "$(conf BACKUP_TELEGRAM_TOKEN)" ] || die "Telegram не настроен: sudo bash $SELF setup"
  [ -n "$(conf BACKUP_TELEGRAM_CHAT_ID)" ] || die "Нет BACKUP_TELEGRAM_CHAT_ID: sudo bash $SELF setup"
  tg_message "Astra ($(hostname 2>/dev/null || echo server)): проверка связи. Сюда будут приходить зашифрованные резервные копии." \
    || die "Не удалось отправить сообщение — проверьте токен и chat id (и что вы нажали Start у бота)"
  ok "Тестовое сообщение отправлено — проверьте Telegram"
  [ -n "$(conf BACKUP_PASSPHRASE)" ] || warn "Нет BACKUP_PASSPHRASE — без пароля копии в Telegram не отправляются"
}

setup() {
  [ -t 0 ] || die "setup — интерактивная команда, запустите её в терминале"
  cat <<EOF
Отправка резервных копий в ВАШ Telegram-бот (по желанию).
  1. В Telegram откройте @BotFather → /newbot → получите токен вида 123456:ABC…
  2. Откройте своего нового бота и нажмите «Start» (или напишите ему что-нибудь).
  3. Придумайте пароль шифрования. Без него копию НЕ расшифровать — запишите его в менеджер паролей.
Копии шифруются на сервере (AES-256) до отправки; в Telegram попадает только зашифрованный файл.
Настройки сохраняются в $ENV_FILE (права 600). Отключить: удалите строки BACKUP_TELEGRAM_* из этого файла.

EOF
  local token chat pp pp2 cur resp
  cur=$(env_get BACKUP_TELEGRAM_TOKEN)
  read -rsp "Токен бота (ввод скрыт)${cur:+; Enter — оставить прежний}: " token; echo
  token=${token:-$cur}
  [[ "$token" =~ ^[0-9]+:[A-Za-z0-9_-]+$ ]] || die "Токен не похож на токен бота (123456:ABC…)"
  export BACKUP_TELEGRAM_TOKEN=$token
  cur=$(env_get BACKUP_TELEGRAM_CHAT_ID)
  read -rp "Chat id (Enter — определить автоматически по последнему сообщению боту)${cur:+ [$cur]}: " chat
  if [ -z "$chat" ] && [ -n "$cur" ]; then chat=$cur; fi
  if [ -z "$chat" ]; then
    resp=$(tg_call getUpdates) || die "Не удалось связаться с Telegram"
    chat=$(printf '%s' "$resp" | grep -o '"chat":{"id":-\{0,1\}[0-9]*' | tail -n 1 | grep -o -- '-\{0,1\}[0-9]*$' || true)
    [ -n "$chat" ] || die "Бот ещё не получал сообщений. Напишите ему что-нибудь и запустите setup снова"
    ok "Найден chat id: $chat"
  fi
  [[ "$chat" =~ ^-?[0-9]+$ ]] || die "Chat id — это число (например 123456789)"
  export BACKUP_TELEGRAM_CHAT_ID=$chat
  cur=$(env_get BACKUP_PASSPHRASE)
  read -rsp "Пароль шифрования (не меньше 12 символов${cur:+; Enter — оставить прежний}): " pp; echo
  if [ -z "$pp" ] && [ -n "$cur" ]; then
    pp=$cur
  else
    [ "${#pp}" -ge 12 ] || die "Слишком короткий пароль (нужно ≥ 12 символов)"
    case "$pp" in *"'"*|*\\*) die "В пароле нельзя использовать ' и \\" ;; esac
    read -rsp "Повторите пароль: " pp2; echo
    [ "$pp" = "$pp2" ] || die "Пароли не совпадают"
  fi
  export BACKUP_PASSPHRASE=$pp
  env_set BACKUP_TELEGRAM_TOKEN "$token"
  env_set BACKUP_TELEGRAM_CHAT_ID "$chat"
  env_set BACKUP_PASSPHRASE "$pp"
  ok "Сохранено в $ENV_FILE"
  telegram_test
  echo "Готово. Следующая ночная копия уйдёт в Telegram. Отправить сейчас: sudo bash $SELF now"
}

# ---------------------------------------------------------------- list
list() {
  echo "Копии в $BACKUP_DIR:"
  local f n=0 total=0 s
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    s=$(fsize "$BACKUP_DIR/$f"); total=$((total + s)); n=$((n + 1))
    printf '  %-34s %10s  %s\n' "$f" "$(human "$s")" "$(date -r "$BACKUP_DIR/$f" '+%Y-%m-%d %H:%M')"
  done < <(backups_sorted)
  [ "$n" -gt 0 ] || echo "  (пока нет — сделать: sudo bash $SELF now)"
  [ "$n" -gt 0 ] && echo "  Всего: $n, $(human "$total")"
  if [ -f "$BACKUP_DIR/.last-status" ]; then
    echo "Последний бэкап:"
    sed 's/^/  /' "$BACKUP_DIR/.last-status"
  fi
  if sysctl_ok; then
    echo "Таймер $TIMER:"
    systemctl list-timers "$TIMER" --all --no-pager 2>/dev/null | sed 's/^/  /' || true
    systemctl show sozvon-backup.service -p Result -p ExecMainStatus -p ExecMainExitTimestamp --no-pager 2>/dev/null \
      | sed 's/^/  /' || true
    echo "  журнал: journalctl -u sozvon-backup -n 50 --no-pager"
  fi
  if telegram_enabled; then echo "Telegram: включён (chat $(conf BACKUP_TELEGRAM_CHAT_ID))"; else echo "Telegram: выключен (включить: sudo bash $SELF setup)"; fi
}

# ---------------------------------------------------------------- restore
confirm() {   # confirm ВОПРОС → 0 если «да»
  [ "${BACKUP_ASSUME_YES:-0}" = 1 ] && return 0
  [ -t 0 ] || die "Нужно подтверждение: запустите в терминале (или BACKUP_ASSUME_YES=1)"
  local a
  read -rp "$1 " a
  [ "$a" = "да" ] || [ "$a" = "yes" ]
}

restore() {
  local src=${1:-} work tar_file top ts parent new ans
  [ -n "$src" ] || die "Укажите файл: sudo bash $SELF restore $BACKUP_DIR/astra-ГГГГММДД-ЧЧММ.tar.zst"
  if [ ! -f "$src" ] && [ -f "$BACKUP_DIR/$src" ]; then src="$BACKUP_DIR/$src"; fi
  [ -f "$src" ] || die "Файл не найден: $src"
  parent=$(dirname "$DATA_DIR")
  install -d "$parent"
  work=$(mktemp -d "$parent/.astra-restore.XXXXXX")
  # shellcheck disable=SC2064
  trap "rm -rf '$work'" EXIT
  tar_file=$src
  case "$src" in
    *.part00)
      info "Склеиваю части ${src%.part00}.part*"
      cat "${src%.part00}".part* >"$work/joined.enc"
      tar_file="$work/joined.enc" ;;
  esac
  case "$tar_file" in
    *.enc)
      info "Расшифровываю…"
      decrypt_file "$tar_file" "$work/archive"
      tar_file="$work/archive" ;;
  esac
  mkdir "$work/x"
  decompress_to_tar "$tar_file" | tar -x -C "$work/x" --numeric-owner || die "Архив повреждён"
  if [ -f "$work/x/BACKUP-INFO.txt" ] && [ -d "$work/x/data" ]; then
    top="$work/x/data"
    [ -f "$work/x/env/sozvon.env" ] && mv "$work/x/env/sozvon.env" "$work/sozvon.env"
  elif [ -d "$work/x/sozvon" ]; then   # копии старого формата (backup.sh до v13)
    top="$work/x/sozvon"
    [ -f "$work/x/sozvon.env" ] && mv "$work/x/sozvon.env" "$work/sozvon.env"
  else
    die "Это не резервная копия Astra"
  fi
  [ -f "$top/db.json" ] || warn "В копии нет db.json"
  echo "Копия: $src"
  [ -f "$work/x/BACKUP-INFO.txt" ] && sed -n 's/^created=/  создана: /p' "$work/x/BACKUP-INFO.txt"
  printf '  данные: %s\n' "$(du -sh "$top" | cut -f1)"
  echo "ВНИМАНИЕ: текущие данные $DATA_DIR будут заменены данными из копии."
  echo "Службы ($SERVICES) будут остановлены на время восстановления."
  confirm "Восстановить? Напишите «да»:" || die "Отменено"

  local restore_env=n
  if [ -f "$work/sozvon.env" ]; then
    if [ -n "${BACKUP_RESTORE_ENV:-}" ]; then
      restore_env=${BACKUP_RESTORE_ENV}
    elif [ -t 0 ]; then
      read -rp "Восстановить и настройки $ENV_FILE из копии? (y/N) " ans
      case "$ans" in y|Y|д|Д|yes|да) restore_env=y ;; esac
    fi
  fi

  ts=$(date +%Y%m%d-%H%M%S)
  # shellcheck disable=SC2086
  svc stop $SERVICES || warn "Не удалось остановить службы"
  if [ -e "$DATA_DIR" ]; then
    mv "$DATA_DIR" "$DATA_DIR.bak-$ts"
    ok "Текущие данные сохранены: $DATA_DIR.bak-$ts"
  fi
  mv "$top" "$DATA_DIR"
  new=$DATA_DIR
  if id "$APP_USER" >/dev/null 2>&1; then
    chown -R "$APP_USER:$APP_USER" "$new"
  else
    warn "Нет пользователя $APP_USER — владелец файлов не изменён"
  fi
  chmod 750 "$new"
  ok "Данные восстановлены в $DATA_DIR"
  if [ "$restore_env" = y ]; then
    [ -f "$ENV_FILE" ] && cp -p "$ENV_FILE" "$ENV_FILE.bak-$ts" && ok "Прежние настройки: $ENV_FILE.bak-$ts"
    install -m 0600 "$work/sozvon.env" "$ENV_FILE"
    chown root:root "$ENV_FILE" 2>/dev/null || true
    ok "Настройки восстановлены: $ENV_FILE"
  elif [ -f "$work/sozvon.env" ]; then
    info "Настройки $ENV_FILE оставлены текущими"
  fi
  # shellcheck disable=SC2086
  svc start $SERVICES || warn "Службы не запустились — смотрите journalctl -u sozvon -n 50"
  cat <<EOF

Проверьте:
  systemctl status sozvon sozvon-bot --no-pager
  journalctl -u sozvon -n 50 --no-pager
  curl -fsS http://127.0.0.1:3000/api/config && echo OK
Если что-то не так — вернуть как было:
  systemctl stop sozvon-bot sozvon && mv $DATA_DIR $DATA_DIR.failed-$ts && mv $DATA_DIR.bak-$ts $DATA_DIR && systemctl start sozvon sozvon-bot
Старую копию данных удалите, когда убедитесь, что всё работает:  rm -rf $DATA_DIR.bak-$ts
EOF
}

# ---------------------------------------------------------------- main
cmd=${1:-now}
case "$cmd" in
  now|backup) do_backup ;;
  list|ls) list ;;
  restore) restore "${2:-}" ;;
  --restore) restore "${2:-}" ;;   # старый синтаксис
  --keep) export BACKUP_KEEP_DAILY=${2:-7} BACKUP_KEEP_WEEKLY=0; do_backup ;;   # старый синтаксис (cron)
  setup) setup ;;
  telegram-test) telegram_test ;;
  -h|--help|help) sed -n '2,18p' "$SELF" | sed 's/^# \{0,1\}//' ;;
  *) die "Неизвестная команда: $cmd (now | list | restore ФАЙЛ | setup | telegram-test)" ;;
esac
