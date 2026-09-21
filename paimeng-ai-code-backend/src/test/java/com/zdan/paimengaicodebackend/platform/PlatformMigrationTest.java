package com.zdan.paimengaicodebackend.platform;

import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import org.junit.jupiter.api.Test;

class PlatformMigrationTest {

    @Test
    void migrationsCreateOnlyPlatformDomainTablesAndNormalizeTextStorage() throws Exception {
        String v1 = resource("/db/migration/V1__platform_domain.sql");
        String v2 = resource("/db/migration/V2__platform_domain_text_and_collation.sql");
        String v3 = resource("/db/migration/V3__platform_requirement_immutable.sql");

        assertTrue(v1.contains("CREATE TABLE platform_application"));
        assertTrue(v1.contains("CREATE TABLE platform_requirement"));
        assertTrue(v1.contains("CREATE TABLE platform_task"));
        assertTrue(v1.contains("CREATE TABLE platform_run"));
        assertTrue(v1.contains("CREATE TABLE platform_trusted_profile_version"));
        assertTrue(!v1.contains("ALTER TABLE app"));
        assertTrue(!v1.contains("credit_ledger"));
        assertTrue(v2.contains("MODIFY acceptance_target TEXT"));
        assertTrue(v2.contains("utf8mb4_unicode_ci"));
        assertTrue(v3.contains("CREATE TRIGGER platform_requirement_immutable"));
    }

    private String resource(String path) throws Exception {
        try (InputStream stream = getClass().getResourceAsStream(path)) {
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        }
    }
}
