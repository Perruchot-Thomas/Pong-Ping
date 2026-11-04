#!/usr/bin/env bash
# Installation de Pong Ping sur le VPS (service systemd + Apache + HTTPS).
# A lancer une fois, depuis le dossier du projet :  sudo bash deploy/install.sh
# Le script peut être relancé sans risque : il n'ajoute rien en double.
set -euo pipefail

DOMAIN=pongping.tperruchot.fr
APP=/var/www/pongping/Pong-Ping
PORT=3001
CONF=/etc/apache2/sites-available/000-default.conf

[ "$(id -u)" = 0 ] || { echo "Lance ce script avec sudo : sudo bash deploy/install.sh"; exit 1; }

echo "== 1/4 Service systemd pongping (port $PORT)"
cp "$APP/deploy/pongping.service" /etc/systemd/system/pongping.service
systemctl daemon-reload
systemctl enable --now pongping
systemctl restart pongping
sleep 2
curl -fsS -o /dev/null "http://localhost:$PORT/" && echo "   OK : le jeu répond sur le port $PORT"

echo "== 2/4 Modules Apache"
a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl >/dev/null
cp "$CONF" "$CONF.bak-pongping-$(date +%Y%m%d-%H%M%S)"
if ! grep -q "pongping-80" "$CONF"; then
  cat >> "$CONF" <<EOF

# pongping-80
<VirtualHost *:80>
    ServerName $DOMAIN
</VirtualHost>
EOF
fi
apachectl configtest
systemctl reload apache2

echo "== 3/4 Certificat HTTPS (certbot)"
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
  certbot certonly --apache -d "$DOMAIN"
else
  echo "   Certificat déjà présent"
fi

echo "== 4/4 VirtualHost HTTPS + WebSockets"
if ! grep -q "pongping-443" "$CONF"; then
  cat >> "$CONF" <<EOF

# pongping-443
<VirtualHost *:443>
    ServerName $DOMAIN
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/$DOMAIN/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/$DOMAIN/privkey.pem

    ProxyPreserveHost On
    RewriteEngine On
    RewriteCond %{HTTP:Upgrade} =websocket [NC]
    RewriteRule ^/?(.*) ws://localhost:$PORT/\$1 [P,L]
    ProxyPass / http://localhost:$PORT/
    ProxyPassReverse / http://localhost:$PORT/
</VirtualHost>
EOF
fi
apachectl configtest
systemctl reload apache2

echo
echo "Terminé : https://$DOMAIN"
