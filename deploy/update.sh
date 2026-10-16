#!/usr/bin/env bash
# Созвон — быстрое обновление: свежий код из git, зависимости, перезапуск.
#   sudo bash /opt/sozvon/deploy/update.sh
# Если менялись шаблоны nginx/coturn/systemd — запустите полную установку ещё раз:
#   sudo bash /opt/sozvon/deploy/install.sh
set -Eeuo pipefail

APP_DIR=/opt/sozvon
ENV_FILE=/etc/sozvon.env
BRANCH="${SOZVON_BRANCH:-main}"
NPM_REGISTRY_MAIN=https://registry.npmjs.org/
NPM_REGISTRY_MIRROR=https://registry.npmmirror.com/

die() { printf '\n✗ ОШИБКА: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }

[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0"
[ -d "$APP_DIR/.git" ] || die "$APP_DIR не git-репозиторий. Запустите deploy/install.sh"
export PATH="/opt/node/bin:/usr/local/bin:$PATH"
command -v npm >/dev/null || die "npm не найден. Запустите deploy/install.sh"

old=$(git -C "$APP_DIR" rev-parse --short HEAD)
git -C "$APP_DIR" fetch --depth 1 origin "$BRANCH" || die "git fetch не удался (доступ к github.com?)"
git -C "$APP_DIR" reset --hard -q FETCH_HEAD
new=$(git -C "$APP_DIR" rev-parse --short HEAD)
chown -R root:root "$APP_DIR"
chmod -R u+rwX,go+rX,go-w "$APP_DIR"
if [ "$old" = "$new" ]; then ok "Код уже свежий ($new)"; else ok "Код: $old → $new"; fi

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

systemctl restart sozvon
systemctl restart sozvon-bot
port=$(sed -n "s/^PORT=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)
for _ in $(seq 1 30); do
  if curl -fsS --noproxy "*" --max-time 3 -o /dev/null "http://127.0.0.1:${port:-3000}/api/config" 2>/dev/null; then
    ok "Созвон перезапущен и отвечает"
    exit 0
  fi
  sleep 1
done
die "Сервер не отвечает после обновления. Журнал: journalctl -u sozvon -n 100"
