"""Extract supported operation inputs from OpenCode 1.18.35 GET /doc.

Usage: python3 scripts/import-opencode-schema.py /path/to/openapi.json
The source must come from an isolated, pinned native server, not a user account.
"""
import json
import pathlib
import sys

NAMES = {
    'project.list', 'provider.list', 'app.agents',
    'experimental.session.list', 'session.list', 'session.get', 'session.create',
    'session.update', 'session.status', 'session.messages', 'session.message',
    'session.prompt_async', 'session.abort', 'session.children',
    'permission.list', 'permission.reply', 'question.list', 'question.reply', 'question.reject',
}
source = json.loads(pathlib.Path(sys.argv[1]).read_text())

def expand(value):
    if isinstance(value, list):
        return [expand(item) for item in value]
    if not isinstance(value, dict):
        return value
    if '$ref' in value:
        return expand(source['components']['schemas'][value['$ref'].split('/')[-1]])
    return {key: expand(item) for key, item in value.items()}

operations = []
for path, verbs in source['paths'].items():
    for verb, op in verbs.items():
        if op.get('operationId') not in NAMES:
            continue
        properties = {}
        required = []
        for location in ['path', 'query']:
            params = [p for p in op.get('parameters', []) if p['in'] == location]
            if not params:
                continue
            fields = {p['name']: expand(p['schema']) for p in params}
            mandatory = [p['name'] for p in params if p.get('required')]
            properties[location] = {'type': 'object', 'properties': fields, 'additionalProperties': False}
            if mandatory:
                properties[location]['required'] = mandatory
                required.append(location)
        body = op.get('requestBody', {}).get('content', {}).get('application/json', {}).get('schema')
        if body:
            body = expand(body)
            # Agenvo owns execution policy, not alternative permission modes.
            if op['operationId'] in ['session.create', 'session.update']:
                body['properties'].pop('permission', None)
            if op['operationId'] == 'session.prompt_async':
                body['properties'].pop('tools', None)
            properties['body'] = body
            if body.get('required'):
                required.append('body')
        schema = {'type': 'object', 'properties': properties, 'additionalProperties': False}
        if required:
            schema['required'] = required
        operations.append({'name': op['operationId'], 'verb': verb.upper(), 'path': path, 'inputSchema': schema})
missing = NAMES - {op['name'] for op in operations}
if missing:
    raise SystemExit(f'Missing operations: {missing}')
path = pathlib.Path(__file__).resolve().parents[1] / 'apps/opencode/src/schema.json'
path.write_text(json.dumps(operations, indent=2) + '\n')
