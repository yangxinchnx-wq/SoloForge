package com.soloforge.agent.config;

import com.zaxxer.hikari.HikariConfig;
import com.zaxxer.hikari.HikariDataSource;
import lombok.extern.slf4j.Slf4j;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.jdbc.core.JdbcTemplate;

import javax.sql.DataSource;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.Paths;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.Statement;
import java.time.LocalDateTime;

/**
 * SQLite 数据源配置
 *
 * 连接 AI Society 的 ai_society.db (共享数据库)
 * 路径解析优先级:
 *   1. 环境变量 SOLOFORGE_SQLITE_URL (如 jdbc:sqlite:/absolute/path/ai_society.db)
 *   2. 自动检测: jar 所在目录的 ../python/data/ai_society/ai_society.db
 *   3. 默认: ../python/data/ai_society/ai_society.db (相对于工作目录)
 */
@Slf4j
@Configuration
public class SqliteConfig {

    @Value("${spring.datasource.url}")
    private String configuredUrl;

    @Bean
    public DataSource dataSource() {
        String dbUrl = resolveDbUrl();

        // 从 JDBC URL 提取文件路径并验证
        String dbPath = dbUrl.replace("jdbc:sqlite:", "");
        Path path = Paths.get(dbPath);
        if (!Files.exists(path)) {
            log.info("AI Society SQLite not found, auto-initializing: {}", path.toAbsolutePath());
            autoInitDatabase(path);
        } else if (!checkTableExists(path, "agent_identity")) {
            log.info("AI Society SQLite exists but missing tables, auto-initializing: {}", path.toAbsolutePath());
            autoInitDatabase(path);
        } else {
            log.info("Connecting to AI Society SQLite: {}", path.toAbsolutePath());
            // 旧库兼容: 表已存在但可能缺少后来新增的列, 补全 schema
            ensureColumns(path);
        }

        HikariConfig config = new HikariConfig();
        config.setJdbcUrl(dbUrl);
        config.setDriverClassName("org.sqlite.JDBC");
        config.setMaximumPoolSize(5);
        config.setMinimumIdle(1);
        config.setConnectionTimeout(5000);
        config.setPoolName("SoloForge-SQLite-Pool");

        // SQLite 特有优化
        config.addDataSourceProperty("journal_mode", "WAL");
        config.addDataSourceProperty("foreign_keys", "true");
        config.addDataSourceProperty("busy_timeout", "30000");

        HikariDataSource ds = new HikariDataSource(config);
        log.info("SQLite DataSource initialized (pool size: 5)");
        return ds;
    }

    @Bean
    public JdbcTemplate jdbcTemplate(DataSource dataSource) {
        return new JdbcTemplate(dataSource);
    }

