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
- **Mon RIB** : RIB complet (banque, guichet, compte, clé) + IBAN FR valide,
  copiable en un clic
- **Demande de virement** : saisir le RIB complet (ou IBAN) du payeur, qui
  accepte (paiement immédiat) ou refuse — clé RIB vérifiée à la saisie
- Historique complet : recherche + filtres entrées/sorties
- Profil : modifier ses infos, changer son mot de passe

### Espace admin (seul habilité aux dépôts/retraits)
- Vue d'ensemble : nb clients, encours total, opérations 24 h, flux global
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
| `v_rib` | vue calculée : RIB complet (banque, guichet, compte, clé) par client |
| `operations` | journal complet (dépôts, retraits, virements) avec solde après opération |
| `demandes_virement` | demandes entre comptes (en attente / acceptée / refusée) |
| `sessions` | jetons de connexion côté serveur |

Le compte admin `0000000001` / `Admin123!` est créé à l'import.
En attendant l'API serveur, le site fonctionne en localStorage.

## Structure

```
index.html        — application complète (HTML + CSS + JS, zéro dépendance)
sql/schema.sql    — schéma MySQL/MariaDB à importer chez l'hébergeur
```

## Hébergement

Déployé via **GitHub Pages** :
`https://kyzcodepro.github.io/mon-site/`
