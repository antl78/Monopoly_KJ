# Monopoly Custom — Serveur multijoueur

## Lancer en local

```bash
npm install
npm start
# → http://localhost:3000
```

## Déployer gratuitement sur Render.com

1. Créez un compte sur render.com
2. "New > Web Service" > connectez votre repo GitHub
3. Build command : npm install  |  Start command : npm start
4. Render vous donne une URL : https://monopoly-custom-xxxx.onrender.com
5. Dans le client, utilisez : wss://monopoly-custom-xxxx.onrender.com

Note : les instances gratuites s'endorment après 15 min d'inactivité.

## Structure

  monopoly-server/
  ├── server.js          ← Serveur WebSocket (Node.js)
  ├── package.json
  ├── README.md
  └── public/
      └── index.html     ← Client multijoueur

## Flux réseau

  1. Hôte crée un salon → reçoit un code (ex: AB3KZ)
  2. Amis rejoignent avec le code
  3. Hôte peut charger plateau.json + cartes.json custom
  4. Hôte lance la partie
  5. Serveur est l'autorité unique — chaque action est validée
     puis l'état est broadcasté à tous les joueurs

## Variable d'environnement

  PORT (défaut: 3000)
