# 滚动新闻快照采集与归档

本服务面向新闻编辑部和数据运营人员：采集经常刷新的新闻目录页面，规范化标题与链接，并在本地 SQLite 中保留每次采集及文章出现历史。一次短暂的页面缺项不会立刻从归档删除新闻；操作者可以查看快照差异、采集健康、审核记录，并导出 CSV。

## 环境

- Node.js `22.23.4`。
- 仅使用 Node 内置模块和 SQLite，无第三方包，不要求网络连接。

## 验收与演示

```sh
npm test
npm run build
npm run demo
```

演示会读取本地合成页面并在临时目录建立数据库，输出一次采集摘要后清理临时文件。生产数据库由 `ARCHIVE_DB` 指定，默认 `./var/archive.sqlite`；页面原文保存在数据库旁的 `blobs/` 内容寻址目录（可用构造参数 `blobRoot` 调整）。默认 HTTP 监听地址为 `127.0.0.1:8080`，可用 `HOST` 和 `PORT` 调整。

## HTTP 接口

- `POST /v1/feeds`：注册来源，提交 `feedId`、`baseUrl`、`allowedHosts`，以及可选的 `minimumItems`、`missingThreshold`。
- `POST /v1/feeds/:feedId/snapshots`：提交已保存的 HTML 页面；可用 `X-Captured-At` 指定采集时间。
- `POST /v1/feeds/:feedId/refresh`：手动抓取已注册来源；仅访问允许列表中的 DNS 主机。
- `GET /v1/feeds/:feedId`：查看 feed 状态、文章统计和采集健康。
- `GET /v1/feeds/:feedId/items`：分页读取文章；`visibility=visible|quiet` 可过滤状态。
- `GET /v1/feeds/:feedId/runs`：读取近期页面快照接纳/拒绝记录。
- `GET /v1/feeds/:feedId/runs/:captureId/source`：下载该次采集保存的原始页面字节，响应头携带内容哈希、解析版本和字节数。
- `GET /v1/feeds/:feedId/runs/:captureId/replay`：用当前解析器只读复演该次采集，返回当时的接纳/拒绝决定、解析版本、指纹与重新解析结果；不写入任何数据。
- `GET /v1/feeds/:feedId/attempts`：读取抓取请求、重试、失败和响应审计。
- `GET /v1/feeds/:feedId/changes`：比较最近两次已接纳快照；未达到两次时返回 `409`。
- `GET /v1/feeds/:feedId/health`：读取 24 小时抓取成功率、最近成功时间和异常提示。
- `GET /v1/feeds/:feedId/items.csv`：流式导出；限制输出行数并转义表格公式前缀。
- `PATCH /v1/feeds/:feedId/items/:articleId/review`：按修订号更新审核状态，状态为 `unreviewed`、`confirmed` 或 `withdrawn`。
- `GET /v1/feeds/:feedId/items/:articleId/review`：查看审核事件历史。
- `GET /v1/feeds/:feedId/items/:articleId/history`：查看文章在已接纳列表快照中的出现位置和间隔。
- `GET /health`：进程健康检查。

抓取失败、页面异常和正常列表变更有不同记录。相同页面指纹重复提交时不会重复增加文章观察次数。短暂缺失需达到来源配置的连续快照阈值后才转为 `quiet`，重新出现时恢复 `visible`。人工审核状态独立于可见性状态，旧修订号会得到冲突响应而不会覆盖新审核决定。

## 页面原文保存与复演

- 原文按 SHA-256 内容寻址保存在数据库旁的 `blobs/<前两位>/<完整哈希>` 文件中，先写 `blobs/tmp/` 临时文件并 fsync，再原子改名；SQLite 的 `page_blobs` 只保存哈希、分片路径、字节数和引用计数，`capture_sources` 把每次抓取关联到 blob 并记录解析版本。多兆字节响应不进入采集事务，文章查询路径不承载原文。
- 相同正文跨采集、跨来源共用一个 blob，引用计数由 `capture_sources` 对账维护；只要还有采集记录引用，原文就不会被清理。
- 复演是纯只读操作：校验 blob 指纹后重新跑解析，对比当时与当前的解析结果和解析版本，不增加文章出现次数，也不改变 feed 水位。相同指纹的重复提交仍走原有幂等路径。
- 存档打开时自动执行一次 blob 对账：清理崩溃遗留的临时文件、按真实引用修正计数、删除零引用的孤儿行与文件、报告缺失但仍被引用的文件。也可通过 `reconcile` 命令手动执行；`audit` 的 `page_blob_references` 检查会暴露引用漂移、缺失文件和孤儿文件。
- 拒绝页面同样保存原文，运营可凭一次抓取定位原始字节、解析版本和最终接纳/拒绝原因。5 MB 页面上限与来源主机白名单在写 blob 之前生效，保持不变。

命令行新增 `reconcile`（执行 blob 对账）和 `replay <feed> <capture-id>`（打印只读复演结果）。

仓库中的 HTML 样本为本地合成数据，仅用于离线演示和测试。实际部署前请配置准确来源域名，并遵守来源站点的使用条件。本服务不在后台隐式启动定时抓取；由操作者或外部调度器显式触发刷新。
