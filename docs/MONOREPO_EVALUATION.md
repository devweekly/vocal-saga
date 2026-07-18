# Monorepo 可行性评估

> **日期**:2026-07-16
> **评估对象**:将 vocal-saga 和 fanyi-extension 合并为 monorepo(pnpm workspace)
> **结论**:**可行但不推荐立即实施**,建议等共享包(A1)稳定后再评估。

---

## 1. 现状

### 当前架构
- `vocal-saga`:独立仓库,Cloudflare Workers 服务端
- `fanyi-extension`:独立仓库,WXT 浏览器扩展
- `fanyi-shared-types`:独立包,共享类型和纯函数(A1 创建)
- 同步方式:`CROSS_PROJECT_SYNC.md` 文档驱动 + `scripts/check-sync.ts` 自动校验

### 痛点
- 14 个"完全一致"模块需手工同步,容易遗漏
- 共享包发版流程:改包 → publish → 两端升级,迭代慢
- 跨仓库 refactor 无 IDE 支持(跳转、重命名)
- 测试不共享,行为一致性靠 golden files 间接保证

---

## 2. Monorepo 方案

### 目标结构
```
fanyi-monorepo/
├── packages/
│   ├── shared/              # 共享逻辑(原 @fanyi/shared-types)
│   ├── extension/           # fanyi-extension
│   └── server/              # vocal-saga
├── pnpm-workspace.yaml
├── turbo.json               # turborepo 配置(任务编排)
├── package.json             # 根 package.json(脚本聚合)
└── .github/workflows/
    ├── ci.yml               # 统一 CI
    └── deploy.yml           # 部署
```

### pnpm-workspace.yaml
```yaml
packages:
  - 'packages/*'
```

### turbo.json
```json
{
  "$schema": "https://turbo.build/schema.json",
  "tasks": {
    "build": {
      "dependsOn": ["^build"],
      "outputs": ["dist/**"]
    },
    "test": {
      "dependsOn": ["^build"],
      "outputs": []
    },
    "typecheck": {
      "outputs": []
    }
  }
}
```

### 包间依赖
```json
// packages/server/package.json
{
  "dependencies": {
    "@fanyi/shared": "workspace:*"
  }
}

// packages/extension/package.json
{
  "dependencies": {
    "@fanyi/shared": "workspace:*"
  }
}
```

`workspace:*` 是 pnpm 的 workspace 协议,指向本地包,无需 publish。

---

## 3. 收益评估

### ✅ 显著收益

| 收益 | 影响 |
|---|---|
| **共享包即时生效** | 改 `packages/shared` 后,server 和 extension 立刻看到,无需 publish |
| **跨包 refactor** | IDE 跳转、重命名跨包生效,减少手工同步 |
| **统一 CI** | 一个 GitHub Actions 跑所有包的 typecheck + test,不再分散 |
| **原子提交** | 一次 commit 可以同时改共享逻辑和两端调用方,不会出现"包升级了但调用方没改"的中间状态 |
| **统一 issue/PR** | 跨项目的 bug 不用在两个仓库来回 ref |

### ⚠️ 边际收益

| 收益 | 影响 |
|---|---|
| 统一版本管理 | 所有包用同一 Changeset 发版 |
| 统一依赖版本 | 根 package.json 锁定 TypeScript/Vitest 版本,避免版本漂移 |

---

## 4. 成本评估

### 🔴 高成本

| 成本 | 详情 |
|---|---|
| **Git 历史合并** | 两个独立仓库合并,需用 `git subtree` 或 `git filter-repo` 保留历史,操作复杂 |
| **CI/CD 重构** | vocal-saga 部署到 Cloudflare Workers,fanyi-extension 用 WXT build + 浏览器商店发布;部署流程需分别适配 |
| **代码迁移** | 两个仓库的 tsconfig、ESLint、Prettier 配置需统一;依赖版本冲突需解决 |
| **学习曲线** | 团队需熟悉 pnpm workspace + turborepo |

### 🟡 中等成本

| 成本 | 详情 |
|---|---|
| **仓库体积** | 合并后仓库更大,clone 时间增加(但 pnpm 的 content-addressable store 缓解) |
| **CI 时间** | turbo 的缓存和依赖图优化可以缓解,但初始配置需要调优 |
| **权限管理** | 如果之前两个仓库贡献者不同,合并后需重新设置 CODEOWNERS |

### 🟢 低成本

| 成本 | 详情 |
|---|---|
| **package.json 调整** | 改 name + 加 workspace 依赖,工作量小 |
| **import 路径** | 从 `@fanyi/shared-types` 改为 `@fanyi/shared`(或保持不变) |

---

## 5. 风险评估

### 高风险

