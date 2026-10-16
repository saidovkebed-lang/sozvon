#!/bin/sh
# Созвон: после получения/продления сертификата Let's Encrypt
# копирует его для coturn (у coturn нет доступа к /etc/letsencrypt) и перезапускает службы.
# Создан deploy/install.sh. certbot передаёт RENEWED_LINEAGE=/etc/letsencrypt/live/<имя>.
set -eu
LINEAGE="@CERT_LINEAGE@"
[ "${RENEWED_LINEAGE:-$LINEAGE}" = "$LINEAGE" ] || exit 0
install -d -o turnserver -g turnserver -m 0750 @TURN_CERT_DIR@
install -o turnserver -g turnserver -m 0644 "$LINEAGE/fullchain.pem" @TURN_CERT_DIR@/fullchain.pem
install -o turnserver -g turnserver -m 0600 "$LINEAGE/privkey.pem" @TURN_CERT_DIR@/privkey.pem
if [ -d /run/systemd/system ]; then
  systemctl restart coturn 2>/dev/null || true
  systemctl reload nginx 2>/dev/null || true
fi
