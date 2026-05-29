-- SoloForge baseline migration rollback (down)
-- Version: 202605281200

REMOVE TABLE eventLog;
REMOVE TABLE marlEpisode;
REMOVE TABLE courtSubmission;
REMOVE TABLE decision;
REMOVE TABLE schema_migrations;
