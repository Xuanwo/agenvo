# @agenvo/amp

[English](README.md)

通过公开 Plugin API 接入独立运行的 Amp 宿主的实验性 Agenvo 连接器。需要 Node.js 24.13+，以及已登录、支持 Thread 插件接口的 Amp CLI。

<!-- x-release-please-start-version -->

```sh
npm install --global @agenvo/amp@0.2.0
```

<!-- x-release-please-end -->

供 AI Agent 使用：先按照[安装指南](https://github.com/Xuanwo/agenvo/blob/v0.2.0/docs/installation.zh-CN.md)安装，<!-- x-release-please-version -->
再按照 [Amp 接入指南](https://github.com/Xuanwo/agenvo/blob/v0.2.0/docs/amp.zh-CN.md)配置。 <!-- x-release-please-version -->

Connector 安装本地插件并连接原生宿主，任务执行与历史继续由 Amp 持有。断开连接不停止任务。加载插件会在该宿主中启用自动工具批准；远程访问仍需 Agenvo 配对和授权。
