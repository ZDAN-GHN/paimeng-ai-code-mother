package com.zdan.paimengaicodebackend.platform.validation;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/** Static, fail-closed check of submitted MySQL migration SQL before isolated execution. */
public final class MigrationSafetyGate {
    private static final int MAX_SQL_LENGTH = 65536;
    private static final int MAX_STATEMENTS = 64;
    private static final String IDENTIFIER = "`[A-Za-z_][A-Za-z0-9_]*`";
    private static final String TYPE = "(?:TINYINT|SMALLINT|INTEGER|INT|BIGINT|BOOLEAN|BOOL|TEXT|JSON|BLOB|"
        + "DOUBLE|FLOAT|VARCHAR\\([1-9][0-9]{0,4}\\)|CHAR\\([1-9][0-9]{0,4}\\)|"
        + "DECIMAL\\([1-9][0-9]?(?:,[0-9]{1,2})?\\)|DATETIME(?:\\([0-6]\\))?|"
        + "TIMESTAMP(?:\\([0-6]\\))?)";
    private static final String DEFAULT = "(?:NULL|TRUE|FALSE|[0-9]+(?:\\.[0-9]+)?|"
        + "'(?:[A-Za-z0-9 _.,:@/+-]|'')*'|CURRENT_TIMESTAMP(?:\\([0-6]\\))?)";
    private static final Pattern CREATE_TABLE = pattern("CREATE\\s+TABLE\\s+(" + IDENTIFIER
        + ")\\s*\\((.+)\\)\\s+DEFAULT\\s+CHARACTER\\s+SET\\s+utf8mb4\\s+COLLATE\\s+utf8mb4_unicode_ci");
    private static final Pattern CREATE_INDEX = pattern("CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+" + IDENTIFIER
        + "\\s+ON\\s+(" + IDENTIFIER + ")\\s*\\((" + IDENTIFIER + "(?:\\s*,\\s*" + IDENTIFIER + ")*)\\)");
    private static final Pattern ALTER_ADD_COLUMN = pattern("ALTER\\s+TABLE\\s+(" + IDENTIFIER
        + ")\\s+ADD\\s+COLUMN\\s+(.+)");
    private static final Pattern COLUMN = pattern("(" + IDENTIFIER + ")\\s+" + TYPE
        + "(?:\\s+UNSIGNED)?(?:\\s+(?:NOT\\s+NULL|NULL))?(?:\\s+DEFAULT\\s+" + DEFAULT
        + ")?(?:\\s+AUTO_INCREMENT)?");
    private static final Pattern PRIMARY_KEY = pattern("PRIMARY\\s+KEY\\s*\\((" + IDENTIFIER
        + "(?:\\s*,\\s*" + IDENTIFIER + ")*)\\)");
    private static final Pattern DEFAULT_VALUE = Pattern.compile("\\bDEFAULT\\s+" + DEFAULT + "(?:\\s|$)", Pattern.CASE_INSENSITIVE);
    private static final Pattern COLUMN_NOT_NULL = Pattern.compile("\\bNOT\\s+NULL\\b", Pattern.CASE_INSENSITIVE);
    private static final Pattern DESTRUCTIVE = pattern("(?:DROP|TRUNCATE|RENAME|DELETE)\\b.*");
    private static final Pattern BACKFILL = pattern("(?:UPDATE|INSERT|REPLACE|LOAD)\\b.*");
    private static final Pattern LOCKING = pattern("(?:LOCK|UNLOCK|OPTIMIZE|REPAIR|ANALYZE|FLUSH)\\b.*");

    public record Decision(boolean allowed, String reasonCode) {}

    public Decision evaluate(String sql) {
        if (sql == null || sql.isBlank()) return reject("EMPTY_MIGRATION");
        if (sql.length() > MAX_SQL_LENGTH) return reject("MIGRATION_LIMIT");
        List<String> statements = statements(sql);
        if (statements == null) return reject("UNSUPPORTED_SQL");
        if (statements.isEmpty()) return reject("EMPTY_MIGRATION");
        if (statements.size() > MAX_STATEMENTS) return reject("MIGRATION_LIMIT");
        Set<String> createdTables = new HashSet<>();
        for (String statement : statements) {
            Decision decision = check(statement, createdTables);
            if (!decision.allowed()) return decision;
        }
        return new Decision(true, "ALLOWED");
    }