1. **部署中断**:vocal-saga 的 Cloudflare Workers 部署和 fanyi-extension 的商店发布流程不同,合并后如果 CI 配置错误,可能导致某一方部署失败
   - **缓解**:先在分支上验证 CI,确认无误后再合并

2. **Git 历史丢失**:合并仓库时如果操作不当,可能丢失 commit 历史
   - **缓解**:用 `git filter-repo --to-subdirectory-filter` 保留历史,合并前备份

3. **依赖冲突**:两个仓库可能用不同版本的 TypeScript / Vitest / WXT,合并后需统一
   - **缓解**:先在 monorepo 分支解决冲突,跑通所有测试

### 中风险

4. **商店审核**:fanyi-extension 的浏览器商店审核流程不变,但 build 命令变了,需重新验证
   - **缓解**:保持 WXT build 命令兼容,只是路径从根目录改为 packages/extension

5. **贡献者流失**:如果外部贡献者只熟悉其中一个仓库,合并后可能不适应
   - **缓解**:写 CONTRIBUTING.md 说明新结构

---

## 6. 实施步骤(如果决定推进)

### 阶段 1:准备(1 周)
- [ ] 统一两个仓库的 TypeScript / Vitest / ESLint 版本
- [ ] 统一 Prettier 配置
- [ ] 解决已知的依赖冲突
- [ ] 备份两个仓库

### 阶段 2:创建 monorepo 骨架(2-3 天)
- [ ] 创建新仓库 `fanyi-monorepo`
- [ ] 配置 pnpm-workspace.yaml + turbo.json
- [ ] 创建 packages/shared(从 fanyi-shared-types 迁移)
- [ ] 配置根 package.json 的脚本

### 阶段 3:迁移代码(3-5 天)
- [ ] 用 `git filter-repo --to-subdirectory-filter` 把 vocal-saga 历史迁到 packages/server
- [ ] 用 `git filter-repo --to-subdirectory-filter` 把 fanyi-extension 历史迁到 packages/extension
- [ ] 合并两个过滤后的历史到 monorepo
- [ ] 调整 import 路径
- [ ] 把 `@fanyi/shared-types` 依赖改为 `workspace:*`

### 阶段 4:验证(2-3 天)
- [ ] 跑通所有包的 typecheck
- [ ] 跑通所有包的 test
- [ ] 跑通 vocal-saga 的 Cloudflare Workers 部署
- [ ] 跑通 fanyi-extension 的 WXT build + 商店上传
- [ ] 配置 CI(turbo run typecheck test build)

### 阶段 5:切换(1 天)
- [ ] 归档旧仓库(设为 read-only,指向新仓库)
- [ ] 通知贡献者
- [ ] 更新文档

**总预估**:2-3 周(含测试和验证)

---

## 7. 决策矩阵

| 维度 | 维持现状 | 共享包(A1) | Monorepo(B1) |
|---|---|---|---|
| 同步即时性 | 差(手工) | 中(publish 流程) | 好(即时) |
| 实施成本 | 无 | 中(已完成) | 高(2-3 周) |
| 维护成本 | 高(易遗漏) | 中(发版流程) | 低(自动) |
| 风险 | 高(脱节) | 低 | 中(部署) |
| IDE 支持 | 无 | 部分 | 完整 |
| 适合阶段 | 早期 | 中期 | 成熟期 |

---

## 8. 结论与建议

### 结论
Monorepo 技术上可行,收益清晰(即时同步 + 统一 CI + 跨包 refactor),但实施成本高(Git 历史 + 部署适配 + 依赖统一),且有部署中断风险。

### 建议
1. **当前阶段(2026 Q3)不实施 monorepo**
2. 先让 A1(共享包)+ A2(check-sync 脚本)+ A3(golden files)稳定运行 2-3 个月
3. 如果发现共享包发版流程成为瓶颈(每周都要改共享包),再启动 monorepo 评估
4. 如果启动,按 §6 的 5 阶段实施,总预估 2-3 周

### 触发条件(满足任一即可重新评估)
- 共享包发版频率 > 每周 1 次
- 跨包 refactor 需求 > 每月 2 次
- 两个仓库贡献者完全重合(同一团队)
- CI 分散维护成本超过 monorepo 迁移成本

---

## 9. 附录:参考案例

- **Turbo repo 官方示例**:https://turbo.build/repo/docs/handbook
- **pnpm workspace 文档**:https://pnpm.io/workspaces
- **git filter-repo**:https://github.com/newren/git-filter-repo
- **类似项目**:shadcn/ui(turborepo)、t3-stack(turborepo)、vercel/next.js(monorepo)

---

**文档版本**:1.0
**下次评估时间**:2026-10-01(或触发条件满足时)
