# Connect Agenvo in ChatGPT

[简体中文](chatgpt.zh-CN.md) · [README](../README.md)

Deploy the Relay, set its administrator key and [pair a device](usage.md). Your ChatGPT account or workspace must allow custom MCP servers.

1. Open **Plugins → Add → Add custom MCP server** in ChatGPT.
2. Enter `Agenvo`, your public URL such as `https://relay.example.com/mcp`, and **OAuth** authentication. Leave optional client credentials empty; ChatGPT registers automatically.
3. Create the plugin and choose **Continue to Agenvo**.
4. On Agenvo's login page, enter your administrator key. An existing login session skips this step. Never give the key to ChatGPT.
5. Check the client and callback, then choose **Allow**. This grants access to all approved instances, including future approvals. The browser returns to ChatGPT.
6. Ask your assistant to use `search` to discover targets and schemas, then `execute` to query native services. Verify the expected devices and services.

If ChatGPT reports workspace permissions or security settings before opening Agenvo, check the account's custom-app permissions. If the browser reaches Agenvo, use the error on its login or consent page to diagnose the failure.

To replace an old endpoint when the UI has no URL editor, create a new app under a temporary name and complete the steps above. Once verified, delete the old app and rename the new one to Agenvo.

References: [official connection guide](https://developers.openai.com/plugins/deploy/connect-chatgpt) · [official OAuth flow](https://developers.openai.com/plugins/build/auth).

Use [event subscriptions](events.md) to wake the consumer on changes. Read current state and output after each notification instead of continuously polling.
