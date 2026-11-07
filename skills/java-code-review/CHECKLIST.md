# Java Code Review 检查清单

评审时按以下四个维度逐项对照。所有检查项基于 JDK 17+ / Spring Boot 3.x / Spring Data JPA 常见场景。

## 一、正确性与潜在 Bug

- [ ] **空指针**：链式调用中间可能为 null（`Optional.get()` 前未 `isPresent()`、Repository 查无结果直接 `.getXxx()`）
- [ ] **边界条件**：空集合、除零、off-by-one、`substring` 越界
- [ ] **异常处理**：吞异常（空 catch）、`catch (Exception)` 粒度过粗、异常未带上下文信息
- [ ] **资源泄漏**：未用 try-with-resources 的流/连接、手动关闭但无 finally
- [ ] **并发安全**：单例 Bean 中的可变实例字段、非线程安全的 `SimpleDateFormat`、check-then-act 竞态
- [ ] **等值与哈希**：重写 `equals` 未重写 `hashCode`；用 `==` 比较包装类型或字符串
- [ ] **浮点精度**：金额等敏感计算使用 `double`（应 `BigDecimal`，且用字符串构造）
- [ ] **集合误用**：遍历时修改、返回不可变集合后调用方尝试修改、`Arrays.asList` 陷阱
- [ ] **逻辑运算符**：`&`/`&&` 混用、条件短路导致副作用丢失
- [ ] **测试有效性**：断言过弱（只断言非 null）、mock 行为与真实契约不符

## 二、代码规范与可读性

- [ ] **命名**：类 PascalCase、方法/变量 camelCase、常量 UPPER_SNAKE；名称能表达意图（避免 `data`、`temp`、`flag`）
- [ ] **方法长度**：单方法超过 ~40 行或职责不单一 → 提取私有方法
- [ ] **参数数量**：超过 3-4 个参数 → 引入参数对象/DTO
- [ ] **重复代码**：同一逻辑形状出现在多处 → 提取共享方法
- [ ] **嵌套深度**：`if` 嵌套超过 3 层 → 卫语句提前 return
- [ ] **魔法值**：散落的字面量数字/字符串 → 常量或枚举
- [ ] **注释质量**：注释解释"为什么"而非"做了什么"；过期注释、被注释掉的死代码要删除
- [ ] **死代码**：未使用的私有方法、字段、导入、TODO 遗留
- [ ] **分层职责**：Controller 不写业务逻辑、Service 不处理 HTTP 概念、实体不掺入请求解析

## 三、Spring Boot 最佳实践

- [ ] **依赖注入**：使用构造器注入 + `final` 字段，避免字段 `@Autowired`；禁止手动 `new` Spring 管理的类
- [ ] **事务边界**：`@Transactional` 标在 Service 公开方法上；注意自调用失效（同类内部调用不经过代理）；只读方法用 `@Transactional(readOnly = true)`
- [ ] **JPA 陷阱**：
  - 循环内调 `repository.save/find`（N+1）→ 用 `saveAll` 或批量查询
  - 实体懒加载集合在事务外序列化 → `LazyInitializationException` 或 JSON 递归爆炸
  - 双向关系未设 `mappedBy`、`toString`/`equals` 包含关联实体导致递归
  - 大列表用 `findAll()` 全表加载 → 分页 `Pageable`
- [ ] **实体设计**：无业务行为的贫血实体可接受，但校验注解（`@NotNull`、`@Size`）应放在实体或 DTO 入口层
- [ ] **Controller 设计**：
  - 路径动词化（`/getUser`）→ 应为 RESTful 资源 + HTTP 方法
  - 返回 `Map` / 原始实体 → 应定义响应 DTO，屏蔽内部字段
  - 入参用 `@Valid` + BindingResult 或让全局异常处理器统一处理
- [ ] **配置外置**：URL、密钥、阈值不硬编码，用 `application.properties` + `@ConfigurationProperties`/`@Value`
- [ ] **组件扫描**：`@Component`/`@Service` 不滥用；工具类应为 `static` 方法 + 私有构造
- [ ] **全局异常处理**：`@RestControllerAdvice` 统一转换异常，不在每个 Controller 重复 try-catch
- [ ] **启动类职责**：`main` 类不含业务 Bean 定义（除非刻意为之）

## 四、安全性

- [ ] **注入**：JPA `@Query`/Native Query 拼接用户输入 → 用参数绑定 `:param`；LIKE 查询转义 `%` `_`
- [ ] **敏感信息**：密码只存哈希（BCrypt），响应 DTO/日志不返回、不打印密码 token；配置文件中的密钥不进版本库
- [ ] **输入校验**：请求体、路径变量、上传文件均有校验（长度、范围、类型、文件后缀/大小）
- [ ] **权限控制**：数据操作校验归属（水平越权：改/查别人的资源）；Spring Security 规则中 `permitAll` 范围是否过宽
- [ ] **反序列化与表达式**：不反序列化不可信数据；避免用户输入进入 SpEL/OGNL
- [ ] **CSRF 与 CORS**：`CorsConfiguration` 不用 `*` 生产全开；CSRF 关闭需有明确理由（如纯 token API）
- [ ] **错误信息泄露**：异常堆栈、SQL 错误不直接返回给客户端
- [ ] **硬编码凭据**：源码里的账号、密码、API Key（含测试代码中的真实凭据）
