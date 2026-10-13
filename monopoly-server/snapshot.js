// ════════════════════════════════════════════════════════════════════════════
// snapshot.js — Sauvegarde « instantané chiffré et signé »
// ────────────────────────────────────────────────────────────────────────────
// Render peut redémarrer le serveur à tout moment et efface alors son disque :
// la sauvegarde ne peut donc pas vivre sur le serveur. À la place, le serveur
// envoie régulièrement à chaque joueur une copie de la partie, que son
// navigateur garde. Si le serveur a perdu le salon, le premier joueur qui
// revient la renvoie et la partie repart.
//
// La copie est CHIFFRÉE ET SIGNÉE (AES-256-GCM) avec une clé secrète rangée
// dans la variable d'environnement SNAPSHOT_SECRET (réglages Render) :
//   • chiffrée : personne ne peut y lire l'ordre des paquets ni la graine des dés ;
//   • signée  : la moindre modification (argent, biens...) la rend invalide.
// La copie est compressée (zlib) avant chiffrement pour rester légère.
// Le plateau et les cartes n'y sont PAS (trop lourds avec les images) : on y
// garde seulement leur empreinte, et le joueur les renvoie avec la copie.
// ════════════════════════════════════════════════════════════════════════════
const crypto = require('crypto');
const zlib = require('zlib');

let KEY;
let ephemeral = false;
if (process.env.SNAPSHOT_SECRET && process.env.SNAPSHOT_SECRET.length >= 16) {
  KEY = crypto.createHash('sha256').update(process.env.SNAPSHOT_SECRET).digest();
} else {
  KEY = crypto.randomBytes(32);
  ephemeral = true;
}

function hashJson(obj) { return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('base64url'); }
function hashToken(token) { return crypto.createHash('sha256').update(String(token)).digest('base64url'); }
function newToken() { return crypto.randomBytes(24).toString('base64url'); }

function seal(payload) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);
  const data = Buffer.concat([cipher.update(zlib.deflateRawSync(Buffer.from(JSON.stringify(payload)))), cipher.final()]);
  return ['mkj1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
}

// Renvoie le contenu, ou null si la copie est illisible, falsifiée ou faite
// avec une autre clé.
function open(blob) {
  try {
    const [tag0, iv, tag, data] = String(blob).split('.');
    if (tag0 !== 'mkj1') return null;
    const d = crypto.createDecipheriv('aes-256-gcm', KEY, Buffer.from(iv, 'base64url'));
    d.setAuthTag(Buffer.from(tag, 'base64url'));
    const raw = Buffer.concat([d.update(Buffer.from(data, 'base64url')), d.final()]);
    return JSON.parse(zlib.inflateRawSync(raw).toString());
  } catch (e) {
    return null;
  }
}

module.exports = { seal, open, hashJson, hashToken, newToken, isEphemeral: () => ephemeral };
