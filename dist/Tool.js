// src/tools/Tool.ts
function findToolByName(tools, name) {
  return tools.find((t) => t.name === name);
}
function buildTool(def) {
  return {
    isConcurrencySafe: () => false,
    isReadOnly: () => false,
    isDestructive: () => false,
    isEnabled: () => true,
    userFacingName: () => def.name,
    ...def
  };
}
export {
  findToolByName,
  buildTool
};
