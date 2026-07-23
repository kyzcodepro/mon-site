-- =====================================================================
--  Migration 02 — Nettoyage des mentions « par Admin »
--  Retire la mention d'auteur des dépôts/retraits existants (le serveur
--  ne l'enregistre plus).
-- =====================================================================

UPDATE `operations` SET `meta` = NULL WHERE `meta` LIKE 'par %';
