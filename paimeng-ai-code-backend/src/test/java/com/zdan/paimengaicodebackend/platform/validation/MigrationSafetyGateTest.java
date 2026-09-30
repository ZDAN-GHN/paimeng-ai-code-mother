package com.zdan.paimengaicodebackend.platform.validation;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertTrue;

import org.junit.jupiter.api.Test;

class MigrationSafetyGateTest {
    private final MigrationSafetyGate gate = new MigrationSafetyGate();

    @Test
    void acceptsSubmittedPrismaCreateTableAndIndex() {
        String sql = """
            -- CreateTable
            CREATE TABLE `WorkItem` (
                `id` INTEGER NOT NULL AUTO_INCREMENT,
                `title` VARCHAR(191) NOT NULL,
                `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
                PRIMARY KEY (`id`)
            ) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

            -- CreateIndex
            CREATE UNIQUE INDEX `WorkItem_title_key` ON `WorkItem`(`title`);
            """;
        assertTrue(gate.evaluate(sql).allowed());
        assertEquals("ALLOWED", gate.evaluate(sql).reasonCode());
    }

    @Test
    void acceptsNullableAndDefaultedAdditions() {
        assertTrue(gate.evaluate("ALTER TABLE `WorkItem` ADD COLUMN `notes` TEXT NULL;").allowed());
        assertTrue(gate.evaluate("ALTER TABLE `WorkItem` ADD COLUMN `active` BOOLEAN NOT NULL DEFAULT TRUE;").allowed());
    }

    @Test
    void rejectsDangerousOrUnsupportedStatementsWithReasonCodes() {
        assertRejected("DROP TABLE `WorkItem`;", "DESTRUCTIVE_SQL");
        assertRejected("DELETE FROM `WorkItem`;", "DESTRUCTIVE_SQL");
        assertRejected("UPDATE `WorkItem` SET `active` = TRUE;", "UNBOUNDED_BACKFILL");
        assertRejected("LOCK TABLES `WorkItem` WRITE;", "LOCKING_OPERATION");
        assertRejected("ALTER TABLE `WorkItem` ADD COLUMN `name` VARCHAR(191) NOT NULL;", "CONSTRAINT_TIGHTENING");
        assertRejected("ALTER TABLE `WorkItem` MODIFY COLUMN `name` TEXT;", "CONSTRAINT_TIGHTENING");
        assertRejected("ALTER TABLE `WorkItem` ADD CONSTRAINT `fk` FOREIGN KEY (`id`) REFERENCES `Other`(`id`);", "CONSTRAINT_TIGHTENING");
        assertRejected("CREATE TABLE `T` (`id` INTEGER, FOREIGN KEY (`id`) REFERENCES `Other`(`id`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;", "UNSUPPORTED_SQL");
        assertRejected("CREATE TABLE `T` (`id` INTEGER) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci; DROP TABLE `T`;", "DESTRUCTIVE_SQL");
        assertRejected("CREATE INDEX `idx` ON `db`.`WorkItem`(`id`);", "UNSUPPORTED_SQL");
        assertRejected("CREATE INDEX `idx` ON `WorkItem`(`id`);", "INDEX_ON_EXISTING_TABLE");
        assertRejected("ALTER TABLE `_prisma_migrations` ADD COLUMN `stamp` TEXT NULL;", "HISTORY_TABLE");
        assertRejected("CREATE TABLE `_prisma_migrations` (`id` INTEGER) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;", "HISTORY_TABLE");
        assertRejected("CREATE INDEX `idx` ON `WorkItem`(`id`); /* bypass */", "UNSUPPORTED_SQL");
        assertRejected("CREATE INDEX `idx` ON `WorkItem`(`id`)", "UNSUPPORTED_SQL");
    }

    @Test
    void rejectsEveryDestructiveMigrationFamilyNamedByTheAcceptanceCriteria() {
        assertRejected("DROP TABLE `WorkItem`;", "DESTRUCTIVE_SQL");
        assertRejected("TRUNCATE TABLE `WorkItem`;", "DESTRUCTIVE_SQL");
        assertRejected("RENAME TABLE `WorkItem` TO `Renamed`;", "DESTRUCTIVE_SQL");
        assertRejected("ALTER TABLE `WorkItem` RENAME COLUMN `title` TO `label`;", "DESTRUCTIVE_SQL");
        assertRejected("ALTER TABLE `WorkItem` CHANGE COLUMN `title` VARCHAR(32) NOT NULL;",
            "CONSTRAINT_TIGHTENING");
        assertRejected("ALTER TABLE `WorkItem` ADD COLUMN `title` VARCHAR(191) NOT NULL;",
            "CONSTRAINT_TIGHTENING");
        assertRejected("ALTER TABLE `WorkItem` MODIFY COLUMN `title` VARCHAR(32) NOT NULL;",
            "CONSTRAINT_TIGHTENING");
        assertRejected("ALTER TABLE `WorkItem` ADD CONSTRAINT `fk` FOREIGN KEY (`id`) REFERENCES `Other`(`id`);",
            "CONSTRAINT_TIGHTENING");
        assertRejected("UPDATE `WorkItem` SET `title` = 'rewritten';", "UNBOUNDED_BACKFILL");
        assertRejected("INSERT INTO `WorkItem` SELECT * FROM `Other`;", "UNBOUNDED_BACKFILL");
        assertRejected("REPLACE INTO `WorkItem` VALUES (1, 'rewritten');", "UNBOUNDED_BACKFILL");
        assertRejected("LOAD DATA INFILE '/etc/passwd' INTO TABLE `WorkItem`;", "UNBOUNDED_BACKFILL");
        assertRejected("LOCK TABLES `WorkItem` WRITE;", "LOCKING_OPERATION");
        assertRejected("UNLOCK TABLES;", "LOCKING_OPERATION");
        assertRejected("OPTIMIZE TABLE `WorkItem`;", "LOCKING_OPERATION");
        assertRejected("FLUSH TABLES;", "LOCKING_OPERATION");
    }

    @Test
    void rejectsEmptyAndInvalidTableDefinitions() {
        assertRejected("", "EMPTY_MIGRATION");
        assertRejected("-- comment only", "EMPTY_MIGRATION");
        assertRejected("CREATE TABLE `T` (`id` INTEGER, `id` TEXT) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;", "UNSUPPORTED_SQL");
        assertRejected("CREATE TABLE `T` (`id` INTEGER, PRIMARY KEY (`missing`)) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;", "UNSUPPORTED_SQL");
    }

    private void assertRejected(String sql, String code) {
        MigrationSafetyGate.Decision decision = gate.evaluate(sql);
        assertFalse(decision.allowed(), sql);
        assertEquals(code, decision.reasonCode(), sql);
    }
}
