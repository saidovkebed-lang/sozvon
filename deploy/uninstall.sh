#!/usr/bin/env bash
# Созвон — удаление с сервера.
#   sudo bash /opt/sozvon/deploy/uninstall.sh           удалить программу, ДАННЫЕ ОСТАВИТЬ (/var/lib/sozvon)
#   sudo bash /opt/sozvon/deploy/uninstall.sh --purge   удалить всё, включая данные, пользователя и сертификат
#   --yes  не спрашивать подтверждение
# Пакеты nginx/coturn/certbot/ffmpeg, Node.js в /opt/node и yt-dlp (без --purge) не удаляются (могут быть нужны другим программам);
# правила ufw тоже остаются — список: ufw status numbered.
set -Eeuo pipefail

APP_DIR=/opt/sozvon
DATA_DIR=/var/lib/sozvon
ENV_FILE=/etc/sozvon.env
PURGE=0
YES=0

die() { printf '\n✗ ОШИБКА: %s\n' "$*" >&2; exit 1; }
ok() { printf '  ✓ %s\n' "$*"; }

for a in "$@"; do
  case "$a" in
    --purge) PURGE=1 ;;
    --yes|-y) YES=1 ;;
    -h|--help) sed -n '2,8p' "$0"; exit 0 ;;
    *) die "Неизвестный параметр: $a" ;;
  esac
done
[ "$(id -u)" -eq 0 ] || die "Запустите от root: sudo bash $0"

domain=$(sed -n "s/^SOZVON_DOMAIN=//p" "$ENV_FILE" 2>/dev/null | tail -n 1 || true)

echo "Будут удалены: службы sozvon и sozvon-bot, $APP_DIR, $ENV_FILE,"
echo "сайт nginx sozvon.conf, настройки coturn (coturn будет остановлен)."
if [ "$PURGE" = 1 ]; then
  echo "!!! --purge: ТАКЖЕ БУДУТ УДАЛЕНЫ ВСЕ ДАННЫЕ ($DATA_DIR: переписка, файлы, музыка),"
  echo "!!! пользователь sozvon и сертификат Let's Encrypt${domain:+ для $domain}."
else
  echo "Данные останутся в $DATA_DIR (удалить: --purge)."
fi
if [ "$YES" != 1 ]; then
  printf 'Продолжить? Напишите yes: '
  answer=""
  if [ -t 0 ]; then
    read -r answer || true
  else
    { read -r answer </dev/tty; } 2>/dev/null || die "Нет терминала для подтверждения — добавьте --yes"
  fi
  [ "$answer" = yes ] || { echo "Отменено."; exit 0; }
fi

if [ -d /run/systemd/system ]; then
  systemctl disable --now sozvon-bot sozvon 2>/dev/null || true
  systemctl disable --now sozvon-ytdlp-update.timer 2>/dev/null || true
  systemctl disable --now coturn 2>/dev/null || true
fi
rm -f /etc/systemd/system/sozvon.service /etc/systemd/system/sozvon-bot.service \
  /etc/systemd/system/sozvon-ytdlp-update.service /etc/systemd/system/sozvon-ytdlp-update.timer
[ -d /run/systemd/system ] && systemctl daemon-reload
ok "Службы остановлены и удалены"

rm -f /etc/nginx/sites-enabled/sozvon.conf /etc/nginx/sites-available/sozvon.conf
if [ ! -e /etc/nginx/sites-enabled/default ] && [ -f /etc/nginx/sites-available/default ]; then
  ln -s /etc/nginx/sites-available/default /etc/nginx/sites-enabled/default
fi
if nginx -t -q 2>/dev/null && [ -d /run/systemd/system ]; then systemctl reload nginx 2>/dev/null || true; fi
ok "Сайт nginx удалён"

rm -f /etc/turnserver.conf /etc/letsencrypt/renewal-hooks/deploy/sozvon-coturn.sh
rm -rf /etc/coturn/certs
[ -f /etc/default/coturn ] && sed -i -E 's/^TURNSERVER_ENABLED=1/#TURNSERVER_ENABLED=1/' /etc/default/coturn
ok "Настройки coturn удалены"

rm -rf "$APP_DIR" "$ENV_FILE"
ok "Удалены $APP_DIR и $ENV_FILE"

if [ "$PURGE" = 1 ]; then
  rm -rf "$DATA_DIR"
  # yt-dlp, поставленный установщиком (бинарь или venv)
  if [ -d /var/lib/sozvon-ytdlp ]; then rm -rf /usr/local/bin/yt-dlp /opt/yt-dlp-venv /var/lib/sozvon-ytdlp; fi
  id sozvon >/dev/null 2>&1 && userdel sozvon 2>/dev/null || true
  if [ -n "$domain" ] && command -v certbot >/dev/null; then
    certbot delete --non-interactive --cert-name "$domain" >/dev/null 2>&1 || true
  fi
  ok "Данные, пользователь и сертификат удалены"
else
  ok "Данные сохранены в $DATA_DIR (бэкапы — в /var/backups/sozvon, если делали)"
fi
echo "Готово."
