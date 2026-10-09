# Logo assets

`agenvo-pigeon.png` is the transparent master. `agenvo-pigeon-ivory.png` is the warm-white variant.

The Relay embeds a 256×256 PNG rendition as `packages/relay/src/logo.json` so Cloudflare and the standalone Node package serve the same icon without external assets. To regenerate it on macOS, run from the repository root:

```sh
sips -Z 256 docs/images/logo/agenvo-pigeon.png --out /tmp/agenvo-brand-256.png
node --input-type=module <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const base64 = readFileSync('/tmp/agenvo-brand-256.png').toString('base64');
writeFileSync('packages/relay/src/logo.json', JSON.stringify({ base64 }, null, 2) + '\n');
JS
```

The public URL `/assets/agenvo.png` is shared by MCP server information, page headers, and favicons. Responses cache for one day; do not mark this stable URL immutable.
