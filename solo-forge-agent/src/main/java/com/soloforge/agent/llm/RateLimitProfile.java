package com.soloforge.agent.llm;

import java.util.Map;

/**
 * 限流配置 — 动态可插拔
 *
 * <p>数据来源:
 * <ol>
 *   <li>前端模型配置页面扫描/探测时从 HTTP 响应头解析 (X-RateLimit-*)</li>
 *   <li>429 响应头实时更新 (Retry-After)</li>
 *   <li>无数据时使用保守默认值</li>
 * </ol>
 *
 * <p>各 provider 限流头格式:
 * <ul>
 *   <li>OpenAI: X-RateLimit-Requests-Per-Minute / X-RateLimit-Tokens-Per-Minute</li>
 *   <li>Anthropic: anthropic-ratelimit-requests-limit / retry-after</li>
 *   <li>DeepSeek: 同 OpenAI 兼容</li>
 *   <li>通用: X-RateLimit-Limit / X-RateLimit-Remaining / Retry-After</li>
 * </ul>
 */
public class RateLimitProfile {
    private int maxConcurrent = 3;
    private int maxRpm = 50;
    private int maxTpm = 0;
    private int retryAfterSec = 0;
    private String source = "default";
    public int getMaxConcurrent() { return maxConcurrent; }
    public int getMaxRpm() { return maxRpm; }
    public int getMaxTpm() { return maxTpm; }
    public int getRetryAfterSec() { return retryAfterSec; }
    public String getSource() { return source; }
    public void setMaxConcurrent(int v) { this.maxConcurrent = v; }
    public void setMaxRpm(int v) { this.maxRpm = v; }
    public void setMaxTpm(int v) { this.maxTpm = v; }
    public void setRetryAfterSec(int v) { this.retryAfterSec = v; }
    public void setSource(String v) { this.source = v; }
    public RateLimitProfile copy() {
        RateLimitProfile c = new RateLimitProfile();
        c.maxConcurrent = maxConcurrent;
        c.maxRpm = maxRpm;
        c.maxTpm = maxTpm;
        c.retryAfterSec = retryAfterSec;
        c.source = source;
        return c;
    }
    public static RateLimitProfile defaults() { return new RateLimitProfile(); }
    public static RateLimitProfile fromHeaders(Map<String, String> headers) {
        if (headers == null || headers.isEmpty()) return defaults();
        RateLimitProfile p = new RateLimitProfile();
        p.source = "headers";
        for (Map.Entry<String, String> e : headers.entrySet()) {
            String key = e.getKey().toLowerCase().trim();
            String val = e.getValue().trim();
            try {
                if (key.contains("requests-per-minute") || key.equals("x-ratelimit-limit") && val.matches("\\\\d+")) {
                    p.maxRpm = Math.max(1, Integer.parseInt(val));
                    p.maxConcurrent = Math.min(p.maxRpm, Math.max(1, p.maxRpm / 10));
                }
                else if (key.contains("tokens-per-minute")) p.maxTpm = Integer.parseInt(val);
                else if (key.contains("requests-limit") && key.contains("anthropic")) {
                    p.maxRpm = Math.max(1, Integer.parseInt(val));
                    p.maxConcurrent = Math.min(p.maxRpm, Math.max(1, p.maxRpm / 10));
                }
                else if (key.equals("retry-after")) p.retryAfterSec = Integer.parseInt(val);
            } catch (NumberFormatException ignored) {}
        }
        return p;
    }
}
