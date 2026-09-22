# 固定版本素材

前端构建使用随仓库提供的 `assets/local/atlas-assets-24d6e8427efd2e90f29f1b7e/`。克隆后即可构建，无需另行取得资源包。`assets/resource-manifest.json` 固定该版本的 2,426 个文件、172,413,803 字节，记录路径、大小和 SHA-256；素材版本由文件清单内容生成。

清单覆盖 `assets/`、`avatars/`、`illustrations/` 与 `favicon.svg`。来源见 `assets/appearance-manifest.json`、包内 `assets/fonts.json`、[第三方声明](../THIRD_PARTY.md)和[素材与字体记录](ASSET_LICENSING.md)。当前 `rights_status` 为 `unreviewed`；文件纳入仓库和哈希校验通过均不表示第三方权利已核实，原创代码的 MIT 许可不扩大到这些素材。

## 校验与构建

```bash
make assets-verify
make check
```

`npm run dev` 和 `npm run build` 的前置步骤校验素材并复制到生成的 `frontend/public/`，构建结果位于 `frontend/build/`。缺失、内容变化和符号链接会明确失败。立绘索引同时检查人物条目、图片尺寸、文件引用和可选缓存版本；引用须指向包内文件，缓存版本须对应实际摘要。自有默认头像在 `frontend/static/unknown.svg`。

CI 的 `frontend-source` 检查执行完整 `make check-frontend`，包含素材校验、类型检查、生产构建及游戏和图谱测试。其他本地素材版本、压缩归档和生成目录不提交。

## 可选离线归档工具

资源打包与导入工具用于离线复制或恢复，不是普通开发的前置步骤。从当前素材制作确定性归档：

```bash
backend/.venv/bin/python scripts/resource_pack.py pack --source assets/local/atlas-assets-24d6e8427efd2e90f29f1b7e --manifest assets/resource-manifest.json --output .runtime/resources/atlas-assets-24d6e8427efd2e90f29f1b7e.tar.gz
```

工具先核对清单，固定归档顺序和时间，拒绝覆盖已有输出。清单按相对 POSIX 路径字符串排序，Python 打包器与素材生成器须保持一致。归档保留在本地，不随源码重复提交。

在目标版本目录尚不存在的环境中，可导入已有匹配归档：

```bash
make assets-install ASSET_PACKAGE=/path/to/resource-pack.tar.gz
```

导入拒绝覆盖目标目录，并在临时目录校验清单、路径、类型、重复项、大小及哈希，拒绝目录穿越、链接、缺失或额外文件，成功后才移动为目标目录。干净克隆已包含目标目录，通常直接校验即可。需要从其他目录构建时，设置 `ATLAS_ASSET_DIR`；内容仍须符合固定清单：

```bash
ATLAS_ASSET_DIR=/path/to/resources npm --prefix frontend run build
```

## 更新素材

准备新输入后，可生成候选清单：

```bash
backend/.venv/bin/python scripts/resource_pack.py inventory --source /path/to/resources --manifest .runtime/resource-manifest-candidate.json
```

核对文件变化、来源和权利状态，通过 PR 一并更新正式清单、对应素材和精确的 Git 忽略例外。不得将归档、订单、许可持有人信息或无关版本混入提交。`inventory` 默认使用 `unreviewed`，修改状态文字本身不是授权证明；进一步许可核对遵循[项目约定](../AGENTS.md#当前许可核对范围)。数据发布包的 `asset_version` 应对应实际清单版本。

Python 工具与后端共用 `backend/atlas/resource_manifest.py` 的清单约束；资料建包与发布核对素材版本和头像引用，见[资料发布](DATA_RELEASES.md)。Python 与 Node 资源测试随 `make check-tools` 执行，涵盖确定性归档、完整恢复、损坏或缺失文件、非法路径、清单结构和立绘断链。
