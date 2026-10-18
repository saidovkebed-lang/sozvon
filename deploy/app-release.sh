#!/usr/bin/env bash
# Созвон — приложение для ПК: скачать свежий релиз с GitHub Releases на этот сервер,
# чтобы пользователи из РФ качали его со страницы https://<ваш-адрес>/download, а не с GitHub.
#
#   sudo bash /opt/sozvon/deploy/app-release.sh            # последний релиз с тегом desktop-v*
#   sudo bash /opt/sozvon/deploy/app-release.sh --force    # скачать заново, даже если версия та же
#   sudo bash /opt/sozvon/deploy/app-release.sh --from-dir КАТАЛОГ ВЕРСИЯ
#                                                          # опубликовать готовые файлы (без GitHub)
#
# Файлы: $DATA_DIR/downloads/, описание: $DATA_DIR/app-release.json (его читает GET /api/app/latest).
# Переменные: SOZVON_APP_REPO (по умолчанию saidovkebed-lang/sozvon), GITHUB_TOKEN (необязательно,
# от лимита запросов API), DATA_DIR (по умолчанию /var/lib/sozvon), SOZVON_GITHUB_API (для тестов).
# Код выхода: 0 — готово или релизов нет; 1 — ошибка (сеть и т.п.). Сервер перезапускать не нужно.
set -Eeuo pipefail

REPO="${SOZVON_APP_REPO:-saidovkebed-lang/sozvon}"
API="${SOZVON_GITHUB_API:-https://api.github.com}"
DATA_DIR="${DATA_DIR:-/var/lib/sozvon}"
APP_USER="${APP_USER:-sozvon}"
DL_DIR="$DATA_DIR/downloads"
JSON="$DATA_DIR/app-release.json"
export PATH="/opt/node/bin:/usr/local/bin:$PATH"

ok() { printf '  ✓ %s\n' "$*"; }
warn() { printf '  ⚠ %s\n' "$*" >&2; }
fail() { printf '  ✗ %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

have node || fail "node не найден (нужен для разбора ответа GitHub)"
have curl || fail "curl не найден"

FORCE=0
FROM_DIR=""
FROM_VER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --force) FORCE=1 ;;
    --from-dir)
      [ $# -ge 3 ] || fail "Укажите каталог и версию: --from-dir КАТАЛОГ 1.2.3"
      FROM_DIR=$2; FROM_VER=$3; shift 3; continue ;;
    -h|--help) sed -n '2,15p' "$0"; exit 0 ;;
    *) fail "Неизвестный параметр: $1" ;;
  esac
  shift
done

install -d -m 0755 "$DL_DIR"
if id "$APP_USER" >/dev/null 2>&1; then chown "$APP_USER:$APP_USER" "$DL_DIR" 2>/dev/null || true; fi

# Одна копия за раз: таймер sozvon-app-release и update.sh могут запуститься одновременно
exec 9>"$DATA_DIR/.app-release.lock"
if ! flock -w 1800 9; then fail "Другая загрузка приложения для ПК не закончилась за 30 мин"; fi

# Атомарная замена файла: копия рядом + переименование (раздача не видит «полуфайла»)
put() {
  local src=$1 dst=$2 tmp
  tmp=$(mktemp "$(dirname "$dst")/.put.XXXXXX")
  cp -f "$src" "$tmp" && chmod 0644 "$tmp" && mv -f "$tmp" "$dst"
}

# Служебные файлы автообновления electron-builder: latest*.yml (версия + sha512) и *.blockmap
# (дифференциальная загрузка). Раздаём их, но на странице /download не показываем.
is_meta_file() {
  case "${1,,}" in
    latest*.yml|*.blockmap) return 0 ;;
    *) return 1 ;;
  esac
}

# Файлы приложения для страницы /download
is_app_file() {
  case "${1,,}" in
    *.yml|*.yaml|*.blockmap|*.txt|*.json) return 1 ;;
    *.exe|*.zip|*.appimage|*.dmg|*.deb|*.rpm|*.tar.gz) return 0 ;;
    *) return 1 ;;
  esac
}

# write_json ВЕРСИЯ ТЕГ ДАТА ЗАМЕТКИ ИМЯ... — описание релиза по лежащим в $DL_DIR файлам
write_json() {
  local tmp
  tmp=$(mktemp "$DATA_DIR/.app-release.XXXXXX")
  node -e '
    const fs = require("fs"), path = require("path");
    const [dir, version, tag, publishedAt, notes, ...names] = process.argv.slice(1);
    const guess = (n) => {
      const l = n.toLowerCase();
      if (l.endsWith(".appimage")) return ["linux", "appimage"];
      if (l.endsWith(".deb")) return ["linux", "deb"];
      if (l.endsWith(".dmg")) return ["mac", "dmg"];
      if (l.endsWith(".exe")) return ["win", l.includes("setup") ? "installer" : "portable"];
      if (l.endsWith(".zip")) return [l.includes("mac") || l.includes("darwin") ? "mac" : "win", "portable"];
      return ["win", "other"];
    };
    const files = names.map((name) => {
      const [platform, kind] = guess(name);
      return { name, url: "/media/downloads/" + encodeURIComponent(name), size: fs.statSync(path.join(dir, name)).size, platform, kind };
    });
    process.stdout.write(JSON.stringify({ version, tag, publishedAt, notes, files }, null, 2) + "\n");
  ' "$DL_DIR" "$@" >"$tmp"
  chmod 0644 "$tmp"
  mv -f "$tmp" "$JSON"
}

