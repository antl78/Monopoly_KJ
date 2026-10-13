# Monopoly KJ — Serveur multijoueur

Le serveur fait deux choses :

1. **Il sert le jeu.** Les joueurs ouvrent simplement l'adresse du serveur dans leur navigateur : `monopoly-game.html`, `engine.js`, `images/`, `plateau.json` et `cartes.json` sont servis depuis la racine du repo. Les éditeurs ne sont **pas** servis.
2. **Il gère les salons en ligne** (WebSocket). Le protocole est décrit dans `protocol.md`.

Il n'y a aucune règle de jeu ici : tout passe par `../engine.js`, le même moteur que la partie locale.

## Fichiers

```
engine.js              ← moteur de règles partagé (racine du repo)
monopoly-game.html     ← LE jeu (local + en ligne)
monopoly-server/
├── server.js          ← HTTP + WebSocket, messages, anti-flood
├── room.js            ← un salon : places, présence, minuteurs, sauvegardes
├── snapshot.js        ← sauvegarde chiffrée et signée (AES-256-GCM)
├── protocol.md        ← description des messages
└── package.json       ← une seule dépendance : ws
tests/                 ← tests du moteur et du serveur (node --test)
```

## Lancer en local

Depuis la racine du repo :

```bash
npm install --prefix monopoly-server
node monopoly-server/server.js
# → http://localhost:3000
```

Pour tester à plusieurs sur un seul PC, ouvrez un onglet par joueur : chaque onglet a sa propre place, et rafraîchir un onglet ramène dans la partie.

## Tests

```bash
node --test "tests/*.test.js"            # moteur + parties simulées + serveur
FUZZ_GAMES=1500 node --test "tests/*.test.js"   # passe longue (≈ 8 min)
```

## Déploiement sur Render — ⚠️ réglages à changer une fois

Le serveur doit maintenant voir **tout le repo** (le jeu et `engine.js` sont à la racine). Dans les réglages du service Render (*Settings*) :

| Réglage | Nouvelle valeur |
|---|---|
| **Root Directory** | *(vide)* |
| **Build Command** | `npm install --prefix monopoly-server` |
| **Start Command** | `node monopoly-server/server.js` |
| **Health Check Path** | `/health` *(facultatif)* |

Dans **Environment**, ajoutez la variable **`SNAPSHOT_SECRET`** avec une longue phrase aléatoire (au moins 16 caractères).

- C'est la clé qui chiffre et signe les sauvegardes. **Ne la changez plus ensuite** : les sauvegardes faites avec l'ancienne clé deviendraient illisibles.
- Sans elle, le serveur fonctionne quand même, mais une partie ne survit pas à un redémarrage de Render.

Autre option : le fichier `render.yaml` à la racine décrit ces réglages. *New → Blueprint* crée un nouveau service déjà configuré, avec un `SNAPSHOT_SECRET` généré automatiquement. Attention, le nouveau service aura une adresse différente.

### Bon à savoir sur l'offre gratuite de Render

- **Mise en veille.** Le service s'endort après 15 min sans trafic. Le premier accès peut alors prendre environ 1 minute.
- **Pendant une partie**, les navigateurs envoient un petit message toutes les 25 s, ce qui garde le serveur éveillé.
- **Redémarrages.** Render peut redémarrer le service à tout moment et efface alors sa mémoire. Pas de panique : chaque joueur garde la dernière sauvegarde de la partie. Au retour, son navigateur la renvoie automatiquement et la partie reprend là où elle en était.

## Variables d'environnement

| Variable | Rôle |
|---|---|
| `PORT` | Port d'écoute (fourni par Render). |
| `SNAPSHOT_SECRET` | Clé des sauvegardes. **Obligatoire en ligne.** |
| `GAME_ROOT` | Dossier du jeu. Par défaut : le dossier parent de `monopoly-server/`. |
