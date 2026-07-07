package com.soloforge.agent.training;

import com.fasterxml.jackson.core.type.TypeReference;
import com.fasterxml.jackson.databind.ObjectMapper;
import lombok.RequiredArgsConstructor;
import lombok.extern.slf4j.Slf4j;
import org.springframework.core.io.Resource;
import org.springframework.core.io.support.PathMatchingResourcePatternResolver;
import org.springframework.stereotype.Component;

import jakarta.annotation.PostConstruct;
import java.io.InputStream;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

/**
 * 标准测试任务集加载器
 *
 * 从 classpath:training-tasks/*.json 加载所有任务文件，按 domain 分组。
 * 当前预置:
 *   - code-dev-tasks.json     (8 个代码开发任务)
 *   - planning-tasks.json     (5 个规划任务)
 *   - debugging-tasks.json    (5 个调试任务)
 *   - documentation-tasks.json (5 个文档任务)
 */
@Slf4j
@Component
@RequiredArgsConstructor
public class TrainingTaskLoader {

    private final ObjectMapper objectMapper;
    private final Map<String, List<TrainingTask>> tasksByDomain = new HashMap<>();

    @PostConstruct
    public void loadAll() {
        try {
            var resolver = new PathMatchingResourcePatternResolver();
            Resource[] resources = resolver.getResources("classpath:training-tasks/*.json");
            int total = 0;
            for (Resource res : resources) {
                try (InputStream is = res.getInputStream()) {
                    List<TrainingTask> tasks = objectMapper.readValue(is, new TypeReference<>() {});
                    if (tasks.isEmpty()) continue;
                    String domain = tasks.get(0).getDomain();
                    tasksByDomain.put(domain, tasks);
                    total += tasks.size();
                    log.info("Loaded {} training tasks for domain: {}", tasks.size(), domain);
                }
            }
            log.info("TrainingTaskLoader: {} tasks loaded across {} domains", total, tasksByDomain.size());
        } catch (Exception e) {
            log.error("Failed to load training tasks: {}", e.getMessage());
        }
    }

    /**
     * 获取指定 domain 的所有任务
     */
    public List<TrainingTask> getTasksByDomain(String domain) {
        return tasksByDomain.getOrDefault(domain, List.of());
    }

    /**
     * 获取所有任务（跨 domain）
     */
    public List<TrainingTask> getAllTasks() {
        List<TrainingTask> all = new ArrayList<>();
        for (List<TrainingTask> list : tasksByDomain.values()) {
            all.addAll(list);
        }
        return all;
    }

    /**
     * 获取所有 domain
     */
    public List<String> getDomains() {
        return new ArrayList<>(tasksByDomain.keySet());
    }

    /**
     * 获取任务总数
     */
    public int getTotalCount() {
        return tasksByDomain.values().stream().mapToInt(List::size).sum();
    }
}
