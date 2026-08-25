# ToolRet 工具检索评测

[English](README.md) | 中文

本目录为从大型能力目录中选择少量工具的实验提供可复现的本地检索评测。它下载 ToolRet 作者发布的评测数据，在外部数据边界进行校验，并运行确定性的 BM25 基线；整个过程不需要模型凭据，也不修改 Harness 运行时。

## 准备内容

固定版本的数据集包含 44,453 份工具文档和 7,961 条查询，覆盖 `web`、`code` 与 `customized`。下载器会把全部 38 个 Parquet 文件拉取到 `.cache/toolret/raw/`，检查每个文件的字节数和 SHA-256 摘要，并写入 `.cache/toolret/manifest.json`。仓库会忽略该缓存；提交到仓库的只有下载器、固定的源元数据、适配器、基线、测试和文档。

工具源 [`mangopy/ToolRet-Tools`](https://huggingface.co/datasets/mangopy/ToolRet-Tools) 固定在 `e06c38c75612b6536bd959e08cdd345894aba6a7`，查询源 [`mangopy/ToolRet-Queries`](https://huggingface.co/datasets/mangopy/ToolRet-Queries) 固定在 `b8c76ad3349ff17497b6bdb28bb5b8f61a0f6445`。`scripts/toolret/sources.ts` 还固定了每个 LFS 对象的预期大小与 SHA-256 摘要，因此可变分支或不完整下载无法悄悄改变评测内容。

## 下载与校验

在仓库根目录下载完整评测集：

```shell
corepack pnpm run benchmark:toolret:fetch
```

命令只会在校验通过后复用已有文件。使用 `--verify-only` 可执行离线完整性检查，使用 `--repair` 可替换校验失败的文件，使用 `--cache-dir <path>` 可指定其他缓存根目录：

```shell
corepack pnpm run benchmark:toolret:fetch --verify-only
```

## 运行基线

用合并后的 44,453 个工具语料评测全部 7,961 条仅 query 输入：

```shell
corepack pnpm run benchmark:toolret
```

运行 ToolRet 的 `query + instruction` 设置：

```shell
corepack pnpm run benchmark:toolret --with-instruction
```

默认输出为 `.cache/toolret/results/bm25-query-only.json` 和 `.cache/toolret/results/bm25-with-instruction.json`。每份结果都会记录源 revision、选择范围、语料与查询数量、BM25 参数、聚合指标、分类指标和本机耗时。耗时只用于诊断，不是可跨机器比较的性能分数。

快速冒烟运行或聚焦某项任务时，可使用 `--limit`、重复传入 `--task`，或者选择一个分类。分类选项会同时过滤查询和语料，确保每个相关工具仍在评测范围内：

```shell
corepack pnpm run benchmark:toolret --task toolbench --limit 100 --no-write
corepack pnpm run benchmark:toolret --category code --output .cache/toolret/results/code.json
```

其他控制项包括 `--k1`、`--b`、`--cache-dir` 和 `--no-write`。命令始终向标准输出打印带版本的 JSON 结果，并向标准错误报告进度。

## 指标与解读

评测器报告 ToolRet 公开的 `NDCG`、`MAP`、`Recall`、`Precision` 和 `Comprehensiveness`，截断位置为 5、10 和 20。Comprehensiveness 表示在相应截断位置前召回全部相关工具的查询比例。聚合结果和分类结果都对查询做宏平均。

这里的 BM25 是透明的设施基线，并非对论文所报告神经检索模型的复现。它对 Unicode 文本分词、拆分驼峰词、移除一小组固定英文停用词，并按工具 ID 消除同分歧义。先用它证明数据与指标链路，再让任务条件路由器或向量检索器在同一组固定输入和评测器上进行比较。

## 数据条款与局限

ToolRet 数据集卡没有声明统一的数据许可证，而且 ToolRet 汇集了多个上游评测集。作者评测代码所使用的 Apache-2.0 许可证并不会自动授予每个底层数据源的使用权。应把数据保留在被忽略的本地缓存中；如需重新分发，或者用于内部研究与评测之外的场景，应先完成相应审查。

ToolRet 衡量检索相关性，不衡量工具执行、参数正确性、权限安全、运行时安装或端到端任务成功率。它反映的也是公开评测分布，而不是本项目未来的真实公司负载。结果可以支持或否定某种检索设计，但不能单独证明运行时自修改值得实施。
