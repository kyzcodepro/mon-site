# 💳 Kyz Account — Gestion de comptes clients

Application web de gestion de comptes clients : création de compte directement
sur le site, identification par **numéro de compte à 10 chiffres**, historique
des opérations, virements et demandes de virement entre comptes, espace
administrateur complet. Interface moderne (thème sombre, dégradés, animations).

## ✨ Fonctionnalités

### Espace client
- Création de compte en ligne : le numéro de compte (10 chiffres) est généré
  automatiquement et sert d'identifiant de connexion
- Solde animé, tuiles entrées/sorties 30 jours
- **Graphique d'évolution du solde** (90 j) avec crosshair + tooltip
- **Faire un virement** vers un autre compte via son RIB (n° à 10 chiffres)
- **Demande de virement** : demander de l'argent à un autre compte, qui
  accepte (paiement immédiat) ou refuse
- Historique complet : recherche + filtres entrées/sorties
- Profil : modifier ses infos, changer son mot de passe

### Espace admin (seul habilité aux dépôts/retraits)
- Vue d'ensemble : nb clients, encours total, opérations 24 h, flux global
- **Dépôt / Retrait** sur n'importe quel compte client
- Gestion clients : créer (numéro généré + mot de passe provisoire),
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

## Structure

```
index.html   — application complète (HTML + CSS + JS, zéro dépendance)
```

## Hébergement

Déployé via **GitHub Pages** :
`https://kyzcodepro.github.io/mon-site/`