    private Decision check(String statement, Set<String> createdTables) {
        Matcher createTable = CREATE_TABLE.matcher(statement);
        if (createTable.matches() && columnsSafe(createTable.group(2))) {
            if (reservedTable(createTable.group(1))) return reject("HISTORY_TABLE");
            if (!createdTables.add(createTable.group(1).toLowerCase(Locale.ROOT))) return reject("UNSUPPORTED_SQL");
            return new Decision(true, "ALLOWED");
        }
        Matcher index = CREATE_INDEX.matcher(statement);
        if (index.matches()) {
            if (reservedTable(index.group(1))) return reject("HISTORY_TABLE");
            return createdTables.contains(index.group(1).toLowerCase(Locale.ROOT))
                ? new Decision(true, "ALLOWED") : reject("INDEX_ON_EXISTING_TABLE");
        }
        Matcher add = ALTER_ADD_COLUMN.matcher(statement);
        if (add.matches()) {
            if (reservedTable(add.group(1))) return reject("HISTORY_TABLE");
            String column = add.group(2);
            if (COLUMN.matcher(column).matches()) {
                if (COLUMN_NOT_NULL.matcher(column).find() && !DEFAULT_VALUE.matcher(column).find()) {
                    return reject("CONSTRAINT_TIGHTENING");
                }
                if (column.toUpperCase(Locale.ROOT).contains("AUTO_INCREMENT")) {
                    return reject("CONSTRAINT_TIGHTENING");
                }
                return new Decision(true, "ALLOWED");
            }
        }
        if (DESTRUCTIVE.matcher(statement).matches() || statement.matches("(?is)^ALTER\\s+TABLE\\s+.+\\b(?:DROP|RENAME)\\b.*")) {
            return reject("DESTRUCTIVE_SQL");
        }
        if (BACKFILL.matcher(statement).matches()) return reject("UNBOUNDED_BACKFILL");
        if (LOCKING.matcher(statement).matches()) return reject("LOCKING_OPERATION");
        if (statement.matches("(?is)^ALTER\\s+TABLE\\s+.+\\b(?:MODIFY|CHANGE|ADD\\s+(?:CONSTRAINT|FOREIGN\\s+KEY))\\b.*")) {
            return reject("CONSTRAINT_TIGHTENING");
        }
        return reject("UNSUPPORTED_SQL");
    }

    private static boolean reservedTable(String identifier) {
        return identifier.equalsIgnoreCase("`_prisma_migrations`");
    }

    private static Decision reject(String code) {
        return new Decision(false, code);
    }

    private static Pattern pattern(String expression) {
        return Pattern.compile("^" + expression + "$", Pattern.CASE_INSENSITIVE | Pattern.DOTALL);
    }

    private static boolean columnsSafe(String body) {
        List<String> definitions = split(body, ',');
        if (definitions == null || definitions.isEmpty()) return false;
        Set<String> columns = new HashSet<>();
        String primary = null;
        for (String definition : definitions) {
            Matcher key = PRIMARY_KEY.matcher(definition);
            if (key.matches()) {
                if (primary != null) return false;
                primary = key.group(1);
                continue;
            }
            Matcher column = COLUMN.matcher(definition);
            if (!column.matches() || !columns.add(column.group(1).toLowerCase(Locale.ROOT))) return false;
        }
        if (columns.isEmpty()) return false;
        if (primary == null) return true;
        for (String identifier : primary.split(",")) {
            if (!columns.contains(identifier.strip().toLowerCase(Locale.ROOT))) return false;
        }
        return true;
    }

    private static List<String> statements(String sql) {
        StringBuilder source = new StringBuilder();
        for (String line : sql.split("\\R", -1)) {
            String stripped = line.stripLeading();
            if (stripped.startsWith("-- ") || stripped.equals("--")) continue;
            // Other comments, hints, and inline comments cannot be reviewed as SQL here.
            if (line.contains("--") || line.contains("/*") || line.contains("*/") || line.contains("#")) return null;
            source.append(line).append('\n');
        }
        if (source.toString().isBlank()) return List.of();
        if (!source.toString().stripTrailing().endsWith(";")) return null;
        List<String> pieces = split(source.toString(), ';');
        if (pieces == null || pieces.isEmpty() || !pieces.get(pieces.size() - 1).isEmpty()) return null;
        pieces.remove(pieces.size() - 1);
        if (pieces.stream().anyMatch(String::isEmpty)) return null;
        return pieces;
    }

    private static List<String> split(String input, char delimiter) {
        List<String> parts = new ArrayList<>();
        int depth = 0;
        boolean quoted = false;
        boolean identifier = false;
        int start = 0;
        for (int i = 0; i < input.length(); i++) {
            char ch = input.charAt(i);
            if (quoted) {
                if (ch == '\'') {
                    if (i + 1 < input.length() && input.charAt(i + 1) == '\'') i++;
                    else quoted = false;
                }
                continue;
            }
            if (identifier) {
                if (ch == '`') identifier = false;
                continue;
            }
            if (ch == '\'') quoted = true;
            else if (ch == '`') identifier = true;
            else if (ch == '(' && ++depth > 8) return null;
            else if (ch == ')' && --depth < 0) return null;
            else if (ch == delimiter && depth == 0) {
                parts.add(input.substring(start, i).strip());
                start = i + 1;
            }
        }
        if (quoted || identifier || depth != 0) return null;
        parts.add(input.substring(start).strip());
        return parts;
    }
}
