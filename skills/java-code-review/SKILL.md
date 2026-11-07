---
name: java-code-review
description: Review Java and Spring Boot code for correctness, security, coding standards, and Spring best practices. Use when the user asks to "review java 代码", "code review", "检查代码", or asks for quality feedback on .java files, Java packages, or recent Java changes. Supports both whole files/directories and incremental git diffs.
---

# Java Code Review

对 Java / Spring Boot 代码进行四维度评审：**正确性与潜在 Bug**、**代码规范与可读性**、**Spring Boot 最佳实践**、**安全性**。

## 评审流程

### 1. 确定评审对象

- 用户指定了 `.java` 文件或目录 → 评审这些文件
- 用户说"最近改动的代码"或未指定 → 用 git 获取增量：
  ```bash
  git status --short          # 未提交的改动
  git diff -- '*.java'        # 工作区变更
  git log --oneline -5        # 确认"最近提交"范围，必要时 diff 某个 commit
  ```
- 两者都没有 → 询问用户要评审哪些文件

### 2. 收集上下文

评审前先读项目的 `pom.xml` / `build.gradle` 确认技术栈版本（如 Spring Boot、JPA、安全框架），避免用不适用的规则挑毛病。读取被评审类直接依赖的相邻类（Repository、Service、DTO），确保对契约的理解正确。

### 3. 按四个维度逐项检查

对照 [CHECKLIST.md](CHECKLIST.md) 中的检查项逐一审查代码。每个维度只报**有证据**的问题，引用具体代码行，不臆测。

### 4. 输出报告

按以下模板组织：

```markdown
# Java Code Review：<评审范围>

## 概览
<1-2 句话总结代码整体质量> | 问题总数：X（🔴 X / 🟡 X / 🔵 X）

## 🔴 严重（必须修复）
- **[文件名.java:行号]** 问题描述 → 修复建议（附修正后的代码片段）

## 🟡 警告（应当修复）
- ...

## 🔵 建议（可以考虑）
- ...

## 亮点
<值得保留的写法，如有>
```

## 分级标准

| 级别 | 判定条件 |
|------|----------|
| 🔴 严重 | 会导致 Bug、数据错误、安全漏洞、资源泄漏 |
| 🟡 警告 | 违反 Spring/JPA 最佳实践、缺失校验或异常处理、明显可读性问题 |
| 🔵 建议 | 命名优化、重复代码提取、方法拆分等非强制改进 |

## 评审原则

1. **对事不对人**：只评代码，每条问题给出可执行的修复方案
2. **项目约定优先**：仓库已有的代码风格、`AGENT.md` 中的约定覆盖通用规则
3. **跳过工具已强制的内容**：编译器、IDE、格式化插件能发现的问题不占篇幅
4. **增量评审只看 diff**：评审 git 变更时，未改动的旧代码不挑毛病（除非 diff 中的改动激活了旧问题）
5. **宁可少而准**：没有证据的"可能有问题"不写进报告

## 详细检查清单

- 四维度完整检查项见 [CHECKLIST.md](CHECKLIST.md)
