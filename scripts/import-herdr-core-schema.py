"""Freeze the reviewed subset of the herdr-core OpenRPC document.

Usage: python3 scripts/import-herdr-core-schema.py <herdr-core checkout>/schema/hc.openrpc.json
"""
import json, pathlib, sys
source = json.loads(pathlib.Path(sys.argv[1]).read_text())
# Methods the connector exposes, plus the handshake and event subscription it uses.
methods = ['hello', 'server.status', 'templates.list', 'machine.list', 'terminal.list',
 'terminal.get', 'terminal.run', 'terminal.send', 'terminal.keys', 'terminal.interrupt',
 'terminal.read', 'terminal.kill', 'terminal.rm', 'terminal.label', 'terminal.keep',
 'events.subscribe']
schemas = source['components']['schemas']
needed = set()
def refs(node):
 if isinstance(node, dict):
  ref = node.get('$ref')
  if ref and ref.startswith('#/components/schemas/'):
   name = ref.rsplit('/', 1)[1]
   if name not in needed:
    needed.add(name); refs(schemas[name])
  for value in node.values(): refs(value)
 elif isinstance(node, list):
  for value in node: refs(value)
selected = []
for name in methods:
 method = next(m for m in source['methods'] if m['name'] == name)
 refs(method); selected.append(method)
out = {'openrpc': source['openrpc'], 'info': source['info'], 'methods': selected,
 'components': {'schemas': {k: schemas[k] for k in sorted(needed)}}}
target = pathlib.Path(__file__).resolve().parent.parent / 'tests' / 'fixtures' / 'herdr-core.openrpc.json'
target.write_text(json.dumps(out, indent=1, sort_keys=True) + '\n')
print(f"{len(selected)} methods, {len(needed)} schemas from herdr-core {source['info']['version']}")