# удалить из $DL_DIR файлы прошлых релизов (кроме перечисленных)
prune() {
  local keep=" $* " f
  for f in "$DL_DIR"/*; do
    [ -f "$f" ] || continue
    case "$(basename "$f")" in .*) continue ;; esac
    [[ $keep == *" $(basename "$f") "* ]] || rm -f "$f"
  done
}

# ---------------------------------------------------------- из каталога --
if [ -n "$FROM_DIR" ]; then
  [ -d "$FROM_DIR" ] || fail "Нет каталога $FROM_DIR"
  [[ $FROM_VER =~ ^[0-9]+\.[0-9]+\.[0-9]+ ]] || fail "Укажите версию: --from-dir КАТАЛОГ 1.2.3"
  names=(); metas=()
  for f in "$FROM_DIR"/*; do
    [ -f "$f" ] || continue
    if is_app_file "$(basename "$f")"; then names+=("$(basename "$f")")
    elif is_meta_file "$(basename "$f")"; then metas+=("$(basename "$f")")
    else continue; fi
    put "$f" "$DL_DIR/$(basename "$f")"
  done
  [ ${#names[@]} -gt 0 ] || fail "В $FROM_DIR нет файлов приложения (.exe/.zip/.AppImage/.dmg)"
  prune "${names[@]}" "${metas[@]}"
  write_json "$FROM_VER" "desktop-v$FROM_VER" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "" "${names[@]}"
  ok "Опубликовано приложение $FROM_VER: ${names[*]}"
  exit 0
fi

# ------------------------------------------------------------- с GitHub --
auth=()
[ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
work=$(mktemp -d "$DATA_DIR/.app-release-dl.XXXXXX")
trap 'rm -rf "$work"' EXIT

curl -fsSL --retry 2 --connect-timeout 10 --max-time 60 "${auth[@]}" \
  -H 'Accept: application/vnd.github+json' -o "$work/releases.json" \
  "$API/repos/$REPO/releases?per_page=30" \
  || fail "GitHub API недоступен ($API) — приложение для ПК не обновлено"

# последний опубликованный (не черновик, не pre-release) релиз с тегом desktop-v*
plan=$(node -e '
  const rel = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8"));
  if (!Array.isArray(rel)) { console.error(rel && rel.message || "неожиданный ответ GitHub"); process.exit(2); }
  const r = rel.filter((x) => !x.draft && !x.prerelease && /^desktop-v\d+\.\d+\.\d+/.test(x.tag_name || ""))
    .sort((a, b) => String(b.published_at).localeCompare(String(a.published_at)))[0];
  if (!r) process.exit(3);
  const ok = /\.(exe|zip|appimage|dmg|deb|rpm)$/i;
  const meta = /^latest[\w.-]*\.yml$|\.blockmap$/i;
  const assets = (r.assets || []).filter((a) => (ok.test(a.name) || meta.test(a.name)) && /^[\w.+-]+$/.test(a.name));
  console.log(["REL", r.tag_name.replace(/^desktop-v/, ""), r.tag_name, r.published_at || "", ""].join("\t"));
  for (const a of assets) console.log(["ASSET", a.name, a.size, a.browser_download_url].join("\t"));
' "$work/releases.json") || {
  code=$?
  if [ "$code" = 3 ]; then ok "Релизов приложения для ПК (тег desktop-v*) пока нет"; exit 0; fi
  fail "Не удалось разобрать ответ GitHub"
}

version=""; tag=""; published=""
names=(); sizes=(); urls=()
while IFS=$'\t' read -r kind a b c _; do
  case "$kind" in
    REL) version=$a; tag=$b; published=$c ;;
    ASSET) names+=("$a"); sizes+=("$b"); urls+=("$c") ;;
  esac
done <<<"$plan"
napps=0
for n in "${names[@]}"; do is_app_file "$n" && napps=$((napps + 1)); done
[ "$napps" -gt 0 ] || { warn "В релизе $tag нет файлов приложения"; exit 0; }

# уже скачан?
if [ "$FORCE" = 0 ] && [ -f "$JSON" ]; then
  cur=$(node -e 'try{process.stdout.write(String(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).version||""))}catch{}' "$JSON")
  all=1
  for i in "${!names[@]}"; do
    f="$DL_DIR/${names[$i]}"
    { [ -f "$f" ] && [ "$(stat -c %s "$f")" = "${sizes[$i]}" ]; } || all=0
  done
  if [ "$cur" = "$version" ] && [ "$all" = 1 ]; then ok "Приложение для ПК уже свежее ($version)"; exit 0; fi
fi

printf '  … скачиваю приложение для ПК %s (%s файл(ов))\n' "$version" "${#names[@]}"
for i in "${!names[@]}"; do
  out="$work/${names[$i]}"
  curl -fL --retry 3 --retry-delay 3 --connect-timeout 15 --max-time 1800 -sS "${auth[@]}" -o "$out" "${urls[$i]}" \
    || fail "Не скачался ${names[$i]} — оставляю прежнюю версию"
  [ "$(stat -c %s "$out")" = "${sizes[$i]}" ] || fail "Размер ${names[$i]} не совпал — оставляю прежнюю версию"
done
# сначала сами программы и blockmap, latest*.yml — последними: приложения друзей увидят новую
# версию только когда все её файлы уже лежат на сервере
apps=(); metas=(); ymls=()
for n in "${names[@]}"; do
  if is_app_file "$n"; then apps+=("$n"); elif [[ ${n,,} == *.yml ]]; then ymls+=("$n"); else metas+=("$n"); fi
done
for n in "${apps[@]}" "${metas[@]}" "${ymls[@]}"; do
  put "$work/$n" "$DL_DIR/$n"
done
prune "${names[@]}"
write_json "$version" "$tag" "$published" "" "${apps[@]}"
ok "Приложение для ПК $version: ${names[*]} → $DL_DIR (страница /download)"
