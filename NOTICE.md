# NOTICE — 来源与归属

## 本仓库的性质

本仓库是上游开源项目的**派生副本（fork / mirror）**，由个人账号维护，**不是官方仓库**，
与华为技术有限公司及 OpenHarmony SIG 无隶属、赞助或背书关系。

## 上游项目

| 项 | 值 |
| --- | --- |
| 项目名 | deveco-cli（DevEco CLI） |
| 上游地址 | <https://gitcode.com/openharmony-sig/deveco-cli> |
| 所属组织 | `openharmony-sig` |
| 上游默认分支 | `develop` |
| 本副本基线提交 | `2aa3100`（`!485 merge fix/run-module-multi-value into develop`） |

## 版权与许可

- 版权归 **Copyright (c) 2026 Huawei Device Co., Ltd.** 所有。
- 项目以 **MIT License** 分发，许可证全文见 [LICENSE](./LICENSE)，已随本副本一并保留。
- 上游的完整提交历史（含各位贡献者的作者署名）在本仓库中**原样保留、未被改写或压缩**，
  每条提交均可追溯至上游对应提交。
- 本副本**未修改任何上游源码文件**，仅在基线之上新增了下述文档。

## 本副本新增的内容

| 文件 | 说明 | 提交 |
| --- | --- | --- |
| `docs/technical-overview.md` | deveco-cli 技术概览：分层架构、核心机制剖析，以及在本机的构建与端到端运行验证记录 | `1625a30` |

## 未随本副本提供的内容

上游以下产物通过发布包分发，**未纳入版本库**，因此本仓库同样不包含：

- `index.zip` — 离线文档检索索引（由 `npm run build:index` 生成）
- `docs.zip` — HarmonyOS 文档正文
- `THIRD-PARTY-LICENSES` — 第三方许可清单（由 `npm run license` 生成）

因此，从本仓库克隆后 `devecocli docs` 相关命令不可用（会报 `docs.zip not found`），
需要使用上游的发布包。

## 同步上游

```bash
git fetch upstream
git merge upstream/develop      # 或 git rebase upstream/develop
git push origin develop
```

本仓库的 remote 布局：`origin` → 本 GitHub 仓库，`upstream` → 上游 GitCode 仓库。

## 支持与问题反馈

本副本**不提供任何支持或保证**，也不承诺与上游保持同步。

与 deveco-cli 本身相关的缺陷、疑问与改进建议，请提交至**上游项目**；
仅与本副本新增文档相关的问题，才适合反馈到本仓库。
