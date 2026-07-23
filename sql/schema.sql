-- =====================================================================
--  Kyz Account — Schéma de base de données (MySQL / MariaDB)
--  À importer chez ton hébergeur (phpMyAdmin > Importer, ou CLI mysql).
--  Compatible MySQL 5.7+ / MariaDB 10.3+
-- =====================================================================

SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- ---------------------------------------------------------------------
-- Table des comptes (clients + administrateurs)
-- Le numéro de compte à 10 chiffres est l'identifiant public (RIB) et
-- sert à la connexion. Le mot de passe est stocké hashé : SHA-256 de la
-- chaîne "sel::motdepasse" (même algorithme que le front actuel).
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `comptes`;
CREATE TABLE `comptes` (
  `id`           INT UNSIGNED     NOT NULL AUTO_INCREMENT,
  `numero`       CHAR(10)         NOT NULL COMMENT 'N° de compte à 10 chiffres (RIB / identifiant de connexion)',
  `prenom`       VARCHAR(60)      NOT NULL,
  `nom`          VARCHAR(60)      NOT NULL,
  `role`         ENUM('client','admin') NOT NULL DEFAULT 'client',
  `pass_hash`    CHAR(64)         NOT NULL COMMENT 'SHA-256 hex de "sel::motdepasse"',
  `sel`          VARCHAR(40)      NOT NULL COMMENT 'Sel aléatoire propre au compte',
  `solde`        DECIMAL(12,2)    NOT NULL DEFAULT 0.00,
  `statut`       ENUM('actif','bloque') NOT NULL DEFAULT 'actif',
  `cree_le`      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `modifie_le`   DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_numero` (`numero`),
  KEY `idx_role` (`role`),
  KEY `idx_statut` (`statut`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Comptes clients et administrateurs';

-- ---------------------------------------------------------------------
-- Table des opérations (journal / historique)
-- montant signé : positif = crédit, négatif = débit.
-- solde_apres = solde du compte juste après l'opération (pour
-- l'historique et le graphique d'évolution).
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `operations`;
CREATE TABLE `operations` (
  `id`           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `compte_id`    INT UNSIGNED     NOT NULL,
  `type`         ENUM('depot','retrait','virement_in','virement_out','admin_credit','admin_debit','paiement') NOT NULL,
  `libelle`      VARCHAR(160)     NOT NULL,
  `montant`      DECIMAL(12,2)    NOT NULL COMMENT 'Signé : + crédit / − débit',
  `solde_apres`  DECIMAL(12,2)    NOT NULL,
  `meta`         VARCHAR(160)     NULL COMMENT 'Motif, auteur admin, référence…',
  `contrepartie_id` INT UNSIGNED  NULL COMMENT 'Autre compte impliqué (virements)',
  `cree_le`      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP
                 COMMENT 'Date de l''opération — peut être fournie explicitement (dépôt/retrait antidaté par l''admin)',
  PRIMARY KEY (`id`),
  KEY `idx_compte_date` (`compte_id`, `cree_le`),
  KEY `idx_type` (`type`),
  CONSTRAINT `fk_op_compte`
    FOREIGN KEY (`compte_id`) REFERENCES `comptes` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `fk_op_contrepartie`
    FOREIGN KEY (`contrepartie_id`) REFERENCES `comptes` (`id`)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Journal des opérations (historique complet)';

-- ---------------------------------------------------------------------
-- Table des demandes de virement
-- Le client saisit un RIB LIBRE (texte, aucune vérification) : la demande
-- part chez l'administrateur (statut en_attente). À la validation, le
-- compte du client est débité ; sinon la demande est refusée.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `demandes_virement`;
CREATE TABLE `demandes_virement` (
  `id`           BIGINT UNSIGNED  NOT NULL AUTO_INCREMENT,
  `demandeur_id` INT UNSIGNED     NOT NULL COMMENT 'Compte client qui fait la demande',
  `rib`          VARCHAR(40)      NOT NULL COMMENT 'RIB/IBAN saisi librement par le client (non vérifié)',
  `montant`      DECIMAL(12,2)    NOT NULL,
  `motif`        VARCHAR(160)     NULL,
  `statut`       ENUM('en_attente','acceptee','refusee','annulee') NOT NULL DEFAULT 'en_attente',
  `cree_le`      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `traite_le`    DATETIME         NULL COMMENT 'Date d''acceptation/refus',
  PRIMARY KEY (`id`),
  KEY `idx_statut` (`statut`),
  KEY `idx_demandeur` (`demandeur_id`),
  CONSTRAINT `fk_dem_demandeur`
    FOREIGN KEY (`demandeur_id`) REFERENCES `comptes` (`id`)
    ON DELETE CASCADE,
  CONSTRAINT `chk_montant_positif` CHECK (`montant` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Demandes de virement (traitées par l''administrateur)';

-- ---------------------------------------------------------------------
-- Table des sessions (authentification côté serveur)
-- Un jeton opaque est remis au navigateur après connexion.
-- ---------------------------------------------------------------------
DROP TABLE IF EXISTS `sessions`;
CREATE TABLE `sessions` (
  `token`        CHAR(64)         NOT NULL COMMENT 'Jeton aléatoire (hex)',
  `compte_id`    INT UNSIGNED     NOT NULL,
  `cree_le`      DATETIME         NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `expire_le`    DATETIME         NOT NULL,
  PRIMARY KEY (`token`),
  KEY `idx_compte` (`compte_id`),
  KEY `idx_expiration` (`expire_le`),
  CONSTRAINT `fk_sess_compte`
    FOREIGN KEY (`compte_id`) REFERENCES `comptes` (`id`)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  COMMENT='Sessions de connexion';

-- =====================================================================
--  Données initiales : compte administrateur
--  N° de compte : 0000000001
--  Mot de passe : Admin123!   (à changer dès la première connexion)
--  pass_hash = SHA-256("kyz_admin_2026::Admin123!")
-- =====================================================================
INSERT INTO `comptes` (`numero`,`prenom`,`nom`,`role`,`pass_hash`,`sel`,`solde`,`statut`) VALUES
('0000000001','Admin','Kyz','admin',
 '768c75406897e9690c0f9daa689bcd2c8589260796ba186f6493f1e2e7a9696a',
 'kyz_admin_2026', 0.00, 'actif');

SET FOREIGN_KEY_CHECKS = 1;


-- =====================================================================
--  Requêtes utiles (référence pour l'API)
-- =====================================================================
-- Connexion :
--   SELECT * FROM comptes WHERE numero = ? ;
--   → vérifier SHA-256(CONCAT(sel, '::', motdepasse)) = pass_hash
--
-- Historique d'un compte :
--   SELECT * FROM operations WHERE compte_id = ? ORDER BY cree_le DESC;
--
-- Virement (dans UNE transaction SQL) :
--   START TRANSACTION;
--     UPDATE comptes SET solde = solde - :m WHERE id = :src AND solde >= :m AND statut='actif';
--     UPDATE comptes SET solde = solde + :m WHERE id = :dst AND statut='actif';
--     INSERT INTO operations (compte_id,type,libelle,montant,solde_apres,contrepartie_id) VALUES
--       (:src,'virement_out',:lib,-:m,(SELECT solde FROM comptes WHERE id=:src),:dst),
--       (:dst,'virement_in', :lib, :m,(SELECT solde FROM comptes WHERE id=:dst),:src);
--   COMMIT;
--
-- Demandes en attente (vue admin) :
--   SELECT d.*, c.prenom, c.nom, c.solde FROM demandes_virement d
--   JOIN comptes c ON c.id = d.demandeur_id
--   WHERE d.statut = 'en_attente' ORDER BY d.cree_le;
--
-- Dépôt antidaté par l'admin (date choisie) :
--   INSERT INTO operations (compte_id,type,libelle,montant,solde_apres,cree_le)
--   VALUES (:id,'admin_credit',:lib,:m,0,:date_choisie);
--   → puis recalculer la chaîne des soldes du compte :
--   SET @bal := 0;
--   UPDATE operations SET solde_apres = (@bal := ROUND(@bal + montant,2))
--   WHERE compte_id = :id ORDER BY cree_le, id;
--   UPDATE comptes SET solde = @bal WHERE id = :id;
--
-- Purge des sessions expirées :
--   DELETE FROM sessions WHERE expire_le < NOW();