    /**
     * 检查 SQLite 数据库中是否存在指定表
     */
    private boolean checkTableExists(Path dbPath, String tableName) {
        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + dbPath.toAbsolutePath())) {
            var rs = conn.createStatement().executeQuery(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='" + tableName + "'");
            return rs.next();
        } catch (Exception e) {
            log.debug("Could not check table existence: {}", e.getMessage());
            return false;
        }
    }

    /**
     * 解析 SQLite 数据库 URL
     * 优先级: 环境变量 > jar 相对路径 > 配置文件默认值
     */
    private String resolveDbUrl() {
        // 1. 环境变量优先
        String envUrl = System.getenv("SOLOFORGE_SQLITE_URL");
        if (envUrl != null && !envUrl.isBlank()) {
            log.info("Using SQLite URL from env: {}", envUrl);
            return envUrl;
        }

        // 2. 自动检测 jar 所在目录
        try {
            Path jarDir = Paths.get(SqliteConfig.class.getProtectionDomain()
                    .getCodeSource().getLocation().toURI()).getParent();
            if (jarDir != null) {
                // jar_dir/python/data/ai_society/ai_society.db
                Path dbPath = jarDir.resolve("python/data/ai_society/ai_society.db");
                if (Files.exists(dbPath)) {
                    String autoUrl = "jdbc:sqlite:" + dbPath.toAbsolutePath();
                    log.info("Auto-detected SQLite path: {}", dbPath.toAbsolutePath());
                    return autoUrl;
                }
                // jar_dir/../python/data/ai_society/ai_society.db
                Path parentDbPath = jarDir.getParent().resolve("python/data/ai_society/ai_society.db");
                if (Files.exists(parentDbPath)) {
                    String autoUrl = "jdbc:sqlite:" + parentDbPath.toAbsolutePath();
                    log.info("Auto-detected SQLite path (parent): {}", parentDbPath.toAbsolutePath());
                    return autoUrl;
                }
            }
        } catch (Exception e) {
            log.debug("Could not auto-detect jar location: {}", e.getMessage());
        }

        // 3. 默认配置值
        log.info("Using default SQLite URL from config: {}", configuredUrl);
        return configuredUrl;
    }

    /**
     * 旧库兼容: 检查 agent_identity 表是否缺少后来新增的列, 缺则 ALTER TABLE 补上
     *
     * 场景: 数据库由旧版代码创建 (无 avatar/domain/capabilities 等列),
     *       新代码 SELECT * 会导致 "no such column: 'avatar'" 错误。
     *       CREATE TABLE IF NOT EXISTS 不会修改已有表, 所以需要手动 ALTER。
     */
    private void ensureColumns(Path dbPath) {
        String[][] requiredColumns = {
            {"avatar", "TEXT"},
            {"domain", "TEXT"},
            {"capabilities", "TEXT DEFAULT '[]'"},
            {"strategy", "TEXT DEFAULT 'direct'"},
            {"level", "TEXT DEFAULT 'senior'"},
            {"temperature", "REAL DEFAULT 0.3"},
            {"max_rounds", "INTEGER DEFAULT 8"},
        };

        try (Connection conn = DriverManager.getConnection("jdbc:sqlite:" + dbPath.toAbsolutePath())) {
            // 获取 agent_identity 表现有的列名
            var rs = conn.createStatement().executeQuery("PRAGMA table_info(agent_identity)");
            java.util.Set<String> existingCols = new java.util.HashSet<>();
            while (rs.next()) {
                existingCols.add(rs.getString("name"));
            }

            // 补全缺失的列
            boolean altered = false;
            for (String[] col : requiredColumns) {
                if (!existingCols.contains(col[0])) {
                    conn.createStatement().execute(
                        "ALTER TABLE agent_identity ADD COLUMN " + col[0] + " " + col[1]);
                    log.info("Schema migration: added column '{}' to agent_identity", col[0]);
                    altered = true;
                }
            }
            if (altered) {
                log.info("Schema migration completed for agent_identity");
            }
        } catch (Exception e) {
            log.warn("Could not ensure columns for agent_identity: {}", e.getMessage());
        }
    }

    /**
     * 自动初始化 SQLite 数据库
     * 创建目录 + 建表 + 插入 4 个默认 Agent
     */
    private void autoInitDatabase(Path dbPath) {
        try {
            Path parent = dbPath.getParent();
            if (parent != null && !Files.exists(parent)) {
                Files.createDirectories(parent);
                log.info("Created directory: {}", parent.toAbsolutePath());
            }

            String url = "jdbc:sqlite:" + dbPath.toAbsolutePath();
            try (Connection conn = DriverManager.getConnection(url)) {
                conn.setAutoCommit(false);
                try (Statement stmt = conn.createStatement()) {
                    stmt.execute("PRAGMA journal_mode=WAL");
                    stmt.execute("PRAGMA foreign_keys=ON");
                    stmt.execute("PRAGMA busy_timeout=30000");

                    stmt.execute("""
                        CREATE TABLE IF NOT EXISTS schema_version (
                            version INTEGER PRIMARY KEY,
                            description TEXT NOT NULL,
                            applied_at TEXT NOT NULL
                        )
                    """);
                    stmt.execute("""
                        INSERT OR IGNORE INTO schema_version (version, description, applied_at)
                        VALUES (3, 'initial auto-creation by Java Agent', '%s')
                    """.formatted(LocalDateTime.now()));

                    stmt.execute("""
                        CREATE TABLE IF NOT EXISTS agent_identity (
                            id TEXT PRIMARY KEY,
                            role TEXT NOT NULL,
                            model_binding TEXT NOT NULL,
                            system_prompt TEXT DEFAULT '',
                            system_prompt_version INTEGER DEFAULT 0,
                            current_checkpoint_path TEXT,
                            checkpoint_version INTEGER DEFAULT 0,
                            task_count INTEGER DEFAULT 0,
                            reputation_id TEXT,
                            status TEXT DEFAULT 'active',
                            name TEXT,
                            avatar TEXT,
                            domain TEXT,
                            capabilities TEXT DEFAULT '[]',
                            strategy TEXT DEFAULT 'direct',
                            level TEXT DEFAULT 'senior',
                            temperature REAL DEFAULT 0.3,
                            max_rounds INTEGER DEFAULT 8,
                            enabled INTEGER DEFAULT 1,
                            created_at TEXT NOT NULL,
                            updated_at TEXT NOT NULL
                        )
                    """);
                    stmt.execute("""
                        CREATE TABLE IF NOT EXISTS agent_training_history (
                            id TEXT PRIMARY KEY,
                            agent_id TEXT NOT NULL,
                            trained_at TEXT NOT NULL,
                            trigger_reason TEXT NOT NULL,
                            sample_count INTEGER,
                            reward_before REAL,
                            reward_after REAL,
                            prompt_version_before INTEGER,
                            prompt_version_after INTEGER,
                            checkpoint_path TEXT,
                            notes TEXT,
                            created_at TEXT NOT NULL
                        )
                    """);
                    stmt.execute("""
                        CREATE TABLE IF NOT EXISTS governance_record (
                            id TEXT PRIMARY KEY,
                            governance_id TEXT NOT NULL,
                            agent_id TEXT NOT NULL,
                            compliant INTEGER NOT NULL,
                            action_taken TEXT,
                            notes TEXT,
                            created_at TEXT NOT NULL
                        )
                    """);
                    stmt.execute("""
                        CREATE TABLE IF NOT EXISTS credit_transaction (
                            id TEXT PRIMARY KEY,
                            economy_id TEXT NOT NULL,
                            amount REAL NOT NULL,
                            transaction_type TEXT NOT NULL,
                            category TEXT NOT NULL,
                            description TEXT,
                            created_at TEXT NOT NULL
                        )
                    """);
                    stmt.execute("""
                        CREATE TABLE IF NOT EXISTS reputation_record (
                            id TEXT PRIMARY KEY,
                            reputation_id TEXT NOT NULL,
                            delta REAL NOT NULL,
                            reason TEXT NOT NULL,
                            source TEXT NOT NULL,
                            created_at TEXT NOT NULL
                        )
                    """);
                    stmt.execute("""
                        CREATE TABLE IF NOT EXISTS economy_record (
                            id TEXT PRIMARY KEY,
                            agent_id TEXT NOT NULL,
                            event TEXT NOT NULL,
                            credits_change REAL NOT NULL,
                            reason TEXT NOT NULL,
                            created_at TEXT NOT NULL
                        )
                    """);

                    stmt.execute("CREATE INDEX IF NOT EXISTS idx_governance_record ON governance_record(governance_id)");
                    stmt.execute("CREATE INDEX IF NOT EXISTS idx_transaction_economy ON credit_transaction(economy_id)");
                    stmt.execute("CREATE INDEX IF NOT EXISTS idx_reputation_record ON reputation_record(reputation_id)");
                    stmt.execute("CREATE INDEX IF NOT EXISTS idx_economy_record_agent ON economy_record(agent_id)");
                    stmt.execute("CREATE INDEX IF NOT EXISTS idx_agent_identity_role ON agent_identity(role)");
                    stmt.execute("CREATE INDEX IF NOT EXISTS idx_agent_identity_status ON agent_identity(status)");
                    stmt.execute("CREATE INDEX IF NOT EXISTS idx_agent_training_history_agent ON agent_training_history(agent_id)");

                    String now = LocalDateTime.now().toString();
                    String insertSql = """
                        INSERT OR IGNORE INTO agent_identity
                        (id, role, model_binding, name, avatar, domain, system_prompt, capabilities, strategy, level, temperature, max_rounds, task_count, status, system_prompt_version, checkpoint_version, enabled, created_at, updated_at)
                        VALUES (?,?,?,?,?,?,?,?,?,?,?,?,0,'active',0,0,1,?,?)
                        """;
                    try (PreparedStatement ps = conn.prepareStatement(insertSql)) {
                        String[][] agents = {
                            {"code_agent", "EXECUTOR", "gpt-4o", "代码工程师", "💻", "code-dev", "你是 SoloForge 的代码工程师 Agent。专精代码编写、重构、调试、架构设计。优先使用工具查看真实代码，不要猜测。", "[\"read\",\"write\",\"search\",\"execute\",\"analyze\"]", "direct", "senior", "0.3", "8"},
                            {"plan_agent", "PLANNER", "gpt-4o", "规划师", "📋", "planning", "你是 SoloForge 的规划师 Agent。专精任务拆解、方案设计、技术选型。先理解需求再给方案，避免直接编码。", "[\"read\",\"search\",\"analyze\"]", "chain_of_thought", "master", "0.2", "12"},
                            {"debug_agent", "REVIEWER", "gpt-4o", "调试专家", "🔍", "debugging", "你是 SoloForge 的调试专家 Agent。专精 bug 定位、根因分析、修复验证。系统化排查，不要瞎猜。", "[\"read\",\"search\",\"execute\",\"analyze\"]", "chain_of_thought", "expert", "0.1", "10"},
                            {"doc_agent", "EXECUTOR", "gpt-4o", "文档作家", "📝", "documentation", "你是 SoloForge 的文档作家 Agent。专精文档撰写、注释、README。语言简洁清晰。", "[\"read\",\"write\",\"search\"]", "direct", "senior", "0.5", "6"}
                        };
                        for (String[] a : agents) {
                            ps.setString(1, a[0]);
                            ps.setString(2, a[1]);
                            ps.setString(3, a[2]);
                            ps.setString(4, a[3]);
                            ps.setString(5, a[4]);
                            ps.setString(6, a[5]);
                            ps.setString(7, a[6]);
                            ps.setString(8, a[7]);
                            ps.setString(9, a[8]);
                            ps.setString(10, a[9]);
                            ps.setDouble(11, Double.parseDouble(a[10]));
                            ps.setInt(12, Integer.parseInt(a[11]));
                            ps.setString(13, now);
                            ps.setString(14, now);
                            ps.executeUpdate();
                        }
                    }

                    conn.commit();
                    log.info("Auto-initialized SQLite database with 4 preset agents: {}", dbPath.toAbsolutePath());
                }
            }
        } catch (Exception e) {
            log.error("Failed to auto-initialize SQLite database: {}", e.getMessage(), e);
        }
    }
}
