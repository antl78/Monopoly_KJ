# Protocole réseau — Monopoly KJ

Échanges en **WebSocket**, un message = un objet JSON avec un champ `type`.
Le serveur ne contient aucune règle : il transmet les actions au moteur partagé `engine.js` et diffuse le résultat.

## Principes

- **Place et jeton.** Chaque joueur reçoit un **jeton secret** (`token`) quand il crée ou rejoint un salon.
  - Le navigateur le garde en mémoire.
  - Le serveur n'en stocke qu'une empreinte (SHA-256).
  - Ce jeton permet de reprendre sa place après une coupure ou un rafraîchissement.
- **Le serveur fait autorité.** Le client n'envoie que des *intentions* (`act`). Le serveur les valide avec le moteur, puis envoie à tout le monde le nouvel état **et** les événements à animer.
- **Numéro de version** (`v`) : il est égal à `state.seq` et augmente de 1 à chaque coup.
  - Un client qui reçoit un `v` déjà connu l'ignore.
  - Un client qui a raté des messages reçoit de toute façon l'état complet au message suivant.
- **Vue filtrée.** Certaines données ne partent **jamais** vers les joueurs :
  - `state.secret` (graine des dés, ordre des paquets) ;
  - le plateau, les cartes et les images des pions, envoyés **une seule fois** dans `game`. Dans l'état de jeu, un pion en image devient `img:N`.

## Client → serveur

