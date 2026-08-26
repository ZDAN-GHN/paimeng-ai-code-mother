---
name: project-comment-style
description: Write comments according to the annotation habits of LXH, the author of this project.Use it when you need to add or complete comments, write class-level Javadocs, method Javadocs, field descriptions, in-line explanations, or review whether comments conform to the project style.
---

# 项目注释风格

本项目注释由作者 LXH 手写，风格高度一致。生成注释时套用下列模式，不要引入通用 AI 注释腔。

## 总则

- 注释用中文；代码、标识符、注解、日志保持英文原文。
- 极简至上：代码能自解释就不写注释。宁缺毋滥。
- 解释「为什么」，不复述「做什么」。`// 设置用户名` 这类注释一律不要。
- 禁用指代词开头：不写「这个方法」「该字段」「此处」。直接给名词或动宾短语。
- `@author` 一律写 `LXH`（全项目 152 处 LXH，个别历史文件为 ZDAN / yupi，不要模仿）。

## Java

### 类级 Javadoc（必写）

```java
/**
 * 权限控制 aop 拦截器
 *
 * @author LXH
 */
```

- 首行是**职责短语**，不是类名的直译。
- **首行不加句号。** 项目内 147 个类级注释中 137 个无句号；带句号的 10 个是 MyBatis Flex 生成器产出后未修改的骨架（`应用 实体类。`）。改到那些文件时保留原句号，但新写的一律不加。
- 分层类用「域 + 空格 + 层」：`用户 控制层`、`用户 服务层实现`、`应用 映射层`。
- `@author` 前空一行。类级 Javadoc **只有** `@author`，不写 `@date`、`@version`、`@since`。
- 需要补充职责时紧接首行另起一行，中间不空行：

```java
/**
 * 文件修改工具
 * 支持 AI 通过工具调用的方式修改文件内容
 *
 * @author LXH
 */
```

真实样例：`异常状态码枚举`、`提示词安全输入护轨`、`快速构造响应结果的工具类`、`限流类型枚举，即被限流的对象`、`派蒙零代码应用生成后端入口`、`ai 代码生成服务`、`健康检查`、`静态资源访问`。

### 字段 / 枚举常量 Javadoc

```java
/**
 * 应用id
 */
private Long appId;
```

- 极短，通常就是字段名的中文说法。**不加句号**。
- 不写「字段」「属性」二字。
- 取值有限时直接列出：`user/ai`。
- 实体类、DTO、VO、常量类的每个字段都写。

真实样例：`id`、`消息`、`user/ai`、`创建用户id`、`更新时间`、`用户登录态键`、`默认角色`、`接口级别限流`、`状态码`、`信息`。

### 方法 Javadoc

接口方法必写，参数齐全：

```java
/**
 * 创建应用
 *
 * @param appAddRequest 创建应用请求 dto
 * @param loginUser     当前登录用户
 * @return 应用 id
 */
Long createApp(AppAddRequest appAddRequest, User loginUser);
```

- 首行**动宾短语**，无主语，不加句号。
- 首行与 `@param` 之间空一行。
- `@param` 说明不加冒号；多个参数时说明文字**按列对齐**（上例 `loginUser` 后补空格与 `appAddRequest` 对齐）。
- `@return` 写返回值是什么，短名词短语：`应用 id`、`应用访问 url`、`响应`、`应用列表`。
- 返回 `void` 时省略 `@return`。
- 泛型方法补 `@param <T> 数据类型`。
- **实现类的 `@Override` 方法不写 Javadoc**，注释只留在接口上（`AppServiceImpl` 8 个 `@Override` 全部无注释）。
- Controller 方法写 Javadoc，风格同接口方法。

私有方法按需写，可用 ` - ` 追加限定或状态：

```java
/**
 * 参数校验 - 3 param
 */
```

特殊构造器说明用途：

```java
/**
 * 此构造方法仅用于注册到 spring 容器，作为本类的代表实例
 */
```

### 行内注释

单独一行放在被解释代码**上方**，不写行尾注释。

```java
// 当前登录用户
User loginUser = userService.getLoginUser(request);

// 不需要权限，放行
if (StrUtil.isBlank(mustRole)) {
    return joinPoint.proceed();
}
```

流程较长时用序号分段，段间空行：

```java
// 1. 基础校验
ThrowUtils.throwIf(appId == null, ErrorCode.PARAMS_ERROR);

// 2. 查询应用信息
App app = this.getById(appId);
```

反直觉设计、踩坑点、取舍原因用**中文全角括号**在同一行补充，不另起一行：

```java
// 要求必须有管理员权限，但用户没有管理员权限，拒绝 （两步判断利于扩展，后续有新的角色按照本方式继续加 if 就行了，不会修改到已有代码）

// 排除 Langchain4j-Redis 依赖的默认向量加载配置（目前不需要 rag 知识库）

// 如果 deployKey 和其他用户的冲突，deployKey 有唯一键，插入数据库直接失败，这里不用校验是否重复了（实际重复概率约等于不可能）

// 从内存中获取服务实例，如果没有则调用 lambda 创建 键值对（相当于 Map 的 computeIfAbsent）
```

注解和配置项逐行说明其作用：

```java
// 仅作用于类
@Target(ElementType.TYPE)
// 运行时保留，可通过反射获取
@Retention(RetentionPolicy.RUNTIME)
// 标记注解会被包含在 JavaDoc 文档中
@Documented
```

数据封装、查询数据库等常见步骤用固定短语标注：`// 数据封装`、`// 查询数据库`、`// 获取封装类`。

## 前端（TypeScript / Vue）

- 只用 `// ` 单行注释，写在代码上方。不用 `/** */`。
- 模块初始化、拦截器等关键块加一行说明：`// 创建 Axios 实例`、`// 全局请求拦截器`、`// 全局响应拦截器`。
- 分支含义用短语点明：`// 未登录`、`// 刷新数据`。
- 复杂条件在判断前用完整句子说明：

```ts
// 不是获取用户信息的请求，并且用户目前不是已经在用户登录页面，则跳转到登录页面
if (
  !response.request.responseURL.includes('user/get/login') &&
  !window.location.pathname.includes('/user/login')
) {
```

- 待办或依赖后端的地方直接写明：

```ts
// 注意：这里需要后端提供删除对话历史的接口
// 目前先显示成功，实际实现需要调用删除接口
```

- Vue `<template>` 和 `<style>` 段**不写注释**。`<script setup>` 内仅在逻辑不自明处写。
- 组件的 `interface Props` / `interface Emits` 不写注释，类型即文档。

## 不要写注释的地方

- getter / setter、普通构造器。
- `@Override` 实现方法（注释在接口上）。
- 一行就能看懂的私有方法。
- Vue 模板与样式。
- 测试方法，除非断言逻辑复杂。

## 自检清单

- [ ] 类级 Javadoc 带 `@author LXH`，且只有这一个标签
- [ ] 类级注释首行**无句号**（除非改的是已有句号的生成文件）
- [ ] 字段注释无句号、无「字段」二字
- [ ] 方法首行是动宾短语、无句号，与 `@param` 间空一行
- [ ] 多个 `@param` 的说明文字已按列对齐
- [ ] `void` 方法没有 `@return`
- [ ] 实现类没有重复接口的 Javadoc
- [ ] 行内注释都在代码上方，没有行尾注释
- [ ] 补充原因用的是中文全角括号，且与注释正文同行
- [ ] 没有「这个」「该」开头的注释
- [ ] 没有复述代码字面意思的注释
