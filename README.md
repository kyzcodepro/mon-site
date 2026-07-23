# 💳 Kyz Account — Gestion de comptes clients

Application web de gestion de comptes clients : création de compte directement
sur le site, identification par **numéro de compte à 10 chiffres**, historique
des opérations, virements et demandes de virement entre comptes, espace
administrateur complet. Interface moderne (thème sombre, dégradés, animations).

## ✨ Fonctionnalités

### Espace client
- Connexion par numéro de compte à 10 chiffres (comptes créés par l'admin)
- Solde animé, tuiles entrées/sorties 30 jours
- **Graphique d'évolution du solde** (90 j) avec crosshair + tooltip
- **Demande de virement** : le client saisit librement le RIB/IBAN du
  bénéficiaire (aucune vérification) — la demande part chez l'admin avec le
  statut « Demande en cours », le client suit son état (en cours / acceptée /
  refusée)
- Historique complet : recherche + filtres entrées/sorties
- Profil : modifier ses infos, changer son mot de passe

### Espace admin (seul habilité aux dépôts/retraits)
- Vue d'ensemble : nb clients, encours total, opérations 24 h, flux global
- **Traitement des demandes de virement** : valider (le compte du client est
  débité) ou refuser, avec RIB saisi et solde du client affichés
- **Dépôt / Retrait** sur n'importe quel compte, avec **date d'opération au
  choix** (antidatage : l'historique et les soldes sont recalculés)
- Gestion clients : créer (numéro + IBAN générés, mot de passe provisoire),
  bloquer/débloquer, supprimer
- Fiche client détaillée avec historique
- Journal de toutes les opérations avec recherche

## 🔐 Compte administrateur

| N° de compte | Mot de passe |
|--------------|--------------|
| `0000000001` | `Admin123!` |

> Change le mot de passe dès la première connexion (Mon profil →
> Changer le mot de passe).

## ⚠️ Nature du projet

Application 100 % front-end : les données vivent dans le **localStorage du
navigateur** (aucun serveur). Une mise en production réelle nécessiterait un
backend (base de données, authentification serveur, etc.).

## 🗄️ Base de données (hébergeur)

Le fichier [`sql/schema.sql`](sql/schema.sql) contient le schéma MySQL/MariaDB
prêt à importer chez ton hébergeur (phpMyAdmin → Importer) :

| Table | Rôle |
|-------|------|
| `comptes` | clients + admins, n° à 10 chiffres, mot de passe hashé, solde, statut |
| `operations` | journal complet (dépôts, retraits, virements) avec solde après opération |
| `demandes_virement` | demandes vers RIB libre, traitées par l'admin (en cours / acceptée / refusée) |
| `sessions` | jetons de connexion côté serveur |

Le compte admin `0000000001` / `Admin123!` est créé à l'import.

## 🚀 Serveur API (obligatoire)

Le site est branché sur l'API `server/server.js` (Express + MySQL) : chaque
création de client, dépôt, demande de virement… écrit dans la base.

```bash
cd server
npm install
cp .env.example .env   # renseigner les accès MySQL
npm start              # sert le site + l'API sur le port 3000
```

## Structure

```
index.html        — interface (HTML + CSS + JS, appelle l'API /api/*)
server/server.js  — API Express + MySQL (sert aussi le site)
server/.env       — accès base de données (à créer depuis .env.example)
sql/schema.sql    — schéma MySQL/MariaDB à importer chez l'hébergeur (neuf)
sql/migration-01-demandes-rib-libre.sql — migration pour base existante
```

## Hébergement

Déployé via **GitHub Pages** :
`https://kyzcodepro.github.io/mon-site/`
