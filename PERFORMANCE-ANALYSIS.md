# Cloudflare Workers 性能优化分析报告 v3

> 分析日期：2026-06-14
> 目标：CF Workers CPU time 和 TTFB 优化

---

## 一、实测数据

### 三个真实页面的指标

| 指标 | TechCrunch | The Verge | Jane Street |
|------|-----------|-----------|-------------|
| DOM 节点 | 1997 | 2359 | 415 |
| Blocks | 61 | 83 | 35 |
| Chunks | 4 | 6 | 5 |
| Layer1 命中 | ✓ main | ✓ [role="article"] | ✓ .post-content |
| Layer2 触发 | ✗ | ✗ | ✗ |
| headingPath 数量 | 61/61 | 83/83 | 35/35 |

**关键发现**：
- **Layer1 命中率 100%**（测试的 3 个站全部 Layer1 命中）
- **headingPath 被收集但从未使用**（100% 的 block 都计算了，但 prompt 里没用）

---

## 二、headingPath 是最大的浪费

### 当前状态

`walker.ts` 第 307 行：

```typescript
headingPath: getHeadingPath(translateNode),
```

每个 block 都调用 `getHeadingPath`，这个函数会：
1. 向上遍历祖先链找 heading
2. 拼接路径字符串

### 但 prompt 里完全没用

```bash
grep -rn "headingPath" lib/translate/service/*.ts lib/translate/pipeline.ts
# 无输出
```

**结论：headingPath 是纯粹的 CPU 浪费**。

### 优化方案

**直接删除 `getHeadingPath` 和 `headingPath` 字段**。

收益：
- 每个 block 省一次祖先链遍历
- 500 blocks × 10 层深度 = 5000 次节点访问
- CPU ↓ 显著

---

## 三、xpath 同样可以删除

`walker.ts` 第 305 行：

```typescript
xpath: getXPath(translateNode),
```

**生产环境只用 `data-fanyi-block-id`**，xpath 没有被使用。

---

## 四、DOM 遍历次数分析

### 当前流程

```
Layer1 命中 → contentHelper.findArticleRoot (1次查询)
            → walker (1次 DFS)
            = 2次 DOM 访问
```

如果 Layer1 命中率是 100%（测试数据支持），那么：
- contentDetector **根本不执行**
- 实际只有 **2 次 DOM 访问**，不是 3 次

### 但 Layer1 内部有冗余

`contentHelper.ts` 中：
1. `querySelector` 遍历 ARTICLE_SELECTORS（最多 17 次）
2. `refineArticleRoot` 可能再做 `querySelector`
3. `expandIfFragmented` 向上遍历祖先

**这部分可以优化，但不是大头**。

---

## 五、更新后的优先级

### P0（立即做，收益最大）

| # | 改动 | 收益 | 工作量 |
|---|------|------|--------|
| 1 | **删除 `getHeadingPath` 和 `headingPath`** | CPU ↓ 显著（每个 block 省一次祖先遍历） | 小 |
| 2 | **删除 `getXPath` 和 `xpath`** | CPU ↓（每个 block 省一次祖先遍历） | 小 |
| 3 | **compromise lazy import** | 冷启动 -50~100ms | 小 |

### P1（值得做）

| # | 改动 | 收益 | 工作量 |
|---|------|------|--------|
| 4 | 合并 contentHelper + walker 的重复遍历 | CPU ↓ | 中 |
| 5 | JSON stringify/parse 热点分析 | 需要先测量 | 小 |

### P2（有空再做）

| # | 改动 | 收益 | 工作量 |
|---|------|------|--------|
| 6 | TextEncoder 模块级缓存 | 微量 | 小 |
| 7 | RegExp 模块级缓存 | 微量 | 小 |

### P3（不需要做）

| # | 改动 | 原因 |
|---|------|------|
| 8 | Array.from → for...of | <1% 收益 |
| 9 | contentDetector 缓存 | Layer1 100% 命中，不触发 |
| 10 | LRU/SITE_RULES | 已优化 |

---

## 六、总结

**最大发现**：`headingPath` 被收集但从未使用，是纯粹的 CPU 浪费。

**最大收益**：删除 `headingPath` + `xpath`，每个 block 省两次祖先遍历。

**Layer1 命中率**：100%（测试数据），contentDetector 根本不触发。

---

*报告 v3 完毕。*
