// Generate literal-only scripts; runtime values never become executable source.
export function callCode(input: {
  deviceId: string;
  instanceId: string;
  method: string;
  params?: unknown;
}) {
  return {
    code: `return await call(${JSON.stringify({ deviceId: input.deviceId, instanceId: input.instanceId })}, ${JSON.stringify(input.method)}, ${JSON.stringify(input.params ?? {})});`,
  };
}
export function nativeOutcome(response: any) {
  if (response.isError) throw new Error(JSON.stringify(response.content));
  return JSON.parse(response.content[0].text);
}
