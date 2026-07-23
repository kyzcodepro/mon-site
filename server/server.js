/* =====================================================================
   Kyz Account — API serveur (Express + MySQL)
   - Sert le site (index.html à la racine du dépôt)
   - Expose /api/* pour l'authentification et les opérations
   Lancement :  cd server && npm install && cp .env.example .env
                (renseigner .env) && npm start
   ===================================================================== */
'use strict';

const path = require('path');
const crypto = require('crypto');
const express = require('express');
const mysql = require('mysql2/promise');
require('dotenv').config({ path: path.join(__dirname, '.env') });

const PORT = Number(process.env.PORT || 3000);

const DB_HOST = process.env.DB_HOST || 'localhost';
/* TLS : requis par TiDB Cloud / PlanetScale / Aiven… Activé automatiquement
   pour ces hôtes, ou via DB_SSL=true dans .env (DB_SSL=false pour forcer sans). */
const wantSSL = process.env.DB_SSL
  ? /^(1|true|yes)$/i.test(process.env.DB_SSL)
  : /tidbcloud\.com|psdb\.cloud|aivencloud\.com|rds\.amazonaws\.com/i.test(DB_HOST);

const pool = mysql.createPool({
  host: DB_HOST,
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASS || '',
  database: process.env.DB_NAME || 'kyz_account',
  waitForConnections: true,
  connectionLimit: 10,
  dateStrings: false,
  ssl: wantSSL ? { minVersion: 'TLSv1.2', rejectUnauthorized: true } : undefined,
});

/* ---------- utilitaires ---------- */
const sha256 = s => crypto.createHash('sha256').update(s, 'utf8').digest('hex');
const hashPass = (pass, sel) => sha256(sel + '::' + pass);
const newToken = () => crypto.randomBytes(32).toString('hex');
const newSel = () => crypto.randomBytes(12).toString('hex');
const round2 = n => Math.round(n * 100) / 100;
const tsOf = d => (d instanceof Date ? d.getTime() : new Date(d).getTime());

const compteRow = r => ({
  id: r.id, prenom: r.prenom, nom: r.nom, numero: r.numero, role: r.role,
  solde: parseFloat(r.solde), statut: r.statut === 'bloque' ? 'bloqué' : 'actif',
  createdAt: tsOf(r.cree_le),
});
const opRow = r => ({
  id: r.id, userId: r.compte_id, ts: tsOf(r.cree_le), type: r.type, label: r.libelle,
  montant: parseFloat(r.montant), soldeApres: parseFloat(r.solde_apres), meta: r.meta,
  prenom: r.prenom, nom: r.nom,
});

/* ---------- épargne : intérêts automatiques ---------- */
const TAUX_ANNUEL = 0.20; // 20 % par an, capitalisation continue

/* Ajoute les intérêts courus d'un compte (appelé à chaque lecture d'état).
   Les intérêts sont matérialisés en opération 'interet' dès qu'ils
   atteignent 1 centime. */
async function accrueInterest(compteId) {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query("SELECT * FROM comptes WHERE id=? AND role='client' FOR UPDATE", [compteId]);
    const c = rows[0];
    if (!c || c.statut === 'bloque') { await conn.rollback(); return; }
    const solde = parseFloat(c.solde);
    if (solde <= 0) { await conn.rollback(); return; }
    const base = c.interet_accru_le || c.cree_le;
    const dtJours = (Date.now() - new Date(base).getTime()) / 86400000;
    if (dtJours <= 0) { await conn.rollback(); return; }
    const interets = round2(solde * (Math.pow(1 + TAUX_ANNUEL, dtJours / 365) - 1));
    if (interets < 0.01) { await conn.rollback(); return; }
    const ns = round2(solde + interets);
    await conn.query('UPDATE comptes SET solde=?, interet_accru_le=NOW() WHERE id=?', [ns, c.id]);
    // anti-spam : si la dernière opération du compte est déjà une ligne
    // d'intérêts, on l'actualise au lieu d'en créer une nouvelle
    const [last] = await conn.query(
      'SELECT id, type, montant FROM operations WHERE compte_id=? ORDER BY cree_le DESC, id DESC LIMIT 1 FOR UPDATE', [c.id]);
    if (last.length && last[0].type === 'interet') {
      await conn.query(
        'UPDATE operations SET montant=?, solde_apres=?, cree_le=NOW() WHERE id=?',
        [round2(parseFloat(last[0].montant) + interets), ns, last[0].id]);
    } else {
      await conn.query(
        "INSERT INTO operations (compte_id,type,libelle,montant,solde_apres) VALUES (?,'interet','Intérêts d\\'épargne (20 %/an)',?,?)",
        [c.id, interets, ns]);
    }
    await conn.commit();
  } catch (e) { await conn.rollback().catch(() => {}); console.error('[interets]', e.message); }
  finally { conn.release(); }
}

