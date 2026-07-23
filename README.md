# 💳 NovaBank — Gestion de comptes clients

Application web de gestion de comptes clients façon banque en ligne :
inscription directe sur le site, espace client avec historique et graphique,
espace administrateur complet. Interface moderne (thème sombre, dégradés,
animations).

## ✨ Fonctionnalités

### Espace client
- Création de compte en ligne (mot de passe hashé SHA-256 + sel, prime de bienvenue)
- Solde animé, IBAN généré, tuiles entrées/sorties 30 jours
- **Graphique d'évolution du solde** (90 j) avec crosshair + tooltip au survol
- Virements entre clients, dépôts et retraits (démo)
- Historique complet : recherche + filtres entrées/sorties
- Profil : modifier ses infos, changer son mot de passe

### Espace admin
- Vue d'ensemble : nb clients, encours total, opérations 24 h, flux global
- Gestion clients : créer, créditer/débiter, **bloquer/débloquer**, supprimer
- Fiche client détaillée avec historique
- Journal de toutes les opérations avec recherche

## 🎭 Comptes de démonstration

| Rôle | Email | Mot de passe |
|------|-------|--------------|
| Admin | `admin@novabank.fr` | `Admin123!` |
| Client | `sophie@exemple.fr` | `Demo123!` |
| Client | `karim@exemple.fr` | `Demo123!` |
| Client | `lea@exemple.fr` | `Demo123!` |

## ⚠️ Nature du projet

Démo 100 % front-end : les données vivent dans le **localStorage du
navigateur** (aucun serveur). Parfait pour prototyper et présenter ;
une mise en production réelle nécessiterait un backend (base de données,
authentification serveur, etc.).

## Structure

```
index.html   — application complète (HTML + CSS + JS, zéro dépendance)
```

## Hébergement

Déployé via **GitHub Pages** :
`https://kyzcodepro.github.io/mon-site/`
