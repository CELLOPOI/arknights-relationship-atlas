# 喜好首版验收归档

历史记录：以下是第二轮开发前的验收与覆盖，不代表当前版本。现行结果见 [V2 验收](PREFERENCES_V2_ACCEPTANCE.md)。



所有服务端写入均在独立可丢弃测试库完成，合成参与记录不代表真实公众选择。以下保留迁移兼容性与统计校准的历史验证依据；现行初始化和调度见[运行说明](PREFERENCES.md)。

| 检查 | 实际结果与证据 |
| --- | --- |
| `make check` | 通过：后端 145 项，SQLite 跳过 12 项 PostgreSQL 专属检查；游戏 29 项、图谱/来源 5 项、Python 工具 5 项、资源验证 3 项；类型与生产构建通过。日志 `.runtime/preferences-dev/make-check-final.log` |
| `make check-postgres` | 145 项全部通过，覆盖并发派发、重复答题、名单/选择冲突、名录发布竞争及历史修订；只使用随机隔离测试库 |
| 固定素材 | 192 文件摘要、尺寸、透明通道、职业及归属与完整集合校验通过；92 外观联系表及实际页面目视核验 |
| 干净输入构建 | 复制仓库内 frontend/assets/data/scripts/LICENSE 至隔离目录，重新生成 public 与生产产物通过；复用已安装 node_modules，没有相邻资料工程或旧 public 输入。日志 `.runtime/preferences-dev/clean-build-final.log` |
| 合成统计 | seed=20260923，300 合成参与标识、6000 次判断收敛，序关系恢复 98.33%，平均分数绝对误差 1.29；单次区间覆盖 14/16，仅为实现校准。报告 `.runtime/preferences-dev/statistics-calibration.json` |
| 浏览器模拟接口 | 四视口全部通过，另覆盖只读暂停、页面内名录更新/冲突恢复、响应丢失后的原题原键重试。报告 `.runtime/verification/preferences-ui/report.json` |
| 真实浏览器与 API | 生产构建实际写入隔离 PostgreSQL：待答刷新同题、选择和自动下一题、厨力/本命、阿米娅三形态、斯卡蒂完整外观、刷新后个人卡面、独立 Cookie 无串读；浏览器错误为 0。报告 `.runtime/verification/preferences-real/integration-report.json` |
| 备份恢复 | PostgreSQL 16 的 custom pg_dump/pg_restore，在新库、空缓存下恢复额度、当前支持/本命、选择、正式任务和快照一致；演练库已删除。报告 `.runtime/verification/preferences-backup-restore/result.json` |
| 原入口 | 图谱真实读取 565 人物/5711 关系，游戏四模式与图片、站点导航及来源通过；浏览器与 HTTP 错误为 0。报告 `.runtime/verification/preferences-entry-regression/report.json` |

皮肤首页在新 Chromium 上下文、目录就绪后 800ms 的网络测量：桌面 52 请求约 2.04MB，手机 42 请求约 1.64MB；分别请求 30/21 张缩略图，完整外观图均为 0。浏览器原生懒加载会包含视口附近卡片，不将这些数字称为真实网络下的性能保证。详情只加载当前对象完整候选。报告 `.runtime/verification/preferences-real/network-report.json`。

已核对 1440×900、390×844、320×640、844×390 截图；实际设备、更多浏览器、完整辅助技术审计、容量及两周真实流量仍待运行阶段验证。名录覆盖和原始第三方素材许可状态没有因测试通过而扩大。
