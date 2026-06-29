---
name: refactor
description: 在不改变外部行为的前提下改善代码内部结构。Use when user asks "重构" / "refactor" / "整理一下" / "清理代码" / "代码太乱了" / "clean up this code".
license: MIT
metadata:
  group: 编程
  name-zh: 重构
  author: SoloForge
  version: 1.0.0
allowed-tools: Read Edit Grep Glob
---

# 重构

## 概述

在不改变可观察行为的前提下,改善代码的内部结构。**重写不是重构,重构不改功能**。

## 重构原则

### 第一原则:不要破坏现有行为
- **必须**先有测试覆盖(没有就先补)
- **一次只改一个点**,不要顺便"优化"无关代码
- **每改一步都跑测试**
- 保持 git 提交粒度小,便于回退

### 第二原则:小步前进
每次只做一次转换:
- 抽取函数(Extract Function)
- 内联变量(Inline Variable)
- 改名(Rename)
- 移动(Move)
- 用多态替换条件(Replace Conditional with Polymorphism)

## 常见信号(代码异味)

| 异味 | 含义 | 建议重构 |
|---|---|---|
| 长函数 | >50 行难理解 | Extract Function |
| 大类 | 一个类做太多事 | Extract Class |
| 重复代码 | 几乎一样的两段 | Extract Function/Class |
| 长参数列表 | >3 个参数 | Parameter Object |
| 霰弹式修改 | 改一处要改多处 | Move Method |
| 特性依恋 | 函数更关心别的类 | Move Method |
| 基本类型偏执 | 用 string 表示状态 | Replace Type Code with Class |

## 重构流程

1. **确认行为契约**:现有代码做了什么?输入输出?
2. **写测试/确认测试存在**:覆盖主要分支
3. **小步重构**:每次一个动作
4. **测试通过**:再继续
5. **完成后整体测试**:包括边界情况

## 反模式

- ❌ 在没有测试的代码上重构
- ❌ 一次重构 + 改 bug + 加功能混在一起
- ❌ "既然重构了,顺便把 X 改了"
- ❌ 重构到"完美"才停
- ❌ 改 API 签名(那是 breaking change,不算重构)
