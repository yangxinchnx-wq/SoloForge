package com.soloforge.agent.training;

import lombok.Data;

/**
 * 标准测试任务
 */
@Data
public class TrainingTask {
    private String id;
    private String domain;
    private String difficulty;        // easy / medium / hard
    private String input;
    private String[] expectedKeywords;
    private String[] expectedActions;
    private double weight;
}
