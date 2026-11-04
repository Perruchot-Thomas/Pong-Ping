# Déploiement de Pong Ping sur le VPS (Apache + Bun)

Adapté du TP « Déploiement AstroJS + SQLite ». Différences avec ce TP :

- **Pas de build** : le jeu est un simple serveur Node (`server.js`), il n'y a ni `dist/` ni Astro.
- **Pas de base de données ni de `.env`.**
- **Port 3001** (le 3000 est peut-être déjà pris par l'application scolarité).
- **WebSockets** : Apache doit aussi faire suivre les connexions WebSocket (module `proxy_wstunnel` + règle `RewriteRule`), sinon les parties ne démarrent pas.

```text
Internet -> Apache :443 -> (reverse proxy HTTP + WebSocket) -> Bun server.js :3001
```

## 1. Sur le poste de développement : GitHub

```bash
git init
git add .
git commit -m "Initial commit"
git branch -M main
git remote add origin https://github.com/<VOTRE_COMPTE>/pong-ping.git
git push -u origin main
```

## 2. Sur le VPS : récupérer le code

```bash
ssh -p 23<xxx> etudiant@185.157.244.202
sudo mkdir -p /var/www/pongping
sudo chown -R etudiant:etudiant /var/www/pongping
cd /var/www/pongping
git clone https://github.com/<VOTRE_COMPTE>/pong-ping.git
cd pong-ping
bun install
```

## 3. Tester avant Apache

```bash
PORT=3001 bun server.js
# dans un autre terminal sur le VPS :
curl -I http://localhost:3001
```

## 4. Service systemd

```bash
sudo cp deploy/pongping.service /etc/systemd/system/pongping.service
sudo systemctl daemon-reload
sudo systemctl enable pongping
sudo systemctl start pongping
sudo systemctl status pongping
```

## 5. Apache + HTTPS

DNS (Infomaniak) : enregistrement **A** `pongping.<votredomaine>.<tld>` → `185.157.244.202`.

```bash
sudo a2enmod proxy proxy_http proxy_wstunnel rewrite headers ssl
```

Dans `/etc/apache2/sites-available/000-default.conf`, ajouter d'abord :

```apache
<VirtualHost *:80>
    ServerName pongping.<votredomaine>.<tld>
</VirtualHost>
```

```bash
sudo systemctl restart apache2
sudo certbot certonly --apache -d pongping.<votredomaine>.<tld>
```

Puis ajouter le bloc `<VirtualHost *:443>` de `deploy/apache-pongping.conf` et redémarrer Apache :

```bash
sudo apachectl configtest
sudo systemctl restart apache2
```

## 6. Mise à jour

```bash
cd /var/www/pongping/pong-ping
git pull origin main
bun install
sudo systemctl restart pongping
```