| type | champs | rôle |
|---|---|---|
| `ping` | `t` | Toutes les 25 s. Garde Render éveillé et vérifie la connexion. Réponse : `pong`. |
| `create_room` | `name`, `pawn` | Crée un salon (code à 5 caractères). Le créateur devient l'hôte. |
| `join_room` | `code`, `name`, `pawn`, `claim?` | Rejoint un salon d'attente. Pendant une partie, reprend une place **libérée par l'hôte** (`claim` = n° de place). |
| `resume` | `code`, `token` | Reprend sa place (salon d'attente ou partie). |
| `restore` | `snapshot`, `board`, `cards`, `pawns` | Recrée un salon perdu (redémarrage du serveur) à partir d'une sauvegarde. |
| `leave` | — | Quitte le salon (libère la place seulement dans le salon d'attente). |
| `lobby_me` | `name?`, `pawn?` | Change son nom ou son pion dans le salon d'attente. |
| `lobby_config` | `config` : `startMoney`, `auctions`, `evenBuild`, `buildingLimit`, `timerSec` | Hôte uniquement. |
| `lobby_data` | `board?`, `cards?` (`null` = fichiers officiels) | Hôte uniquement : plateau / cartes personnalisés. |
| `kick_lobby` | `seat` | Hôte uniquement, dans le salon d'attente. |
| `start` | — | Hôte uniquement. Il faut au moins 2 joueurs. |
| `act` | `action` : `{type, pos?, amount?, to?, give?, get?}` | Une action de jeu (voir la liste ci-dessous). |
| `presence` | `away` (booléen) | « Je m'absente » / « Je suis là ». |
| `host` | `cmd`, `seat?`, `value?` | Hôte : `pause`, `resume`, `wait`, `auto`, `unauto`, `remove`, `free_seat`, `timer`, `end_by_worth`. |
| `chat` | `text` (300 caractères max) | Message de chat. |
| `sync` | — | Redemande l'état complet. |

### Actions de jeu (`act.action.type`)

- **Dés et prison** : `roll`, `pay_jail`, `use_get_out`, `end_turn`
- **Achat** : `buy`, `decline` (lance une enchère si l'option est activée)
- **Enchères** : `bid` {`amount`}, `pass`
- **Carte à choix** : `choose_pay`, `choose_draw`
- **Alertes et hypothèques** : `build`, `upgrade`, `sell_house`, `sell_hotel`, `mortgage`, `unmortgage` — toutes avec {`pos`}
- **Échanges** : `trade_propose` {`to`, `give`, `get`}, `trade_accept`, `trade_reject`, `trade_cancel`
  - `give` et `get` ont la forme `{money, props:[pos], getOut}`.
- **Faillite** : `bankrupt` (faillite quand on ne peut pas payer), `resign` (abandon)

## Serveur → client

| type | contenu |
|---|---|
| `hello` | `protocol` |
| `joined` | `code`, `seat`, `token`, `host`, `phase` |
| `lobby` | salon d'attente : `seats`, `hostSeat`, `config`, `timerSec`, `customBoard`, `customCards` |
| `game` | état complet : `board`, `cards`, `pawns`, `state`, `meta`, `chat` |
| `update` | après chaque coup : `v`, `events`, `state`, `meta`, `by` (qui a joué), `auto` (coup joué automatiquement) |
| `meta` | présence et minuteurs seuls (voir ci-dessous) |
| `snapshot` | sauvegarde chiffrée : `code`, `v`, `blob`, `ended` |
| `chat` | `msg` : `{seat, name, pawn, text, ts}` (`seat: null` = message du système) |
| `error` | `message`, `code?` (`unknown_room`, `bad_snapshot`), `refused?` |
| `resume_failed` | `reason` : `unknown_room` (le client tente alors `restore`) ou `unknown_seat` |
| `restored` | le salon a été recréé : le client envoie alors `resume` |
| `claim_list` | places qu'on peut reprendre dans une partie en cours |
| `kicked`, `replaced` | retiré par l'hôte / partie ouverte dans un autre onglet |

`meta` contient :

- `hostSeat`, `paused`, `timerSec`, `awaiting` ;
- `timerLeft` et `auctionLeft`, en millisecondes restantes ;
- `seats[]` : `{connected, away, auto, removed, claimable, needsDecision, waitForever, graceLeft}`.

### Événements (`update.events`)

| t | champs | animation |
|---|---|---|
| `dice` | `player`, `d` | grands dés au centre |
| `move` | `player`, `from`, `path`, `kind` | `walk` : marche case par case ; `teleport` : saut direct |
| `card` | `player`, `deck`, `card` | la carte s'affiche chez tout le monde |
| `log` | `msg`, `kind` | ligne d'historique |
| `turn` | `player` | nouveau tour (son « à vous » pour le joueur concerné) |
| `auction` | `pos` | début d'enchère |
| `trade` | `from`, `to` | nouvelle proposition d'échange |
| `bankrupt` | `player` | faillite |
| `end` | `winner` | fin de partie |

## Présence et minuteurs (côté serveur, `room.js`)

- **Déconnexion.** La partie attend le joueur **2 minutes**. Ensuite, l'hôte choisit : *Attendre*, *Jouer pour lui* ou *Retirer*. Si l'hôte lui-même est parti depuis plus de 2 minutes, le rôle passe au joueur connecté suivant.
- **Minuteur de décision** (réglable, `0` = illimité). À la fin du temps, le serveur joue l'action prudente du moteur (`MonoEngine.autoAction`). Après **2 expirations d'affilée**, le joueur passe en mode *absent*.
- **Mode absent ou auto.** Le serveur joue prudemment à sa place, un coup toutes les 1,2 s :
  - il lance les dés, refuse l'achat, passe aux enchères, refuse les échanges et finit le tour ;
  - s'il a une dette : il revend des alertes, puis hypothèque, et ne fait faillite qu'en dernier recours.
- **Enchère.** Elle est adjugée **15 s** après la dernière offre (`auction_timeout`).
- **Pause.** Tout est gelé, minuteurs compris.

## Sauvegarde (`snapshot.js`)

- **Contenu.** État complet (y compris `secret`), empreintes du plateau, des cartes et des pions, et places (empreintes des jetons).
- **Format.** Compressée (zlib), puis chiffrée **et** signée en AES-256-GCM avec la clé `SNAPSHOT_SECRET`.
- **Fréquence.** Elle est envoyée à chaque changement de tour, puis au plus tard 1 s après chaque coup.
- **Stockage côté client.** Le navigateur la garde dans `localStorage`. Le Menu permet de la télécharger en fichier.
- **Restauration.** Pour `restore`, le client renvoie le plateau, les cartes et les pions : le serveur vérifie qu'ils correspondent aux empreintes.
- **Deux restaurations simultanées.** C'est la plus récente qui gagne, tant que personne n'a rejoué.
