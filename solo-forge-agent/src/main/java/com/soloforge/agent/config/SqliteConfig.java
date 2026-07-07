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

/**
 * SQLite 数据源配置
 *
 * 连接 AI Society 的 ai_society.db (共享数据库)
 * 路径: ../python/data/ai_society/ai_society.db (相对于 Java 服务工作目录)
 */
@Slf4j
@Configuration
public class SqliteConfig {

    @Value("${spring.datasource.url}")
    private String dbUrl;

    @Bean
    public DataSource dataSource() {
        // 从 JDBC URL 提取文件路径并验证
        String dbPath = dbUrl.replace("jdbc:sqlite:", "");
        Path path = Paths.get(dbPath);
        if (!Files.exists(path)) {
            log.warn("AI Society SQLite database not found at: {}", path.toAbsolutePath());
            log.warn("Please run 'python init_ai_society.py' first in the python/ directory");
        } else {
            log.info("Connecting to AI Society SQLite: {}", path.toAbsolutePath());
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
}
