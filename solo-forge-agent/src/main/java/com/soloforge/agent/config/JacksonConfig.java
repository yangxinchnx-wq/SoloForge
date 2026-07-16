package com.soloforge.agent.config;

import com.fasterxml.jackson.databind.ObjectMapper;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

/**
 * Jackson 配置 — 提供 ObjectMapper Bean
 *
 * Spring Boot 自动配置通常会在 web 场景下注册 ObjectMapper,
 * 但当 spring-web-mvc 的自动配置被排除时需要手动声明。
 */
@Configuration
public class JacksonConfig {

    @Bean
    public ObjectMapper objectMapper() {
        return new ObjectMapper();
    }
}
