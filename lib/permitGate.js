// Pure: decide whether a permit-engine action may run. Fail closed.
export function engineGateError(settings) {
  if (settings && settings.active === true) return null;
  return "Permit engine is inactive — activate it before running this action.";
}
