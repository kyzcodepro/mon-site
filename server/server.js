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

const RIB_BANQUE = '30012', RIB_GUICHET = '00001';
function cleRib(banque, guichet, compte) {
  return String(97n - ((89n * BigInt(banque) + 15n * BigInt(guichet) + 3n * BigInt(compte)) % 97n)).padStart(2, '0');
}
function ibanFrom(banque, guichet, compte, cle) {
  const bban = banque + guichet + compte + cle;
  const key = String(98n - (BigInt(bban + '152700') % 97n)).padStart(2, '0');
  return 'FR' + key + bban;
}
const ribOf = numero => {
  const compte = '0' + numero;
  const cle = cleRib(RIB_BANQUE, RIB_GUICHET, compte);
  return { banque: RIB_BANQUE, guichet: RIB_GUICHET, compte, cle, iban: ibanFrom(RIB_BANQUE, RIB_GUICHET, compte, cle) };
};
function parseRib(raw) {
  let s = String(raw || '').replace(/[\s.-]/g, '').toUpperCase();
  if (s.startsWith('FR')) s = s.slice(4);
  if (!/^\d{23}$/.test(s)) return { error: 'format' };
  const banque = s.slice(0, 5), guichet = s.slice(5, 10), compte = s.slice(10, 21), cle = s.slice(21, 23);
  if (cleRib(banque, guichet, compte) !== cle) return { error: 'cle' };
  return { numero: compte.replace(/^0/, '') };
}

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
    const me = compteRow(req.user);
    if (req.user.role === 'admin') {
      const [cl] = await pool.query("SELECT * FROM comptes WHERE role='client' ORDER BY cree_le DESC");
      const [ops] = await pool.query(
        `SELECT o.*, c.prenom, c.nom FROM operations o JOIN comptes c ON c.id=o.compte_id
         ORDER BY o.cree_le DESC, o.id DESC LIMIT 500`);
      return res.json({ me, clients: cl.map(compteRow), ledger: ops.map(opRow), requests: [] });
    }
    const [ops] = await pool.query(
      'SELECT o.*, NULL AS prenom, NULL AS nom FROM operations o WHERE compte_id=? ORDER BY cree_le DESC, id DESC', [req.user.id]);
    const [reqs] = await pool.query(
      `SELECT d.*, f.prenom AS from_prenom, f.nom AS from_nom, t.prenom AS to_prenom, t.nom AS to_nom
       FROM demandes_virement d
       JOIN comptes f ON f.id = d.demandeur_id
       JOIN comptes t ON t.id = d.payeur_id
       WHERE d.demandeur_id=? OR d.payeur_id=?
       ORDER BY d.cree_le DESC LIMIT 100`, [req.user.id, req.user.id]);
    res.json({
      me,
      ledger: ops.map(opRow),
      requests: reqs.map(r => ({
        id: r.id, fromId: r.demandeur_id, toId: r.payeur_id,
        fromName: r.from_prenom + ' ' + r.from_nom, toName: r.to_prenom + ' ' + r.to_nom,
        montant: parseFloat(r.montant), note: r.motif,
        statut: r.statut === 'en_attente' ? 'en_attente' : (r.statut === 'acceptee' ? 'acceptée' : 'refusée'),
        ts: tsOf(r.cree_le),
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

/* ---------- demandes de virement (client) ---------- */
app.post('/api/demandes', auth, async (req, res, next) => {
  try {
    if (req.user.statut === 'bloque') return fail(res, 403, 'Compte suspendu');
    const r = parseRib(req.body.rib);
    if (r.error === 'format') return fail(res, 400, 'RIB invalide : IBAN FR complet ou 23 chiffres attendus');
    if (r.error === 'cle') return fail(res, 400, 'Clé RIB incorrecte : vérifie le RIB saisi');
    const montant = round2(parseFloat(req.body.montant));
    if (!(montant > 0)) return fail(res, 400, 'Montant invalide');
    const [rows] = await pool.query("SELECT * FROM comptes WHERE numero=? AND role='client'", [r.numero]);
    const payeur = rows[0];
    if (!payeur) return fail(res, 404, 'Aucun compte ne correspond à ce RIB');
    if (payeur.id === req.user.id) return fail(res, 400, 'Impossible de se faire une demande à soi-même');
    if (payeur.statut === 'bloque') return fail(res, 403, 'Ce compte est suspendu');
    await pool.query(
      'INSERT INTO demandes_virement (demandeur_id, payeur_id, montant, motif) VALUES (?,?,?,?)',
      [req.user.id, payeur.id, montant, String(req.body.motif || '').trim() || null]);
    res.json({ ok: true, payeurNom: payeur.prenom + ' ' + payeur.nom });
  } catch (e) { next(e); }
});

app.post('/api/demandes/:id/accept', auth, async (req, res, next) => {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const [dr] = await conn.query(
      "SELECT * FROM demandes_virement WHERE id=? AND payeur_id=? AND statut='en_attente' FOR UPDATE",
      [req.params.id, req.user.id]);
    const d = dr[0];
    if (!d) { await conn.rollback(); return fail(res, 404, 'Demande introuvable ou déjà traitée'); }
    const [cr] = await conn.query('SELECT * FROM comptes WHERE id IN (?,?) FOR UPDATE', [d.payeur_id, d.demandeur_id]);
    const payeur = cr.find(x => x.id === d.payeur_id), benef = cr.find(x => x.id === d.demandeur_id);
    const montant = parseFloat(d.montant);
    if (!payeur || !benef) { await conn.rollback(); return fail(res, 404, 'Compte introuvable'); }
    if (payeur.statut === 'bloque' || benef.statut === 'bloque') { await conn.rollback(); return fail(res, 403, 'Compte suspendu'); }
    if (parseFloat(payeur.solde) < montant) { await conn.rollback(); return fail(res, 400, 'Solde insuffisant'); }
    const sp = round2(parseFloat(payeur.solde) - montant);
    const sb = round2(parseFloat(benef.solde) + montant);
    await conn.query('UPDATE comptes SET solde=? WHERE id=?', [sp, payeur.id]);
    await conn.query('UPDATE comptes SET solde=? WHERE id=?', [sb, benef.id]);
    await conn.query(
      `INSERT INTO operations (compte_id,type,libelle,montant,solde_apres,meta,contrepartie_id) VALUES
       (?,?,?,?,?,?,?), (?,?,?,?,?,?,?)`,
      [payeur.id, 'virement_out', 'Virement vers ' + benef.prenom + ' ' + benef.nom, -montant, sp, d.motif, benef.id,
       benef.id, 'virement_in', 'Virement de ' + payeur.prenom + ' ' + payeur.nom, montant, sb, d.motif, payeur.id]);
    await conn.query("UPDATE demandes_virement SET statut='acceptee', traite_le=NOW() WHERE id=?", [d.id]);
    await conn.commit();
    res.json({ ok: true });
  } catch (e) { await conn.rollback().catch(() => {}); next(e); }
  finally { conn.release(); }
});

app.post('/api/demandes/:id/refuse', auth, async (req, res, next) => {
  try {
    const [r] = await pool.query(
      "UPDATE demandes_virement SET statut='refusee', traite_le=NOW() WHERE id=? AND payeur_id=? AND statut='en_attente'",
      [req.params.id, req.user.id]);
    if (!r.affectedRows) return fail(res, 404, 'Demande introuvable ou déjà traitée');
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
    res.json({ ok: true, numero, iban: ribOf(numero).iban });
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
    const meta = 'par ' + req.user.prenom;
    if (dateOp) {
      await conn.query(
        'INSERT INTO operations (compte_id,type,libelle,montant,solde_apres,meta,cree_le) VALUES (?,?,?,?,0,?,?)',
        [c.id, kind === 'credit' ? 'admin_credit' : 'admin_debit', libelle, signed, meta, dateOp]);
      await recalcLedger(conn, c.id);
    } else {
      const ns = round2(parseFloat(c.solde) + signed);
      await conn.query(
        'INSERT INTO operations (compte_id,type,libelle,montant,solde_apres,meta) VALUES (?,?,?,?,?,?)',
        [c.id, kind === 'credit' ? 'admin_credit' : 'admin_debit', libelle, signed, ns, meta]);
      await conn.query('UPDATE comptes SET solde=? WHERE id=?', [ns, c.id]);
    }
    await conn.commit();
    res.json({ ok: true });
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

app.listen(PORT, () => console.log(`Kyz Account : http://localhost:${PORT} (API + site)`));