/* Recalcule la chaîne des soldes d'un compte (après antidatage). conn = transaction */
async function recalcLedger(conn, compteId) {
  const [ops] = await conn.query(
    'SELECT id, montant FROM operations WHERE compte_id=? ORDER BY cree_le, id', [compteId]);
  let bal = 0;
  for (const op of ops) {
    bal = round2(bal + parseFloat(op.montant));
    await conn.query('UPDATE operations SET solde_apres=? WHERE id=?', [bal, op.id]);
  }
  await conn.query('UPDATE comptes SET solde=? WHERE id=?', [bal, compteId]);
  return bal;
}

/* ---------- app ---------- */
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, '..'), { index: 'index.html' }));

const fail = (res, code, msg) => res.status(code).json({ error: msg });

/* auth middleware */
async function auth(req, res, next) {
  try {
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return fail(res, 401, 'Non connecté');
    const [rows] = await pool.query(
      `SELECT c.* FROM sessions s JOIN comptes c ON c.id = s.compte_id
       WHERE s.token = ? AND s.expire_le > NOW()`, [token]);
    if (!rows.length) return fail(res, 401, 'Session expirée');
    req.user = rows[0];
    req.token = token;
    next();
  } catch (e) { next(e); }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : fail(res, 403, 'Réservé à l\'administrateur');

/* identification du serveur (diagnostic : qui répond sur /api ?) */
app.get('/api/version', (req, res) => res.json({ api: 'kyz-account', version: require('./package.json').version }));

/* ---------- authentification ---------- */
app.post('/api/login', async (req, res, next) => {
  try {
    const numero = String(req.body.numero || '').replace(/\D/g, '');
    const pass = String(req.body.pass || '');
    const [rows] = await pool.query('SELECT * FROM comptes WHERE numero=?', [numero]);
    const u = rows[0];
    if (!u || hashPass(pass, u.sel) !== u.pass_hash)
      return fail(res, 401, 'Numéro de compte ou mot de passe incorrect');
    const token = newToken();
    await pool.query(
      'INSERT INTO sessions (token, compte_id, expire_le) VALUES (?,?,DATE_ADD(NOW(), INTERVAL 24 HOUR))',
      [token, u.id]);
    pool.query('DELETE FROM sessions WHERE expire_le < NOW()').catch(() => {});
    res.json({ token, me: compteRow(u) });
  } catch (e) { next(e); }
});

app.post('/api/logout', auth, async (req, res, next) => {
  try {
    await pool.query('DELETE FROM sessions WHERE token=?', [req.token]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- état complet (selon le rôle) ---------- */
app.get('/api/state', auth, async (req, res, next) => {
  try {
    const mapStatut = s => s === 'en_attente' ? 'en_attente' : (s === 'acceptee' ? 'acceptée' : 'refusée');
    if (req.user.role === 'admin') {
      const [ids] = await pool.query("SELECT id FROM comptes WHERE role='client'");
      for (const r of ids) await accrueInterest(r.id);
    } else {
      await accrueInterest(req.user.id);
      const [me2] = await pool.query('SELECT * FROM comptes WHERE id=?', [req.user.id]);
      if (me2.length) req.user = Object.assign(me2[0], { sel: req.user.sel, pass_hash: req.user.pass_hash });
    }
    const me = compteRow(req.user);
    if (req.user.role === 'admin') {
      const [cl] = await pool.query("SELECT * FROM comptes WHERE role='client' ORDER BY cree_le DESC");
      const [ops] = await pool.query(
        `SELECT o.*, c.prenom, c.nom FROM operations o JOIN comptes c ON c.id=o.compte_id
         ORDER BY o.cree_le DESC, o.id DESC LIMIT 500`);
      const [reqs] = await pool.query(
        `SELECT d.*, f.prenom AS from_prenom, f.nom AS from_nom, f.solde AS from_solde
         FROM demandes_virement d JOIN comptes f ON f.id = d.demandeur_id
         ORDER BY d.cree_le DESC LIMIT 100`);
      return res.json({
        me, clients: cl.map(compteRow), ledger: ops.map(opRow),
        requests: reqs.map(r => ({
          id: r.id, fromId: r.demandeur_id,
          fromName: r.from_prenom + ' ' + r.from_nom, fromSolde: parseFloat(r.from_solde),
          rib: r.rib, montant: parseFloat(r.montant), note: r.motif,
          statut: mapStatut(r.statut), ts: tsOf(r.cree_le),
        })),
      });
    }
    const [ops] = await pool.query(
      'SELECT o.*, NULL AS prenom, NULL AS nom FROM operations o WHERE compte_id=? ORDER BY cree_le DESC, id DESC', [req.user.id]);
    const [reqs] = await pool.query(
      'SELECT * FROM demandes_virement WHERE demandeur_id=? ORDER BY cree_le DESC LIMIT 100', [req.user.id]);
    res.json({
      me,
      ledger: ops.map(opRow),
      requests: reqs.map(r => ({
        id: r.id, fromId: r.demandeur_id, rib: r.rib,
        montant: parseFloat(r.montant), note: r.motif,
        statut: mapStatut(r.statut), ts: tsOf(r.cree_le),
      })),
    });
  } catch (e) { next(e); }
});

/* ---------- profil ---------- */
app.put('/api/profil', auth, async (req, res, next) => {
  try {
    const prenom = String(req.body.prenom || '').trim(), nom = String(req.body.nom || '').trim();
    if (!prenom || !nom) return fail(res, 400, 'Prénom et nom obligatoires');
    await pool.query('UPDATE comptes SET prenom=?, nom=? WHERE id=?', [prenom, nom, req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.put('/api/password', auth, async (req, res, next) => {
  try {
    const { oldPass, newPass } = req.body || {};
    if (hashPass(String(oldPass || ''), req.user.sel) !== req.user.pass_hash)
      return fail(res, 400, 'Mot de passe actuel incorrect');
    if (String(newPass || '').length < 8 || !/\d/.test(newPass))
      return fail(res, 400, 'Nouveau mot de passe trop faible (8 caractères min. et 1 chiffre)');
    const sel = newSel();
    await pool.query('UPDATE comptes SET sel=?, pass_hash=? WHERE id=?', [sel, hashPass(newPass, sel), req.user.id]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- demandes de virement ----------
   Le client saisit un RIB libre (AUCUNE vérification) : la demande part
   chez l'administrateur avec le statut 'en_attente'. À la validation,
   le compte du client est débité. */
app.post('/api/demandes', auth, async (req, res, next) => {
  try {
    if (req.user.role !== 'client') return fail(res, 403, 'Réservé aux clients');
    if (req.user.statut === 'bloque') return fail(res, 403, 'Compte suspendu');
    const rib = String(req.body.rib || '').trim().slice(0, 40);
    if (rib.length < 5) return fail(res, 400, 'RIB manquant');
    const montant = round2(parseFloat(req.body.montant));
    if (!(montant > 0)) return fail(res, 400, 'Montant invalide');
    await pool.query(
      'INSERT INTO demandes_virement (demandeur_id, rib, montant, motif) VALUES (?,?,?,?)',
      [req.user.id, rib, montant, String(req.body.motif || '').trim() || null]);
    res.json({ ok: true });
  } catch (e) { next(e); }
});

app.post('/api/demandes/:id/accept', auth, adminOnly, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [dr] = await conn.query(
      "SELECT * FROM demandes_virement WHERE id=? AND statut='en_attente' FOR UPDATE", [req.params.id]);
    const d = dr[0];
    if (!d) { await conn.rollback(); return fail(res, 404, 'Demande introuvable ou déjà traitée'); }
    const [cr] = await conn.query('SELECT * FROM comptes WHERE id=? FOR UPDATE', [d.demandeur_id]);
    const client = cr[0];
    const montant = parseFloat(d.montant);
    if (!client) { await conn.rollback(); return fail(res, 404, 'Compte introuvable'); }
    if (parseFloat(client.solde) < montant) { await conn.rollback(); return fail(res, 400, 'Solde du client insuffisant'); }
    const ns = round2(parseFloat(client.solde) - montant);
    await conn.query('UPDATE comptes SET solde=? WHERE id=?', [ns, client.id]);
    await conn.query(
      'INSERT INTO operations (compte_id,type,libelle,montant,solde_apres,meta) VALUES (?,?,?,?,?,?)',
      [client.id, 'virement_out', 'Virement vers ' + d.rib, -montant, ns, d.motif]);
    await conn.query("UPDATE demandes_virement SET statut='acceptee', traite_le=NOW() WHERE id=?", [d.id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback().catch(() => {}); next(e); }
  finally { conn.release(); }
});

app.post('/api/demandes/:id/refuse', auth, adminOnly, async (req, res, next) => {
  try {
    const [r] = await pool.query(
      "UPDATE demandes_virement SET statut='refusee', traite_le=NOW() WHERE id=? AND statut='en_attente'",
      [req.params.id]);
    if (!r.affectedRows) return fail(res, 404, 'Demande introuvable ou déjà traitée');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* Suppression d'une demande (nettoyage de l'historique). Une demande encore
   en attente doit d'abord être validée ou refusée. */
app.delete('/api/demandes/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const [r] = await pool.query(
      "DELETE FROM demandes_virement WHERE id=? AND statut<>'en_attente'", [req.params.id]);
    if (!r.affectedRows) return fail(res, 404, 'Demande introuvable ou encore en attente (traite-la d\'abord)');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* ---------- administration ---------- */
app.post('/api/clients', auth, adminOnly, async (req, res, next) => {
  try {
    const prenom = String(req.body.prenom || '').trim(), nom = String(req.body.nom || '').trim();
    const pass = String(req.body.pass || '');
    const solde = round2(parseFloat(req.body.solde) || 0);
    if (!prenom || !nom) return fail(res, 400, 'Prénom et nom obligatoires');
    if (pass.length < 8) return fail(res, 400, 'Mot de passe trop court (8 caractères minimum)');
    let numero, tries = 0;
    do {
      numero = String(Math.floor(Math.random() * 9) + 1);
      for (let i = 0; i < 9; i++) numero += Math.floor(Math.random() * 10);
      const [dup] = await pool.query('SELECT id FROM comptes WHERE numero=?', [numero]);
      if (!dup.length) break;
    } while (++tries < 20);
    const sel = newSel();
    const [ins] = await pool.query(
      "INSERT INTO comptes (numero,prenom,nom,role,pass_hash,sel,solde,statut) VALUES (?,?,?,'client',?,?,0,'actif')",
      [numero, prenom, nom, hashPass(pass, sel), sel]);
    if (solde > 0) {
      await pool.query(
        "INSERT INTO operations (compte_id,type,libelle,montant,solde_apres) VALUES (?,?,?,?,?)",
        [ins.insertId, 'depot', "Dépôt d'ouverture", solde, solde]);
      await pool.query('UPDATE comptes SET solde=? WHERE id=?', [solde, ins.insertId]);
    }
    res.json({ ok: true, numero });
  } catch (e) { next(e); }
});

app.post('/api/clients/:id/mouvement', auth, adminOnly, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    const kind = req.body.kind === 'debit' ? 'debit' : 'credit';
    const montant = round2(parseFloat(req.body.montant));
    if (!(montant > 0)) { return fail(res, 400, 'Montant invalide'); }
    let dateOp = null;
    if (req.body.date) {
      const today = new Date().toISOString().slice(0, 10);
      if (req.body.date !== today) {
        const d = new Date(req.body.date + 'T12:00:00');
        if (isNaN(d.getTime())) return fail(res, 400, 'Date invalide');
        if (req.body.date > today) return fail(res, 400, 'Date future refusée');
        dateOp = d;
      }
    }
    await conn.beginTransaction();
    const [cr] = await conn.query("SELECT * FROM comptes WHERE id=? AND role='client' FOR UPDATE", [req.params.id]);
    const c = cr[0];
    if (!c) { await conn.rollback(); return fail(res, 404, 'Client introuvable'); }
    if (kind === 'debit' && parseFloat(c.solde) < montant) { await conn.rollback(); return fail(res, 400, 'Solde insuffisant'); }
    const signed = kind === 'credit' ? montant : -montant;
    const libelle = String(req.body.motif || '').trim() || (kind === 'credit' ? 'Dépôt sur le compte' : 'Retrait du compte');
    if (dateOp) {
      await conn.query(
        'INSERT INTO operations (compte_id,type,libelle,montant,solde_apres,cree_le) VALUES (?,?,?,?,0,?)',
        [c.id, kind === 'credit' ? 'admin_credit' : 'admin_debit', libelle, signed, dateOp]);
      await recalcLedger(conn, c.id);
    } else {
      const ns = round2(parseFloat(c.solde) + signed);
      await conn.query(
        'INSERT INTO operations (compte_id,type,libelle,montant,solde_apres) VALUES (?,?,?,?,?)',
        [c.id, kind === 'credit' ? 'admin_credit' : 'admin_debit', libelle, signed, ns]);
      await conn.query('UPDATE comptes SET solde=? WHERE id=?', [ns, c.id]);
    }
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback().catch(() => {}); next(e); }
  finally { conn.release(); }
});

/* ---------- modification / suppression de dépôts & retraits ----------
   Uniquement les opérations saisies par l'admin (dépôts/retraits) —
   les virements restent intouchables. Les soldes sont recalculés. */
const OP_EDITABLE = ['depot', 'retrait', 'admin_credit', 'admin_debit'];
const OP_CREDIT = ['depot', 'admin_credit'];

app.put('/api/operations/:id', auth, adminOnly, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM operations WHERE id=? FOR UPDATE', [req.params.id]);
    const op = rows[0];
    if (!op) { await conn.rollback(); return fail(res, 404, 'Opération introuvable'); }
    if (!OP_EDITABLE.includes(op.type)) { await conn.rollback(); return fail(res, 400, 'Seuls les dépôts et retraits sont modifiables'); }

    let montant = op.montant;
    if (req.body.montant !== undefined) {
      const m = round2(parseFloat(req.body.montant));
      if (!(m > 0)) { await conn.rollback(); return fail(res, 400, 'Montant invalide'); }
      montant = OP_CREDIT.includes(op.type) ? m : -m;
    }
    let libelle = op.libelle;
    if (req.body.motif !== undefined && String(req.body.motif).trim()) libelle = String(req.body.motif).trim().slice(0, 160);

    let creeLe = op.cree_le;
    if (req.body.date) {
      const today = new Date().toISOString().slice(0, 10);
      if (req.body.date > today) { await conn.rollback(); return fail(res, 400, 'Date future refusée'); }
      const cur = new Date(op.cree_le).toISOString().slice(0, 10);
      if (req.body.date !== cur) {
        const d = new Date(req.body.date + 'T12:00:00');
        if (isNaN(d.getTime())) { await conn.rollback(); return fail(res, 400, 'Date invalide'); }
        creeLe = d;
      }
    }
    await conn.query('UPDATE operations SET montant=?, libelle=?, cree_le=? WHERE id=?', [montant, libelle, creeLe, op.id]);
    const bal = await recalcLedger(conn, op.compte_id);
    if (bal < 0) { await conn.rollback(); return fail(res, 400, 'Impossible : le solde du client deviendrait négatif (' + bal.toFixed(2) + ' €)'); }
    await conn.commit();
    res.json({ ok: true, solde: bal });
  } catch (e) { await conn.rollback().catch(() => {}); next(e); }
  finally { conn.release(); }
});

app.delete('/api/operations/:id', auth, adminOnly, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [rows] = await conn.query('SELECT * FROM operations WHERE id=? FOR UPDATE', [req.params.id]);
    const op = rows[0];
    if (!op) { await conn.rollback(); return fail(res, 404, 'Opération introuvable'); }
    if (!OP_EDITABLE.includes(op.type)) { await conn.rollback(); return fail(res, 400, 'Seuls les dépôts et retraits sont supprimables'); }
    await conn.query('DELETE FROM operations WHERE id=?', [op.id]);
    const bal = await recalcLedger(conn, op.compte_id);
    if (bal < 0) { await conn.rollback(); return fail(res, 400, 'Impossible : le solde du client deviendrait négatif (' + bal.toFixed(2) + ' €)'); }
    await conn.commit();
    res.json({ ok: true, solde: bal });
  } catch (e) { await conn.rollback().catch(() => {}); next(e); }
  finally { conn.release(); }
});

app.post('/api/clients/:id/lock', auth, adminOnly, async (req, res, next) => {
  try {
    const [r] = await pool.query(
      "UPDATE comptes SET statut = IF(statut='actif','bloque','actif') WHERE id=? AND role='client'", [req.params.id]);
    if (!r.affectedRows) return fail(res, 404, 'Client introuvable');
    const [rows] = await pool.query('SELECT statut FROM comptes WHERE id=?', [req.params.id]);
    res.json({ ok: true, statut: rows[0].statut === 'bloque' ? 'bloqué' : 'actif' });
  } catch (e) { next(e); }
});

app.delete('/api/clients/:id', auth, adminOnly, async (req, res, next) => {
  try {
    const [r] = await pool.query("DELETE FROM comptes WHERE id=? AND role='client'", [req.params.id]);
    if (!r.affectedRows) return fail(res, 404, 'Client introuvable');
    res.json({ ok: true });
  } catch (e) { next(e); }
});

/* fiche client (admin) : historique d'un client */
app.get('/api/clients/:id/operations', auth, adminOnly, async (req, res, next) => {
  try {
    const [ops] = await pool.query(
      'SELECT o.*, NULL AS prenom, NULL AS nom FROM operations o WHERE compte_id=? ORDER BY cree_le DESC, id DESC LIMIT 100',
      [req.params.id]);
    res.json({ ledger: ops.map(opRow) });
  } catch (e) { next(e); }
});

/* ---------- erreurs ---------- */
app.use((err, req, res, next) => {
  console.error('[api]', err.message);
  fail(res, 500, 'Erreur serveur : ' + err.message);
});

/* ---------- migrations automatiques au démarrage ---------- */
async function ensureSchema() {
  const tryQ = async (sql) => { try { await pool.query(sql); return true; } catch (e) { return false; } };
  try {
    const [cols] = await pool.query("SHOW COLUMNS FROM demandes_virement LIKE 'rib'");
    if (!cols.length) {
      console.log('[migration] demandes_virement : passage au RIB libre…');
      await tryQ('ALTER TABLE demandes_virement DROP FOREIGN KEY fk_dem_payeur');
      await tryQ('ALTER TABLE demandes_virement DROP INDEX idx_payeur_statut');
      await tryQ('ALTER TABLE demandes_virement DROP COLUMN payeur_id');
      await pool.query("ALTER TABLE demandes_virement ADD COLUMN rib VARCHAR(40) NOT NULL DEFAULT '' AFTER demandeur_id");
      await tryQ('ALTER TABLE demandes_virement ADD INDEX idx_statut (statut)');
      console.log('[migration] demandes_virement : OK');
    }
    await tryQ("UPDATE operations SET meta = NULL WHERE meta LIKE 'par %'");
    // épargne : date de dernier calcul d'intérêts + type d'opération 'interet'
    const [c2] = await pool.query("SHOW COLUMNS FROM comptes LIKE 'interet_accru_le'");
    if (!c2.length) {
      console.log('[migration] comptes : ajout interet_accru_le…');
      await pool.query('ALTER TABLE comptes ADD COLUMN interet_accru_le DATETIME NULL');
      await pool.query('UPDATE comptes SET interet_accru_le = NOW()');
      console.log('[migration] comptes : OK');
    }
    const [t] = await pool.query("SHOW COLUMNS FROM operations LIKE 'type'");
    if (t.length && !String(t[0].Type).includes('interet')) {
      console.log("[migration] operations : ajout du type 'interet'…");
      await pool.query("ALTER TABLE operations MODIFY COLUMN type ENUM('depot','retrait','virement_in','virement_out','admin_credit','admin_debit','paiement','interet') NOT NULL");
      console.log('[migration] operations : OK');
    }
    // anti-spam : fusionne les lignes d'intérêts consécutives existantes
    const [clients] = await pool.query("SELECT id FROM comptes WHERE role='client'");
    for (const cl of clients) {
      const [ops] = await pool.query(
        'SELECT id, type, montant, solde_apres FROM operations WHERE compte_id=? ORDER BY cree_le, id', [cl.id]);
      let run = [];
      const flush = async () => {
        if (run.length > 1) {
          const total = round2(run.reduce((s, o) => s + parseFloat(o.montant), 0));
          const dernier = run[run.length - 1];
          await pool.query('UPDATE operations SET montant=?, solde_apres=? WHERE id=?', [total, dernier.solde_apres, dernier.id]);
          const aSupprimer = run.slice(0, -1).map(o => o.id);
          await pool.query('DELETE FROM operations WHERE id IN (?)', [aSupprimer]);
          console.log(`[nettoyage] compte ${cl.id} : ${run.length} lignes d'intérêts fusionnées`);
        }
        run = [];
      };
      for (const o of ops) {
        if (o.type === 'interet') run.push(o);
        else await flush();
      }
      await flush();
    }
  } catch (e) {
    console.error('[migration] vérification impossible :', e.message);
  }
}

ensureSchema().finally(() =>
  app.listen(PORT, () => console.log(`Kyz Account : http://localhost:${PORT} (API + site)`)));
