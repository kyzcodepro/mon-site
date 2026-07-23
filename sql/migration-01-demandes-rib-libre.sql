-- =====================================================================
--  Migration 01 — Demandes de virement vers RIB libre
--  À appliquer sur une base EXISTANTE (créée avec l'ancien schema.sql).
--  Nouveau fonctionnement : le client saisit un RIB libre (texte, sans
--  vérification) ; la demande part chez l'admin (statut en_attente) qui
--  valide (débit du client) ou refuse. Plus de notion de payeur interne.
-- =====================================================================

ALTER TABLE `demandes_virement` DROP FOREIGN KEY `fk_dem_payeur`;
ALTER TABLE `demandes_virement` DROP INDEX `idx_payeur_statut`;
ALTER TABLE `demandes_virement` DROP COLUMN `payeur_id`;
ALTER TABLE `demandes_virement`
  ADD COLUMN `rib` VARCHAR(40) NOT NULL DEFAULT '' COMMENT 'RIB/IBAN saisi librement par le client (non vérifié)' AFTER `demandeur_id`;
ALTER TABLE `demandes_virement` ADD INDEX `idx_statut` (`statut`);
