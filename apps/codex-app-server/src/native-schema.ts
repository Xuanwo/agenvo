import { Ajv, type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";
import schemas from "./schema/codex.json";
import { Fault } from "@agenvo/protocol";
const ajv = new Ajv({ strict: false, allErrors: false });
addFormats(ajv);
for (const name of ["uint", "uint32", "uint64", "int64", "int32"])
  ajv.addFormat(name, true);
export const methodValidators = new Map(
  Object.entries(schemas.methods).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);
export const responseValidators = new Map(
  Object.entries(schemas.responses).map(([name, schema]) => [
    name,
    ajv.compile(schema),
  ]),
);
export function validate(validator: ValidateFunction, input: unknown) {
  if (!validator(input))
    throw new Fault(
      "invalid_params",
      "Parameters do not match the approved native schema",
    );
}
