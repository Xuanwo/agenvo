# @agenvo/amp

[简体中文](README.zh-CN.md)

Experimental Agenvo connector for independently running Amp hosts through the public Plugin API. Requires Node.js 24.13+ and an authenticated Amp CLI with the Thread plugin APIs.

```sh
npm install --global @agenvo/amp@0.1.0
```

For AI agents: follow the [installation guide](https://github.com/Xuanwo/agenvo/blob/v0.1.0/docs/installation.md), then the [Amp connection guide](https://github.com/Xuanwo/agenvo/blob/v0.1.0/docs/amp.md).

The Connector installs a local plugin, connects to its native host, and leaves task execution and history with Amp. Disconnecting does not stop tasks. Loading the plugin enables automatic tool approval in that host; remote access still requires Agenvo pairing and authorization.
