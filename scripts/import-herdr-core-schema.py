"""Freeze the reviewed subset of the herdr-core 0.1.15 OpenRPC document.

Usage: python3 scripts/import-herdr-core-schema.py <herdr-core checkout>/schema/hc.openrpc.json
Writes apps/herdr-core/src/schema.json: method inputs used by the connector at
runtime, and native result schemas used by tests.
"""
import copy, json, pathlib, sys
source = json.loads(pathlib.Path(sys.argv[1]).read_text())
schemas = source['components']['schemas']
# Exposed methods and the native params each accepts. Omitted: caller (the
# connector is not a terminal), wait/timeout on run and send (blocking waits),
# no_parent and the ignored die_with_parent.
methods = {
 'server.status': [], 'templates.list': [], 'machine.list': [],
 'terminal.list': ['all', 'labels'],
 'terminal.get': ['terminal'],
 'terminal.run': ['name', 'argv', 'line', 'cwd', 'env', 'labels', 'keep', 'on', 'rm', 'parent', 'outlive_parent', 'no_notify'],
 'terminal.send': ['terminal', 'text', 'force', 'if'],
 'terminal.keys': ['terminal', 'keys'],
 'terminal.interrupt': ['terminal', 'timeout'],
 'terminal.read': ['terminal', 'lines'],
 'terminal.kill': ['terminal'], 'terminal.rm': ['terminal'],
 'terminal.label': ['terminal', 'labels'], 'terminal.keep': ['terminal', 'keep'],
}
# Agenvo bridges, each documented in design/herdr-core-connector.zh-CN.md:
# a name is the query key for a start that outlasts the call, the interrupt
# watch fits the relay call budget, and read history fits the result frame.
overrides = {
 ('terminal.run', 'name'): {'type': 'string', 'required': True,
  'description': 'Name, unique among live terminals: 1-32 of a-z 0-9 - _ . Required by Agenvo: terminal.get with this name reports a start that outlasts the call.'},
 ('terminal.interrupt', 'timeout'): {'type': 'number', 'minimum': 0.5, 'maximum': 5, 'default': 5,
  'description': 'Seconds to watch for an effect (native default 10; Agenvo default and limit 5 to fit the call budget).'},
 ('terminal.read', 'lines'): {'maximum': 1000},
}
# Results the connector reads itself, besides the exposed methods.
internal = ['hello', 'events.subscribe']

def expand(node):
 if isinstance(node, list): return [expand(v) for v in node]
 if not isinstance(node, dict): return node
 if '$ref' in node: return expand(schemas[node['$ref'].rsplit('/', 1)[1]])
 return {k: expand(v) for k, v in node.items()}
def native(name):
 return next(m for m in source['methods'] if m['name'] == name)
inputs = {}
for name, fields in methods.items():
 params = {p['name']: p for p in native(name)['params']}
 assert set(fields) <= set(params), (name, set(fields) - set(params))
 properties, required = {}, []
 for field in fields:
  schema = expand(params[field]['schema'])
  change = dict(overrides.get((name, field), {}))
  if change.pop('required', False) or params[field].get('required'): required.append(field)
  schema.update(change)
  properties[field] = schema
 inputs[name] = {'type': 'object', 'properties': properties, 'required': required, 'additionalProperties': False}
needed = set()
def refs(node):
 if isinstance(node, dict):
  ref = node.get('$ref')
  if ref:
   key = ref.rsplit('/', 1)[1]
   if key not in needed: needed.add(key); refs(schemas[key])
  for v in node.values(): refs(v)
 elif isinstance(node, list):
  for v in node: refs(v)
results = {}
for name in [*methods, *internal]:
 results[name] = copy.deepcopy(native(name)['result']['schema']); refs(results[name])
out = {'version': source['info']['version'], 'generation': 1, 'methods': inputs, 'results': results,
 'components': {'schemas': {k: schemas[k] for k in sorted(needed)}}}
target = pathlib.Path(__file__).resolve().parent.parent / 'apps' / 'herdr-core' / 'src' / 'schema.json'
target.write_text(json.dumps(out, indent=1) + '\n')
print(f"{len(inputs)} methods, {len(results)} results from herdr-core {out['version']}")
