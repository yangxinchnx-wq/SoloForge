---
name: test-coverage
description: 为已有代码补充单元测试与集成测试。Use when user asks "补测试" / "加测试" / "test coverage" / "写单测" / "unittest" / "如何测试这个".
license: MIT
metadata:
  group: 编程
  name-zh: 测试覆盖
  author: SoloForge
  version: 1.0.0
allowed-tools: Read Write Edit Grep Glob Bash
---

# 测试覆盖

## 概述

为已有代码补充测试,提高回归安全性。目标:**每个关键路径都有测试,每个边界都被覆盖**。

## 测试设计原则

### FIRST 原则
- **F**ast:测试要快
- **I**ndependent:测试间无依赖
- **R**epeatable:可重复(无随机/时间依赖)
- **S**elf-validating:自动判定 pass/fail
- **T**imely:与代码同步

### 测什么

1. **正常路径**(happy path):常见输入返回正确结果
2. **边界值**:0、空、负数、极大、字符串边界
3. **异常路径**:错误输入抛出合适异常
4. **状态变化**:副作用是否正确发生(写入文件/数据库)

### 不测什么

- 框架/标准库自身的逻辑
- 简单的 getter/setter
- 100% 内部实现细节(易碎测试)

## 测试结构(AAA)

```typescript
test('功能名', () => {
  // Arrange:准备
  const input = ...;

  // Act:执行
  const result = fn(input);

  // Assert:断言
  expect(result).toBe(expected);
});
```

## 命名约定

`test('should <行为> when <条件>')`:
- ✅ `should return empty array when input is empty`
- ✅ `should throw when user not found`
- ❌ `test1` / `works correctly` / `fix bug`

## 覆盖策略

### 单元测试(快、隔离)
- 纯函数
- 业务逻辑
- 数据转换

### 集成测试(中速、组合)
- API 端点
- 数据库读写
- 模块协作

### 端到端测试(慢、真实)
- 关键用户旅程
- 关键回归保护

## 反模式

- ❌ 测试实现细节(私有方法/内部状态)
- ❌ 共享状态导致测试间相互影响
- ❌ mock 一切(测的不是真东西)
- ❌ 写完代码不跑测试
- ❌ 一个测试函数 200 行
